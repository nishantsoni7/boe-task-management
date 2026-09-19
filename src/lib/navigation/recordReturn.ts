// ── Back to where you came from ──────────────────────────────────────────────
//
// An Order or PI record opened from a list should send its reader back to THAT
// list — the same tab, filters, search and page — not to a fixed address and
// not out of the app. The Task module already solved this with a validated
// `returnTo` parameter (src/lib/tasks/taskReturnPath.ts); Orders and Finance
// reuse the same parameter name and the same validator rather than growing a
// second convention.
//
// WHAT IT REPLACES:
//   * the Order record's Back was router.back(): from a new tab, a bookmark or
//     a notification opened in a fresh window it left the app altogether;
//   * the PI record's Back always pushed /orders/drafts, so a PI opened from
//     Confirmed Payments' "Allocated Against" link returned to the wrong module.
//
// SAFE BY CONSTRUCTION. Every value is passed through safeReturnPath, which
// accepts only a same-origin path ("/…", never "//host", a scheme or a
// backslash). Anything else is dropped and the record falls back to its own
// list. A return path is a place to go back to; it grants and reveals nothing —
// the destination still loads under the reader's own session and RLS.

import { safeReturnPath } from '@/lib/safeReturnPath'
import { RETURN_TO_PARAM } from '@/lib/tasks/taskReturnPath'

export { RETURN_TO_PARAM }

/**
 * `href` with `returnTo` appended when `returnTo` is a safe in-app path.
 * An href that already carries a query keeps it.
 */
export function withReturnTo(href: string, returnTo: string | null | undefined): string {
  const source = safeReturnPath(returnTo)
  if (!source) return href
  const [path, query = ''] = href.split('?')
  const params = new URLSearchParams(query)
  params.set(RETURN_TO_PARAM, source)
  return `${path}?${params.toString()}`
}

/** The validated return path in a query string, or null. */
export function returnPathFrom(search: string | { get(name: string): string | null }): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return safeReturnPath(params.get(RETURN_TO_PARAM))
}

/**
 * The words on the Back control for a destination — "Back to Confirmed Orders",
 * never a bare "Back" that leaves the reader guessing where it goes. Anything
 * this does not recognise is simply "Back".
 */
export function returnLabelFor(path: string): string {
  const bare = path.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/'
  const known: Record<string, string> = {
    '/orders':                'Orders',
    '/orders/all':            'Confirmed Orders',
    '/orders/drafts':         'PI Drafts',
    '/orders/notifications':  'Notifications',
    '/finance':               'Payment Requests',
    '/finance/received':      'Confirmed Payments',
    '/finance/notifications': 'Notifications',
  }
  if (known[bare]) return `Back to ${known[bare]}`
  if (/^\/orders\/drafts\/[^/]+$/.test(bare)) return 'Back to PI Draft'
  if (/^\/orders\/[0-9a-f-]{36}$/i.test(bare)) return 'Back to Order'
  return 'Back'
}

/**
 * A list's own address with the search AS TYPED, trimmed — for the `returnTo`
 * a record is opened with.
 *
 * WHY NOT THE COMMITTED URL. The search box commits to the URL after a 250ms
 * pause, or on blur. Typing a term and clicking a row at once runs: mousedown,
 * blur (flush, which only SCHEDULES a replace), click — and the click reads the
 * address from before the flush. The record would then send its reader back to
 * the list without the term they had just typed. Building `returnTo` from the
 * pending term closes that gap whatever the timing; the flush still brings the
 * list's own URL into line for the browser's Back.
 */
export function listReturnPathWithSearch(
  pathname: string,
  currentSearch: string,
  pendingSearch: string,
  key = 'q',
): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  const typed = pendingSearch.trim()
  if (typed) params.set(key, typed)
  else params.delete(key)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}
