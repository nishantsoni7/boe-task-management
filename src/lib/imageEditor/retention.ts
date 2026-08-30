// The retention rule, in one place.
//
// CLIENT-SAFE and framework-free. No sharp, no Supabase, no network, no key —
// the page imports it for the labels and the API routes import it for the
// filter, so the browser and the server cannot disagree about when a result
// stops existing.
//
// THE RULE
// --------
//   * a result is visible for SEVEN DAYS FROM GENERATION;
//   * a result marked Keep is visible for as long as it stays kept;
//   * anything else is deleted, object and row, once its window has passed.
//
// WHERE THE SEVEN DAYS ACTUALLY LIVE
// ----------------------------------
// In the DATABASE: `image_editor_results.expires_at` defaults to
// `now() + interval '7 days'` and is never written by the application. The
// constant below therefore describes that default and is used for LABELS and
// for tests — it is not the thing that sets the window, and changing it alone
// would change what the screen says without changing what is kept. Both move
// together or neither does; the test beside this file says so.
//
// WHY EXPIRY IS A READ RULE, NOT ONLY A JOB
// -----------------------------------------
// Every read filters on the same predicate the sweep uses, so a result becomes
// invisible the moment it expires — whether or not the daily cleanup has run.
// A late or failed cron makes bytes linger; it never makes an expired image
// reappear. Correctness does not depend on the scheduler.

/** Days a result survives from generation unless it is kept. */
export const RETENTION_DAYS = 7

/** The interval the migration defaults `expires_at` to. Kept beside
 *  RETENTION_DAYS so a change to one is visibly a change to the other. */
export const RETENTION_INTERVAL_SQL = `${RETENTION_DAYS} days`

/** The private bucket holding generated masters. */
export const HISTORY_BUCKET = 'image-editor-results'

/**
 * How long a signed URL lives.
 *
 * One hour: long enough that a tab left open over a lunch break still shows its
 * pictures, short enough that a URL copied out of devtools is not a lasting
 * back door. Matches the showroom quotation route.
 */
export const SIGNED_URL_TTL_SECONDS = 3600

/** How many rows one cleanup pass will handle. A ceiling, not a target: it
 *  bounds the work a single cron invocation can do so the function cannot run
 *  past its timeout on a backlog. Whatever is left is taken tomorrow. */
export const CLEANUP_BATCH_LIMIT = 500

/** The newest results a listing returns. Nobody scrolls a hundred; a kept
 *  archive that grows without bound is a separate feature nobody asked for. */
export const HISTORY_PAGE_SIZE = 50

/**
 * The object key for a result: '<user_id>/<result_id>.png'.
 *
 * The first segment IS the owner, and the storage policies in
 * 20261021000000 authorize by parsing it. Building this key anywhere else, or
 * changing its shape here, silently breaks that authorization — which is why
 * every caller goes through this function.
 */
export function historyObjectPath(userId: string, resultId: string): string {
  return `${userId}/${resultId}.png`
}

/** The shape the retention rules need. Deliberately narrower than the table so
 *  callers can pass a row, an API payload or a test fixture. */
export type RetainedResult = {
  kept: boolean
  /** ISO-8601, as PostgREST returns it. */
  expiresAt: string
}

function expiryMs(result: RetainedResult): number {
  return Date.parse(result.expiresAt)
}

/**
 * Whether this result is past its window and not kept.
 *
 * An unparseable timestamp is treated as NOT expired. That fails towards
 * keeping an employee's work rather than deleting it, which is the only safe
 * direction for a function whose true answer causes a deletion.
 */
export function isExpired(result: RetainedResult, now: number = Date.now()): boolean {
  if (result.kept) return false
  const at = expiryMs(result)
  if (Number.isNaN(at)) return false
  return at <= now
}

/** Whether this result should still be shown. The exact complement of
 *  isExpired, named for the caller that reads rather than the one that deletes. */
export function isVisible(result: RetainedResult, now: number = Date.now()): boolean {
  return !isExpired(result, now)
}

/**
 * Whole days left before deletion, rounded UP.
 *
 * Rounding up is what makes the label honest: something with eleven hours to
 * live is "1 day", not "0 days", because it will still be there tomorrow
 * morning. Returns 0 for anything already past, and null for a kept result,
 * which has no countdown at all.
 */
export function daysRemaining(
  result: RetainedResult,
  now: number = Date.now(),
): number | null {
  if (result.kept) return null
  const at = expiryMs(result)
  if (Number.isNaN(at)) return null
  const ms = at - now
  if (ms <= 0) return 0
  return Math.ceil(ms / 86_400_000)
}

/** What the card says about how long this result has. One sentence fragment,
 *  no provider detail, no timestamps an employee would have to interpret. */
export function retentionLabel(result: RetainedResult, now: number = Date.now()): string {
  if (result.kept) return 'Kept'
  const days = daysRemaining(result, now)
  if (days === null) return 'Kept'
  if (days === 0) return 'Expired'
  // Under a day left. "Expires in 1 day" would read as "some time tomorrow",
  // which is the one thing it is not.
  if (days === 1) return 'Expires today'
  return `Expires in ${days} days`
}

/**
 * The PostgREST `or` filter selecting rows that are still visible.
 *
 * The same predicate the sweep inverts, written once. `nowIso` is passed in
 * rather than read here so a caller stamps one instant across a whole request
 * and a listing cannot straddle a second boundary.
 */
export function visibleFilter(nowIso: string): string {
  return `kept.eq.true,expires_at.gt.${nowIso}`
}
