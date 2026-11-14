import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadProfile } from './useProfile'
import {
  cachedModulePermissions, callerModulePermissions, callerProfile, profileForFirstResolve, profileReadInFlight,
} from './usePermissionContext'
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

describe("the shell's first permission read reuses the row the page just read", () => {
  it('reuses a row read in the last 30 seconds when the context has never resolved', () => {
    const qc = new QueryClient()
    qc.setQueryData(['profile', ME], ROW)
    assert.equal(profileForFirstResolve(qc, ME), ROW)
  })

  it('reads again on a refetch, so a role change still reaches an open page', () => {
    const qc = new QueryClient()
    qc.setQueryData(['profile', ME], ROW)
    qc.setQueryData(['permission-context', ME], { profile: ROW, permissionsByModule: new Map() })
    assert.equal(profileForFirstResolve(qc, ME), null)
  })

  it('reads again when the row is missing, older than 30 seconds or marked stale', async () => {
    const qc = new QueryClient()
    assert.equal(profileForFirstResolve(qc, ME), null)
    qc.setQueryData(['profile', ME], null)
    assert.equal(profileForFirstResolve(qc, ME), null, 'a failed or missing row is not reused')
    qc.setQueryData(['profile', ME], ROW, { updatedAt: Date.now() - 31_000 })
    assert.equal(profileForFirstResolve(qc, ME), null)
    qc.setQueryData(['profile', ME], ROW)
    await qc.invalidateQueries({ queryKey: ['profile', ME], refetchType: 'none' })
    assert.equal(profileForFirstResolve(qc, ME), null)
  })
})

// THE START-UP READS THAT WERE ASKED TWICE ON EVERY PAGE (2026-11-14). A request that waits beside others
// finishes later (about 70 ms each on this database), so the first wave of every page and the Orders pages'
// own second wave were slowed by reads of a row and of permissions the guard had just resolved.
describe('a screen that loads in an effect reuses what the guard just read', () => {
  const VIEW: EffectivePermission = { actionKey: 'view', allowed: true, source: 'employee_override' }
  const noDatabase = { rpc: () => { throw new Error('the database must not be asked') } } as unknown as SupabaseClient

  it('callerProfile returns the row the shell published in the last 30 seconds without a read', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['profile', ME], ROW)
    let reads = 0
    assert.equal(await callerProfile(qc, ME, async () => { reads++; return null }), ROW)
    assert.equal(reads, 0)
  })

  it('callerProfile reads again when the row is missing, older than 30 seconds, failed or marked stale', async () => {
    const qc = new QueryClient()
    const fresh = { ...ROW, role: 'member' } as unknown as UserProfile
    let reads = 0
    const read = async () => { reads++; return fresh }
    assert.equal(await callerProfile(qc, ME, read), fresh)
    assert.equal(reads, 1, 'nothing cached')
    qc.setQueryData(['profile', ME], ROW, { updatedAt: Date.now() - 31_000 })
    assert.equal(await callerProfile(qc, ME, read), fresh)
    assert.equal(reads, 2, 'older than 30 s')
    qc.setQueryData(['profile', ME], null)
    assert.equal(await callerProfile(qc, ME, read), fresh)
    assert.equal(reads, 3, 'a failed or missing row is not reused')
    qc.setQueryData(['profile', ME], ROW)
    await qc.invalidateQueries({ queryKey: ['profile', ME], refetchType: 'none' })
    assert.equal(await callerProfile(qc, ME, read), fresh)
    assert.equal(reads, 4, 'marked stale')
  })

  it('callerProfile reports a failed read as no row, as a read of its own would', async () => {
    assert.equal(await callerProfile(new QueryClient(), ME, async () => null), null)
  })

  it('callerProfile joins the shell read that is on its way instead of asking again', async () => {
    const qc = new QueryClient()
    const shell = deferred<{ profile: UserProfile | null }>()
    void qc.fetchQuery({ queryKey: ['permission-context', ME], queryFn: () => shell.promise })
    let reads = 0
    const got = callerProfile(qc, ME, async () => { reads++; return null })
    shell.resolve({ profile: ROW })
    assert.equal(await got, ROW)
    assert.equal(reads, 0)
  })

  it('callerModulePermissions uses the fresh shell answer and never asks the database', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['permission-context', ME], { profile: ROW, permissionsByModule: new Map([['orders', [VIEW]]]) })
    assert.deepEqual(await callerModulePermissions(qc, noDatabase, ME, 'orders'), [VIEW])
    assert.deepEqual(await callerModulePermissions(qc, noDatabase, ME, 'finance'), [], 'a module with no rows is no grant')
  })

  it('callerModulePermissions asks the database when the answer is missing or older than 30 seconds', async () => {
    const asked: string[] = []
    const database = {
      rpc: async (_name: string, args: { p_module_key: string }) => {
        asked.push(args.p_module_key)
        return { data: [{ action_key: 'view', allowed: true, source: 'role' }], error: null }
      },
    } as unknown as SupabaseClient
    const qc = new QueryClient()
    assert.deepEqual(await callerModulePermissions(qc, database, ME, 'orders'), [{ actionKey: 'view', allowed: true, source: 'role' }])
    qc.setQueryData(['permission-context', ME], { profile: ROW, permissionsByModule: new Map([['orders', [VIEW]]]) },
      { updatedAt: Date.now() - 31_000 })
    await callerModulePermissions(qc, database, ME, 'orders')
    assert.deepEqual(asked, ['orders', 'orders'])
  })

  it('callerModulePermissions gives no permissions when the database read fails (no capability)', async () => {
    const database = { rpc: async () => ({ data: null, error: { message: 'down' } }) } as unknown as SupabaseClient
    assert.deepEqual(await callerModulePermissions(new QueryClient(), database, ME, 'orders'), [])
  })
})

describe("the shell's permission read waits for a profile read that is already running", () => {
  it('reports no read in flight when nothing is running, and the running read when there is one', async () => {
    const qc = new QueryClient()
    assert.equal(profileReadInFlight(qc, ME), null)
    const running = deferred<UserProfile | null>()
    void qc.fetchQuery({ queryKey: ['profile', ME], queryFn: () => running.promise })
    const joined = profileReadInFlight(qc, ME)
    assert.ok(joined, 'a read is running')
    running.resolve(ROW)
    assert.equal(await joined, ROW)
    assert.equal(profileReadInFlight(qc, ME), null, 'and none once it has answered')
  })

  it('a failed running read is reported as no row, so the context reads the row itself', async () => {
    const qc = new QueryClient()
    void qc.fetchQuery({ queryKey: ['profile', ME], queryFn: () => Promise.reject(new Error('blip')), retry: false }).catch(() => {})
    assert.equal(await profileReadInFlight(qc, ME), null)
  })
})

describe('the start-up reads stay folded', () => {
  const root = join(__dirname, '..', '..', '..')
  const src = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('the Login-as-member widget reads no users row of its own: its role comes from the shared profile', () => {
    const widget = src('src/components/layout/LoginAsMemberWidget.tsx')
    assert.match(widget, /callerProfile\(qc, userId\)/)
    assert.equal(/\.from\('users'\)\s*\.select\('role'\)/.test(widget), false)
  })

  it('the permission context joins a profile read that is already running before it reads the row itself', () => {
    const ctx = src('src/hooks/queries/usePermissionContext.ts')
    assert.match(ctx, /profileReadInFlight\(qc, userId\)/)
  })

  for (const page of ['src/app/orders/drafts/page.tsx', 'src/app/orders/[id]/page.tsx', 'src/app/orders/drafts/[submissionId]/page.tsx']) {
    it(`${page} reads its caller's profile and permissions from the guard's answer, not from requests of its own`, () => {
      const code = src(page)
      assert.match(code, /callerProfile\(qc, session\.user\.id\)/)
      assert.match(code, /callerModulePermissions\(qc, supabase, session\.user\.id, 'orders'\)/)
      assert.equal(/getEffectivePermissions\(/.test(code), false, 'no resolve_effective_permissions request of its own')
      assert.equal(/USER_PROFILE_COLUMNS/.test(code), false, 'no 20-column users read of its own')
    })
  }
})
