// BOE Credits — the service layer. The only module that knows credits live in
// a database, and deliberately small: reads, the controlled writes, and the
// settings.
//
// WHO CALLS THIS, AND WITH WHAT
// -----------------------------
// The /api/boe-credits routes, with a SERVICE-ROLE client, after
// requireAdmin / requireSelfOrAdmin / resolveCaller
// (src/lib/security/attendancePayrollApiAuth.ts) has decided who is asking and
// which employee they may ask about. The route is the boundary for reads — the
// service role bypasses RLS — so every read here takes the employee id the
// route has already authorised, never one from a request body.
//
// Writes go through the database's SECURITY DEFINER functions, which only the
// service role can execute and which re-verify the actor. There is no other
// way a ledger row is written, and this file does not contain one: it never
// inserts into the ledger directly.
//
// THE BALANCES ARE READ, NOT COMPUTED HERE. getCreditBalance reads the
// boe_credit_balances view, which derives all three figures on every read:
//   available_credits    the recorded total, SUM(credits)
//   provisional_credits  rewards of review months still below the minimum
//   spendable_credits    available − provisional — the only figure a
//                        redemption may consume
// sumCredits in ./ledger exists for screens that already hold the rows; it is
// not a second source of truth.

import type { SupabaseClient } from '@supabase/supabase-js'
import { creditAmountIssue, creditReasonIssue } from './ledger'
import { parseBoeCreditSettings, DEFAULT_BOE_CREDIT_SETTINGS } from './settings'
import { isRedeemableDeductionType, type RedeemableDeductionType } from './attendanceRedemption'
import {
  isCreditTransactionType,
  type BoeCreditSettings,
  type CreditBalance,
  type CreditPayrollApplication,
  type CreditReviewMonth,
  type CreditReviewReward,
  type CreditTransaction,
  type CreditTransactionType,
  type EmployeeCreditBalance,
} from './types'

// Callers pass a service-role client in; we accept any schema parameterisation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Svc = SupabaseClient<any, any, any>

const LEDGER_COLUMNS =
  'id, employee_id, transaction_type, credits, source_type, source_id, payroll_period_id, description, created_by, created_at'

const BALANCE_COLUMNS =
  'employee_id, available_credits, provisional_credits, spendable_credits, transaction_count, last_transaction_at'

const SETTINGS_COLUMNS =
  'id, review_reward_credits, image_review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews, note, created_at, created_by'

const MONTH_COLUMNS =
  'id, employee_id, review_month, minimum_reviews_snapshot, qualifying_review_count, earned_review_credits, status, qualified_at, finalized_at, lapse_transaction_id'

const REWARD_COLUMNS =
  'transaction_id, employee_id, card_id, card_ref, submitted_at, review_month, review_month_id'

const APPLICATION_COLUMNS =
  'id, employee_id, payroll_period_id, credits_used, credit_value_snapshot, credit_amount_snapshot, redemption_transaction_id, reversal_transaction_id, reversed_at, created_at'

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Every refusal the database raises starts with a marker the route can map:
 *   BOE_CREDITS_ZERO, BOE_CREDITS_TYPE, BOE_CREDITS_REASON, BOE_CREDITS_SOURCE,
 *   BOE_CREDITS_SIGN, BOE_CREDITS_EMPLOYEE, BOE_CREDITS_ACTOR, BOE_CREDITS_DENIED,
 *   BOE_CREDITS_REVERSAL, BOE_CREDITS_DUPLICATE_SOURCE, BOE_CREDITS_INSUFFICIENT,
 *   BOE_CREDITS_APPEND_ONLY; from Phase 1C: BOE_CREDITS_REDEMPTION_TYPE,
 *   BOE_CREDITS_PERIOD, BOE_CREDITS_PERIOD_LOCKED, BOE_CREDITS_NOT_GENERATED,
 *   BOE_CREDITS_DATE, BOE_CREDITS_ALREADY_COVERED, BOE_CREDITS_REDEMPTION,
 *   BOE_CREDITS_ALREADY_REVERSED; from Phase 1D: BOE_CREDITS_SETTINGS,
 *   BOE_CREDITS_REVIEW_MONTH, BOE_CREDITS_MONTH_OPEN, BOE_CREDITS_MONTH_LAPSED.
 * The sentence after the colon is written for the person, and is what a route
 * shows. Anything without a marker is an unexpected failure.
 */
export class CreditServiceError extends Error {
  readonly marker: string | null
  readonly sqlstate: string | null
  constructor(message: string, marker: string | null, sqlstate: string | null) {
    super(message)
    this.name = 'CreditServiceError'
    this.marker = marker
    this.sqlstate = sqlstate
  }
}

// No `s` flag: the project targets ES2017. [\s\S] spans the newline a
// multi-line database message may carry.
const MARKER = /^(BOE_CREDITS_[A-Z_]+):\s*([\s\S]*)$/

/** Turn a PostgREST/RPC error into a CreditServiceError with its marker split out. */
export function creditErrorFrom(err: { message?: string; code?: string } | null | undefined, fallback: string): CreditServiceError {
  const raw = (err?.message ?? '').trim()
  const m = raw.match(MARKER)
  if (m) return new CreditServiceError(m[2].trim(), m[1], err?.code ?? null)
  return new CreditServiceError(raw || fallback, null, err?.code ?? null)
}

/** The HTTP status a route should answer with for a given refusal. */
export function creditErrorStatus(e: CreditServiceError): number {
  switch (e.marker) {
    case 'BOE_CREDITS_DENIED':           return 403
    case 'BOE_CREDITS_APPEND_ONLY':      return 403
    case 'BOE_CREDITS_EMPLOYEE':         return 404
    case 'BOE_CREDITS_ACTOR':            return 404
    case 'BOE_CREDITS_PERIOD':           return 404
    case 'BOE_CREDITS_REDEMPTION':       return 404
    case 'BOE_CREDITS_DUPLICATE_SOURCE': return 409
    case 'BOE_CREDITS_INSUFFICIENT':     return 409
    case 'BOE_CREDITS_ALREADY_COVERED':  return 409
    case 'BOE_CREDITS_ALREADY_REVERSED': return 409
    case 'BOE_CREDITS_PERIOD_LOCKED':    return 409
    case 'BOE_CREDITS_NOT_GENERATED':    return 409
    case 'BOE_CREDITS_MONTH_OPEN':       return 409
    case 'BOE_CREDITS_MONTH_LAPSED':     return 409
    case null:                           return 500
    default:                             return 422
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

const ZERO_BALANCE = (employeeId: string): CreditBalance => ({
  employee_id: employeeId,
  available_credits: 0,
  provisional_credits: 0,
  spendable_credits: 0,
  transaction_count: 0,
  last_transaction_at: null,
})

function toBalance(row: Record<string, unknown>): CreditBalance {
  return {
    employee_id:         String(row.employee_id),
    available_credits:   Number(row.available_credits ?? 0),
    provisional_credits: Number(row.provisional_credits ?? 0),
    spendable_credits:   Number(row.spendable_credits ?? 0),
    transaction_count:   Number(row.transaction_count ?? 0),
    last_transaction_at: (row.last_transaction_at as string | null) ?? null,
  }
}

/**
 * One employee's three figures — recorded, provisional, spendable — read
 * through the boe_credit_balances view. An employee with no rows is absent
 * from the view and has zero of each.
 */
export async function getCreditBalance(svc: Svc, employeeId: string): Promise<CreditBalance> {
  const { data, error } = await svc
    .from('boe_credit_balances')
    .select(BALANCE_COLUMNS)
    .eq('employee_id', employeeId)
    .maybeSingle()
  if (error) throw creditErrorFrom(error, 'Could not read the credit balance.')
  return data ? toBalance(data as Record<string, unknown>) : ZERO_BALANCE(employeeId)
}

export type CreditTransactionFilters = {
  /** Newest first; default 100, capped at 500. */
  limit?: number
  /** Only these kinds. */
  types?: readonly CreditTransactionType[]
}

/** One employee's ledger, newest first. */
export async function getCreditTransactions(
  svc: Svc,
  employeeId: string,
  filters: CreditTransactionFilters = {},
): Promise<CreditTransaction[]> {
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 500)
  let query = svc
    .from('boe_credit_transactions')
    .select(LEDGER_COLUMNS)
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)
  if (filters.types && filters.types.length > 0) query = query.in('transaction_type', [...filters.types])
  const { data, error } = await query
  if (error) throw creditErrorFrom(error, 'Could not read the credit history.')
  return (data ?? []) as CreditTransaction[]
}

/**
 * Every employee's balance, for the management list. Active payroll employees
 * are listed even when they hold no credits yet, so the screen shows zero
 * rather than omitting them; inactive employees appear only if they have a
 * ledger row, so history is never hidden.
 */
export async function getAllCreditBalances(svc: Svc): Promise<EmployeeCreditBalance[]> {
  const [{ data: balances, error: bErr }, { data: people, error: pErr }] = await Promise.all([
    svc.from('boe_credit_balances').select(BALANCE_COLUMNS),
    svc
      .from('users')
      .select('id, full_name, employee_code, is_active, is_deleted')
      .eq('is_deleted', false),
  ])
  if (bErr) throw creditErrorFrom(bErr, 'Could not read credit balances.')
  if (pErr) throw creditErrorFrom(pErr, 'Could not read employees.')

  const byEmployee = new Map<string, CreditBalance>()
  for (const raw of (balances ?? []) as Record<string, unknown>[]) {
    const b = toBalance(raw)
    byEmployee.set(b.employee_id, b)
  }

  const rows: EmployeeCreditBalance[] = []
  for (const u of (people ?? []) as { id: string; full_name: string; employee_code: string | null; is_active: boolean }[]) {
    const b = byEmployee.get(u.id)
    if (!b && !u.is_active) continue
    rows.push({
      ...(b ?? ZERO_BALANCE(u.id)),
      full_name: u.full_name,
      employee_code: u.employee_code ?? null,
    })
  }
  rows.sort((a, b) => a.full_name.localeCompare(b.full_name))
  return rows
}

function toMonth(row: Record<string, unknown>): CreditReviewMonth {
  return {
    id:                       String(row.id),
    employee_id:              String(row.employee_id),
    review_month:             String(row.review_month),
    minimum_reviews_snapshot: Number(row.minimum_reviews_snapshot),
    qualifying_review_count:  Number(row.qualifying_review_count),
    earned_review_credits:    Number(row.earned_review_credits),
    status:                   row.status as CreditReviewMonth['status'],
    qualified_at:             (row.qualified_at as string | null) ?? null,
    finalized_at:             (row.finalized_at as string | null) ?? null,
    lapse_transaction_id:     (row.lapse_transaction_id as string | null) ?? null,
  }
}

/** One employee's review months, newest first. */
export async function getCreditReviewMonths(svc: Svc, employeeId: string, limit = 12): Promise<CreditReviewMonth[]> {
  const { data, error } = await svc
    .from('boe_credit_review_months')
    .select(MONTH_COLUMNS)
    .eq('employee_id', employeeId)
    .order('review_month', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 120))
  if (error) throw creditErrorFrom(error, 'Could not read the review months.')
  return ((data ?? []) as Record<string, unknown>[]).map(toMonth)
}

/** Every employee's row for ONE review month — the admin's month-close list. */
export async function getCreditReviewMonthsFor(svc: Svc, reviewMonth: string): Promise<CreditReviewMonth[]> {
  const { data, error } = await svc
    .from('boe_credit_review_months')
    .select(MONTH_COLUMNS)
    .eq('review_month', reviewMonth)
  if (error) throw creditErrorFrom(error, 'Could not read the review months.')
  return ((data ?? []) as Record<string, unknown>[]).map(toMonth)
}

/** The reward records behind a set of ledger rows, keyed by transaction id. */
export async function getCreditReviewRewards(svc: Svc, transactionIds: readonly string[]): Promise<Map<string, CreditReviewReward>> {
  const out = new Map<string, CreditReviewReward>()
  if (transactionIds.length === 0) return out
  const { data, error } = await svc
    .from('boe_credit_review_rewards')
    .select(REWARD_COLUMNS)
    .in('transaction_id', [...transactionIds])
  if (error) throw creditErrorFrom(error, 'Could not read the review rewards.')
  for (const r of (data ?? []) as CreditReviewReward[]) out.set(r.transaction_id, r)
  return out
}

function toApplication(row: Record<string, unknown>): CreditPayrollApplication {
  return {
    id:                        String(row.id),
    employee_id:               String(row.employee_id),
    payroll_period_id:         String(row.payroll_period_id),
    credits_used:              Number(row.credits_used),
    credit_value_snapshot:     Number(row.credit_value_snapshot),
    credit_amount_snapshot:    Number(row.credit_amount_snapshot),
    redemption_transaction_id: String(row.redemption_transaction_id),
    reversal_transaction_id:   (row.reversal_transaction_id as string | null) ?? null,
    reversed_at:               (row.reversed_at as string | null) ?? null,
    created_at:                String(row.created_at),
  }
}

/** The payroll applications behind a set of ledger rows, keyed by their redemption transaction id. */
export async function getCreditPayrollApplicationsByTransaction(
  svc: Svc,
  transactionIds: readonly string[],
): Promise<Map<string, CreditPayrollApplication>> {
  const out = new Map<string, CreditPayrollApplication>()
  if (transactionIds.length === 0) return out
  const { data, error } = await svc
    .from('boe_credit_payroll_applications')
    .select(APPLICATION_COLUMNS)
    .in('redemption_transaction_id', [...transactionIds])
  if (error) throw creditErrorFrom(error, 'Could not read the payroll applications.')
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const a = toApplication(raw)
    out.set(a.redemption_transaction_id, a)
  }
  return out
}

/** The attendance redemption records behind a set of ledger rows, keyed by transaction id. */
export async function getAttendanceRedemptionsByTransaction(
  svc: Svc,
  transactionIds: readonly string[],
): Promise<Map<string, { id: string; attendance_date: string; deduction_type: RedeemableDeductionType; credits: number; reversal_transaction_id: string | null }>> {
  const out = new Map<string, { id: string; attendance_date: string; deduction_type: RedeemableDeductionType; credits: number; reversal_transaction_id: string | null }>()
  if (transactionIds.length === 0) return out
  const { data, error } = await svc
    .from('boe_credit_attendance_redemptions')
    .select('id, transaction_id, attendance_date, deduction_type, credits, reversal_transaction_id')
    .in('transaction_id', [...transactionIds])
  if (error) throw creditErrorFrom(error, 'Could not read the attendance redemptions.')
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    if (!isRedeemableDeductionType(raw.deduction_type)) continue
    out.set(String(raw.transaction_id), {
      id: String(raw.id),
      attendance_date: String(raw.attendance_date),
      deduction_type: raw.deduction_type,
      credits: Number(raw.credits),
      reversal_transaction_id: (raw.reversal_transaction_id as string | null) ?? null,
    })
  }
  return out
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export type PostCreditInput = {
  employeeId: string
  transactionType: CreditTransactionType
  /** Signed whole credits. Never zero. */
  credits: number
  sourceType: string
  sourceId: string | null
  description: string | null
  /** The authenticated caller, from the bearer token — never from a body. */
  actorId: string | null
  payrollPeriodId?: string | null
}

/**
 * Post one controlled ledger row through post_boe_credit_transaction().
 *
 * The same rules the database enforces are checked here first, so a bad
 * request is refused with a sentence rather than a round trip — but the
 * database is the guarantee, and this is not a substitute for it.
 */
export async function postCreditTransaction(svc: Svc, input: PostCreditInput): Promise<{ id: string }> {
  if (!isCreditTransactionType(input.transactionType)) {
    throw new CreditServiceError(`unknown transaction type ${String(input.transactionType)}`, 'BOE_CREDITS_TYPE', '22023')
  }
  const amountIssue = creditAmountIssue(input.credits)
  if (amountIssue) throw new CreditServiceError(amountIssue, 'BOE_CREDITS_ZERO', '22023')

  if (input.transactionType === 'admin_adjustment') {
    const reasonIssue = creditReasonIssue(input.description)
    if (reasonIssue) throw new CreditServiceError(reasonIssue, 'BOE_CREDITS_REASON', '22023')
    if (input.sourceType !== 'manual' || input.sourceId != null) {
      throw new CreditServiceError('an admin adjustment is a manual entry and carries no source id', 'BOE_CREDITS_SOURCE', '22023')
    }
  } else if (!input.sourceType || input.sourceType === 'manual' || !input.sourceId) {
    throw new CreditServiceError(`a ${input.transactionType} must name the source it came from`, 'BOE_CREDITS_SOURCE', '22023')
  }

  const { data, error } = await svc.rpc('post_boe_credit_transaction', {
    p_employee_id:       input.employeeId,
    p_transaction_type:  input.transactionType,
    p_credits:           input.credits,
    p_source_type:       input.sourceType,
    p_source_id:         input.sourceId,
    p_description:       input.description,
    p_actor_id:          input.actorId,
    p_payroll_period_id: input.payrollPeriodId ?? null,
  })
  if (error) throw creditErrorFrom(error, 'Could not record the credit transaction.')
  return { id: String(data) }
}

/** An administrator's correction: signed credits and a mandatory reason. */
export async function postAdminAdjustment(
  svc: Svc,
  input: { employeeId: string; credits: number; reason: string; actorId: string },
): Promise<{ id: string }> {
  return postCreditTransaction(svc, {
    employeeId: input.employeeId,
    transactionType: 'admin_adjustment',
    credits: input.credits,
    sourceType: 'manual',
    sourceId: null,
    description: input.reason,
    actorId: input.actorId,
  })
}

/**
 * Post the compensating row for one transaction. The original is untouched;
 * a new 'reversal' row with the amount negated is added, and the database
 * allows exactly one per original. The database refuses a reward whose month
 * has lapsed and a redemption inside a locked payroll month.
 */
export async function reverseCreditTransaction(
  svc: Svc,
  input: { transactionId: string; reason: string; actorId: string },
): Promise<{ id: string }> {
  const reasonIssue = creditReasonIssue(input.reason)
  if (reasonIssue) throw new CreditServiceError(reasonIssue, 'BOE_CREDITS_REASON', '22023')

  const { data, error } = await svc.rpc('reverse_boe_credit_transaction', {
    p_transaction_id: input.transactionId,
    p_actor_id:       input.actorId,
    p_reason:         input.reason,
  })
  if (error) throw creditErrorFrom(error, 'Could not reverse the credit transaction.')
  return { id: String(data) }
}

// ─── Attendance redemption (Phase 1C) ─────────────────────────────────────────

export type RedeemAttendanceDayInput = {
  /** The employee whose day is covered. From the token, never from a body. */
  employeeId: string
  payrollPeriodId: string
  /** YYYY-MM-DD */
  attendanceDate: string
  /** What the route found on the day after running the engine. */
  deductionType: RedeemableDeductionType
  /**
   * Who is acting: the employee themselves (the redemption route), or the
   * administrator whose attendance correction re-prices an existing coverage
   * (src/lib/payroll/creditCoverage.ts). The database admits nobody else.
   */
  actorId: string
}

export type RedeemAttendanceDayResult = {
  redemption_id: string
  transaction_id: string
  deduction_type: RedeemableDeductionType
  attendance_date: string
  /** What the day cost, at the settings price the database read. */
  credits: number
  /** The SPENDABLE balance afterwards. */
  available_credits: number
}

/**
 * Cover one attendance day with credits, through
 * redeem_boe_credits_for_attendance(). The database decides the cost (from
 * the settings), the period lock, the date window, the spendable balance and
 * the one-active-per-day rule under its own locks; the caller has already
 * decided the day carries a chargeable deduction.
 */
export async function redeemAttendanceDay(svc: Svc, input: RedeemAttendanceDayInput): Promise<RedeemAttendanceDayResult> {
  if (!isRedeemableDeductionType(input.deductionType)) {
    throw new CreditServiceError(`credits cover a half day or an absent day, not ${String(input.deductionType)}`, 'BOE_CREDITS_REDEMPTION_TYPE', '22023')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceDate)) {
    throw new CreditServiceError('a valid attendance date is required', 'BOE_CREDITS_DATE', '22023')
  }

  const { data, error } = await svc.rpc('redeem_boe_credits_for_attendance', {
    p_employee_id:       input.employeeId,
    p_payroll_period_id: input.payrollPeriodId,
    p_attendance_date:   input.attendanceDate,
    p_deduction_type:    input.deductionType,
    p_actor_id:          input.actorId,
  })
  if (error) throw creditErrorFrom(error, 'Could not apply the credits.')

  const out = (data ?? {}) as Partial<RedeemAttendanceDayResult>
  return {
    redemption_id:     String(out.redemption_id),
    transaction_id:    String(out.transaction_id),
    deduction_type:    input.deductionType,
    attendance_date:   input.attendanceDate,
    credits:           Number(out.credits),
    available_credits: Number(out.available_credits),
  }
}

export type ReverseAttendanceRedemptionResult = {
  redemption_id: string
  reversal_transaction_id: string
  /** The credits restored. */
  credits: number
  available_credits: number
}

/**
 * Withdraw one active coverage, through
 * reverse_boe_credit_attendance_redemption(): the compensating ledger row is
 * posted by reverse_boe_credit_transaction() — an active admin actor and a
 * reason, as every reversal needs — and the ledger trigger closes the record.
 * The original redemption row and its ledger row are untouched; both stay in
 * the employee's history beside the reversal.
 */
export async function reverseAttendanceRedemption(
  svc: Svc,
  input: { redemptionId: string; actorId: string; reason: string },
): Promise<ReverseAttendanceRedemptionResult> {
  const reasonIssue = creditReasonIssue(input.reason)
  if (reasonIssue) throw new CreditServiceError(reasonIssue, 'BOE_CREDITS_REASON', '22023')

  const { data, error } = await svc.rpc('reverse_boe_credit_attendance_redemption', {
    p_redemption_id: input.redemptionId,
    p_actor_id:      input.actorId,
    p_reason:        input.reason.trim(),
  })
  if (error) throw creditErrorFrom(error, 'Could not restore the credits.')

  const out = (data ?? {}) as Partial<ReverseAttendanceRedemptionResult>
  return {
    redemption_id:           String(out.redemption_id),
    reversal_transaction_id: String(out.reversal_transaction_id),
    credits:                 Number(out.credits),
    available_credits:       Number(out.available_credits),
  }
}

// ─── Payroll application (Phase 1D) ───────────────────────────────────────────

export type ApplyPayrollCreditsResult = {
  application_id: string
  transaction_id: string
  credits_used: number
  credit_value: number
  credit_amount: number
  spendable_credits: number
  replaced_application_id: string | null
  /** True when an identical active application already existed — nothing was written. */
  unchanged: boolean
}

/**
 * Apply N spendable credits to one payroll month as a salary addition,
 * through apply_boe_credits_to_payroll(). The actor MUST be the employee. The
 * database reads the rate, snapshots it with the rupees, checks the spendable
 * balance and the period lock, and replaces an existing application
 * atomically (reversal + new row); the same N twice is a no-op.
 */
export async function applyPayrollCredits(
  svc: Svc,
  input: { employeeId: string; payrollPeriodId: string; credits: number; actorId: string },
): Promise<ApplyPayrollCreditsResult> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new CreditServiceError('choose at least one credit to apply', 'BOE_CREDITS_ZERO', '22023')
  }
  const { data, error } = await svc.rpc('apply_boe_credits_to_payroll', {
    p_employee_id:       input.employeeId,
    p_payroll_period_id: input.payrollPeriodId,
    p_credits:           input.credits,
    p_actor_id:          input.actorId,
  })
  if (error) throw creditErrorFrom(error, 'Could not apply the credits to payroll.')
  const out = (data ?? {}) as Record<string, unknown>
  return {
    application_id:          String(out.application_id),
    transaction_id:          String(out.transaction_id),
    credits_used:            Number(out.credits_used),
    credit_value:            Number(out.credit_value),
    credit_amount:           Number(out.credit_amount),
    spendable_credits:       Number(out.spendable_credits),
    replaced_application_id: (out.replaced_application_id as string | null) ?? null,
    unchanged:               out.unchanged === true,
  }
}

export type RemovePayrollCreditsResult = {
  removed: boolean
  application_id: string | null
  reversal_transaction_id: string | null
  spendable_credits: number
}

/** Withdraw the active application for one month, through remove_boe_credit_payroll_application(). */
export async function removePayrollCredits(
  svc: Svc,
  input: { employeeId: string; payrollPeriodId: string; actorId: string },
): Promise<RemovePayrollCreditsResult> {
  const { data, error } = await svc.rpc('remove_boe_credit_payroll_application', {
    p_employee_id:       input.employeeId,
    p_payroll_period_id: input.payrollPeriodId,
    p_actor_id:          input.actorId,
  })
  if (error) throw creditErrorFrom(error, 'Could not remove the credits from payroll.')
  const out = (data ?? {}) as Record<string, unknown>
  return {
    removed:                 out.removed === true,
    application_id:          (out.application_id as string | null) ?? null,
    reversal_transaction_id: (out.reversal_transaction_id as string | null) ?? null,
    spendable_credits:       Number(out.spendable_credits ?? 0),
  }
}

// ─── Month finalization (Phase 1D) ────────────────────────────────────────────

export type FinalizeReviewMonthResult = {
  review_month_id: string
  status: CreditReviewMonth['status']
  qualifying_review_count: number
  minimum_reviews: number
  lapsed_credits: number
  lapse_transaction_id: string | null
  already_finalized: boolean
}

/**
 * Finalize one employee's review month, through
 * finalize_boe_credit_review_month(): admin actor, month ended, idempotent.
 */
export async function finalizeReviewMonth(
  svc: Svc,
  input: { employeeId: string; reviewMonth: string; actorId: string },
): Promise<FinalizeReviewMonthResult> {
  if (!/^\d{4}-\d{2}-01$/.test(input.reviewMonth)) {
    throw new CreditServiceError('a review month is named by its first day', 'BOE_CREDITS_REVIEW_MONTH', '22023')
  }
  const { data, error } = await svc.rpc('finalize_boe_credit_review_month', {
    p_employee_id:  input.employeeId,
    p_review_month: input.reviewMonth,
    p_actor_id:     input.actorId,
  })
  if (error) throw creditErrorFrom(error, 'Could not finalize the review month.')
  const out = (data ?? {}) as Record<string, unknown>
  return {
    review_month_id:         String(out.review_month_id),
    status:                  out.status as CreditReviewMonth['status'],
    qualifying_review_count: Number(out.qualifying_review_count),
    minimum_reviews:         Number(out.minimum_reviews),
    lapsed_credits:          Number(out.lapsed_credits ?? 0),
    lapse_transaction_id:    (out.lapse_transaction_id as string | null) ?? null,
    already_finalized:       out.already_finalized === true,
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export type ActiveCreditSettings = {
  settings: BoeCreditSettings
  id: string | null
  created_at: string | null
  created_by: string | null
  /** True when no usable row existed and the built-in defaults are being shown. */
  fell_back: boolean
}

function settingsFromRow(row: Record<string, unknown>) {
  return parseBoeCreditSettings({
    review_reward_credits:       row.review_reward_credits,
    // A row written before the image reward existed carries no value for it.
    // Falling back to the built-in default keeps fetchActiveCreditSettings()'s
    // promise that it never fails and never returns null — a screen must not go
    // blank because one column is younger than one row.
    image_review_reward_credits: row.image_review_reward_credits ?? DEFAULT_BOE_CREDIT_SETTINGS.image_review_reward_credits,
    credit_value:                row.credit_value,
    half_day_redemption_credits: row.half_day_redemption_credits,
    full_day_redemption_credits: row.full_day_redemption_credits,
    minimum_monthly_reviews:     row.minimum_monthly_reviews,
  })
}

/**
 * The settings in force — the newest row. Never throws and never returns
 * null: a screen must not fail because the settings table could not be read.
 * Every operational path (the payslip's offer, the payroll application form,
 * the knowledge page) reads THIS, so they cannot disagree about a price.
 */
export async function fetchActiveCreditSettings(svc: Svc): Promise<ActiveCreditSettings> {
  const fallback: ActiveCreditSettings = {
    settings: DEFAULT_BOE_CREDIT_SETTINGS,
    id: null,
    created_at: null,
    created_by: null,
    fell_back: true,
  }
  const { data, error } = await svc
    .from('boe_credit_settings')
    .select(SETTINGS_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return fallback

  const row = data as Record<string, unknown> & { id: string; created_at: string; created_by: string | null }
  const parsed = settingsFromRow(row)
  if (!parsed.ok) {
    console.error('[boe-credits/settings] active settings row did not parse:', parsed.issues)
    return { ...fallback, id: row.id, created_at: row.created_at, created_by: row.created_by }
  }
  return { settings: parsed.settings, id: row.id, created_at: row.created_at, created_by: row.created_by, fell_back: false }
}

/**
 * Save a new settings row. An INSERT, never an UPDATE — the table is
 * append-only and a trigger enforces it. `createdBy` is the admin who saved,
 * from the bearer token.
 */
export async function saveCreditSettings(
  svc: Svc,
  settings: BoeCreditSettings,
  createdBy: string,
  note?: string | null,
): Promise<{ id: string; created_at: string }> {
  const parsed = parseBoeCreditSettings(settings)
  if (!parsed.ok) {
    throw new CreditServiceError(
      `refusing to store invalid settings — ${parsed.issues.map(i => i.message).join(' ')}`,
      'BOE_CREDITS_SETTINGS',
      '22023',
    )
  }
  const { data, error } = await svc
    .from('boe_credit_settings')
    .insert({
      review_reward_credits:       parsed.settings.review_reward_credits,
      image_review_reward_credits: parsed.settings.image_review_reward_credits,
      credit_value:                parsed.settings.credit_value,
      half_day_redemption_credits: parsed.settings.half_day_redemption_credits,
      full_day_redemption_credits: parsed.settings.full_day_redemption_credits,
      minimum_monthly_reviews:     parsed.settings.minimum_monthly_reviews,
      created_by: createdBy,
      note: note ?? null,
    })
    .select('id, created_at')
    .single()
  if (error || !data) throw creditErrorFrom(error, 'Could not save the credit settings.')
  return data as { id: string; created_at: string }
}

export type CreditSettingsHistoryRow = BoeCreditSettings & {
  id: string
  note: string | null
  created_by: string | null
  created_at: string
}

/** Every settings row, newest first — the audit trail. */
export async function fetchCreditSettingsHistory(svc: Svc, limit = 20): Promise<CreditSettingsHistoryRow[]> {
  const { data, error } = await svc
    .from('boe_credit_settings')
    .select(SETTINGS_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw creditErrorFrom(error, 'Could not read the settings history.')
  return ((data ?? []) as Record<string, unknown>[]).map(r => ({
    id:                          String(r.id),
    review_reward_credits:       Number(r.review_reward_credits),
    image_review_reward_credits: Number(r.image_review_reward_credits ?? DEFAULT_BOE_CREDIT_SETTINGS.image_review_reward_credits),
    credit_value:                Number(r.credit_value),
    half_day_redemption_credits: Number(r.half_day_redemption_credits ?? DEFAULT_BOE_CREDIT_SETTINGS.half_day_redemption_credits),
    full_day_redemption_credits: Number(r.full_day_redemption_credits ?? DEFAULT_BOE_CREDIT_SETTINGS.full_day_redemption_credits),
    minimum_monthly_reviews:     Number(r.minimum_monthly_reviews ?? DEFAULT_BOE_CREDIT_SETTINGS.minimum_monthly_reviews),
    note:                        (r.note as string | null) ?? null,
    created_by:                  (r.created_by as string | null) ?? null,
    created_at:                  String(r.created_at),
  }))
}
