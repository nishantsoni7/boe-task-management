import type { Exhibition } from './constants'

// Whether Exhibition Leads is taking new leads at all. It is a fact about the
// exhibitions table, not a setting kept in code: Admin closes the last open
// exhibition (Exhibitions → Close) and every way in disappears — the
// "Add Exhibition Lead" quick link, the Add Lead navigation item and the Add Lead
// bar — and re-opening one brings them back, with no deploy.
//
// It decides what to SHOW. The database refuses a lead for a closed exhibition
// on its own (create_exhibition_lead), so a stale screen cannot add one.

export type IntakeState = 'open' | 'closed' | 'unknown'

/** `list` is the exhibitions answer, undefined until it arrives (or when the read failed). */
export function intakeState(list: readonly Pick<Exhibition, 'is_active'>[] | undefined): IntakeState {
  if (!list) return 'unknown'
  return list.some(e => e.is_active) ? 'open' : 'closed'
}

/** The module's own navigation: only a definite "closed" removes Add Lead. */
export const showAddLeadEntry = (state: IntakeState): boolean => state !== 'closed'

/**
 * The launcher's quick link. Shown on a definite "open"; while the answer is still
 * on its way it stays hidden (so it never flashes and vanishes), but a FAILED read
 * shows it — a network problem must not take the entry form from somebody at a stand.
 */
export const showQuickLink = (state: IntakeState, readFailed: boolean): boolean =>
  state === 'open' || (state === 'unknown' && readFailed)
