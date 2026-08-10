// Whether a payroll period may be permanently deleted, and what the admin has
// to do to confirm it.
//
// Pure, and shared, for the same reason unlockRules.ts is: the API route, the
// row menu and the confirmation dialog must agree to the letter about which
// periods are deletable and why a refused one was refused. A dialog that offers
// a button the route will reject is worse than no button, and a rule stated in
// two places eventually becomes two rules.
//
// The database says no as well — public.delete_payroll_period() re-checks every
// refusal here, because a disabled button is not an enforcement boundary. What
// lives here is the wording and the ordering: which objection an admin is shown
// first when a period fails more than one test.

import type { PeriodStatus } from './correctionRules'

export type { PeriodStatus }

// ─── What the caller has to know about a period ──────────────────────────────

/**
 * Everything the decision depends on, and nothing else.
 *
 * Deliberately counts and booleans rather than rows: this module must be
 * callable from a component that has never seen a settlement record, and it must
 * not be able to leak a salary figure into a refusal message by accident.
 */
export type PayrollDeletionFacts = {
  status: PeriodStatus
  /** Employee payroll results stored against the period. */
  resultCount: number
  /** Settlement records for the period, paid or not. */
  settlementCount: number
  /** Settlements with a recorded payment — amount, date or timestamp. */
  paidSettlementCount: number
  /** Employee results individually marked locked. */
  lockedResultCount: number
  /** A generation or recalculation is in flight for this period. */
  generationRunning: boolean
  /**
   * Settlements on OTHER periods that carry a NON-ZERO balance forward from this
   * one. Zero-value pointers are not counted: they carry no money, and the
   * deletion clears them without changing any figure.
   */
  carryForwardDependentCount: number
}

export type PayrollDeletionDenialReason =
  | 'not_authorised'
  | 'locked'
  | 'paid'
  | 'result_locked'
  | 'generation_running'
  | 'carry_forward_dependency'

export type PayrollDeletionDenial = {
  allowed: false
  reason: PayrollDeletionDenialReason
  /** What is wrong. */
  message: string
  /** What has to happen before deletion becomes possible. Empty when nothing can. */
  resolution: string
}

export type PayrollDeletionPermission =
  | {
      allowed: true
      /**
       * True when deleting this period will remove salary records employees can
       * currently see. A draft has produced none, so it needs no such warning;
       * a generated period does, and the dialog states it plainly.
       */
      removesEmployeeVisibleSalary: boolean
    }
  | PayrollDeletionDenial

/**
 * Whether this caller may delete this payroll period.
 *
 * Admin and nothing else. Not "payroll module access": Control Center can name a
 * member into the Payroll module, which lets them read the figures — it has
 * never granted generate, lock or unlock, and it does not grant this either.
 * Managers are not admins in this codebase and are refused by the same test.
 *
 * The refusals are ordered by how final they are. Locked comes first because it
 * is the only one an admin can clear from this screen; payment comes next
 * because it can never be cleared at all.
 */
export function canDeletePayrollPeriod(
  role: string | null | undefined,
  facts: PayrollDeletionFacts,
): PayrollDeletionPermission {
  if (role !== 'admin') {
    return {
      allowed: false,
      reason: 'not_authorised',
      message: 'Only payroll administrators can delete a payroll period.',
      resolution: '',
    }
  }

  if (facts.status === 'locked') {
    return {
      allowed: false,
      reason: 'locked',
      message: 'This payroll is locked, so it cannot be deleted.',
      resolution: 'Unlock the payroll first, with a stated reason, then delete it.',
    }
  }

  if (facts.paidSettlementCount > 0) {
    return {
      allowed: false,
      reason: 'paid',
      message:
        facts.paidSettlementCount === 1
          ? 'A payment has been recorded against this payroll, so it cannot be deleted.'
          : `Payments have been recorded against this payroll for ${facts.paidSettlementCount} employees, so it cannot be deleted.`,
      // Deliberately not "remove the payment": a paid month is a record of money
      // that left the company, and this feature must not offer a way to erase it.
      resolution: 'Settled payroll is permanent. Correct the figures instead of deleting them.',
    }
  }

  if (facts.lockedResultCount > 0) {
    return {
      allowed: false,
      reason: 'result_locked',
      message: `${facts.lockedResultCount} employee result${facts.lockedResultCount === 1 ? ' is' : 's are'} locked in this payroll, so it cannot be deleted.`,
      resolution: 'Unlock those employee results first.',
    }
  }

  if (facts.generationRunning) {
    return {
      allowed: false,
      reason: 'generation_running',
      message: 'A payroll generation is still running for this period.',
      resolution: 'Wait for the run to finish, reload, and try again.',
    }
  }

  if (facts.carryForwardDependentCount > 0) {
    return {
      allowed: false,
      reason: 'carry_forward_dependency',
      message: 'A later payroll carries a balance forward from this one, so deleting it would leave money that cannot be explained.',
      resolution: 'Clear or override that carry-forward on the later payroll first.',
    }
  }

  return { allowed: true, removesEmployeeVisibleSalary: facts.status === 'generated' }
}

// ─── The typed confirmation ──────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/**
 * The exact words the admin has to type — "July 2026".
 *
 * The month and year, not the period id: an admin who mistypes a uuid learns
 * nothing, whereas typing the month is a person reading the dialog and agreeing
 * with which payroll it names. It is the same string the row and the dialog
 * title display, so there is nothing to look up.
 */
export function payrollDeletionConfirmationText(month: number, year: number): string {
  const name = MONTH_NAMES[month - 1] ?? `Month ${month}`
  return `${name} ${year}`
}

/**
 * Whether what was typed matches.
 *
 * Surrounding whitespace is forgiven — a trailing space from a paste is not a
 * different answer. Case and spelling are not: this is the last gate before an
 * irreversible deletion, and "july 2026" typed in a hurry against a dialog that
 * says "July 2026" is close enough to be worth stopping. Internal runs of
 * whitespace are collapsed so "July  2026" still reads as the same words.
 */
export function payrollDeletionConfirmationMatches(
  typed: unknown,
  month: number,
  year: number,
): boolean {
  if (typeof typed !== 'string') return false
  const normalised = typed.trim().replace(/\s+/g, ' ')
  return normalised === payrollDeletionConfirmationText(month, year)
}

// ─── The reason ──────────────────────────────────────────────────────────────

/** Same ceiling as the unlock reason, so the two audit trails read alike. */
export const DELETION_REASON_MAX_LENGTH = 500

export type DeletionReasonResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

/**
 * The stated reason for destroying the payroll.
 *
 * Mandatory and trimmed. Once the deletion commits, this sentence and the counts
 * beside it are the only surviving account of what was removed — the figures
 * themselves are gone, and deliberately not copied into the audit.
 */
export function validateDeletionReason(input: unknown): DeletionReasonResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'A reason for deleting this payroll is required.' }
  }
  const value = input.trim()
  if (value === '') {
    return { ok: false, error: 'A reason for deleting this payroll is required.' }
  }
  if (value.length > DELETION_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `The reason must be ${DELETION_REASON_MAX_LENGTH} characters or fewer.`,
    }
  }
  return { ok: true, value }
}

// ─── What the dialog lists ───────────────────────────────────────────────────

/**
 * What deletion removes and what it leaves, as two plain lists.
 *
 * Stated here rather than typed into the modal so the promise the dialog makes
 * is the same promise the migration keeps, and so a future change to the
 * deletion scope has one obvious place that also has to change.
 */
export function payrollDeletionScope(facts: Pick<PayrollDeletionFacts, 'resultCount' | 'settlementCount'>) {
  const removed = [
    `${facts.resultCount} employee payroll result${facts.resultCount === 1 ? '' : 's'} for this month`,
    'Every stored deduction and addition line behind those results',
    'The daily payroll breakdown shown on each payslip',
    'The calculation settings pinned to this payroll',
    'This payroll’s generation history and lock history',
  ]
  if (facts.settlementCount > 0) {
    removed.push(
      `${facts.settlementCount} unpaid settlement record${facts.settlementCount === 1 ? '' : 's'} for this month`,
    )
  }
  removed.push('Any payroll issue raised against these results, and its notifications')

  const kept = [
    'Attendance imports and raw attendance records',
    'Attendance corrections — kept in full',
    'Employee profiles and salary configuration',
    'Global Payroll Settings',
    'Every other payroll month',
    'Salary advances and other adjustments — returned to pending',
  ]

  return { removed, kept }
}
