// Loading and error state for the Team Performance dataset request.
//
// Extracted from the page for the same reason the calendar helpers were: the
// route handlers and the page component are not unit-testable in this setup,
// so the decision logic lives here where the tests can reach it.
//
// The defect this exists to prevent: the page previously showed its progress
// loader whenever `data` was still null. A failed request leaves `data` null
// forever, so the loader ramped to its 90% ceiling and stayed there, hiding
// the error panel that was rendered underneath it. A terminal state — success
// *or* failure — must always clear the loader.

/** Why a Team Performance request ended without a dataset. */
export type LoadErrorKind = 'auth' | 'forbidden' | 'invalid' | 'server' | 'network'

export type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; kind: LoadErrorKind; message: string }

/**
 * User-facing copy. Deliberately free of database internals: the raw cause
 * (`users: column users.exit_date does not exist`, a Postgres message, a stack)
 * goes to the console, never to the panel.
 */
export const LOAD_ERROR_MESSAGE: Record<LoadErrorKind, string> = {
  auth:      'Your session has expired. Please sign in again.',
  forbidden: 'Team Performance is restricted to management.',
  invalid:   'Team Performance could not be loaded. The selected date range is not valid.',
  server:    'Team Performance could not be loaded.',
  network:   'Team Performance could not be loaded. Check your connection and try again.',
}

/** Progress ceiling while a request is genuinely in flight. */
export const PROGRESS_CEILING = 90

export function classifyHttpStatus(status: number): LoadErrorKind {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 400) return 'invalid'
  return 'server'
}

export function toLoadError(kind: LoadErrorKind): Extract<LoadState, { phase: 'error' }> {
  return { phase: 'error', kind, message: LOAD_ERROR_MESSAGE[kind] }
}

export function isTerminal(state: LoadState): boolean {
  return state.phase !== 'loading'
}

/**
 * The full-screen loader shows only while a request is in flight and only
 * until it has been dismissed once. Any terminal state clears it, so an error
 * can never leave the page stuck behind the loader.
 */
export function shouldShowLoader(state: LoadState, dismissed: boolean): boolean {
  return !dismissed && state.phase === 'loading'
}

/**
 * Progress advances while loading and completes on any terminal state. It
 * never stalls: the ceiling is only reachable during a live request, and
 * reaching a terminal state always yields 100.
 */
export function nextProgress(prev: number, state: LoadState, step: number): number {
  if (isTerminal(state)) return 100
  return Math.min(PROGRESS_CEILING, prev + step)
}

/** Retrying only makes sense when the failure might not repeat. */
export function isRetryable(kind: LoadErrorKind): boolean {
  return kind === 'server' || kind === 'network'
}

/** 401 is the only kind that should bounce the user out to the login page. */
export function shouldRedirectToLogin(kind: LoadErrorKind): boolean {
  return kind === 'auth'
}

/**
 * A successful response carrying no employees is an empty state, not a
 * failure. Kept as a named predicate so the page cannot drift back into
 * treating "no rows" as "still loading".
 */
export function isEmptyResult(state: LoadState, memberCount: number): boolean {
  return state.phase === 'ready' && memberCount === 0
}
