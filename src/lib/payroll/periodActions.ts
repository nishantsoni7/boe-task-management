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

/**
 * How each action is drawn inside a table row.
 *
 * One primary action carries its label; everything else is an icon button with
 * the same label as its aria-label and tooltip. Stated here rather than in the
 * row component so "no full-text Regenerate/Lock/Unlock button sits in a row"
 * is a rule that can be asserted, and so the wording of the accessible name
 * cannot drift from PAYROLL_ACTION_LABELS.
 */
export type PayrollActionPresentation = 'text' | 'icon'

export const PAYROLL_ROW_ACTION_PRESENTATION: Record<PayrollPeriodAction, PayrollActionPresentation> = {
  view:       'text',
  generate:   'text',
  regenerate: 'icon',
  lock:       'icon',
  unlock:     'icon',
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

// ── Attention ────────────────────────────────────────────────────────────────
// What the Attention column has to say about a period, and what to do about it.
//
// The row shows an icon; this is the sentence behind it. Keeping the wording
// pure means the popup and the row cannot disagree about whether a period needs
// attention, and the recovery sequence for a locked month is a rule rather than
// a paragraph typed into a component.

export type PayrollAttentionTone =
  /** Something must be done before these figures can be trusted. */
  | 'amber'
  /** Worth knowing, nothing to do. */
  | 'info'

export type PayrollAttentionDetail = {
  tone: PayrollAttentionTone
  title: string
  body: string
  /** Ordered recovery steps. Empty when a single action fixes it. */
  steps: string[]
  /** The action the popup leads with, or null when there is nothing to do. */
  action: PayrollPeriodAction | null
}

/** One label for every attention trigger — the icon says nothing on its own. */
export const PAYROLL_ATTENTION_ARIA_LABEL = 'View payroll attention details'

export function payrollAttention(input: {
  status: PeriodStatus
  /** Attendance for the month was touched after the last generation. */
  outOfDate: boolean
  /** The period has been reopened at least once after being locked. */
  reopened: boolean
}): PayrollAttentionDetail | null {
  if (input.outOfDate) {
    // Locked is the harder case: the figures cannot be corrected in place, so
    // the popup states the whole way back rather than offering one button and
    // leaving the admin to work out the rest.
    if (input.status === 'locked') {
      return {
        tone: 'amber',
        title: 'Payroll has attendance changes',
        body: 'Attendance records were updated after this payroll was locked.',
        steps: ['Unlock payroll', 'Regenerate payroll', 'Review results', 'Lock payroll again'],
        action: 'unlock',
      }
    }
    return {
      tone: 'amber',
      title: 'Payroll needs regeneration',
      body: 'Attendance records were updated after payroll generation.',
      steps: [],
      action: 'regenerate',
    }
  }

  // A reopened month whose figures are current still deserves a marker: the
  // reason it was reopened lives nowhere else in the interface. Deliberately
  // NOT amber — nothing is wrong, so it must not be counted as work outstanding
  // alongside the periods that are genuinely stale.
  if (input.reopened) {
    return {
      tone: 'info',
      title: 'Payroll was reopened',
      body: 'This payroll was unlocked after it had been locked.',
      steps: [],
      action: null,
    }
  }

  return null
}
