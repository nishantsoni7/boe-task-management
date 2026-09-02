// BOE Credits — the shapes shared by the service, the routes and the screens.
//
// Employees see CREDITS, never rupees — except on the one screen where credits
// become rupees, the payroll application, and there the rate is the server's.
// A credit is a whole number.

/** The five kinds a ledger row can be. Mirrors the CHECK on the table (Phase 1D added the lapse). */
export const CREDIT_TRANSACTION_TYPES = [
  'review_reward',
  'redemption',
  'reversal',
  'admin_adjustment',
  'review_month_lapse',
] as const

export type CreditTransactionType = (typeof CREDIT_TRANSACTION_TYPES)[number]

export function isCreditTransactionType(value: unknown): value is CreditTransactionType {
  return typeof value === 'string' && (CREDIT_TRANSACTION_TYPES as readonly string[]).includes(value)
}

/**
 * Where a row came from. The ledger stores a type/id pair rather than a
 * foreign key so it is not coupled to the Review Workflow's tables. 'manual'
 * is the sourceless kind: an admin adjustment.
 */
export type CreditSourceType =
  | 'customer_review'
  /** A Phase 1C attendance redemption; source_id = boe_credit_attendance_redemptions.id. */
  | 'attendance_redemption'
  /** A Phase 1D payroll application; source_id = boe_credit_payroll_applications.id. */
  | 'payroll_redemption'
  /** A Phase 1D month lapse; source_id = boe_credit_review_months.id. */
  | 'boe_credit_review_month'
  | 'boe_credit_transaction'
  | 'manual'

/** One ledger row, exactly as public.boe_credit_transactions stores it. */
export type CreditTransaction = {
  id: string
  employee_id: string
  transaction_type: CreditTransactionType
  /** Signed whole credits. Positive earns, negative spends. Never zero. */
  credits: number
  source_type: string
  source_id: string | null
  payroll_period_id: string | null
  description: string | null
  /** null = the system posted it. */
  created_by: string | null
  created_at: string
}

/**
 * One row of public.boe_credit_balances.
 *
 * THREE FIGURES, and only one of them can be spent:
 *   available_credits    the recorded total, SUM(credits) — every row counted
 *   provisional_credits  review rewards of months still below the monthly
 *                        minimum: recorded, visible, not spendable
 *   spendable_credits    available − provisional; what a redemption may use
 */
export type CreditBalance = {
  employee_id: string
  available_credits: number
  provisional_credits: number
  spendable_credits: number
  transaction_count: number
  last_transaction_at: string | null
}

/** A balance row joined to the employee it belongs to, for the management list. */
export type EmployeeCreditBalance = CreditBalance & {
  full_name: string
  employee_code: string | null
}

/**
 * The active settings. Five numbers, global, admin-managed; each applies to
 * FUTURE actions only — see settings.ts.
 */
export type BoeCreditSettings = {
  /** Credits ONE verified review earns. */
  review_reward_credits: number
  /** Rupees ONE credit is worth when applied to payroll. Snapshotted per application. */
  credit_value: number
  /** Credits that cover a chargeable Half Day. */
  half_day_redemption_credits: number
  /** Credits that cover a chargeable Absent (full) day. Independent of the half day. */
  full_day_redemption_credits: number
  /** Verified reviews a month needs before its rewards become spendable. */
  minimum_monthly_reviews: number
}

// ─── Phase 1D records ─────────────────────────────────────────────────────────

export type CreditReviewMonthStatus = 'open' | 'qualified' | 'lapsed'

/** One row of public.boe_credit_review_months: an employee's review month. */
export type CreditReviewMonth = {
  id: string
  employee_id: string
  /** The first day of the month, YYYY-MM-01. */
  review_month: string
  minimum_reviews_snapshot: number
  /** Verified reviews still counting (rewarded and not reversed). */
  qualifying_review_count: number
  /** Reward credits still counting (rewarded and not reversed). */
  earned_review_credits: number
  status: CreditReviewMonthStatus
  qualified_at: string | null
  finalized_at: string | null
  lapse_transaction_id: string | null
}

/** One row of public.boe_credit_review_rewards: which review a reward was for, and its month. */
export type CreditReviewReward = {
  transaction_id: string
  employee_id: string
  card_id: string
  card_ref: string
  submitted_at: string
  review_month: string
  review_month_id: string
}

/** One row of public.boe_credit_payroll_applications. ACTIVE while reversal_transaction_id is null. */
export type CreditPayrollApplication = {
  id: string
  employee_id: string
  payroll_period_id: string
  credits_used: number
  /** Rupees per credit at the moment of application. Never re-priced. */
  credit_value_snapshot: number
  /** credits_used × credit_value_snapshot, as stored. */
  credit_amount_snapshot: number
  redemption_transaction_id: string
  reversal_transaction_id: string | null
  reversed_at: string | null
  created_at: string
}
