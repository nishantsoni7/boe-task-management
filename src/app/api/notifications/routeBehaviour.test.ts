/**
 * /api/notifications and /api/notifications/mark-read — the handlers, executed.
 *
 * The source-level tests pin invariants a running test cannot see. This file
 * RUNS the exported GET, DELETE and POST handlers end to end: the real
 * @supabase/ssr session read, the real supabase-js query building and the real
 * route logic, against a small in-memory PostgREST behind a stubbed `fetch`.
 * Nothing in the routes is mocked, and no database is touched.
 *
 * WHAT IT PROVES
 *   · filtering — quotation requests (by tasks.task_type), approval rows and
 *     system types never reach the Task feed, and are removed BEFORE paging
 *   · counts — the badge counts only what the feed shows
 *   · bulk scope — Mark all read and Delete all touch only visible rows; the
 *     chunks run concurrently; a failure part-way is reported with exact counts
 *     and a retry finishes the job
 *   · isolation — a caller only ever reads or changes their own rows
 *   · View As — a refused preview reads nothing, a refused caller receives
 *     nothing, and a preview may not write
 *
 * THE ONE PIECE OF NEXT INTERNALS. `cookies()` only works inside a request
 * scope, which Next's own request handling creates. `inRequestScope` provides
 * the minimum of it; the first test fails loudly if a Next upgrade changes that.
 *
 * Run:
 *   npx tsx --test src/app/api/notifications/routeBehaviour.test.ts
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextRequest } from 'next/server'
import { MUTATION_CONCURRENCY } from '@/lib/notifications/taskNotificationPolicy'
import { VIEW_AS_HEADER } from '@/lib/viewAs'

// ─── Next's request scope ────────────────────────────────────────────────────
//
// Next builds its request stores from `globalThis.AsyncLocalStorage` at the
// moment its modules LOAD (next/dist/server/app-render/async-local-storage.js),
// and its own server sets that global first. So it is set here, and every
// module that reaches Next — the routes included — is imported afterwards, in
// `before()`.

const globalWithStorage = globalThis as { AsyncLocalStorage?: unknown }
if (!globalWithStorage.AsyncLocalStorage) globalWithStorage.AsyncLocalStorage = AsyncLocalStorage

type Handler = (req: NextRequest) => Promise<Response>
let GET: Handler
let DELETE: Handler
let MARK_READ: Handler
let makeRequest: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => NextRequest
let readCookie: (name: string) => Promise<string | undefined>
let inRequestScope: <T>(cookieHeader: string, fn: () => Promise<T>) => Promise<T>

// ─── Sessions ────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://stub.supabase.co'
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const FAR_FUTURE = 4102444800 // 2100-01-01

function accessToken(sub: string): string {
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify({ sub, role: 'authenticated', exp: FAR_FUTURE })), 'sig'].join('.')
}

function subjectOf(token: string): string | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).sub ?? null
  } catch {
    return null
  }
}

/** The cookie @supabase/ssr reads: `sb-<ref>-auth-token`, base64url JSON. */
function sessionCookie(userId: string): string {
  const session = {
    access_token: accessToken(userId), refresh_token: `refresh-${userId}`, token_type: 'bearer',
    expires_in: 3600, expires_at: FAR_FUTURE,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.invalid` },
  }
  return `sb-stub-auth-token=base64-${b64url(JSON.stringify(session))}`
}

// ─── An in-memory PostgREST, only as wide as these routes use ────────────────

type Row = Record<string, unknown>
type TableName = 'notifications' | 'tasks' | 'users' | 'task_activity_log' | 'task_attachments'
type RestCall = { method: string; table: string; params: URLSearchParams }
type Reply = { status: number; body: unknown }
type Candidate = { row: Row; embedded: Record<string, Row | null> }

let db: Record<TableName, Row[]>
let authUsers: Set<string>
let calls: RestCall[]
let intercept: ((call: RestCall, nth: number) => Reply | undefined) | null
let mutationDelayMs: number
let inFlightMutations: number
let peakInFlightMutations: number

const RELATIONSHIPS: Partial<Record<TableName, Record<string, { table: TableName; fk: string }>>> = {
  notifications: { tasks: { table: 'tasks', fk: 'task_id' } },
}
const EMBED = /^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/

function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === '(') depth++
    if (!quoted && ch === ')') depth--
    if (!quoted && depth === 0 && ch === ',') { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts.map(p => p.trim()).filter(Boolean)
}

const unwrap = (s: string) => (s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s)

function compare(op: string, value: string, cell: unknown): boolean {
  if (op === 'is') return value === 'null' ? cell === null || cell === undefined : String(cell) === value
  // SQL: comparing NULL with anything is not true.
  if (cell === null || cell === undefined) return false
  const text = String(cell)
  switch (op) {
    case 'eq': return text === value
    case 'neq': return text !== value
    case 'in': return splitTopLevel(unwrap(value)).map(v => v.replace(/^"(.*)"$/, '$1')).includes(text)
    case 'like':
    case 'ilike': {
      const escaped = value.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${escaped}$`, op === 'ilike' ? 'i' : '').test(text)
    }
    default: throw new Error(`fake PostgREST: unsupported operator "${op}"`)
  }
}

function matches(expr: string, cell: unknown): boolean {
  const negated = expr.startsWith('not.')
  const body = negated ? expr.slice(4) : expr
  const dot = body.indexOf('.')
  const op = body.slice(0, dot)
  const value = body.slice(dot + 1)
  if (!negated) return compare(op, value, cell)
  if (op !== 'is' && (cell === null || cell === undefined)) return false
  return !compare(op, value, cell)
}

function evaluate(table: TableName, params: URLSearchParams) {
  const items = splitTopLevel(params.get('select') ?? '*')
  const embeds = items.map(i => i.match(EMBED)).filter((m): m is RegExpMatchArray => m !== null)
  let candidates: Candidate[] = db[table].map(row => {
    const embedded: Record<string, Row | null> = {}
    for (const m of embeds) {
      const rel = RELATIONSHIPS[table]?.[m[2]]
      if (!rel) throw new Error(`fake PostgREST: no relationship ${table} -> ${m[2]}`)
      embedded[m[2]] = db[rel.table].find(r => r.id === row[rel.fk]) ?? null
    }
    return { row, embedded }
  })
  const inner = new Set(embeds.filter(m => m[3] === 'inner').map(m => m[2]))
  candidates = candidates.filter(c => [...inner].every(name => c.embedded[name] !== null))

  for (const [key, expr] of params) {
    if (['select', 'order', 'limit', 'offset', 'or', 'columns'].includes(key)) continue
    const dot = key.indexOf('.')
    if (dot > 0) {
      // A filter on an embedded resource. With !inner it removes the parent row.
      const name = key.slice(0, dot)
      const column = key.slice(dot + 1)
      if (!inner.has(name)) throw new Error(`fake PostgREST: embedded filter without !inner on ${name}`)
      candidates = candidates.filter(c => matches(expr, c.embedded[name]?.[column]))
    } else {
      candidates = candidates.filter(c => matches(expr, c.row[key]))
    }
  }

  const or = params.get('or')
  if (or) {
    const conditions = splitTopLevel(unwrap(or))
    candidates = candidates.filter(c => conditions.some(cond => {
      const dot = cond.indexOf('.')
      return matches(cond.slice(dot + 1), c.row[cond.slice(0, dot)])
    }))
  }

  const order = params.get('order')
  if (order) {
    const keys = order.split(',').map(k => { const [column, direction] = k.split('.'); return { column, desc: direction === 'desc' } })
    candidates.sort((a, b) => {
      for (const k of keys) {
        const x = String(a.row[k.column] ?? '')
        const y = String(b.row[k.column] ?? '')
        if (x !== y) return (x < y ? -1 : 1) * (k.desc ? -1 : 1)
      }
      return 0
    })
  }
  return { candidates, items }
}

function project(c: Candidate, items: string[]): Row {
  const out: Row = {}
  for (const item of items) {
    const m = item.match(EMBED)
    if (m) {
      const e = c.embedded[m[2]]
      out[m[1] ?? m[2]] = e ? Object.fromEntries(splitTopLevel(m[4]).map(col => [col, e[col] ?? null])) : null
    } else if (item === '*') {
      Object.assign(out, c.row)
    } else {
      out[item] = c.row[item] ?? null
    }
  }
  return out
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== SUPABASE_URL) throw new Error(`unexpected request to ${url.origin}`)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

  if (url.pathname === '/auth/v1/user') {
    const sub = subjectOf((headers.get('authorization') ?? '').replace(/^Bearer /, ''))
    return sub && authUsers.has(sub)
      ? json(200, { id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@example.invalid` })
      : json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' })
  }

  const path = url.pathname.match(/^\/rest\/v1\/(\w+)$/)
  if (!path || !(path[1] in db)) throw new Error(`fake PostgREST: unsupported path ${url.pathname}`)
  const table = path[1] as TableName
  const call: RestCall = { method, table, params: url.searchParams }
  calls.push(call)
  const nth = calls.filter(c => c.method === method && c.table === table).length

  const mutating = method === 'PATCH' || method === 'DELETE'
  if (mutating) {
    inFlightMutations++
    peakInFlightMutations = Math.max(peakInFlightMutations, inFlightMutations)
  }
  try {
    if (mutating && mutationDelayMs > 0) await new Promise(resolve => setTimeout(resolve, mutationDelayMs))
    const intercepted = intercept?.(call, nth)
    if (intercepted) return json(intercepted.status, intercepted.body)

    const { candidates, items } = evaluate(table, url.searchParams)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limitParam = url.searchParams.get('limit')
    const page = candidates.slice(offset, limitParam === null ? undefined : offset + Number(limitParam))

    if (method === 'DELETE') {
      const doomed = new Set(page.map(c => c.row))
      db[table] = db[table].filter(r => !doomed.has(r))
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body ?? '{}')) as Row
      for (const c of page) Object.assign(c.row, patch)
    }

    const prefer = headers.get('prefer') ?? ''
    const extra: Record<string, string> = {}
    if (prefer.includes('count=exact')) {
      extra['content-range'] = page.length ? `${offset}-${offset + page.length - 1}/${candidates.length}` : `*/${candidates.length}`
    }
    if (method === 'HEAD') return new Response(null, { status: 200, headers: extra })
    if (mutating && !prefer.includes('return=representation')) return new Response(null, { status: 204, headers: extra })

    const body = page.map(c => project(c, items))
    if ((headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
      if (body.length !== 1) {
        return json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${body.length} rows`, hint: null })
      }
      return json(200, body[0], extra)
    }
    return json(200, body, extra)
  } finally {
    if (mutating) inFlightMutations--
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INACTIVE = '33333333-3333-4333-8333-333333333333'
/** Signed in, but with no `users` row — the View As decision refuses them. */
const GHOST = '99999999-9999-4999-8999-999999999999'
const TASK = 'a0000000-0000-4000-8000-000000000001'
const QUOTE = 'b0000000-0000-4000-8000-000000000002'
const OTHER_TASK = 'c0000000-0000-4000-8000-000000000003'

const at = (minute: number) => `2026-09-15T10:${String(minute).padStart(2, '0')}:00.000Z`

function note(id: string, over: Row = {}): Row {
  return {
    id, user_id: U1, task_id: TASK, entity_id: null, type: 'task_acknowledged',
    title: 'Admin added a comment', body: 'General task', is_read: false, is_push_sent: true,
    is_digest: false, created_at: at(0), read_at: null, activity_log_id: null, ...over,
  }
}

/** What U1's Task feed shows, newest first. */
const U1_VISIBLE = ['visible-new', 'visible-read', 'visible-other-task']
const HIDDEN = ['hidden-quotation', 'hidden-approval', 'hidden-system']

beforeEach(() => {
  db = {
    users: [
      { id: U1, full_name: 'Uma One', role: 'employee', is_active: true, is_deleted: false },
      { id: U2, full_name: 'Uri Two', role: 'employee', is_active: true, is_deleted: false },
      { id: ADMIN, full_name: 'Ada Admin', role: 'admin', is_active: true, is_deleted: false },
      { id: INACTIVE, full_name: 'Ina Active', role: 'employee', is_active: false, is_deleted: false },
    ],
    tasks: [
      { id: TASK, title: 'General task', task_type: 'general', created_by: ADMIN, assigned_to: U1 },
      { id: QUOTE, title: 'Quotation for a client', task_type: 'quotation_request', created_by: ADMIN, assigned_to: U1 },
      { id: OTHER_TASK, title: 'Another task', task_type: 'general', created_by: ADMIN, assigned_to: U1 },
    ],
    notifications: [
      note('visible-new', { created_at: at(5) }),
      note('visible-read', { created_at: at(4), type: 'task_assigned', title: 'Admin assigned you a task', is_read: true }),
      note('visible-other-task', { task_id: OTHER_TASK, created_at: at(2), title: 'Admin moved task to Working', is_read: true }),
      note('hidden-quotation', { task_id: QUOTE, created_at: at(6), type: 'task_assigned', title: 'New quotation request' }),
      note('hidden-approval', { created_at: at(7), title: 'Admin approved and completed task' }),
      note('hidden-system', { created_at: at(8), type: 'overdue', title: 'Task overdue' }),
      note('finance-row', { task_id: null, entity_id: 'e0000000-0000-4000-8000-000000000004', created_at: at(9), type: 'finance_submitted', title: 'Payment request submitted' }),
      note('someone-else', { user_id: U2, created_at: at(3) }),
    ],
    task_activity_log: [],
    task_attachments: [],
  }
  authUsers = new Set([U1, U2, ADMIN, INACTIVE, GHOST])
  calls = []
  intercept = null
  mutationDelayMs = 0
  inFlightMutations = 0
  peakInFlightMutations = 0
})

const realFetch = globalThis.fetch
const ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'stub-anon-key'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'
  globalThis.fetch = fakeFetch as typeof fetch

  const [route, markRead, server, headers, work, workUnit, cookieLib] = await Promise.all([
    import('./route'),
    import('./mark-read/route'),
    import('next/server'),
    import('next/headers'),
    import('next/dist/server/app-render/work-async-storage.external'),
    import('next/dist/server/app-render/work-unit-async-storage.external'),
    import('next/dist/compiled/@edge-runtime/cookies'),
  ])
  GET = route.GET
  DELETE = route.DELETE
  MARK_READ = markRead.POST
  makeRequest = (url, init) => new server.NextRequest(url, init)
  readCookie = async name => (await headers.cookies()).get(name)?.value
  inRequestScope = <T>(cookieHeader: string, fn: () => Promise<T>) => {
    const requestCookies = new cookieLib.RequestCookies(new Headers(cookieHeader ? { cookie: cookieHeader } : {}))
    const workStore = { route: '/api/notifications', forceStatic: false, dynamicShouldError: false, isStaticGeneration: false }
    const requestStore = { type: 'request', phase: 'render', cookies: requestCookies }
    return work.workAsyncStorage.run(workStore as never, () => workUnit.workUnitAsyncStorage.run(requestStore as never, fn))
  }
})

after(() => {
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

async function send(
  handler: Handler, userId: string | null, path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Row }> {
  const req = makeRequest(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const res = await inRequestScope(userId ? sessionCookie(userId) : '', () => handler(req))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

const listIds = (body: Row) => (body.notifications as Row[]).map(n => n.id)
const rowIds = (userId: string) => db.notifications.filter(n => n.user_id === userId).map(n => n.id).sort()
const unreadIds = (userId: string) => db.notifications.filter(n => n.user_id === userId && !n.is_read).map(n => n.id).sort()
const notificationReadsFor = (userId: string) =>
  calls.filter(c => c.table === 'notifications' && c.params.getAll('user_id').includes(`eq.${userId}`))

// ─── Tests ───────────────────────────────────────────────────────────────────

test('the harness: cookies() resolves inside the request scope', async () => {
  const value = await inRequestScope(sessionCookie(U1), () => readCookie('sb-stub-auth-token'))
  assert.ok(value?.startsWith('base64-'), 'if this fails, Next changed its request store and the harness needs updating')
})

describe('filtering and counts — the Task feed', () => {
  test('the list shows visible rows only, newest first, and never leaks the task join', async () => {
    const { status, body } = await send(GET, U1, '/api/notifications?category=task&limit=50')
    assert.equal(status, 200)
    assert.deepEqual(listIds(body), U1_VISIBLE)
    assert.equal(body.hasMore, false)
    assert.equal(body.unreadCount, 1)
    for (const row of body.notifications as Row[]) assert.equal('tasks' in row, false)
  })

  test('the unread badge counts only what the feed shows', async () => {
    // U1 has four unread task-linked rows; three are hidden.
    const { status, body } = await send(GET, U1, '/api/notifications?count=1&category=task')
    assert.equal(status, 200)
    assert.deepEqual(body, { unreadCount: 1 })
  })

  test('hidden rows are removed before paging: no empty page, no false "older"', async () => {
    for (let i = 0; i < 5; i++) {
      db.notifications.push(note(`newer-quotation-${i}`, { task_id: QUOTE, created_at: at(30 + i), type: 'task_assigned' }))
    }
    const first = await send(GET, U1, '/api/notifications?category=task&limit=1')
    assert.deepEqual(listIds(first.body), ['visible-new'])
    assert.equal(first.body.hasMore, true)
    const all = await send(GET, U1, '/api/notifications?category=task&limit=3')
    assert.deepEqual(listIds(all.body), U1_VISIBLE)
    assert.equal(all.body.hasMore, false)
  })

  test('another module’s feed is unchanged and joins no task', async () => {
    const { status, body } = await send(GET, U1, '/api/notifications?category=finance&limit=50')
    assert.equal(status, 200)
    assert.deepEqual(listIds(body), ['finance-row'])
    const financeRead = calls.find(c => c.table === 'notifications' && c.method === 'GET')
    assert.equal(financeRead?.params.get('select')?.includes('tasks!inner'), false)
  })
})

describe('user isolation', () => {
  test('each caller reads only their own rows', async () => {
    const u2 = await send(GET, U2, '/api/notifications?category=task&limit=50')
    assert.deepEqual(listIds(u2.body), ['someone-else'])
    const u1 = await send(GET, U1, '/api/notifications?category=task&limit=50')
    assert.equal(listIds(u1.body).includes('someone-else'), false)
  })

  test('bulk actions never reach another user’s rows', async () => {
    await send(DELETE, U1, '/api/notifications?category=task', { method: 'DELETE' })
    await send(MARK_READ, U1, '/api/notifications/mark-read', { method: 'POST', body: { all: true, category: 'task' } })
    assert.deepEqual(rowIds(U2), ['someone-else'])
    assert.deepEqual(unreadIds(U2), ['someone-else'])
  })

  test('no session: 401, and nothing is read', async () => {
    const { status } = await send(GET, null, '/api/notifications?category=task')
    assert.equal(status, 401)
    assert.equal(calls.length, 0)
  })
})

describe('bulk scope', () => {
  test('Delete all removes the visible rows and keeps hidden history', async () => {
    const { status, body } = await send(DELETE, U1, '/api/notifications?category=task', { method: 'DELETE' })
    assert.equal(status, 200)
    assert.equal(body.deletedCount, 3)
    assert.equal(body.unreadAffected, 1)
    assert.deepEqual(rowIds(U1), [...HIDDEN, 'finance-row'].sort())
  })

  test('Delete all for one task stays inside that task', async () => {
    const { body } = await send(DELETE, U1, `/api/notifications?category=task&taskId=${TASK}`, { method: 'DELETE' })
    assert.equal(body.deletedCount, 2)
    assert.deepEqual(rowIds(U1), ['visible-other-task', ...HIDDEN, 'finance-row'].sort())
  })

  test('Mark all read flips visible unread rows only', async () => {
    const { status, body } = await send(MARK_READ, U1, '/api/notifications/mark-read', { method: 'POST', body: { all: true, category: 'task' } })
    assert.equal(status, 200)
    assert.equal(body.updatedCount, 1)
    assert.equal(body.unreadAffected, 1)
    assert.deepEqual(unreadIds(U1), ['finance-row', 'hidden-approval', 'hidden-quotation', 'hidden-system'])
  })

  test('Mark read for one task stays inside that task and skips its hidden rows', async () => {
    const { body } = await send(MARK_READ, U1, '/api/notifications/mark-read', { method: 'POST', body: { taskId: TASK, category: 'task' } })
    assert.equal(body.updatedCount, 1)
    assert.ok(unreadIds(U1).includes('hidden-approval'), 'the approval row on the same task stays unread')
  })

  test('a large inbox is mutated in concurrent chunks, within the bound', async () => {
    for (let i = 0; i < 450; i++) db.notifications.push(note(`bulk-${i}`, { created_at: at(10) }))
    mutationDelayMs = 15
    const { status, body } = await send(DELETE, U1, '/api/notifications?category=task', { method: 'DELETE' })
    assert.equal(status, 200)
    assert.equal(body.deletedCount, 453)
    const chunks = calls.filter(c => c.method === 'DELETE').length
    assert.equal(chunks, 3)
    assert.ok(peakInFlightMutations > 1, 'the chunks actually overlap in flight')
    assert.equal(peakInFlightMutations, Math.min(chunks, MUTATION_CONCURRENCY))
    assert.deepEqual(rowIds(U1), [...HIDDEN, 'finance-row'].sort())
  })

  test('Delete all failing part-way reports exact counts, keeps hidden rows, and a retry finishes', async () => {
    for (let i = 0; i < 450; i++) db.notifications.push(note(`bulk-${i}`, { created_at: at(10) }))
    const before = db.notifications.filter(n => n.user_id === U1).length
    intercept = (call, nth) => (call.method === 'DELETE' && nth === 2
      ? { status: 500, body: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } }
      : undefined)

    const failed = await send(DELETE, U1, '/api/notifications?category=task', { method: 'DELETE' })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.partial, true)
    const removed = before - db.notifications.filter(n => n.user_id === U1).length
    assert.ok(removed > 0 && removed < 453, 'some chunks committed, one did not')
    assert.equal(failed.body.deletedCount, removed, 'the count is what actually happened')
    for (const id of [...HIDDEN, 'finance-row']) assert.ok(rowIds(U1).includes(id))

    intercept = null
    const retried = await send(DELETE, U1, '/api/notifications?category=task', { method: 'DELETE' })
    assert.equal(retried.status, 200)
    assert.equal(retried.body.deletedCount, 453 - removed)
    assert.deepEqual(rowIds(U1), [...HIDDEN, 'finance-row'].sort())
  })

  test('Mark all read failing part-way reports exact counts and a retry finishes', async () => {
    for (let i = 0; i < 450; i++) db.notifications.push(note(`bulk-${i}`, { created_at: at(10) }))
    intercept = (call, nth) => (call.method === 'PATCH' && nth === 1
      ? { status: 500, body: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } }
      : undefined)

    const failed = await send(MARK_READ, U1, '/api/notifications/mark-read', { method: 'POST', body: { all: true, category: 'task' } })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.partial, true)
    // 450 bulk rows + visible-new were the visible unread set.
    const stillUnread = db.notifications.filter(n =>
      n.user_id === U1 && !n.is_read && (String(n.id).startsWith('bulk-') || n.id === 'visible-new')).length
    const flipped = 451 - stillUnread
    assert.ok(flipped > 0 && flipped < 451, 'some chunks committed, one did not')
    assert.equal(failed.body.updatedCount, flipped, 'the count is what actually happened')

    intercept = null
    const retried = await send(MARK_READ, U1, '/api/notifications/mark-read', { method: 'POST', body: { all: true, category: 'task' } })
    assert.equal(retried.status, 200)
    assert.equal(retried.body.updatedCount, 451 - flipped)
    assert.deepEqual(unreadIds(U1), ['finance-row', 'hidden-approval', 'hidden-quotation', 'hidden-system'])
  })
})

describe('View As', () => {
  test('an employee naming someone else is refused, and nothing of theirs is read', async () => {
    const { status, body } = await send(GET, U1, `/api/notifications?category=task&subjectUserId=${U2}`)
    assert.equal(status, 403)
    assert.equal('notifications' in body, false)
    assert.equal(notificationReadsFor(U2).length, 0)
    const count = await send(GET, U1, `/api/notifications?count=1&category=task&subjectUserId=${U2}`)
    assert.equal(count.status, 403)
    assert.equal(notificationReadsFor(U2).length, 0)
  })

  test('a refused caller receives the refusal, not the rows read beside the check', async () => {
    // Signed in, no users row: the decision refuses AFTER the speculative read.
    const list = await send(GET, GHOST, '/api/notifications?category=task&limit=50')
    assert.equal(list.status, 401)
    assert.equal('notifications' in list.body, false)
    const count = await send(GET, GHOST, '/api/notifications?count=1&category=task')
    assert.equal(count.status, 401)
    assert.equal('unreadCount' in count.body, false)
  })

  test('naming yourself is an ordinary read', async () => {
    const { status, body } = await send(GET, U1, `/api/notifications?category=task&subjectUserId=${U1}`)
    assert.equal(status, 200)
    assert.deepEqual(listIds(body), U1_VISIBLE)
  })

  test('an administrator previews an eligible employee’s feed, filtered the same way', async () => {
    const { status, body } = await send(GET, ADMIN, `/api/notifications?category=task&subjectUserId=${U1}`)
    assert.equal(status, 200)
    assert.deepEqual(listIds(body), U1_VISIBLE)
    const count = await send(GET, ADMIN, `/api/notifications?count=1&category=task&subjectUserId=${U1}`)
    assert.deepEqual(count.body, { unreadCount: 1 })
  })

  test('an administrator cannot preview an inactive employee', async () => {
    const { status } = await send(GET, ADMIN, `/api/notifications?category=task&subjectUserId=${INACTIVE}`)
    assert.equal(status, 404)
    assert.equal(notificationReadsFor(INACTIVE).length, 0)
  })

  test('a preview may not delete or mark read', async () => {
    const snapshot = JSON.stringify(db.notifications)
    const del = await send(DELETE, ADMIN, '/api/notifications?category=task', { method: 'DELETE', headers: { [VIEW_AS_HEADER]: '1' } })
    assert.equal(del.status, 403)
    const mark = await send(MARK_READ, ADMIN, '/api/notifications/mark-read', { method: 'POST', body: { all: true, category: 'task' }, headers: { [VIEW_AS_HEADER]: '1' } })
    assert.equal(mark.status, 403)
    assert.equal(JSON.stringify(db.notifications), snapshot)
    assert.equal(calls.some(c => c.method === 'DELETE' || c.method === 'PATCH'), false)
  })
})
