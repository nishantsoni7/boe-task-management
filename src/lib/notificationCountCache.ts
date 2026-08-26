// Last-known unread counts, persisted so a badge is not blank on first paint.
//
// WHY. The unread count is ambient information the user has already seen. On a
// hard refresh the in-memory query cache is gone, so the badge had nothing to
// show until a round trip finished — a visible gap on a number that almost
// never changes between page loads. Persisting the last good value closes the
// gap; the request still goes out immediately and replaces it.
//
// WHAT IS STORED, AND NOTHING ELSE: a version, a count, and when it was taken.
// No title, no body, no task id, no name — a notification's CONTENT never
// reaches this file, and the shape below is the whole of what is written.
//
// ── ISOLATION ───────────────────────────────────────────────────────────────
//
// Every key carries the authenticated user id AND the category, so one
// employee's count cannot be read for another: a reader must present the id it
// wants, and a different id is simply a different key that does not exist.
// That is the primary guarantee — not the clearing below, which is defence in
// depth for a shared device (see clearPersistedUnreadCounts, called from the
// auth listener in Providers.tsx on sign-out and on an identity change).
//
// ── FAILURE IS ALWAYS "NO CACHE" ────────────────────────────────────────────
//
// Private mode, disabled site data, a quota error, a half-written value, a
// value another version wrote, something hand-edited: every one of them
// resolves to `null`, which is the same answer as "nothing stored". A cache
// that cannot be read is never an error the user sees, and — the rule that
// matters most — it can never prevent or delay the real request.

import type { NotificationCategory } from '@/lib/notifications'

/** Bumped when the stored shape changes. Older entries are ignored, not migrated. */
export const NOTIFICATION_COUNT_CACHE_VERSION = 1

const KEY_PREFIX = `boe.notif-count.v${NOTIFICATION_COUNT_CACHE_VERSION}.`

/**
 * How old a stored count may be and still be shown.
 *
 * Generous, because the point is to survive a refresh and it is revalidated
 * within milliseconds of being displayed. Bounded anyway: a number from a
 * fortnight ago is noise, and showing it briefly would be worse than showing
 * the placeholder.
 */
export const NOTIFICATION_COUNT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Exactly what is written. Three scalars. */
type PersistedCount = {
  /** Schema version. */
  v: number
  /** The unread count. */
  c: number
  /** When it was taken, epoch ms. */
  at: number
}

export type PersistedCountEntry = { count: number; at: number }

/** The minimal Storage surface, injectable so the rules are testable without a browser. */
export type CountStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

function defaultStorage(): CountStorage | null {
  try {
    // Accessing localStorage THROWS in some configurations rather than being
    // absent, so this is inside the try along with the read.
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

/** The key one user's one category is stored under. User id first, so it reads as an owner. */
export function notificationCountStorageKey(userId: string, category: NotificationCategory): string {
  return `${KEY_PREFIX}${userId}.${category}`
}

/** True for the exact shape this module writes, and nothing else. */
function isPersistedCount(value: unknown): value is PersistedCount {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.v === NOTIFICATION_COUNT_CACHE_VERSION
    && typeof v.c === 'number' && Number.isFinite(v.c) && v.c >= 0
    && typeof v.at === 'number' && Number.isFinite(v.at) && v.at > 0
}

/**
 * The last known count for this user and category, or null.
 *
 * Null for every failure mode there is: no storage, nothing stored, unparseable
 * JSON, a value of the wrong shape, a negative or non-finite count, an older
 * schema version, or an entry past NOTIFICATION_COUNT_MAX_AGE_MS. The caller
 * treats all of them as "show the placeholder and wait for the request".
 */
export function readPersistedUnreadCount(
  userId: string | null | undefined,
  category: NotificationCategory,
  opts: { storage?: CountStorage | null; now?: number } = {},
): PersistedCountEntry | null {
  if (!userId) return null
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  if (!storage) return null
  try {
    const raw = storage.getItem(notificationCountStorageKey(userId, category))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isPersistedCount(parsed)) return null
    const now = opts.now ?? Date.now()
    // A clock that moved backwards makes `at` look like the future. Treat that
    // as unusable rather than as infinitely fresh.
    if (parsed.at > now + 60_000) return null
    if (now - parsed.at > NOTIFICATION_COUNT_MAX_AGE_MS) return null
    return { count: parsed.c, at: parsed.at }
  } catch {
    return null
  }
}

/** Record a count. Silent on any failure — a badge is not worth an exception. */
export function writePersistedUnreadCount(
  userId: string | null | undefined,
  category: NotificationCategory,
  count: number,
  opts: { storage?: CountStorage | null; now?: number } = {},
): void {
  if (!userId) return
  if (!Number.isFinite(count) || count < 0) return
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  if (!storage) return
  const entry: PersistedCount = {
    v: NOTIFICATION_COUNT_CACHE_VERSION,
    c: Math.floor(count),
    at: opts.now ?? Date.now(),
  }
  try {
    storage.setItem(notificationCountStorageKey(userId, category), JSON.stringify(entry))
  } catch {
    // Quota, private mode, disabled site data. Nothing to do and nothing to say.
  }
}

/**
 * Drop every persisted count, for every user and category.
 *
 * Called on sign-out and on an identity change. Not the isolation boundary —
 * the per-user key is — but on a shared device it means the next person's first
 * paint cannot briefly carry a number belonging to the last one, even if some
 * future caller were to read a key it did not own.
 */
export function clearPersistedUnreadCounts(
  opts: { storage?: CountStorage | null } = {},
): void {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  if (!storage) return
  try {
    const doomed: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key && key.startsWith(KEY_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) storage.removeItem(key)
  } catch {
    // Same as above.
  }
}
