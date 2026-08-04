// Which actions a payroll period row offers, and what each one is called.
//
// Pure and separate from the page for two reasons. It is testable without a
// browser — "a locked row offers Unlock Payroll" is a rule, not a rendering
// detail — and it keeps the wording in one place, so the dashboard, the row
// menu and any future payroll surface cannot drift into calling the same action
// "Re-generate", "Regenerate Payroll" and "Generate" in three places, which is
// what they did before.

import type { PeriodStatus } from './correctionRules'

export type PayrollPeriodAction =
  | 'view'
  | 'generate'
  | 'regenerate'
  | 'lock'
  | 'unlock'

export const PAYROLL_ACTION_LABELS: Record<PayrollPeriodAction, string> = {
  view:       'View Payroll',
  // A period that has never produced results is generated, not regenerated.
  // Both labels are deliberate: they tell the admin whether existing figures
  // are about to be replaced.
  generate:   'Generate Payroll',
  regenerate: 'Regenerate Payroll',
  lock:       'Lock Payroll',
  unlock:     'Unlock Payroll',
}

export type PayrollRowActions = {
  /** The one action the row leads with. */
  primary: PayrollPeriodAction
  /** Everything else, in the order it should be shown. */
  secondary: PayrollPeriodAction[]
}

/**
 * The actions available for a period in a given status.
 *
 * Viewing payroll is the primary action wherever results exist, because reading
 * the figures is what an admin comes to this row to do — regenerating and
 * locking are decisions taken after reading them. A draft has nothing to read,
 * so generating is its primary action.
 *
 * A locked row deliberately carries no disabled controls. The status badge
 * already says the period is locked; a greyed-out "Lock" button repeated that
 * and a greyed-out "Regenerate" invited clicks that could never work.
 */
export function payrollRowActions(status: PeriodStatus): PayrollRowActions {
  switch (status) {
    case 'draft':
      return { primary: 'generate', secondary: [] }
    case 'generated':
      return { primary: 'view', secondary: ['regenerate', 'lock'] }
    case 'locked':
      return { primary: 'view', secondary: ['unlock'] }
  }
}
