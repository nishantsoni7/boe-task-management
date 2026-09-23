/**
 * /api/orders/pi-format — the handler, executed.
 *
 * Runs the exported GET end to end: the real @supabase/ssr cookie session read,
 * the real supabase-js user, permission and storage calls, and the real route
 * logic, against a small Supabase stand-in behind a stubbed `fetch`. No database
 * or bucket is touched.
 *
 * WHAT IT PROVES
 *   · the module-entry rule — an Orders viewer (view, no create), a creator and an
 *     admin all download; a signed-in user without Orders access, an inactive or
 *     deleted user, and an anonymous caller are refused, and storage is never read
 *   · `create` is not the rule — a user with create but no view is refused
 *   · only the approved bytes leave — any other object is refused with 502
 *   · the response is an attachment named BOE-PI-Format.xlsx
 *   · the dashboard offers the link outside the `create` gate
 *
 * BYTE-FOR-BYTE CHECK. The workbook is not in the repository (the repo is
 * public). Point PI_FORMAT_WORKBOOK at the approved file to also prove the route
 * serves it unchanged, SHA-256 and all:
 *   PI_FORMAT_WORKBOOK="C:\path\to\approved.xlsx" npx tsx --test src/app/api/orders/pi-format/route.test.ts
 *
 * Run:
 *   npx tsx --test src/app/api/orders/pi-format/route.test.ts
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PI_FORMAT_ACTION,
  PI_FORMAT_BYTES,
  PI_FORMAT_FILENAME,
  PI_FORMAT_OBJECT_PATH,
  PI_FORMAT_SHA256,
} from '@/lib/orders/piFormat'

// Next builds its request stores from this global when its modules load, so it
// is set before anything reaching Next is imported (in `before()`).
const globalWithStorage = globalThis as { AsyncLocalStorage?: unknown }
if (!globalWithStorage.AsyncLocalStorage) globalWithStorage.AsyncLocalStorage = AsyncLocalStorage

let GET: () => Promise<Response>
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

function sessionCookie(userId: string): string {
  const session = {
    access_token: accessToken(userId), refresh_token: `refresh-${userId}`, token_type: 'bearer',
    expires_in: 3600, expires_at: FAR_FUTURE,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.invalid` },
  }
  return `sb-stub-auth-token=base64-${b64url(JSON.stringify(session))}`
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VIEWER   = '11111111-1111-4111-8111-111111111111'
const CREATOR  = '22222222-2222-4222-8222-222222222222'
const ADMIN    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OUTSIDER = '33333333-3333-4333-8333-333333333333'
const CREATE_ONLY = '44444444-4444-4444-8444-444444444444'
const INACTIVE = '55555555-5555-4555-8555-555555555555'
const DELETED  = '66666666-6666-4666-8666-666666666666'

type User = { id: string; role: string; is_active: boolean; is_deleted: boolean | null }
const USERS: User[] = [
  { id: VIEWER, role: 'employee', is_active: true, is_deleted: false },
  { id: CREATOR, role: 'employee', is_active: true, is_deleted: null },
  { id: ADMIN, role: 'admin', is_active: true, is_deleted: false },
  { id: OUTSIDER, role: 'employee', is_active: true, is_deleted: false },
  { id: CREATE_ONLY, role: 'employee', is_active: true, is_deleted: false },
  { id: INACTIVE, role: 'employee', is_active: false, is_deleted: false },
  { id: DELETED, role: 'employee', is_active: true, is_deleted: true },
]

/** Effective Orders grants, as resolve_permission would answer them. */
const GRANTS: Record<string, string[]> = {
  [VIEWER]: ['view'],
  [CREATOR]: ['view', 'create'],
  [CREATE_ONLY]: ['create'],
  [INACTIVE]: ['view'],
  [DELETED]: ['view'],
}

const WORKBOOK_PATH = process.env.PI_FORMAT_WORKBOOK
const APPROVED = WORKBOOK_PATH && existsSync(WORKBOOK_PATH) ? readFileSync(WORKBOOK_PATH) : null

let stored: Uint8Array<ArrayBuffer> | null
let storageReads: number

// ─── A Supabase stand-in, only as wide as this route uses ────────────────────

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
    const id = (url.searchParams.get('id') ?? '').replace(/^eq\./, '')
    const rows = USERS.filter(u => u.id === id)
    if ((req.headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
      return rows.length === 1 ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'no rows', details: null, hint: null })
    }
    return json(200, rows)
  }

  if (url.pathname === '/rest/v1/rpc/resolve_permission') {
    const body = JSON.parse(await req.text()) as { p_user_id: string; p_module_key: string; p_action_key: string }
    const granted = body.p_module_key === 'orders' && (GRANTS[body.p_user_id] ?? []).includes(body.p_action_key)
    return json(200, granted)
  }

  if (url.pathname === `/storage/v1/object/order-files/${PI_FORMAT_OBJECT_PATH}`) {
    storageReads++
    if (!stored) return json(404, { statusCode: '404', error: 'not_found', message: 'Object not found' })
    return new Response(stored, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
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
    const workStore = { route: '/api/orders/pi-format', forceStatic: false, dynamicShouldError: false, isStaticGeneration: false }
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

/** Bytes that are NOT the approved workbook: right size, wrong content. */
const IMPOSTOR: Uint8Array<ArrayBuffer> = new Uint8Array(PI_FORMAT_BYTES)

beforeEach(() => {
  stored = APPROVED ? new Uint8Array(APPROVED) : IMPOSTOR
  storageReads = 0
})

const download = (userId: string | null) =>
  inRequestScope(userId ? sessionCookie(userId) : '', () => GET())

// ─── Access ──────────────────────────────────────────────────────────────────

describe('who may download the PI format — Orders module entry, not orders.create', () => {
  for (const [who, id] of [['an Orders viewer (view, no create)', VIEWER], ['an Order creator', CREATOR], ['an admin', ADMIN]] as const) {
    test(`${who} reaches the approved file`, async () => {
      const res = await download(id)
      assert.equal(storageReads, 1, 'storage is read once for an allowed reader')
      // Without the approved workbook on hand, the stored stand-in is refused as
      // not-the-approved-file — which still proves access was granted.
      assert.equal(res.status, APPROVED ? 200 : 502)
    })
  }

  for (const [who, id, status] of [
    ['a signed-in user without Orders access', OUTSIDER, 403],
    ['a user with create but not view', CREATE_ONLY, 403],
    ['an inactive user, even with view', INACTIVE, 403],
    ['a deleted user, even with view', DELETED, 403],
    ['an anonymous caller', null, 401],
  ] as const) {
    test(`${who} is refused (${status}) and storage is never read`, async () => {
      const res = await download(id)
      assert.equal(res.status, status)
      assert.equal(storageReads, 0)
      assert.equal(res.headers.get('content-disposition'), null)
    })
  }
})

// ─── Integrity ───────────────────────────────────────────────────────────────

describe('only the approved workbook is ever served', () => {
  test('bytes that are not the approved workbook are refused', async () => {
    stored = IMPOSTOR
    const res = await download(VIEWER)
    assert.equal(res.status, 502)
    assert.equal(res.headers.get('content-disposition'), null)
  })

  test('a missing object is reported, not served empty', async () => {
    stored = null
    const res = await download(VIEWER)
    assert.equal(res.status, 502)
  })

  test('the approved workbook is served byte for byte as BOE-PI-Format.xlsx', { skip: APPROVED ? false : 'set PI_FORMAT_WORKBOOK to the approved file' }, async () => {
    const res = await download(VIEWER)
    assert.equal(res.status, 200)
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body.byteLength, PI_FORMAT_BYTES)
    assert.equal(createHash('sha256').update(body).digest('hex'), PI_FORMAT_SHA256)
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${PI_FORMAT_FILENAME}"`)
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    assert.match(res.headers.get('cache-control') ?? '', /no-store/)
  })
})

// ─── The dashboard control ───────────────────────────────────────────────────

describe('the Orders dashboard offers the download to every reader', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
  const page = read('src/app/orders/page.tsx')

  test('the link points at the route and is rendered outside the create gate', () => {
    const actions = page.slice(page.indexOf('actions={'), page.indexOf('ordersCaps.canCreateOrder ? ('))
    assert.ok(actions.includes('href={PI_FORMAT_ACTION.href}'), 'the link sits in the header actions, before the create-gated Upload PI')
    assert.ok(actions.includes('download={PI_FORMAT_FILENAME}'))
    assert.ok(!/ordersCaps\.\w+\s*(&&|\?)/.test(actions), 'nothing gates the link on an Orders capability')
    assert.equal(PI_FORMAT_ACTION.href, '/api/orders/pi-format')
  })

  test('the workbook is not published from the public repository', () => {
    assert.ok(!existsSync(join(process.cwd(), 'public', PI_FORMAT_FILENAME)))
    assert.ok(!existsSync(join(process.cwd(), 'public', 'templates')))
  })
})
