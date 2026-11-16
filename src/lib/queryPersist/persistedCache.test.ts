// THE SAVED COPY OF SELECTED SCREENS (2026-11-15, persisted cache phase A): what may be saved, for whom, for how long,
// and that it can never decide access. Run with: npx tsx --test src/lib/queryPersist/persistedCache.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import {
  ALLOWED_FAMILIES, PERSIST_KEY, PERSIST_KILL_SWITCH_KEY, PERSIST_MAX_AGE_MS, PERSIST_MAX_BYTES, PERSIST_THROTTLE_MS,
  createPersister, isPersistableKey, restorePersistedCache, savePersistedCache, wipePersistedCache, type PersistStorage,
} from './persistedCache'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-11-15T10:00:00Z')

function memoryStorage(initial: Record<string, string> = {}): PersistStorage & { data: Map<string, string>; throwOnSet: boolean } {
  const data = new Map(Object.entries(initial))
  const s = {
    data, throwOnSet: false,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { if (s.throwOnSet) throw new Error('QuotaExceededError'); data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  }
  return s
}

const client = () => new QueryClient()
const put = (qc: QueryClient, key: unknown[], data: unknown, at = NOW) => qc.setQueryData(key, data, { updatedAt: at })

describe('what may be saved', () => {
  test('the phase A families, and only with the owner\'s id in the key', () => {
    for (const key of [
      ['permission-context', ME], ['profile', ME], ['app-modules-visibility', ME], ['module-order', ME],
      ['task-order', ME], ['top-tasks', ME], ['tasks', 'assigned-to', ME],
    ]) assert.equal(isPersistableKey(key, ME), true, JSON.stringify(key))
    for (const key of [['permission-context', OTHER], ['profile', null], ['tasks', 'assigned-to', OTHER]]) {
      assert.equal(isPersistableKey(key, ME), false, JSON.stringify(key))
    }
  })

  test('nothing outside the list, and never Finance, Payroll, Attendance or salary, even under an allowed name', () => {
    for (const key of [
      ['payroll-participation', ME], ['finance-handovers', ME], ['punch-strip', ME], ['notifications', 'count', ME],
      ['day-close-prompt', ME], ['own-row-extras', ME], ['view-as-subject', ME], ['signed-in-user-id'],
      ['tasks', 'completed', 'mine', ME, 'x', 'y', 'z', 'q', '', 1],
      ['profile', ME, 'salary'], ['tasks', 'assigned-to', ME, 'payment'], ['module-order', ME, 'attendance-requests'],
      ['permission-context', ME, 'bank'], ['top-tasks', ME, 'credit'], ['profile', ME, 'expenses'],
    ]) assert.equal(isPersistableKey(key, ME), false, JSON.stringify(key))
  })

  test('the list is exactly the phase A families (a new family must be added here on purpose)', () => {
    assert.deepEqual([...ALLOWED_FAMILIES].sort(), ['app-modules-visibility', 'module-order', 'permission-context', 'profile', 'task-order', 'tasks', 'top-tasks'])
  })
})

describe('phase B: Sales leads and quotations', () => {
  test('the lead list (no search), people, board, My Day and the quotations list are saved', () => {
    for (const key of [
      ['sales-leads', 'list', 'today', '', '', 'all', 'all', ''], ['sales-leads', 'people'], ['sales-leads', 'board', 'f'],
      ['sales-leads', 'board', 'column', 'new', 'f'], ['sales-leads', 'my-day'], ['quotations', 'list', 'mine'], ['quotations', 'list', 'all'],
    ]) assert.equal(isPersistableKey(key, ME), true, JSON.stringify(key))
  })

  test('never: a searched list, held WhatsApp chats, one lead, a phone check, team figures, the quotation access answer or one quotation', () => {
    for (const key of [
      ['sales-leads', 'list', 'all', '', '', 'all', 'all', '98765'], ['sales-leads', 'held'], ['sales-leads', 'detail', 'x'],
      ['sales-leads', 'phone', '98765'], ['sales-leads', 'team', '', '', ''], ['sales-leads', 'premium-misplaced'], ['sales-leads', 'auto-allot'],
      ['quotations', 'access'], ['quotations', 'one', 'q1'], ['quotations'], ['sales-leads'],
    ]) assert.equal(isPersistableKey(key, ME), false, JSON.stringify(key))
  })

  test('the lead key family in the source is still the one listed here', () => {
    const api = readFileSync(join(process.cwd(), 'src/lib/salesLeads/api.ts'), 'utf8')
    assert.match(api, /export const SALES_KEY = 'sales-leads'/)
    const list = readFileSync(join(process.cwd(), 'src/lib/quotations/api.ts'), 'utf8')
    assert.ok(list.includes("['quotations', 'list', scope]"))
  })

  test('a saved lead list comes back only for its owner', () => {
    const qc = client(), storage = memoryStorage()
    put(qc, ['sales-leads', 'list', 'today', '', '', 'all', 'all', ''], { pages: [{ rows: [{ id: 'a' }], total: 1 }], pageParams: [0] })
    assert.ok(savePersistedCache(qc, ME, storage, NOW) > 0)
    const other = client()
    assert.equal(restorePersistedCache(other, OTHER, storage, NOW), 0)
    assert.equal(storage.data.has(PERSIST_KEY), false)
    put(qc, ['sales-leads', 'list', 'today', '', '', 'all', 'all', ''], { pages: [{ rows: [{ id: 'a' }], total: 1 }], pageParams: [0] })
    savePersistedCache(qc, ME, storage, NOW)
    const mine = client()
    assert.equal(restorePersistedCache(mine, ME, storage, NOW), 1)
  })
})

describe('phase C: the PI Drafts list, and keeping what is saved', () => {
  test('the PI Drafts list is saved; nothing else under orders is', () => {
    assert.equal(isPersistableKey(['orders', 'pi-drafts-list'], ME), true)
    for (const key of [['orders'], ['orders', 'all'], ['orders', 'pi-drafts-list', 'x'], ['orders', 'dashboard']]) {
      assert.equal(isPersistableKey(key, ME), false, JSON.stringify(key))
    }
  })

  test('a result saved earlier survives the in-memory cache forgetting it, and a newer one replaces it', () => {
    const qc = client(), storage = memoryStorage()
    put(qc, ['quotations', 'list', 'mine'], [{ id: 1 }])
    put(qc, ['orders', 'pi-drafts-list'], [{ id: 'a' }])
    savePersistedCache(qc, ME, storage, NOW)
    const later = client() // a new page session: the first list is gone from memory, a newer second one arrives
    put(later, ['orders', 'pi-drafts-list'], [{ id: 'b' }], NOW + 1000)
    savePersistedCache(later, ME, storage, NOW + 2000)
    const back = client()
    assert.equal(restorePersistedCache(back, ME, storage, NOW + 3000), 2)
    assert.deepEqual(back.getQueryData(['quotations', 'list', 'mine']), [{ id: 1 }])
    assert.deepEqual(back.getQueryData(['orders', 'pi-drafts-list']), [{ id: 'b' }])
  })

  test('an earlier copy is not kept past 12 hours, nor for somebody else', () => {
    const qc = client(), storage = memoryStorage()
    put(qc, ['quotations', 'list', 'mine'], [{ id: 1 }])
    savePersistedCache(qc, ME, storage, NOW)
    const later = client()
    put(later, ['sales-leads', 'people'], [{ id: 'p' }], NOW + PERSIST_MAX_AGE_MS + 1000)
    savePersistedCache(later, ME, storage, NOW + PERSIST_MAX_AGE_MS + 2000)
    const back = client()
    restorePersistedCache(back, ME, storage, NOW + PERSIST_MAX_AGE_MS + 3000)
    assert.equal(back.getQueryData(['quotations', 'list', 'mine']), undefined)
    assert.deepEqual(back.getQueryData(['sales-leads', 'people']), [{ id: 'p' }])
  })

  test('the PI Drafts page keeps its key and sets the capabilities as soon as they are known', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/drafts/page.tsx'), 'utf8')
    assert.ok(page.includes("const PI_DRAFTS_KEY = ['orders', 'pi-drafts-list'] as const"))
    assert.ok(page.includes('const identity = Promise.all(['))
    assert.ok(page.includes('const [, drafts] = await Promise.all(['))
  })
})

describe('the saved copy is put back whichever auth event arrives first', () => {
  test('the first-event branch of Providers restores (it used to attach with restore: false and so never restored)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/layout/Providers.tsx'), 'utf8').split(String.fromCharCode(13)).join('')
    const first = src.slice(src.indexOf('if (lastUserId.current === undefined) {' + String.fromCharCode(10) + '        lastUserId.current = nextUserId'))
    const branch = first.slice(0, first.indexOf('return'))
    assert.ok(branch.includes('persister.attach(nextUserId)'))
    assert.ok(!branch.includes('restore: false'))
  })

  test('attach() restores once and a second attach for the same person is a no-op', () => {
    const qc = client(), storage = memoryStorage()
    put(qc, ['permission-context', ME], { role: 'admin' })
    savePersistedCache(qc, ME, storage, NOW)
    const fresh = client()
    const p = createPersister(fresh, storage, { now: () => NOW, schedule: () => 0, cancel: () => {} })
    p.attach(ME)
    assert.deepEqual(fresh.getQueryData(['permission-context', ME]), { role: 'admin' })
    fresh.removeQueries()
    p.attach(ME)
    assert.equal(fresh.getQueryData(['permission-context', ME]), undefined)
    p.detach()
  })
})

describe('saving and restoring', () => {
  test('a saved result comes back, a Map included, with its original timestamp (so it is stale and is refetched)', () => {
    const storage = memoryStorage()
    const a = client()
    const ctx = { profile: { id: ME, role: 'admin' }, permissionsByModule: new Map([['orders', [{ actionKey: 'view', allowed: true, source: 'role' }]]]) }
    put(a, ['permission-context', ME], ctx, NOW - 60_000)
    put(a, ['tasks', 'assigned-to', ME], [{ id: 't1', title: 'Call client' }], NOW - 30_000)
    assert.ok(savePersistedCache(a, ME, storage, NOW) > 0)

    const b = client()
    assert.equal(restorePersistedCache(b, ME, storage, NOW + 1000), 2)
    const restored = b.getQueryData(['permission-context', ME]) as typeof ctx
    assert.ok(restored.permissionsByModule instanceof Map)
    assert.deepEqual([...restored.permissionsByModule.keys()], ['orders'])
    assert.equal(b.getQueryState(['permission-context', ME])?.dataUpdatedAt, NOW - 60_000)
    assert.deepEqual(b.getQueryData(['tasks', 'assigned-to', ME]), [{ id: 't1', title: 'Call client' }])
  })

  test('only allowlisted successful results are written; the rest of the cache never reaches the device', () => {
    const storage = memoryStorage()
    const a = client()
    put(a, ['profile', ME], { id: ME })
    put(a, ['punch-strip', ME], { state: 'in' })
    put(a, ['finance-handovers', ME], [{ amount: 5000 }])
    put(a, ['profile', OTHER], { id: OTHER })
    savePersistedCache(a, ME, storage, NOW)
    const text = storage.getItem(PERSIST_KEY) as string
    assert.ok(text.includes('"profile"'))
    for (const leaked of ['punch', 'finance', '5000', OTHER]) assert.equal(text.includes(leaked), false, leaked)
  })

  test('a failed or pending result is not written', () => {
    const storage = memoryStorage()
    const a = client()
    void a.fetchQuery({ queryKey: ['profile', ME], queryFn: () => Promise.reject(new Error('x')), retry: false }).catch(() => {})
    savePersistedCache(a, ME, storage, NOW)
    assert.equal(storage.getItem(PERSIST_KEY), null)
  })

  test('older than 12 hours: not written, and a copy that ages past 12 hours is wiped, not restored', () => {
    const storage = memoryStorage()
    const a = client()
    put(a, ['profile', ME], { id: ME }, NOW - PERSIST_MAX_AGE_MS - 1)
    assert.equal(savePersistedCache(a, ME, storage, NOW), 0)

    put(a, ['profile', ME], { id: ME }, NOW)
    savePersistedCache(a, ME, storage, NOW)
    const b = client()
    assert.equal(restorePersistedCache(b, ME, storage, NOW + PERSIST_MAX_AGE_MS + 1), 0)
    assert.equal(storage.getItem(PERSIST_KEY), null, 'the old copy is gone from the device')
  })

  test('a copy that belongs to somebody else is wiped and nothing of it is restored', () => {
    const storage = memoryStorage()
    const a = client()
    put(a, ['profile', OTHER], { id: OTHER, full_name: 'Other Person' })
    savePersistedCache(a, OTHER, storage, NOW)
    const b = client()
    assert.equal(restorePersistedCache(b, ME, storage, NOW), 0)
    assert.equal(b.getQueryData(['profile', OTHER]), undefined)
    assert.equal(storage.getItem(PERSIST_KEY), null)
  })

  test('a corrupt or tampered copy is wiped; a hand-added forbidden family is refused on the way in', () => {
    const corrupt = memoryStorage({ [PERSIST_KEY]: '{not json' })
    assert.equal(restorePersistedCache(client(), ME, corrupt, NOW), 0)
    assert.equal(corrupt.getItem(PERSIST_KEY), null)

    const a = client()
    put(a, ['profile', ME], { id: ME })
    const good = memoryStorage()
    savePersistedCache(a, ME, good, NOW)
    const saved = JSON.parse(good.getItem(PERSIST_KEY) as string)
    saved.state.queries.push({ queryKey: ['payroll-participation', ME], queryHash: '["payroll-participation"]', state: { data: { payroll_active: true }, dataUpdatedAt: NOW, status: 'success', dataUpdateCount: 1, errorUpdateCount: 0, fetchFailureCount: 0, fetchFailureReason: null, errorUpdatedAt: 0, fetchMeta: null, isInvalidated: false, error: null, fetchStatus: 'idle' } })
    const tampered = memoryStorage({ [PERSIST_KEY]: JSON.stringify(saved) })
    const b = client()
    assert.equal(restorePersistedCache(b, ME, tampered, NOW), 1)
    assert.equal(b.getQueryData(['payroll-participation', ME]), undefined)
  })

  test('a full disk or an oversize copy never throws; the biggest results are dropped to fit', () => {
    const storage = memoryStorage()
    const a = client()
    put(a, ['profile', ME], { id: ME })
    put(a, ['tasks', 'assigned-to', ME], Array.from({ length: 3000 }, (_, i) => ({ id: i, title: 'x'.repeat(600) })))
    assert.ok(savePersistedCache(a, ME, storage, NOW) > 0)
    const text = storage.getItem(PERSIST_KEY) as string
    assert.ok(text.length <= PERSIST_MAX_BYTES + 2000)
    assert.ok(text.includes('"profile"') && !text.includes('xxxxxxxxxx'), 'the small result stays, the huge one is dropped')

    const full = memoryStorage()
    full.throwOnSet = true
    assert.doesNotThrow(() => savePersistedCache(a, ME, full, NOW))
  })

  test('the kill switch turns saving and restoring off', () => {
    const storage = memoryStorage({ [PERSIST_KILL_SWITCH_KEY]: '1' })
    const a = client()
    put(a, ['profile', ME], { id: ME })
    assert.equal(savePersistedCache(a, ME, storage, NOW), 0)
    assert.equal(restorePersistedCache(client(), ME, storage, NOW), 0)
  })

  test('no storage at all (private window, server) is not an error', () => {
    assert.equal(savePersistedCache(client(), ME, null, NOW), 0)
    assert.equal(restorePersistedCache(client(), ME, null, NOW), 0)
    assert.doesNotThrow(() => wipePersistedCache(null))
  })
})

describe('keeping it current', () => {
  const clockRig = () => {
    const timers: Array<{ run: () => void; ms: number }> = []
    return {
      timers,
      clock: { now: () => NOW, schedule: (run: () => void, ms: number) => { const t = { run, ms }; timers.push(t); return t }, cancel: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1) } },
    }
  }

  test('attach restores this person\'s copy, then saves a change after the throttle, once for many changes', () => {
    const storage = memoryStorage()
    const seed = client()
    put(seed, ['profile', ME], { id: ME, full_name: 'Restored' })
    savePersistedCache(seed, ME, storage, NOW)

    const qc = client()
    const { clock, timers } = clockRig()
    const p = createPersister(qc, storage, clock)
    p.attach(ME)
    assert.deepEqual(qc.getQueryData(['profile', ME]), { id: ME, full_name: 'Restored' })

    qc.setQueryData(['tasks', 'assigned-to', ME], [{ id: 't1' }])
    qc.setQueryData(['tasks', 'assigned-to', ME], [{ id: 't1' }, { id: 't2' }])
    assert.equal(timers.length, 1, 'one scheduled save for two changes')
    assert.equal(timers[0].ms, PERSIST_THROTTLE_MS)
    timers[0].run()
    assert.ok((storage.getItem(PERSIST_KEY) as string).includes('t2'))
  })

  test('a change to something that may not be saved does not even schedule a save', () => {
    const qc = client()
    const { clock, timers } = clockRig()
    createPersister(qc, memoryStorage(), clock).attach(ME)
    qc.setQueryData(['punch-strip', ME], { state: 'in' })
    qc.setQueryData(['finance-handovers', ME], [1])
    assert.equal(timers.length, 0)
  })

  test('another person: detach and wipe remove the copy, and attaching them restores nothing of the first', () => {
    const storage = memoryStorage()
    const first = client()
    put(first, ['profile', ME], { id: ME })
    savePersistedCache(first, ME, storage, NOW)

    const qc = client()
    const { clock } = clockRig()
    const p = createPersister(qc, storage, clock)
    p.attach(ME)
    p.detach(); p.wipe()
    assert.equal(storage.getItem(PERSIST_KEY), null)
    p.attach(OTHER, { restore: false })
    assert.equal(qc.getQueryData(['profile', OTHER]), undefined)
  })
})

describe('it is display only, and wired where identity is decided', () => {
  const root = join(__dirname, '..', '..', '..')
  const src = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

  test('ready (every guard) refuses a saved copy; displayReady (painting) accepts it', () => {
    const ctx = src('src/hooks/queries/usePermissionContext.ts')
    assert.match(ctx, /const PAGE_STARTED_AT = Date\.now\(\)/)
    assert.match(ctx, /const savedOnly = data !== undefined && dataUpdatedAt < PAGE_STARTED_AT/)
    assert.match(ctx, /ready: !idPending && !contextPending && !savedOnly/)
    assert.match(ctx, /displayReady: !idPending && data !== undefined/)
  })

  test('the launcher paints from displayReady but redirects and fetches on ready', () => {
    const page = src('src/app/modules/page.tsx')
    assert.match(page, /const loading = !permsDisplayReady \|\| modVisPending \|\| orderLoading/)
    assert.match(page, /if \(permsReady && userId === null\) router\.push\('\/login'\)/)
    assert.match(page, /const mayOpenTask\s+= permsReady && /)
  })

  test('the identity boundary restores for the signed-in person, and wipes on sign-out and on a different person', () => {
    const p = src('src/components/layout/Providers.tsx')
    assert.match(p, /const persister = createPersister\(queryClient\)/)
    assert.match(p, /if \(signedInId\) persister\.attach\(signedInId\)\s*else persister\.wipe\(\)/)
    assert.equal((p.match(/persister\.wipe\(\)/g) ?? []).length, 3, 'no session, sign-out, and a different person')
  })

  test('while previewing somebody else nothing is painted from a saved copy', () => {
    const d = src('src/hooks/queries/useDisplaySubject.ts')
    assert.match(d, /displayReady: subjectReady/)
  })
})
