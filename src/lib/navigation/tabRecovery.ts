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
// not looking and has nothing unsaved (unsavedWorkReasons — typed text, chosen
// files, open modals, saves in flight, filled forms, the page's own leave
// guards), the tab reloads quietly — the full load happens while nobody is
// waiting. Otherwise a small notice offers Refresh; nothing is forced on
// somebody mid-task.
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
 * Everything on a page that a reload could lose. Each signal is collected by
 * the component (src/components/layout/TabRecovery.tsx); the decision is here.
 */
export type PageWorkSignals = {
  /** An `input` / `change` event on a field since this route was opened. */
  editedSinceArrival: boolean
  /** A focused field or contenteditable. */
  editableFocused: boolean
  /** role=dialog, <dialog open>, aria-modal, the app's modal classes, or any
   *  fixed layer covering most of the screen (the app's inline-styled modals). */
  openOverlays: number
  /** File inputs holding a chosen file (a proof, an import sheet, a photo). */
  chosenFiles: number
  /** Writes still in flight: non-GET fetches plus React Query mutations. */
  pendingSaves: number
  /** Editable fields with a value inside a form or an overlay. */
  filledFormFields: number
  /** The page's own "leave site?" guards (beforeunload listeners it added). */
  leaveGuards: number
  /** Elements marked data-unsaved="true" by a page that knows better. */
  declaredUnsaved: number
}

export type UnsavedReason = keyof PageWorkSignals

/**
 * Why a reload would lose something — an empty list means nothing would be lost.
 *
 * DELIBERATELY CAUTIOUS. A false "unsaved" only costs a notice instead of a
 * quiet reload; a false "clean" loses somebody's work. So a prefilled edit
 * form counts as unsaved even if nothing was changed yet.
 *
 * WHY "TYPED SINCE ARRIVING" AND NOT value ≠ defaultValue. React keeps a
 * controlled input's `defaultValue` (its value attribute) in step with its
 * current value, so comparing the two sees no edit at all on this app's forms —
 * found by the stale-tab test, which reloaded a page with a half-typed search.
 * The component therefore records real `input` / `change` events instead.
 */
export function unsavedWorkReasons(signals: PageWorkSignals): UnsavedReason[] {
  return (Object.keys(signals) as UnsavedReason[]).filter(k => {
    const v = signals[k]
    return typeof v === 'boolean' ? v : !(Number.isFinite(v) && v <= 0)
  })
}

export function hasUnsavedWork(signals: PageWorkSignals): boolean {
  return unsavedWorkReasons(signals).length > 0
}

/** A write that a reload would cut off. GET/HEAD/OPTIONS only read. */
export function isWriteRequest(method: string | undefined | null): boolean {
  return !/^(GET|HEAD|OPTIONS)$/i.test(method || 'GET')
}

/**
 * Is a fixed layer actually in the way? The phone layout keeps its sidebar
 * backdrop mounted at full screen with opacity 0 and pointer-events none —
 * found by the phone-profile test, where it made every clean page look busy.
 */
export function isBlockingLayer(style: { position: string; visibility: string; opacity: string; pointerEvents: string; display?: string }): boolean {
  return style.position === 'fixed' && style.display !== 'none' && style.visibility !== 'hidden'
    && style.pointerEvents !== 'none' && !(Number(style.opacity) <= 0.05)
}

/** Does a fixed layer this large cover the page like a modal backdrop? */
export function coversScreen(rect: { width: number; height: number }, viewport: { width: number; height: number }): boolean {
  if (viewport.width <= 0 || viewport.height <= 0) return false
  return rect.width >= viewport.width * 0.9 && rect.height >= viewport.height * 0.9
}
