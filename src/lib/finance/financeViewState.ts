// Confirmed Payments view state — survives a remount, never a destructive
// confirmation.
//
// WHY THIS EXISTS. Requirement 5 traces every code-level cause of an
// automatic Finance refresh on tab-return and finds none reachable from an
// ordinary `focus`/`visibilitychange` event (see financeRefreshPolicy.test.ts
// and the Providers.tsx comment above resolveAuthIdentityAction) — no
// listener, no router.refresh(), no auth-event side effect. What those tests
// cannot rule out is a genuine BROWSER-LEVEL tab discard: the OS/browser
// reclaiming a backgrounded tab's memory, which is not a dispatchable event
// and destroys the React tree outright. This module is the mitigation for
// THAT case, not a claim that it is what was actually happening — if the
// component never remounts, this code never runs, and nothing changes.
//
// sessionStorage, NOT the URL. The existing `?payment=&action=` deep-link
// mechanism and (for /finance/received) the legacy `?view=` read are left
// exactly as they are — this does not compete with either. Search text,
// date-range and filter selections are per-tab, ephemeral browsing state, the
// textbook case for sessionStorage: it survives exactly one tab's lifetime,
// including a discard-and-restore, and never leaks to a different tab or a
// different payment surface.
//
// WHAT IS DELIBERATELY NEVER PERSISTED HERE, and why restoring it would be
// unsafe rather than merely unnecessary:
//
//   * a deletion reason or a typed Payment ID confirmation — DeletePaymentModal
//     (components/finance/DeletePaymentModal.tsx) holds both in its own local
//     useState and never imports this module at all, so there is no code path
//     by which either could be restored. A destructive confirmation must be
//     retyped fresh every time, on purpose.
//   * which modal, if any, was open — an Allocate Funds form mid-entry or a
//     Delete confirmation reappearing on their own after an unrelated browser
//     event is a surprise, not a convenience, and the safer default is that a
//     remount always lands on the closed list, never mid-transaction.
//   * scroll position — DOM-dependent and out of a pure module's reach; left
//     to the browser's own scroll restoration.

const STORAGE_KEY_PREFIX = 'boe.finance.receivedPaymentsView.'

export type PersistedFinanceViewState = {
  search: string
  dateFrom: string
  dateTo: string
  allocation: string
  confirmedFilter: string
  page: number
}

export const FINANCE_VIEW_STATE_DEFAULTS: PersistedFinanceViewState = {
  search: '',
  dateFrom: '',
  dateTo: '',
  allocation: 'all',
  confirmedFilter: 'all',
  page: 1,
}

/** One sessionStorage key per surface, so Confirmed Payments and Payments to
 *  Verify never overwrite each other's remembered state. */
export function financeViewStateKey(surface: string): string {
  return `${STORAGE_KEY_PREFIX}${surface}`
}

/**
 * Serialize a partial view state to the exact JSON string sessionStorage
 * should hold. Pure — no storage access here, so it is testable without a
 * browser.
 */
export function serializeFinanceViewState(state: PersistedFinanceViewState): string {
  return JSON.stringify(state)
}

/**
 * Parse a raw sessionStorage value back into a view state, falling back to
 * FINANCE_VIEW_STATE_DEFAULTS field-by-field for anything missing, malformed,
 * or of the wrong type — a corrupted or hand-edited value degrades to "start
 * fresh," never to a thrown error or a half-populated state.
 */
export function parseFinanceViewState(raw: string | null | undefined): PersistedFinanceViewState {
  if (!raw) return { ...FINANCE_VIEW_STATE_DEFAULTS }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...FINANCE_VIEW_STATE_DEFAULTS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...FINANCE_VIEW_STATE_DEFAULTS }
  const p = parsed as Record<string, unknown>
  return {
    search:          typeof p.search === 'string' ? p.search : FINANCE_VIEW_STATE_DEFAULTS.search,
    dateFrom:        typeof p.dateFrom === 'string' ? p.dateFrom : FINANCE_VIEW_STATE_DEFAULTS.dateFrom,
    dateTo:          typeof p.dateTo === 'string' ? p.dateTo : FINANCE_VIEW_STATE_DEFAULTS.dateTo,
    allocation:      typeof p.allocation === 'string' ? p.allocation : FINANCE_VIEW_STATE_DEFAULTS.allocation,
    confirmedFilter: typeof p.confirmedFilter === 'string' ? p.confirmedFilter : FINANCE_VIEW_STATE_DEFAULTS.confirmedFilter,
    page:            typeof p.page === 'number' && Number.isFinite(p.page) && p.page >= 1
                        ? Math.floor(p.page) : FINANCE_VIEW_STATE_DEFAULTS.page,
  }
}

/**
 * Read the remembered state for one surface directly from sessionStorage.
 * Fails closed to the defaults on anything unexpected — a private-browsing
 * tab that throws on access, a quota error, storage disabled entirely — so a
 * browser that cannot supply memory behaves exactly as a fresh visit would.
 */
export function readFinanceViewState(surface: string): PersistedFinanceViewState {
  try {
    if (typeof window === 'undefined') return { ...FINANCE_VIEW_STATE_DEFAULTS }
    return parseFinanceViewState(window.sessionStorage.getItem(financeViewStateKey(surface)))
  } catch {
    return { ...FINANCE_VIEW_STATE_DEFAULTS }
  }
}

/** Write the remembered state for one surface. Silently gives up on a
 *  storage failure — a browsing session that cannot remember its filters is
 *  never worse than one that throws over trying to. */
export function writeFinanceViewState(surface: string, state: PersistedFinanceViewState): void {
  try {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(financeViewStateKey(surface), serializeFinanceViewState(state))
  } catch {
    // Storage disabled, quota exceeded, or a private-browsing restriction —
    // the state simply is not remembered this time.
  }
}
