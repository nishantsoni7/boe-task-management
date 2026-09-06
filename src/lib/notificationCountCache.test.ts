/**
 * The persisted unread-count cache: what it shows, what it refuses, and who it
 * shows it to.
 *
 * The defect: on /modules the Task Management badge was blank for 3-4 seconds
 * and a hard refresh repeated the wait, because the count lived in component
 * state behind a bare fetch and died with the page. Persisting the last good
 * value closes the visible gap; every rule below is about doing that WITHOUT
 * ever showing the wrong person a number, and without letting a cached value
 * suppress the real request.
 *
 * Run:
 *   npx tsx --test src/lib/notificationCountCache.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NOTIFICATION_COUNT_CACHE_VERSION,
  NOTIFICATION_COUNT_MAX_AGE_MS,
  notificationCountStorageKey,
  readPersistedUnreadCount,
  writePersistedUnreadCount,
  clearPersistedUnreadCounts,
  type CountStorage,
} from './notificationCountCache'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const HOOK = read('src/hooks/queries/useUnreadNotifications.ts')
const MODULES = read('src/app/modules/page.tsx')

const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const NOW = Date.parse('2026-08-26T10:00:00.000Z')

/** An in-memory Storage, so the rules are exercised without a browser. */
function memoryStorage(seed: Record<string, string> = {}): CountStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    get length() { return map.size },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
}

/** Storage that throws on everything — private mode, blocked site data. */
const hostileStorage: CountStorage = {
  get length(): number { throw new Error('blocked') },
  key() { throw new Error('blocked') },
  getItem() { throw new Error('blocked') },
  setItem() { throw new Error('blocked') },
  removeItem() { throw new Error('blocked') },
}

// ── 1-2. It shows immediately, and survives a refresh ───────────────────────

describe('a known count is available on the first render', () => {
  test('1. a written count reads straight back', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 7, { storage, now: NOW })
    assert.deepEqual(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }),
      { count: 7, at: NOW })
  })

  test('2. a hard refresh — new storage handle over the same bytes — restores it', () => {
    const first = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 12, { storage: first, now: NOW })
    // A reload keeps localStorage but drops every in-memory cache; a fresh
    // handle over the same underlying bytes is exactly that.
    const afterReload = memoryStorage(Object.fromEntries(first.map))
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage: afterReload, now: NOW })?.count, 12)
  })

  test('the seed is handed to the query with ITS OWN timestamp, so it revalidates at once', () => {
    // initialData alone would mark the query fresh and SUPPRESS the request —
    // the opposite of what this is for. initialDataUpdatedAt makes TanStack
    // compare the seed's age against staleTime and refetch immediately.
    assert.ok(HOOK.includes('initialData: { unreadCount: seed.count }, initialDataUpdatedAt: seed.at'))
    assert.ok(HOOK.includes('staleTime: 30 * 1000'))
  })
})

// ── 3-4. Background revalidation ────────────────────────────────────────────

describe('revalidation replaces, failure retains', () => {
  test('3. a fresh value overwrites the stale one', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 4, { storage, now: NOW - 60_000 })
    writePersistedUnreadCount(USER_A, 'task', 9, { storage, now: NOW })
    assert.deepEqual(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }),
      { count: 9, at: NOW })
  })

  test('4. a failed request leaves the displayed value alone', () => {
    // The query function THROWS on a non-2xx rather than returning 0, and
    // TanStack keeps the last good `data` through an error.
    assert.ok(HOOK.includes('if (!res.ok) throw new Error('))
    assert.ok(HOOK.includes('keeps the badge at its last known value'))
  })

  test('10. a refetch never clears the visible count', () => {
    // Nothing writes `undefined` into the cache entry, and the persisted value
    // is only ever overwritten by a real number.
    assert.equal(/setQueryData[^\n]*undefined/.test(HOOK), false)
    assert.ok(HOOK.includes('if (!userId || data === undefined) return'),
      'persistence is skipped while unknown, never written as a blank')
  })
})

// ── 5-7. Zero, missing, malformed ───────────────────────────────────────────

describe('zero, missing and malformed are three different answers', () => {
  test('5. a cached ZERO is a real answer and round-trips', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 0, { storage, now: NOW })
    assert.deepEqual(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }),
      { count: 0, at: NOW })
    // The card prints "No notifications" for a resolved zero, and a placeholder
    // only while the value is undefined.
    assert.ok(MODULES.includes('count === undefined ? ('))
    assert.ok(MODULES.includes("aria-label=\"Loading notification count\""))
    assert.ok(MODULES.includes("? 'No notifications'"))
  })

  test('6. no cache reads as null, so the caller shows the placeholder', () => {
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage: memoryStorage(), now: NOW }), null)
    assert.equal(readPersistedUnreadCount(null, 'task', { storage: memoryStorage(), now: NOW }), null)
    assert.equal(readPersistedUnreadCount(undefined, 'task', { storage: null }), null)
  })

  test('7. malformed storage is ignored, never thrown and never displayed', () => {
    const key = notificationCountStorageKey(USER_A, 'task')
    const junk = [
      'not json at all',
      '{',
      'null',
      '[]',
      '"12"',
      JSON.stringify({ c: 5, at: NOW }),                                   // no version
      JSON.stringify({ v: 999, c: 5, at: NOW }),                            // wrong version
      JSON.stringify({ v: NOTIFICATION_COUNT_CACHE_VERSION, c: -1, at: NOW }),
      JSON.stringify({ v: NOTIFICATION_COUNT_CACHE_VERSION, c: 'five', at: NOW }),
      JSON.stringify({ v: NOTIFICATION_COUNT_CACHE_VERSION, c: NaN, at: NOW }),
      JSON.stringify({ v: NOTIFICATION_COUNT_CACHE_VERSION, c: 5 }),        // no timestamp
      JSON.stringify({ v: NOTIFICATION_COUNT_CACHE_VERSION, c: 5, at: 0 }),
      JSON.stringify({ v: NOTIFICATION_COUNT_CACHE_VERSION, c: 5, at: 'yesterday' }),
    ]
    for (const raw of junk) {
      const storage = memoryStorage({ [key]: raw })
      assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }), null,
        `should have been ignored: ${raw}`)
    }
  })

  test('an entry past its maximum age is ignored', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 3,
      { storage, now: NOW - NOTIFICATION_COUNT_MAX_AGE_MS - 1 })
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }), null)
  })

  test('a timestamp from the future — a clock that moved back — is ignored', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 3, { storage, now: NOW + 10 * 60_000 })
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }), null)
  })

  test('storage that throws is survivable in every direction', () => {
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage: hostileStorage, now: NOW }), null)
    assert.doesNotThrow(() =>
      writePersistedUnreadCount(USER_A, 'task', 5, { storage: hostileStorage, now: NOW }))
    assert.doesNotThrow(() => clearPersistedUnreadCounts({ storage: hostileStorage }))
  })

  test('only a count, a version and a timestamp are ever written', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 5, { storage, now: NOW })
    const stored = JSON.parse([...storage.map.values()][0])
    assert.deepEqual(Object.keys(stored).sort(), ['at', 'c', 'v'])
    // No title, body, task id or name can reach this file: the function takes a
    // number.
    assert.equal(typeof stored.c, 'number')
  })
})

// ── 8-9. Isolation ──────────────────────────────────────────────────────────

describe('one employee can never see another’s count', () => {
  test('8. the key carries the user id AND the category', () => {
    const key = notificationCountStorageKey(USER_A, 'task')
    assert.ok(key.includes(USER_A))
    assert.ok(key.endsWith('.task'))
    assert.notEqual(key, notificationCountStorageKey(USER_B, 'task'))
    assert.notEqual(key, notificationCountStorageKey(USER_A, 'finance'))
    assert.ok(key.includes(`v${NOTIFICATION_COUNT_CACHE_VERSION}`))
  })

  test('8. categories do not bleed into each other', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 4, { storage, now: NOW })
    writePersistedUnreadCount(USER_A, 'finance', 11, { storage, now: NOW })
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW })?.count, 4)
    assert.equal(readPersistedUnreadCount(USER_A, 'finance', { storage, now: NOW })?.count, 11)
    assert.equal(readPersistedUnreadCount(USER_A, 'order', { storage, now: NOW }), null)
  })

  test('9. switching user cannot display the previous user’s count', () => {
    const storage = memoryStorage()
    writePersistedUnreadCount(USER_A, 'task', 42, { storage, now: NOW })
    // B asks for B's key, which does not exist. A's number is unreachable.
    assert.equal(readPersistedUnreadCount(USER_B, 'task', { storage, now: NOW }), null)
  })

  test('9. and sign-out wipes them anyway, as defence in depth', () => {
    const storage = memoryStorage({ 'unrelated.key': 'keep me' })
    writePersistedUnreadCount(USER_A, 'task', 42, { storage, now: NOW })
    writePersistedUnreadCount(USER_B, 'finance', 7, { storage, now: NOW })
    clearPersistedUnreadCounts({ storage })
    assert.equal(readPersistedUnreadCount(USER_A, 'task', { storage, now: NOW }), null)
    assert.equal(readPersistedUnreadCount(USER_B, 'finance', { storage, now: NOW }), null)
    assert.equal(storage.getItem('unrelated.key'), 'keep me', 'other keys are untouched')
  })

  test('9. the auth listener calls it on sign-out AND on an identity change', () => {
    const providers = read('src/components/layout/Providers.tsx')
    assert.equal((providers.match(/clearPersistedUnreadCounts\(\)/g) ?? []).length, 2)
    const signOut = providers.indexOf("event === 'SIGNED_OUT'")
    assert.ok(providers.slice(signOut, signOut + 700).includes('clearPersistedUnreadCounts()'))
  })

  test('the query is not even enabled without a resolved user id', () => {
    assert.ok(HOOK.includes('enabled: enabled && !!userId'))
  })
})

// ── 11-14. Wiring ───────────────────────────────────────────────────────────

describe('one key, one request, mutations included', () => {
  test('11. a mutation’s optimistic write is persisted too', () => {
    // Persistence is driven by the cache VALUE, not by the fetch, so
    // patchUnreadCount / setUnreadCount — which write this same entry — are
    // carried to storage without every mutation knowing storage exists.
    assert.ok(HOOK.includes('}, [userId, category, data])'))
    assert.ok(HOOK.includes('writePersistedUnreadCount(userId, category, data.unreadCount)'))
    const cache = read('src/lib/notificationCache.ts')
    assert.ok(cache.includes('export function patchUnreadCount'))
    assert.ok(cache.includes('export function setUnreadCount'))
  })

  test('12. the launcher card and both navs read ONE query key', () => {
    // Still ONE key per category — now suffixed with the DISPLAY SUBJECT, so an
    // administrator previewing an employee reads that employee's count instead
    // of overwriting their own cached badge with it. Outside View As the suffix
    // is the signed-in user and all three surfaces still share one entry.
    assert.ok(HOOK.includes('queryKey: [...notificationKeys.count(category), userId ?? null]'))
    assert.ok(MODULES.includes("useUnreadCountState('task',    mayOpenTask)"))
    assert.ok(MODULES.includes("useUnreadCountState('finance', mayOpenFinance)"))
    assert.ok(MODULES.includes("useUnreadCountState('order',   mayOpenOrders)"))
    // The desktop sidebar entry and the mobile bottom nav read the same hook
    // family, so all three surfaces share one cache entry per category.
    assert.ok(read('src/components/layout/NotificationsNavItem.tsx')
      .includes("useUnreadNotifications } from '@/hooks/queries/useUnreadNotifications'"))
    assert.ok(read('src/components/layout/MobileBottomNav.tsx').includes('unreadNotifs'))
  })

  test('13. the launcher no longer runs its own duplicate fetch', () => {
    assert.equal(MODULES.includes("'/api/notifications?count=1&category=task'"), false)
    assert.equal(MODULES.includes("'/api/notifications?count=1&category=finance'"), false)
    assert.equal(MODULES.includes("'/api/notifications?count=1&category=order'"), false)
    // Exactly one raw count fetch remains: Sample Tracking, which has its own
    // table and endpoint and therefore no shared key to read.
    assert.equal((MODULES.match(/^\s*load\(/gm) ?? []).length, 1,
      'exactly one raw count fetch call remains')
    assert.ok(MODULES.includes("'/api/samples/notifications?count=1'"))
  })

  test('14. Finance is not regressed — same endpoint, same gate, same shape', () => {
    assert.ok(HOOK.includes('`/api/notifications?count=1&category=${category}`'))
    assert.ok(MODULES.includes("const mayOpenFinance = permsReady && canOpenModule('finance')"))
    // Authorization is unchanged: a module the employee cannot open still makes
    // no request, because `enabled` is the same gate the fetch was guarded by.
    assert.ok(MODULES.includes("useUnreadCountState('finance', mayOpenFinance)"))
  })
})
