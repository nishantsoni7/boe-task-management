// ── Tab recovery: after a deployment, and after a navigation that stalls ────
//
// MEASURED PROBLEM 1 — A TAB LEFT OPEN ACROSS A DEPLOYMENT. When the server has
// a newer deployment than the tab, the next in-app navigation cannot be served
// client-side: Next abandons it and does a FULL page load (fetch-server-response
// → doMpaNavigation). With the new deployment's JavaScript uncached, that click
// took 4.7 s on a mid-range phone profile (1.7 s desktop), and every later
// Back did the same. Vercel's Skew Protection would avoid it but is not
// available on this project's plan.
//
// FIX: notice the new deployment BEFORE the person clicks. When a tab returns
// after a while hidden (or periodically while hidden) it asks /api/deployment
// which deployment is live. If it differs from the tab's own and the person is
// not looking and has nothing unsaved, the tab reloads quietly — the full load
// happens while nobody is waiting. Otherwise a small notice offers Refresh;
// nothing is forced on somebody mid-task.
//
// MEASURED PROBLEM 2 — A NAVIGATION THAT NEVER STARTS. Production traces showed
// requests queued 4–19 s on a dead HTTP/2 connection before Chrome opened a new
// one. A full load opens a fresh connection, so a link that has not changed the
// page within STALL_MS offers "Retry", which loads its target directly.
//
// Everything here is pure so the rules are testable without a browser.

export const RECHECK_AFTER_HIDDEN_MS = 5 * 60 * 1000
export const RECHECK_WHILE_HIDDEN_MS = 15 * 60 * 1000
export const STALL_MS = 8000

export type FreshnessDecision = 'current' | 'reload-now' | 'offer-refresh'

/**
 * What to do once the live deployment is known.
 *
 * An unknown id on either side (local build, failed check) is never treated as
 * a new deployment — a false positive would reload somebody's page for nothing.
 */
export function decideFreshness(input: {
  own: string | null
  live: string | null
  hidden: boolean
  hasUnsavedWork: boolean
}): FreshnessDecision {
  if (!input.own || !input.live || input.own === input.live) return 'current'
  if (input.hidden && !input.hasUnsavedWork) return 'reload-now'
  return 'offer-refresh'
}

/** Should a tab that just became visible ask which deployment is live? */
export function shouldCheckOnReturn(hiddenForMs: number): boolean {
  return Number.isFinite(hiddenForMs) && hiddenForMs >= RECHECK_AFTER_HIDDEN_MS
}

/** A deployment id as Vercel issues it, or null. */
export function parseDeploymentId(value: unknown): string | null {
  return typeof value === 'string' && /^dpl_[A-Za-z0-9]{8,40}$/.test(value) ? value : null
}

/**
 * Does the page hold something a reload would lose? Deliberately cautious:
 * anything the person typed or changed on this page since arriving, any open
 * dialog, or a focused editable field.
 *
 * WHY "TYPED SINCE ARRIVING" AND NOT value ≠ defaultValue. React keeps a
 * controlled input's `defaultValue` (its value attribute) in step with its
 * current value, so comparing the two sees no edit at all on this app's forms —
 * found by the stale-tab test, which reloaded a page with a half-typed search.
 * The component therefore records real `input` / `change` events instead.
 */
export function hasUnsavedWork(doc: {
  editedSinceArrival: boolean
  openDialogs: number
  editableFocused: boolean
}): boolean {
  return doc.editedSinceArrival || doc.openDialogs > 0 || doc.editableFocused
}
