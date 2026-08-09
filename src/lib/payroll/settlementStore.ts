// Settlement — database I/O.
//
// The pure arithmetic lives in ./settlement and never touches Supabase; this is
// the only module that reads or writes payroll_settlements and its event log.
// Same split as engine.ts / store.ts, for the same reason: the money rules stay
// testable without a database.
//
// Nothing here calls the payroll engine. Recording a payment or correcting a
// carry-forward must not rerun attendance, and the way to guarantee that is for
// this file to have no path to it.

import { computeSettlement, proposedCarryForwardFrom, sameMoney } from './settlement'

// Callers pass a service-role client; we accept any schema parameterisation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

export type SettlementRow = {
  id: string
  payroll_period_id: string
  employee_id: string
  payroll_result_id: string | null
  proposed_carry_forward: number
  carry_forward_source_period_id: string | null
  carry_forward_amount: number
  carry_forward_is_manual: boolean
  carry_forward_remark: string | null
  carry_forward_set_by: string | null
  carry_forward_set_at: string | null
  amount_paid: number | null
  payment_date: string | null
  payment_remark: string | null
  payment_recorded_by: string | null
  payment_recorded_at: string | null
}

/**
 * Exported so a mutation can ask PostgREST to hand the updated row back on the
 * same round trip (`.update(...).select(SETTLEMENT_COLS).single()`) instead of
 * paying for a second read to find out what it just wrote.
 */
export const SETTLEMENT_COLS = `
  id, payroll_period_id, employee_id, payroll_result_id,
  proposed_carry_forward, carry_forward_source_period_id,
  carry_forward_amount, carry_forward_is_manual, carry_forward_remark,
  carry_forward_set_by, carry_forward_set_at,
  amount_paid, payment_date, payment_remark,
  payment_recorded_by, payment_recorded_at
`

export type SettlementEvent =
  | 'carry_forward_proposed'
  | 'carry_forward_overridden'
  | 'carry_forward_reset'
  | 'payment_recorded'
  | 'payment_changed'
  | 'payment_cleared'

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function fetchSettlement(
  svc: Svc,
  periodId: string,
  employeeId: string,
): Promise<SettlementRow | null> {
  const { data, error } = await svc
    .from('payroll_settlements')
    .select(SETTLEMENT_COLS)
    .eq('payroll_period_id', periodId)
    .eq('employee_id', employeeId)
    .maybeSingle()

  if (error) throw new Error(`fetchSettlement: ${error.message}`)
  return (data as SettlementRow) ?? null
}

export type PeriodRef = { id: string; payroll_month: number; payroll_year: number }

/**
 * The payroll period immediately preceding this one IN THE PAYROLL SEQUENCE.
 *
 * Not the previous calendar month, which is what this used to do. BOE's payroll
 * months are not guaranteed to be contiguous: if May and July exist but June was
 * never run, July's prior period is MAY. Looking up "June" found nothing and
 * silently proposed a zero carry-forward, quietly dropping whatever May left
 * outstanding.
 *
 * Pure, so the selection rule is testable without a database — the ordering is
 * the part that goes wrong.
 */
export function selectPrecedingPeriod(
  periods: PeriodRef[],
  month: number,
  year: number,
): PeriodRef | null {
  const earlier = periods.filter(p =>
    p.payroll_year < year || (p.payroll_year === year && p.payroll_month < month),
  )
  if (earlier.length === 0) return null

  // The latest of the earlier ones — the immediate predecessor in the sequence.
  return earlier.reduce((latest, p) =>
    p.payroll_year > latest.payroll_year ||
    (p.payroll_year === latest.payroll_year && p.payroll_month > latest.payroll_month)
      ? p
      : latest,
  )
}

/**
 * The preceding payroll period, read from the database.
 *
 * Bounded to years at or before this one and then decided in memory: PostgREST
 * has no clean tuple comparison for (year, month), and the period table holds
 * one row per payroll month — tens of rows, not thousands.
 */
export async function fetchPrecedingPeriod(
  svc: Svc,
  month: number,
  year: number,
): Promise<PeriodRef | null> {
  const { data, error } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year')
    .lte('payroll_year', year)

  if (error) throw new Error(`fetchPrecedingPeriod: ${error.message}`)
  return selectPrecedingPeriod((data ?? []) as PeriodRef[], month, year)
}

/**
 * What the preceding payroll period left outstanding for this employee.
 *
 * `resolved` is the load-bearing part. A prior month whose payment was never
 * recorded has NO confirmed closing balance, so nothing may be carried from it:
 * treating it as though ₹0 had been paid would invent a debt for the whole of
 * that month's Salary Payable and push it forward as if it were a reviewed
 * figure. The caller stores 0 and the unresolved state is surfaced instead.
 *
 * Recomputed from the prior month's own stored records rather than read from a
 * saved total, so a period regenerated after its balance was proposed yields an
 * honest figure rather than a stale one.
 */
export type PriorBalance = {
  /** The amount to propose. 0 whenever nothing can be confirmed. */
  amount: number
  /** False when the prior month has no result, or no recorded payment. */
  resolved: boolean
}

export async function previousClosingBalance(
  svc: Svc,
  previousPeriodId: string,
  employeeId: string,
): Promise<PriorBalance> {
  const { data: prevResult, error } = await svc
    .from('payroll_results')
    .select('gross_salary, total_deductions, pending_adjustment_total, days_present')
    .eq('payroll_period_id', previousPeriodId)
    .eq('employee_id', employeeId)
    .maybeSingle()

  if (error) throw new Error(`previousClosingBalance: ${error.message}`)

  // Not paid in that month at all — a month an employee has no result in owes
  // them nothing and is not an unresolved settlement either.
  if (!prevResult) return { amount: 0, resolved: true }

  const prevSettlement = await fetchSettlement(svc, previousPeriodId, employeeId)
  const figures = computeSettlement(prevResult, prevSettlement)

  return {
    amount:   proposedCarryForwardFrom(figures.closing_balance),
    resolved: figures.closing_balance != null,
  }
}

// ─── Event log ────────────────────────────────────────────────────────────────

/**
 * Record a change that moved money.
 *
 * Never throws into the caller's path: a settlement change that succeeded must
 * not be reported as failed because its audit row could not be written. The
 * failure is logged loudly instead, which is the same posture the payroll
 * period status trail takes.
 */
export async function logSettlementEvent(
  svc: Svc,
  settlementId: string,
  event: SettlementEvent,
  detail: {
    previousAmount?: number | null
    newAmount?: number | null
    remark?: string | null
    actorId?: string | null
    actorName?: string | null
  } = {},
): Promise<void> {
  const { error } = await svc.from('payroll_settlement_events').insert({
    payroll_settlement_id: settlementId,
    event,
    previous_amount: detail.previousAmount ?? null,
    new_amount:      detail.newAmount ?? null,
    remark:          detail.remark ?? null,
    actor_id:        detail.actorId ?? null,
    actor_name:      detail.actorName ?? null,
  })
  if (error) console.error(`[payroll/settlement] event ${event} not recorded:`, error.message)
}

// ─── Materialisation ──────────────────────────────────────────────────────────

export type Actor = { id: string | null; name: string | null }

/**
 * Why the proposal is what it is, for the audit trail.
 *
 * The unresolved case is called out explicitly rather than logged as an ordinary
 * zero: "nothing was owed" and "we do not yet know what was owed" are different
 * facts, and only one of them needs somebody to go and record a payment.
 */
function proposalRemark(previousPeriodId: string | null, resolved: boolean): string {
  if (!previousPeriodId) return 'No previous payroll period'
  if (!resolved) {
    return 'Previous payroll period has no recorded payment — nothing carried forward'
  }
  return 'Carried from the preceding payroll period'
}

/**
 * Create or refresh the settlement row for one employee in one period.
 *
 * Called from payroll generation, which is already refused on a locked period —
 * so this never has to reopen one. It is the moment the carry-forward proposal
 * becomes a stored fact with a traceable source, rather than something derived
 * on the fly whose lineage nobody can audit later.
 *
 * THE RULES A REGENERATION MUST NOT BREAK, and how each is kept:
 *
 *   * A manual override survives. When carry_forward_is_manual is true this
 *     touches neither the amount, the remark, nor the recorded proposal — a
 *     regeneration is not a decision to discard the admin's correction.
 *   * A recorded payment survives. No branch here writes amount_paid,
 *     payment_date or payment_remark at all.
 *   * A partial regeneration touches only its own employees, because this is
 *     called once per employee with that employee's own ids.
 */
export async function materialiseSettlement(
  svc: Svc,
  args: {
    periodId: string
    employeeId: string
    resultId: string
    /** Null when this is the first payroll month BOE has run. */
    previousPeriodId: string | null
    actor: Actor
  },
): Promise<void> {
  const { periodId, employeeId, resultId, previousPeriodId, actor } = args

  const prior = previousPeriodId
    ? await previousClosingBalance(svc, previousPeriodId, employeeId)
    : { amount: 0, resolved: true }

  const proposed = prior.amount

  // The source period is recorded whenever one exists, INCLUDING when its
  // settlement is unresolved — it explains why the proposal is zero and points
  // an admin at the month that still needs a payment recorded. It never creates
  // a financial carry-forward on its own; `proposed` is what does that, and it
  // is 0 here.
  const sourcePeriodId = previousPeriodId

  const existing = await fetchSettlement(svc, periodId, employeeId)

  // ── First time this employee-month has been settled ──────────────────────
  if (!existing) {
    const { data, error } = await svc
      .from('payroll_settlements')
      .insert({
        payroll_period_id:              periodId,
        employee_id:                    employeeId,
        payroll_result_id:              resultId,
        proposed_carry_forward:         proposed,
        carry_forward_source_period_id: sourcePeriodId,
        carry_forward_amount:           proposed,
        carry_forward_is_manual:        false,
      })
      .select('id')
      .single()

    if (error) throw new Error(`materialiseSettlement insert: ${error.message}`)

    await logSettlementEvent(svc, (data as { id: string }).id, 'carry_forward_proposed', {
      newAmount: proposed,
      remark:    proposalRemark(previousPeriodId, prior.resolved),
      actorId:   actor.id,
      actorName: actor.name,
    })
    return
  }

  // ── An admin has corrected this balance: leave it entirely alone ─────────
  // Only the link to the (possibly new) result row is refreshed, so the
  // settlement still points at the payroll it settles.
  if (existing.carry_forward_is_manual) {
    if (existing.payroll_result_id !== resultId) {
      const { error } = await svc
        .from('payroll_settlements')
        .update({ payroll_result_id: resultId, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) throw new Error(`materialiseSettlement relink: ${error.message}`)
    }
    return
  }

  // ── Still on the automatic value: refresh from the preceding period ──────
  const changed = !sameMoney(Number(existing.carry_forward_amount), proposed)

  const { error } = await svc
    .from('payroll_settlements')
    .update({
      payroll_result_id:              resultId,
      proposed_carry_forward:         proposed,
      carry_forward_source_period_id: sourcePeriodId,
      carry_forward_amount:           proposed,
      updated_at:                     new Date().toISOString(),
    })
    .eq('id', existing.id)

  if (error) throw new Error(`materialiseSettlement refresh: ${error.message}`)

  // Only worth an audit row when the figure actually moved; a regeneration that
  // reproduces the same balance is not an event anybody needs to read about.
  if (changed) {
    await logSettlementEvent(svc, existing.id, 'carry_forward_proposed', {
      previousAmount: Number(existing.carry_forward_amount),
      newAmount:      proposed,
      remark:         proposalRemark(previousPeriodId, prior.resolved),
      actorId:        actor.id,
      actorName:      actor.name,
    })
  }
}

/**
 * Ensure a settlement row exists so a mutation has something to write to.
 *
 * Payroll generated before this feature existed left no settlement rows behind,
 * and an admin recording a payment against one of those months must not be told
 * to regenerate payroll to do it — regeneration is an attendance operation and
 * has no business being a precondition for recording money.
 */
export async function ensureSettlement(
  svc: Svc,
  periodId: string,
  employeeId: string,
): Promise<SettlementRow> {
  const existing = await fetchSettlement(svc, periodId, employeeId)
  if (existing) return existing

  const { data, error } = await svc
    .from('payroll_settlements')
    .insert({ payroll_period_id: periodId, employee_id: employeeId })
    .select(SETTLEMENT_COLS)
    .single()

  if (error) throw new Error(`ensureSettlement: ${error.message}`)
  return data as SettlementRow
}
