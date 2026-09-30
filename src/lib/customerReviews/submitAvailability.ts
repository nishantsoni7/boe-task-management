// Whether "Submit review" may be used right now, decided ONCE and read by both
// entry points on the Reviews landing page (the header button and the button in
// the Custom Reviews section), so they cannot disagree. The reasons are the ones
// the section already showed; the route and the database still decide.

export type SubmitAvailability =
  | { status: 'loading'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'limit'; reason: string }
  | { status: 'ready'; reason: null }

export const SUBMIT_LOADING_REASON = 'Checking this month\'s allowance…'

export function submitAvailability(input: {
  loaded: boolean
  loadError: string | null
  canSubmitAny: boolean
  limitMessage: string | null
}): SubmitAvailability {
  if (!input.loaded) return { status: 'loading', reason: SUBMIT_LOADING_REASON }
  if (input.loadError) return { status: 'error', reason: input.loadError }
  if (!input.canSubmitAny) return { status: 'limit', reason: input.limitMessage ?? 'You cannot submit another review this month.' }
  return { status: 'ready', reason: null }
}
