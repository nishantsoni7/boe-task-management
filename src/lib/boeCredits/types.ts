// BOE Credits — the shapes shared by the service, the routes and the screens.
//
// Employees see CREDITS, never rupees. A credit is a whole number; the rupee
// value of one lives in the settings and is a later Payroll phase's concern,
// not the ledger's — and NOT attendance redemption's either: a half day costs
// 1 credit and an absent day 2, fixed (see ./attendanceRedemption.ts).

/** The four kinds a ledger row can be. Mirrors the CHECK on the table. */
export const CREDIT_TRANSACTION_TYPES = [
  'review_reward',
  'redemption',
  'reversal',
  'admin_adjustment',
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
  | 'payroll_period'
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

/** One row of public.boe_credit_balances. */
export type CreditBalance = {
  employee_id: string
  available_credits: number
  transaction_count: number
  last_transaction_at: string | null
}

/** A balance row joined to the employee it belongs to, for the management list. */
export type EmployeeCreditBalance = CreditBalance & {
  full_name: string
  employee_code: string | null
}

/** The active settings. Two numbers, two different things — see settings.ts. */
export type BoeCreditSettings = {
  /** How many credits a verified review earns (Phase 1B reads this). */
  review_reward_credits: number
  /**
   * The rupee value of one credit, reserved for a later Payroll phase.
   * Attendance redemption (Phase 1C) never reads it — its cost is fixed.
   */
  credit_value: number
}
