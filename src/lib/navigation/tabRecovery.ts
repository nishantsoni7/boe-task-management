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
// which deployment is live. If it differs from the tab's own, a small notice
// offers Refresh. The person decides when; nothing reloads on its own.
//
// WHY NEVER AN AUTOMATIC RELOAD. An earlier version reloaded a hidden tab
// quietly when the page looked clean — no typed text, chosen file, open modal,
// save in flight, filled form or leave guard. Review found work that none of
// those signals can see: files dropped or pasted into a drop zone (held in
// React state, no input event), the Modules card reorder before Save, and
// click-only controls (aria-pressed toggles, custom listbox pickers). A reload
// there would silently lose it, so the decision is left to the person.
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

export type FreshnessDecision = 'current' | 'offer-refresh'

/**
 * Is there a newer deployment to offer?
 *
 * An unknown id on either side (local build, failed check) is never treated as
 * a new deployment, and one the person already dismissed is not offered again.
 */
export function decideFreshness(input: {
  own: string | null
  live: string | null
  dismissed?: string | null
}): FreshnessDecision {
  if (!input.own || !input.live || input.own === input.live) return 'current'
  if (input.dismissed === input.live) return 'current'
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
