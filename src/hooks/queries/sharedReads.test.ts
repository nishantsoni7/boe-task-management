import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { loadProfile } from './useProfile'
import { cachedModulePermissions } from './usePermissionContext'
import { fetchTaskPeople } from '@/lib/tasks/taskPeople'
import type { UserProfile } from '@/lib/types'
import type { EffectivePermission } from '@/lib/permissions/types'

// The same request asked twice on one page load (2026-11-12, "remove the duplicate requests").

const ME = '6507df9f-cdeb-4ebd-849f-8498c165d596'
const ROW = { id: ME, full_name: 'Test Person', role: 'admin' } as unknown as UserProfile

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('the profile row is read once when a shell is already reading it', () => {
  it('joins the permission-context read that is on its way instead of asking again', async () => {
    const qc = new QueryClient()
    const shell = deferred<{ profile: UserProfile | null }>()
    void qc.fetchQuery({ queryKey: ['permission-context', ME], queryFn: () => shell.promise })
    let ownReads = 0
    const profile = loadProfile(qc, ME, async () => { ownReads++; return null })
    shell.resolve({ profile: ROW })
    assert.equal(await profile, ROW)
    assert.equal(ownReads, 0)
  })

  it('reads the row itself when no shell is reading it', async () => {
    const qc = new QueryClient()
    let ownReads = 0
    assert.equal(await loadProfile(qc, ME, async () => { ownReads++; return ROW }), ROW)
    assert.equal(ownReads, 1)
  })

  it('reads the row itself when the shell read failed', async () => {
    const qc = new QueryClient()
    void qc.fetchQuery({ queryKey: ['permission-context', ME], queryFn: () => Promise.reject(new Error('blip')) }).catch(() => {})
    let ownReads = 0
    assert.equal(await loadProfile(qc, ME, async () => { ownReads++; return ROW }), ROW)
    assert.equal(ownReads, 1)
  })
})

describe('the staff list is fetched once when two parts of a page ask together', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('shares the request on its way, and asks again once it has answered', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ people: [{ id: ME, full_name: 'Test Person', is_active: true }] }))
    }) as typeof fetch
    const [a, b] = await Promise.all([fetchTaskPeople(), fetchTaskPeople()])
    assert.equal(calls, 1)
    assert.deepEqual(a, b)
    await fetchTaskPeople()
    assert.equal(calls, 2, 'nothing is kept after the answer')
  })
})

describe("a module hook reuses the gate's permission answer only while it is fresh", () => {
  const VIEW: EffectivePermission = { actionKey: 'view', allowed: true, source: 'employee_override' }
  const seed = (qc: QueryClient, map: Map<string, EffectivePermission[]>) =>
    qc.setQueryData(['permission-context', ME], { profile: ROW, permissionsByModule: map })

  it('returns a copy of the fresh answer for that module', () => {
    const qc = new QueryClient()
    const meetings = [VIEW]
    seed(qc, new Map([['meetings', meetings]]))
    const got = cachedModulePermissions(qc, ME, 'meetings')
    assert.deepEqual(got, [VIEW])
    assert.notEqual(got, meetings, 'a copy, so the caller cannot change the cache')
  })

  it('a module with no rows (or a failed resolve, cached as an empty map) is no grant', () => {
    const qc = new QueryClient()
    seed(qc, new Map())
    assert.deepEqual(cachedModulePermissions(qc, ME, 'meetings'), [])
  })

  it('asks the database again when there is no answer, or it is older than 30 seconds', () => {
    const qc = new QueryClient()
    assert.equal(cachedModulePermissions(qc, ME, 'meetings'), null)
    qc.setQueryData(['permission-context', ME], { profile: ROW, permissionsByModule: new Map([['meetings', [VIEW]]]) },
      { updatedAt: Date.now() - 31_000 })
    assert.equal(cachedModulePermissions(qc, ME, 'meetings'), null)
  })
})
