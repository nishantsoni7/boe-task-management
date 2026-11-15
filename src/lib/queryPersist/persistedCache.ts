// A SAVED COPY OF SELECTED SCREENS, SO A REVISIT PAINTS AT ONCE (2026-11-15, page speed, persisted cache phase A).
//
// The shared query cache dies with the tab, so every visit started empty and waited for the database. This keeps
// a copy of a SHORT, NAMED list of query results on the device and puts it back at the next visit, where it is
// shown immediately and then refreshed in the background (a restored entry is old, so every screen that uses it
// asks again at once). Owner decisions (15 Nov): the launcher and own profile, task lists, Orders and PI lists, Sales
// leads and quotations MAY be kept (phase A: the launcher, the profile and task lists); Finance, Payroll,
// Attendance and salary data NEVER.
//
// THE RULES THIS FILE ENFORCES
//  - ONE PERSON'S COPY AT A TIME. The saved copy names its owner; it is restored only for that person, and is
//    wiped on sign-out, when somebody else signs in, when it is older than 12 hours, or when it cannot be read.
//  - AN ALLOWLIST, NOT A BLOCKLIST. Only the query families named in ALLOWED_FAMILIES are ever saved, and only when
//    the key carries the owner's id. A family added later is NOT saved until somebody adds it here on purpose.
//    FORBIDDEN_WORDS is a second wall: a key that mentions money, pay, attendance or punches is refused even if a
//    careless edit put its family on the list.
//  - DISPLAY ONLY. A restored result is old on purpose (its timestamp is when it was fetched), so nothing that
//    decides access may trust it: usePermissionContext reports `ready` only for an answer fetched in THIS page
//    session and keeps `displayReady` for painting.
//  - NEVER A FAILURE. Every storage call is guarded; a full disk, a private window or a corrupt value just means no
//    saved copy. A kill switch (localStorage 'boe-qcache-off' = '1') turns the whole thing off without a deploy.

import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from '@tanstack/react-query'

export const PERSIST_VERSION = 1
export const PERSIST_KEY = `boe-qcache:v${PERSIST_VERSION}`
export const PERSIST_KILL_SWITCH_KEY = 'boe-qcache-off'
export const PERSIST_MAX_AGE_MS = 12 * 60 * 60 * 1000
export const PERSIST_MAX_BYTES = 1_500_000
export const PERSIST_THROTTLE_MS = 2_000

/**
 * The first element of a query key, for each family that may be saved. Phase A: the launcher and the profile
 * (permission-context holds the person's own modules and role; profile their name and team; app-modules-visibility
 * and module-order the card list), and the person's own task lists.
 */
export const ALLOWED_FAMILIES: ReadonlySet<string> = new Set([
  'permission-context',
  'profile',
  'app-modules-visibility',
  'module-order',
  'task-order',
  'top-tasks',
  'tasks',
])

/** A second wall: a key that mentions any of these is never saved, whatever family it claims to be. */
export const FORBIDDEN_WORDS = /finance|payroll|attendance|salary|payment|credit|punch|bank|expense|reimburs|payslip|wage/i

/** The tasks family also holds completed-task archives with filters; phase A saves only the person's open list. */
const isOwnOpenTaskList = (key: readonly unknown[]) => key[0] !== 'tasks' || (key[1] === 'assigned-to' && key.length === 3)

export function isPersistableKey(key: readonly unknown[], userId: string): boolean {
  if (typeof key[0] !== 'string' || !ALLOWED_FAMILIES.has(key[0])) return false
  if (!key.includes(userId)) return false
  if (!isOwnOpenTaskList(key)) return false
  let text: string
  try { text = JSON.stringify(key) } catch { return false }
  return !FORBIDDEN_WORDS.test(text)
}

// ── Storage, guarded ─────────────────────────────────────────────────────────

export type PersistStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function deviceStorage(): PersistStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

export function persistEnabled(storage: PersistStorage | null): storage is PersistStorage {
  if (!storage) return false
  try { return storage.getItem(PERSIST_KILL_SWITCH_KEY) !== '1' } catch { return false }
}

// A Map (the permission context holds one) is not JSON; it travels as a tagged list and comes back a Map.
const MAP_TAG = '$map'
const replacer = (_k: string, v: unknown) => (v instanceof Map ? { [MAP_TAG]: [...v.entries()] } : v)
const reviver = (_k: string, v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && MAP_TAG in (v as object) && Object.keys(v as object).length === 1) {
    return new Map((v as Record<string, [unknown, unknown][]>)[MAP_TAG])
  }
  return v
}

type Saved = { v: number; owner: string; savedAt: number; state: DehydratedState }

export function wipePersistedCache(storage: PersistStorage | null): void {
  if (!storage) return
  try { storage.removeItem(PERSIST_KEY) } catch { /* nothing to do */ }
}

/** Write the allowlisted, successful, recent results of `qc` for `userId`. Returns the bytes saved (0 = nothing). */
export function savePersistedCache(
  qc: QueryClient,
  userId: string,
  storage: PersistStorage | null,
  now: number = Date.now(),
): number {
  if (!persistEnabled(storage)) return 0
  try {
    const keep = (q: Query) =>
      q.state.status === 'success'
      && q.state.data !== undefined
      && now - q.state.dataUpdatedAt <= PERSIST_MAX_AGE_MS
      && isPersistableKey(q.queryKey, userId)
    const state = dehydrate(qc, { shouldDehydrateQuery: keep })
    if (state.queries.length === 0) { wipePersistedCache(storage); return 0 }

    // Over the size cap: drop the biggest results first until it fits.
    const sized = state.queries.map(query => ({ query, size: JSON.stringify(query, replacer).length }))
    sized.sort((a, b) => a.size - b.size)
    let total = sized.reduce((n, s) => n + s.size, 0)
    while (total > PERSIST_MAX_BYTES && sized.length > 0) total -= (sized.pop() as { size: number }).size
    if (sized.length === 0) { wipePersistedCache(storage); return 0 }

    const text = JSON.stringify({ v: PERSIST_VERSION, owner: userId, savedAt: now, state: { ...state, queries: sized.map(s => s.query) } } satisfies Saved, replacer)
    storage.setItem(PERSIST_KEY, text)
    return text.length
  } catch {
    wipePersistedCache(storage) // a full disk or a value that would not serialise: no saved copy, never an error
    return 0
  }
}

/**
 * Put the saved copy back into `qc` if, and only if, it belongs to `userId`, is under 12 hours old and reads cleanly.
 * Anything else is wiped. Returns how many results were restored.
 */
export function restorePersistedCache(
  qc: QueryClient,
  userId: string,
  storage: PersistStorage | null,
  now: number = Date.now(),
): number {
  if (!persistEnabled(storage)) return 0
  let raw: string | null
  try { raw = storage.getItem(PERSIST_KEY) } catch { return 0 }
  if (!raw) return 0
  try {
    const saved = JSON.parse(raw, reviver) as Saved
    const ok = saved && saved.v === PERSIST_VERSION && saved.owner === userId
      && typeof saved.savedAt === 'number' && now - saved.savedAt <= PERSIST_MAX_AGE_MS
      && saved.state && Array.isArray(saved.state.queries)
    if (!ok) { wipePersistedCache(storage); return 0 }
    // Re-checked on the way IN as well as on the way out: a copy written by an older build, or edited by hand,
    // still cannot bring back a family that is not on the list today.
    const queries = saved.state.queries.filter(q =>
      isPersistableKey(q.queryKey, userId) && now - (q.state.dataUpdatedAt ?? 0) <= PERSIST_MAX_AGE_MS && q.state.data !== undefined)
    hydrate(qc, { ...saved.state, queries })
    return queries.length
  } catch {
    wipePersistedCache(storage)
    return 0
  }
}

// ── Keeping it current ───────────────────────────────────────────────────────

export type Persister = {
  /** Start for this person: restore their saved copy (if `restore`) and begin saving changes. Idempotent per person. */
  attach: (userId: string, options?: { restore?: boolean }) => void
  /** Stop saving (sign-out, another person). Does not wipe. */
  detach: () => void
  /** Remove the saved copy from the device. */
  wipe: () => void
}

export function createPersister(
  qc: QueryClient,
  storage: PersistStorage | null = deviceStorage(),
  clock: { now: () => number; schedule: (run: () => void, ms: number) => unknown; cancel: (handle: unknown) => void } = {
    now: () => Date.now(),
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Persister {
  let owner: string | null = null
  let stop: (() => void) | null = null

  const detach = () => { stop?.(); stop = null; owner = null }

  return {
    attach(userId, options = {}) {
      if (owner === userId) return
      detach()
      if (!persistEnabled(storage)) return
      if (options.restore !== false) restorePersistedCache(qc, userId, storage, clock.now())
      owner = userId

      let timer: unknown = null
      const flush = () => { timer = null; savePersistedCache(qc, userId, storage, clock.now()) }
      const unsubscribe = qc.getQueryCache().subscribe(event => {
        if (event.type !== 'updated' && event.type !== 'added' && event.type !== 'removed') return
        // Wake only for a result that could be saved: polling and refreshes of everything else must not cost a save.
        if (!isPersistableKey(event.query.queryKey, userId)) return
        if (timer === null) timer = clock.schedule(flush, PERSIST_THROTTLE_MS)
      })
      const onHide = () => { if (document.visibilityState === 'hidden') flush() }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide)
      stop = () => {
        unsubscribe()
        if (timer !== null) clock.cancel(timer)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide)
      }
    },
    detach,
    wipe: () => wipePersistedCache(storage),
  }
}
