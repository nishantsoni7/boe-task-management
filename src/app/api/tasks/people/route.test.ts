/**
 * /api/tasks/people — the handler, executed.
 *
 * Runs the exported GET end to end: the real @supabase/ssr cookie session read and
 * the real supabase-js calls, against a small Supabase stand-in behind a stubbed
 * `fetch`, the same way /api/orders/pi-format is tested. No database is touched.
 *
 * WHAT IT PROVES
 *   · Task Management entry is the rule: a holder of `view` and an admin read the
 *     list; anyone else, an inactive or deleted caller and an anonymous one do not
 *   · an inactive PERSON is named, which is the reason this route exists
 *   · only id, name and active flag leave, whatever the row holds
 *
 * Run:
 *   npx tsx --test src/app/api/tasks/people/route.test.ts
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'

const globalWithStorage = globalThis as { AsyncLocalStorage?: unknown }
if (!globalWithStorage.AsyncLocalStorage) globalWithStorage.AsyncLocalStorage = AsyncLocalStorage

let GET: () => Promise<Response>
let inRequestScope: <T>(cookieHeader: string, fn: () => Promise<T>) => Promise<T>

const SUPABASE_URL = 'https://stub.supabase.co'
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const FAR_FUTURE = 4102444800

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

function sessionCookie(userId: string): string {
  const session = {
    access_token: accessToken(userId), refresh_token: `refresh-${userId}`, token_type: 'bearer',
    expires_in: 3600, expires_at: FAR_FUTURE,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.invalid` },
  }
  return `sb-stub-auth-token=base64-${b64url(JSON.stringify(session))}`
}

const VIEWER   = '11111111-1111-4111-8111-111111111111'
const ADMIN    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OUTSIDER = '33333333-3333-4333-8333-333333333333'
const LEFT     = '55555555-5555-4555-8555-555555555555'
const DELETED  = '66666666-6666-4666-8666-666666666666'

const USERS = [
  { id: VIEWER, full_name: 'Viewer', role: 'employee', is_active: true, is_deleted: false, monthly_salary: 1 },
  { id: ADMIN, full_name: 'Admin', role: 'admin', is_active: true, is_deleted: false, monthly_salary: 2 },
  { id: OUTSIDER, full_name: 'Outsider', role: 'employee', is_active: true, is_deleted: false, monthly_salary: 3 },
  { id: LEFT, full_name: 'Has Left', role: 'employee', is_active: false, is_deleted: false, monthly_salary: 4 },
  { id: DELETED, full_name: 'Deleted', role: 'employee', is_active: true, is_deleted: true, monthly_salary: 5 },
]
const GRANTS: Record<string, string[]> = { [VIEWER]: ['view'], [LEFT]: ['view'], [DELETED]: ['view'] }

let directoryReads = 0

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init)
  const url = new URL(req.url)
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')

  if (url.pathname === '/auth/v1/user') {
    const sub = subjectOf(bearer)
    return sub ? json(200, { id: sub, aud: 'authenticated', role: 'authenticated' }) : json(401, { message: 'invalid JWT' })
  }

  if (url.pathname === '/rest/v1/users') {
    const id = url.searchParams.get('id')?.replace(/^eq\./, '')
    if (!id) {
      directoryReads++
      const columns = (url.searchParams.get('select') ?? '').split(',')
      return json(200, USERS.map(u => Object.fromEntries(Object.entries(u).filter(([k]) => columns.includes(k)))))
    }
    const rows = USERS.filter(u => u.id === id)
    if ((req.headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
      return rows.length === 1 ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'no rows', details: null, hint: null })
    }
    return json(200, rows)
  }

  if (url.pathname === '/rest/v1/rpc/resolve_permission') {
    const body = JSON.parse(await req.text()) as { p_user_id: string; p_module_key: string; p_action_key: string }
    return json(200, body.p_module_key === 'task_management' && (GRANTS[body.p_user_id] ?? []).includes(body.p_action_key))
  }

  throw new Error(`unexpected request: ${req.method} ${url.pathname}`)
}

const realFetch = globalThis.fetch
const ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'stub-anon-key'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'
  globalThis.fetch = fakeFetch as typeof fetch

  const [route, work, workUnit, cookieLib] = await Promise.all([
    import('./route'),
    import('next/dist/server/app-render/work-async-storage.external'),
    import('next/dist/server/app-render/work-unit-async-storage.external'),
    import('next/dist/compiled/@edge-runtime/cookies'),
  ])
  GET = route.GET
  inRequestScope = <T>(cookieHeader: string, fn: () => Promise<T>) => {
    const requestCookies = new cookieLib.RequestCookies(new Headers(cookieHeader ? { cookie: cookieHeader } : {}))
    const workStore = { route: '/api/tasks/people', forceStatic: false, dynamicShouldError: false, isStaticGeneration: false }
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

beforeEach(() => { directoryReads = 0 })

const ask = (userId: string | null) => inRequestScope(userId ? sessionCookie(userId) : '', () => GET())

describe('who may read the names', () => {
  for (const [who, id] of [['a Task Management user', VIEWER], ['an admin', ADMIN]] as const) {
    test(`${who} may`, async () => {
      const res = await ask(id)
      assert.equal(res.status, 200)
      assert.equal(directoryReads, 1)
    })
  }

  for (const [who, id, status] of [
    ['a signed-in user without Task Management', OUTSIDER, 403],
    ['an inactive caller, even with view', LEFT, 403],
    ['a deleted caller, even with view', DELETED, 403],
    ['an anonymous caller', null, 401],
  ] as const) {
    test(`${who} is refused (${status}) and the table is never read`, async () => {
      const res = await ask(id)
      assert.equal(res.status, status)
      assert.equal(directoryReads, 0)
    })
  }
})

describe('what comes back', () => {
  test('an inactive person is named, and marked', async () => {
    const { people } = await (await ask(VIEWER)).json() as { people: { id: string; full_name: string; is_active: boolean }[] }
    assert.deepEqual(people.find(p => p.id === LEFT), { id: LEFT, full_name: 'Has Left', is_active: false })
  })

  test('nothing else about a person leaves the server', async () => {
    const { people } = await (await ask(VIEWER)).json() as { people: Record<string, unknown>[] }
    for (const person of people) assert.deepEqual(Object.keys(person).sort(), ['full_name', 'id', 'is_active'])
  })

  test('the answer is not cached by anything in between', async () => {
    assert.equal((await ask(VIEWER)).headers.get('cache-control'), 'private, no-store')
  })
})
