// BOE Credits — Phase 1C: spending credits on an attendance deduction, as pure
// rules with no database in sight.
//
// THE COST, STATED ONCE
// ---------------------
//   Half Day  = 1 credit
//   Absent    = 2 credits
//
// Whole credits, fixed, and NOT linked to salary, to rupees or to
// boe_credit_settings.credit_value. The same two literals live in
// redeem_boe_credits_for_attendance() (20261103000000) and
// attendanceRedemption.test.ts pins the two against each other.
//
// WHAT QUALIFIES
// --------------
// Only a deduction that actually takes money off the month: an `absent` or
// `half_day` line the payroll engine settled at more than ₹0. A raw "Absent"
// on the attendance screen is not enough — the month's paid leave may already
// have made it cost nothing, or the day may be a Sunday. So eligibility is
// asked of the ENGINE'S day result, never of the attendance status, and the
// server asks it again before anything is written.
//
// Deliberately NOT covered: late marks, missing punches, short hours, company-
// paid (paid leave) days, days already covered, dates in the future, anything
// on a locked month.

import type { DeductionWaiver } from '../payroll/types'

export const ATTENDANCE_REDEMPTION_COST = {
  half_day: 1,
  absent:   2,
} as const

export type RedeemableDeductionType = keyof typeof ATTENDANCE_REDEMPTION_COST

export const REDEEMABLE_DEDUCTION_TYPES = Object.keys(ATTENDANCE_REDEMPTION_COST) as RedeemableDeductionType[]

export function isRedeemableDeductionType(value: unknown): value is RedeemableDeductionType {
  return typeof value === 'string' && value in ATTENDANCE_REDEMPTION_COST
}

/** The waiver the engine writes on a line credits covered. */
export const CREDIT_COVERED_WAIVER: DeductionWaiver = 'boe_credits'

/**
 * One covered day, as the payroll engine consumes it. Read from
 * boe_credit_attendance_redemptions, active rows only — those whose ledger
 * row has not been reversed (src/lib/payroll/store.ts). The ledger row
 * behind it is transaction_type 'redemption', source_type
 * 'attendance_redemption', source_id = the record's id.
 */
export type AttendanceCreditRedemption = {
  attendance_date: string
  deduction_type: RedeemableDeductionType
  /** Credits spent, as written on the record. */
  credits: number
}

/**
 * Whether a redemption bought against one kind of day still covers the day
 * as it is NOW classified. Attendance can change after a redemption (an import,
 * a correction): an absent-day redemption is worth a full day and therefore
 * covers a day that became a half day; a half-day redemption does not cover a
 * day that became a full absence.
 */
export function redemptionCovers(redeemed: RedeemableDeductionType, line: RedeemableDeductionType): boolean {
  if (redeemed === 'absent') return true
  return line === 'half_day'
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export const REDEEMABLE_DEDUCTION_LABELS: Record<RedeemableDeductionType, string> = {
  half_day: 'Half Day',
  absent:   'Absent',
}

/** "1 credit" / "2 credits". */
export function creditsWord(n: number): string {
  return `${n} ${n === 1 ? 'credit' : 'credits'}`
}

/** "Half Day · 1 credit" — the row's offer. */
export function redemptionOfferLabel(type: RedeemableDeductionType): string {
  return `${REDEEMABLE_DEDUCTION_LABELS[type]} · ${creditsWord(ATTENDANCE_REDEMPTION_COST[type])}`
}

/** "Covered with 1 BOE Credit" — the row's state afterwards. */
export function coveredLabel(credits: number): string {
  return `Covered with ${credits} BOE ${credits === 1 ? 'Credit' : 'Credits'}`
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/** The part of an engine day this module reads. Structural, so payroll owns the full type. */
export type RedeemableDayInput = {
  date: string
  deduction_lines: readonly {
    deduction_type: string
    amount_deducted: number
    waived_by?: string
    credits_redeemed?: number
  }[]
}

export type RedemptionIneligibleReason =
  | 'locked'
  | 'future_date'
  | 'not_in_period'
  | 'no_deduction'
  | 'not_day_deduction'
  | 'company_paid'
  | 'already_covered'

export type RedemptionEligibility =
  | {
      eligible: true
      deduction_type: RedeemableDeductionType
      credits: number
      /** What the line costs today, whole rupees, for the confirmation. */
      amount: number
    }
  | { eligible: false; reason: RedemptionIneligibleReason; message: string }

export const REDEMPTION_REFUSALS: Record<RedemptionIneligibleReason, string> = {
  locked:            'Payroll for this month is locked, so credits can no longer be applied to it.',
  future_date:       'Credits cannot be applied to a date that has not happened yet.',
  not_in_period:     'That date is not inside this payroll month.',
  no_deduction:      'There is no salary deduction on this date to cover.',
  not_day_deduction: 'Credits can only cover a half-day or absent-day deduction. Late arrivals, early departures and missing punches are not covered.',
  company_paid:      'This day is already covered by your paid leave, so no credits are needed.',
  already_covered:   'This day is already covered with BOE Credits.',
}

function refuse(reason: RedemptionIneligibleReason): RedemptionEligibility {
  return { eligible: false, reason, message: REDEMPTION_REFUSALS[reason] }
}

/**
 * May this employee cover this day with credits?
 *
 * `day` is the engine's settled day result for the date, or undefined when the
 * date is not a working day of the month (weekly off, holiday, pre-joining —
 * the engine produces no lines for those either way). `periodStatus` is the
 * payroll period's, `today` is the IST date.
 */
export function attendanceRedemptionEligibility(
  day: RedeemableDayInput | undefined,
  ctx: { periodStatus: 'draft' | 'generated' | 'locked'; today: string; periodMonth: number; periodYear: number },
): RedemptionEligibility {
  if (ctx.periodStatus === 'locked') return refuse('locked')
  if (!day) return refuse('no_deduction')

  const [y, m] = day.date.split('-').map(Number)
  if (y !== ctx.periodYear || m !== ctx.periodMonth) return refuse('not_in_period')
  if (day.date > ctx.today) return refuse('future_date')

  const dayLines = day.deduction_lines.filter(l => isRedeemableDeductionType(l.deduction_type))
  if (dayLines.length === 0) {
    return day.deduction_lines.length === 0 ? refuse('no_deduction') : refuse('not_day_deduction')
  }

  // A date carries at most one absent/half-day line: the engine raises them
  // from the classification, and a day has exactly one.
  const line = dayLines[0]
  if (line.waived_by === CREDIT_COVERED_WAIVER) return refuse('already_covered')
  if (line.waived_by != null || line.amount_deducted <= 0) return refuse('company_paid')

  const deduction_type = line.deduction_type as RedeemableDeductionType
  return {
    eligible: true,
    deduction_type,
    credits: ATTENDANCE_REDEMPTION_COST[deduction_type],
    amount: line.amount_deducted,
  }
}

/** One redeemable date, as the detail payload lists them for the employee. */
export type RedeemableDate = {
  date: string
  deduction_type: RedeemableDeductionType
  credits: number
  amount: number
}
