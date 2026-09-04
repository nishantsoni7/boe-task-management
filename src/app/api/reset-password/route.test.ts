/**
 * Password reset, gated the same way every sibling admin-member route is.
 *
 * WHY THIS TEST EXISTS
 * ---------------------
 * The route had NO authentication or authorization check at all: any caller
 * who knew (or guessed) a userId could set that user's password directly,
 * because `actorId` was read from the request body and only ever used for
 * the audit-log row — never for access control. Fixed to require a bearer
 * token that resolves to an admin, matching delete-user/route.ts,
 * update-member/route.ts and toggle-active/route.ts. This file pins that a
 * caller without a valid admin session cannot reach `auth.admin.updateUserById`
 * at all, and that the audit log records the SERVER-VERIFIED caller, not
 * whatever actorId a request claims.
 *
 * Same fetch-stubbing technique as
 * ../permanently-delete-user/route.test.ts: no live Supabase project is
 * touched.
 *
 * Run:
 *   npx tsx --test src/app/api/reset-password/route.test.ts
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const SUPABASE_URL = 'https://stub.supabase.co'
const realFetch = globalThis.fetch
const realEnv = { ...process.env }

const ADMIN  = '11111111-1111-4111-8111-111111111111'
const MEMBER = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'

type Call = { method: string; path: string; body: unknown }
let calls: Call[]

/** Which token, if any, the stub should accept as a session and what role it carries. */
let session: { token: string; id: string; role: string } | null

function install() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method, path: path + url.search, body })

    const headers = new Headers(init?.headers as HeadersInit)
    const wantsOne = (headers.get('accept') ?? '').includes('vnd.pgrst.object')
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    // ── Auth ────────────────────────────────────────────────────────────────
    if (path === '/auth/v1/user') {
      const token = (headers.get('authorization') ?? '').replace('Bearer ', '')
      if (!session || token !== session.token) return json({ error: 'invalid token' }, 401)
      return json({ id: session.id, aud: 'authenticated' })
    }
    if (path.startsWith('/auth/v1/admin/users/')) return json({})

    // ── PostgREST ───────────────────────────────────────────────────────────
    if (path.startsWith('/rest/v1/users')) {
      if (method === 'GET') {
        const id = url.searchParams.get('id')?.replace('eq.', '')
        const row = session && id === session.id ? { id: session.id, role: session.role } : null
        return wantsOne ? json(row) : json(row ? [row] : [])
      }
    }

    if (path.startsWith('/rest/v1/password_reset_log')) return json([])

    throw new Error(`unstubbed request: ${method} ${path}`)
  }) as typeof globalThis.fetch
}

before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub'
  install()
})

after(() => {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
})

beforeEach(() => {
  calls = []
  session = { token: 'admin-token', id: ADMIN, role: 'admin' }
})

async function run(headers: Record<string, string>) {
  const { POST } = await import('./route')
  return POST(new NextRequest('https://app.test/api/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ userId: TARGET, newPassword: 'a-new-password' }),
  }))
}

const isUpdatePassword = (c: Call) => c.path.startsWith('/auth/v1/admin/users/') && c.method === 'PUT'
const isAuditInsert = (c: Call) => c.method === 'POST' && c.path.startsWith('/rest/v1/password_reset_log')

describe('only an admin session can reset a password', () => {
  test('no Authorization header at all: refused before any Supabase call', async () => {
    const res = await run({})
    assert.equal(res.status, 401)
    assert.equal(calls.some(isUpdatePassword), false, 'the password must never be touched')
  })

  test('a token that does not resolve to a real session: refused', async () => {
    const res = await run({ authorization: 'Bearer not-a-real-token' })
    assert.equal(res.status, 401)
    assert.equal(calls.some(isUpdatePassword), false)
  })

  test('a real session that is not an admin: refused', async () => {
    session = { token: 'member-token', id: MEMBER, role: 'member' }
    const res = await run({ authorization: 'Bearer member-token' })
    assert.equal(res.status, 403)
    assert.equal(calls.some(isUpdatePassword), false, 'a non-admin must never reach the password update')
  })

  test('an admin session succeeds, and the audit row names the VERIFIED caller', async () => {
    const res = await run({ authorization: 'Bearer admin-token' })
    assert.equal(res.status, 200)
    assert.ok(calls.some(isUpdatePassword), 'the admin path does reach the password update')

    const audit = calls.find(isAuditInsert)
    assert.ok(audit, 'the reset is logged')
    assert.equal((audit!.body as { actor_id: string }).actor_id, ADMIN,
      'actor_id comes from the token the server verified, never from the request body')
  })

  test('a client-supplied actorId in the body cannot forge the audit trail', async () => {
    const { POST } = await import('./route')
    const res = await POST(new NextRequest('https://app.test/api/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-token' },
      // A caller claiming to be someone else entirely.
      body: JSON.stringify({ userId: TARGET, newPassword: 'a-new-password', actorId: MEMBER }),
    }))
    assert.equal(res.status, 200)
    const audit = calls.find(isAuditInsert)
    assert.equal((audit!.body as { actor_id: string }).actor_id, ADMIN,
      'the claimed actorId in the body is ignored entirely')
  })
})
