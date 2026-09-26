/**
 * resolvePerformanceAccess READS THE PROFILE AND THE PERMISSIONS SIDE BY SIDE.
 *
 * Every Performance API route starts with it. Measured in production
 * (2026-09-26) /api/performance-metrics took 4.6 s: a chain of ~7 sequential
 * server → database round trips at ~0.45 s each (the function runs in iad1, the
 * database in ap-northeast-1). The profile read and the permission RPC are both
 * keyed by the authenticated id and independent, so they now overlap.
 *
 * The decisions must not change: no profile → null; a failing permission RPC
 * → an empty list (an admin still passes on role, anybody else is denied).
 * A fake client with a fixed delay per call proves both, with no database.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePerformanceAccess } from './performance'

const DELAY = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function fakeClient(opts: { profile: Record<string, unknown> | null; rpcFails?: boolean; authFails?: boolean }) {
  const calls: { what: string; start: number; end?: number }[] = []
  const t0 = Date.now()
  const track = async <T>(what: string, value: () => T): Promise<T> => {
    const c = { what, start: Date.now() - t0 } as { what: string; start: number; end?: number }
    calls.push(c)
    await sleep(DELAY)
    c.end = Date.now() - t0
    return value()
  }
  const client = {
    auth: {
      getUser: (_token: string) => track('auth', () => opts.authFails
        ? { data: { user: null }, error: new Error('bad token') }
        : { data: { user: { id: 'u-1' } }, error: null }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          single: () => track(`${table}:${id}`, () => ({ data: opts.profile, error: null })),
        }),
      }),
    }),
    rpc: (name: string, args: { p_user_id: string }) => track(`rpc:${name}:${args.p_user_id}`, () => opts.rpcFails
      ? { data: null, error: new Error('rpc down') }
      : { data: [{ action_key: 'view', allowed: true, source: 'user' }], error: null }),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls }
}

const ADMIN = { id: 'u-1', role: 'admin', full_name: 'Synthetic Admin', team: null, position: null }
const EMPLOYEE = { id: 'u-1', role: 'employee', full_name: 'Synthetic Employee', team: 'Ops', position: null }

describe('the profile read and the permission read overlap', () => {
  test('both start before either finishes, and both use the authenticated id', async () => {
    const { client, calls } = fakeClient({ profile: EMPLOYEE })
    const access = await resolvePerformanceAccess(client, 'token')
    assert.ok(access)
    const profile = calls.find(c => c.what === 'users:u-1')!
    const perms = calls.find(c => c.what === 'rpc:resolve_effective_permissions:u-1')!
    assert.ok(profile && perms, 'both reads happened, keyed by the authenticated id')
    assert.ok(perms.start < profile.end! && profile.start < perms.end!, 'the two reads ran side by side')
  })

  test('three round trips became two: auth, then both reads together', async () => {
    // Structural, not wall-clock: a busy test runner stretches every delay, but
    // it cannot reorder these. Auth finishes first; the two reads both start
    // after it and before either of them finishes — two waves, not three.
    const { client, calls } = fakeClient({ profile: EMPLOYEE })
    await resolvePerformanceAccess(client, 'token')
    assert.equal(calls.length, 3)
    const auth = calls.find(c => c.what === 'auth')!
    const reads = calls.filter(c => c.what !== 'auth')
    assert.equal(reads.length, 2)
    for (const r of reads) assert.ok(r.start >= auth.end!, `${r.what} started after auth`)
    const lastStart = Math.max(...reads.map(r => r.start))
    const firstEnd = Math.min(...reads.map(r => r.end!))
    assert.ok(lastStart < firstEnd, 'both reads were in flight at the same time')
  })
})

describe('the decisions are unchanged', () => {
  test('an unidentified caller is null, and nothing else is read', async () => {
    const { client, calls } = fakeClient({ profile: ADMIN, authFails: true })
    assert.equal(await resolvePerformanceAccess(client, 'token'), null)
    assert.deepEqual(calls.map(c => c.what), ['auth'])
  })

  test('no profile admits nobody, even with permissions granted', async () => {
    const { client } = fakeClient({ profile: null })
    assert.equal(await resolvePerformanceAccess(client, 'token'), null)
  })

  test('a failing permission read degrades to none: an employee gets no capability', async () => {
    const { client } = fakeClient({ profile: EMPLOYEE, rpcFails: true })
    const access = await resolvePerformanceAccess(client, 'token')
    assert.ok(access)
    assert.equal(Object.values(access!.capabilities).some(Boolean), false)
  })

  test('a failing permission read still lets an admin through on role alone', async () => {
    const { client } = fakeClient({ profile: ADMIN, rpcFails: true })
    const access = await resolvePerformanceAccess(client, 'token')
    assert.ok(access)
    assert.equal(Object.values(access!.capabilities).some(Boolean), true)
  })

  test('the caller returned is the profile row', async () => {
    const { client } = fakeClient({ profile: EMPLOYEE })
    const access = await resolvePerformanceAccess(client, 'token')
    assert.equal(access!.caller.full_name, 'Synthetic Employee')
  })
})
