// GET  /api/payroll/delete?period_id=…   — what deleting this payroll would do
// POST /api/payroll/delete               — delete it
//
// Admin only, both verbs. The GET exists so the confirmation dialog can state
// facts rather than guesses: how many employee results the period holds, whether
// any payment has been recorded against it, and — if the period cannot be
// deleted — which rule refused it and what has to happen first. A dialog that
// offered a button the POST would reject would be worse than no button.
//
// POST body
//   payroll_period_id  string  required
//   payroll_month      number  required — must match the stored period
//   payroll_year       number  required — must match the stored period
//   confirmation       string  required — the typed "July 2026"
//   reason             string  required, non-blank — kept in the deletion audit
//
// WHY MONTH AND YEAR ARE IN THE BODY
// ----------------------------------
// They are not used to FIND the period — the id does that, and nothing here ever
// deletes by a month query. They are used to REFUSE. A client that sends an id
// which no longer means what it displayed (a stale tab, a retried request after
// someone else deleted and recreated the month) is turned away instead of
// erasing a payroll nobody chose. The database re-checks the same equality.
//
// The deletion itself is one call to public.delete_payroll_period(), which is a
// single transaction. This route never issues a DELETE of its own, so there is
// no sequence of statements here that could half-succeed.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse, type ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import {
  canDeletePayrollPeriod,
  payrollDeletionConfirmationMatches,
  payrollDeletionConfirmationText,
  payrollDeletionScope,
  validateDeletionReason,
  type PayrollDeletionFacts,
  type PayrollDeletionPermission,
  type PeriodStatus,
} from '@/lib/payroll/deletionRules'

export type PayrollDeletionPreview = {
  payroll_period_id: string
  payroll_month: number
  payroll_year: number
  period_label: string
  status: PeriodStatus
  facts: PayrollDeletionFacts
  permission: PayrollDeletionPermission
  /** What the dialog lists as removed and as kept. */
  scope: ReturnType<typeof payrollDeletionScope>
  /** The exact words the admin has to type. */
  confirmation_text: string
}

/**
 * Everything the decision needs, counted in the database.
 *
 * Counts only — `head: true` with `count: 'exact'` returns no rows at all, so
 * this cannot pull a salary figure across the wire on its way to answering "may
 * this be deleted". Returns null when the period does not exist.
 *
 * Exported so the behavioural tests can exercise it against a real database
 * without going through HTTP and auth, the same arrangement as
 * getOrCreatePayrollPeriod in ../periods/route.ts.
 */
export async function collectDeletionFacts(
  svc: ServiceClient,
  periodId: string,
): Promise<{ month: number; year: number; status: PeriodStatus; facts: PayrollDeletionFacts } | null> {
  const { data: period } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status')
    .eq('id', periodId)
    .maybeSingle()

  if (!period) return null

  const status = period.status as PeriodStatus

  // `head: true` with an exact count returns no rows at all, so nothing here can
  // pull a salary figure across the wire on its way to answering "may this be
  // deleted".
  const countOf = async (
    table: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply: (q: any) => any,
  ): Promise<number> => {
    const { count, error } = await apply(
      svc.from(table).select('id', { count: 'exact', head: true }),
    )
    if (error) throw new Error(`collectDeletionFacts ${table}: ${error.message}`)
    return count ?? 0
  }

  const [
    resultCount,
    settlementCount,
    paidAmount,
    paidDate,
    paidAt,
    lockedResultCount,
    runningCount,
    carryForwardDependentCount,
  ] = await Promise.all([
    countOf('payroll_results',     q => q.eq('payroll_period_id', periodId)),
    countOf('payroll_settlements', q => q.eq('payroll_period_id', periodId)),
    // Three separate reads rather than one `.or()`: a settlement counts as paid
    // if ANY of the three payment columns is set, and PostgREST's or() syntax
    // over null checks is exactly the kind of expression that is easy to get
    // subtly wrong in the direction that says "not paid".
    countOf('payroll_settlements', q => q.eq('payroll_period_id', periodId).not('amount_paid', 'is', null)),
    countOf('payroll_settlements', q => q.eq('payroll_period_id', periodId).not('payment_date', 'is', null)),
    countOf('payroll_settlements', q => q.eq('payroll_period_id', periodId).not('payment_recorded_at', 'is', null)),
    countOf('payroll_results',     q => q.eq('payroll_period_id', periodId).eq('status', 'locked')),
    countOf('payroll_generation',  q => q.eq('payroll_period_id', periodId).eq('status', 'running')),
    // Another period's settlement carrying real money forward from this one.
    countOf('payroll_settlements', q =>
      q.eq('carry_forward_source_period_id', periodId)
        .neq('payroll_period_id', periodId)
        .neq('carry_forward_amount', 0)),
  ])

  return {
    month:  period.payroll_month as number,
    year:   period.payroll_year as number,
    status,
    facts: {
      status,
      resultCount,
      settlementCount,
      paidSettlementCount: Math.max(paidAmount, paidDate, paidAt),
      lockedResultCount,
      generationRunning: runningCount > 0,
      carryForwardDependentCount,
    },
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const periodId = req.nextUrl.searchParams.get('period_id')
  if (!periodId) return NextResponse.json({ error: 'period_id is required' }, { status: 400 })

  let collected: Awaited<ReturnType<typeof collectDeletionFacts>>
  try {
    collected = await collectDeletionFacts(auth.svc, periodId)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  if (!collected) return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })

  const { month, year, status, facts } = collected
  const preview: PayrollDeletionPreview = {
    payroll_period_id: periodId,
    payroll_month:     month,
    payroll_year:      year,
    period_label:      payrollDeletionConfirmationText(month, year),
    status,
    facts,
    permission:        canDeletePayrollPeriod(auth.role, facts),
    scope:             payrollDeletionScope(facts),
    confirmation_text: payrollDeletionConfirmationText(month, year),
  }

  return NextResponse.json(preview)
}

/** Postgres error markers raised by delete_payroll_period(), mapped to HTTP. */
const RPC_STATUS: Array<{ marker: string; status: number }> = [
  { marker: 'PAYROLL_DELETE_DENIED',                  status: 403 },
  { marker: 'PAYROLL_DELETE_MISSING',                 status: 404 },
  { marker: 'PAYROLL_DELETE_MISMATCH',                status: 409 },
  { marker: 'PAYROLL_DELETE_REASON_REQUIRED',         status: 400 },
  { marker: 'PAYROLL_DELETE_BLOCKED_LOCKED',          status: 422 },
  { marker: 'PAYROLL_DELETE_BLOCKED_PAID',            status: 422 },
  { marker: 'PAYROLL_DELETE_BLOCKED_RESULT_LOCKED',   status: 422 },
  { marker: 'PAYROLL_DELETE_BLOCKED_RUNNING',         status: 409 },
  { marker: 'PAYROLL_DELETE_BLOCKED_CARRY_FORWARD',   status: 422 },
]

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  let body: {
    payroll_period_id?: unknown
    payroll_month?: unknown
    payroll_year?: unknown
    confirmation?: unknown
    reason?: unknown
  }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const periodId = typeof body.payroll_period_id === 'string' ? body.payroll_period_id.trim() : ''
  if (!periodId) {
    return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })
  }

  const month = Number(body.payroll_month)
  const year  = Number(body.payroll_year)
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
    return NextResponse.json(
      { error: 'payroll_month and payroll_year are required, and must name the payroll being deleted.' },
      { status: 400 },
    )
  }

  const reason = validateDeletionReason(body.reason)
  if (!reason.ok) return NextResponse.json({ error: reason.error }, { status: 400 })

  // The typed confirmation, checked here as well as in the dialog. It is the one
  // gate that proves a human read which payroll this is, so it cannot live only
  // in a component that a direct API call never runs.
  if (!payrollDeletionConfirmationMatches(body.confirmation, month, year)) {
    return NextResponse.json(
      { error: `Type ${payrollDeletionConfirmationText(month, year)} exactly to confirm this deletion.` },
      { status: 400 },
    )
  }

  // Re-read the period's state and re-apply the rules on the server. The dialog
  // has already done this, but its answer is as old as the moment it opened.
  let collected: Awaited<ReturnType<typeof collectDeletionFacts>>
  try {
    collected = await collectDeletionFacts(svc, periodId)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
  if (!collected) return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })

  if (collected.month !== month || collected.year !== year) {
    return NextResponse.json(
      { error: 'This payroll period is not the month that was confirmed. Reload and try again.' },
      { status: 409 },
    )
  }

  const permission = canDeletePayrollPeriod(auth.role, collected.facts)
  if (!permission.allowed) {
    return NextResponse.json(
      {
        error:      permission.message,
        reason:     permission.reason,
        resolution: permission.resolution,
      },
      { status: permission.reason === 'not_authorised' ? 403 : 422 },
    )
  }

  // One transaction, in the database. Every refusal above is re-checked inside
  // it against rows locked FOR UPDATE, so a period that was locked or paid
  // between the check and this call is still refused — there.
  const { data, error } = await svc.rpc('delete_payroll_period', {
    p_period_id: periodId,
    p_month:     month,
    p_year:      year,
    p_reason:    reason.value,
    p_actor:     auth.id,
  })

  if (error) {
    const matched = RPC_STATUS.find(m => error.message.includes(m.marker))
    // Nothing was deleted: the function is one transaction, so a raised
    // exception rolled back every statement inside it. Saying so is the useful
    // part of the message — an admin needs to know the payroll is still there.
    return NextResponse.json(
      {
        error: `${cleanRpcMessage(error.message)} The payroll was not deleted and nothing was changed.`,
        reason: matched?.marker ?? 'unknown',
      },
      { status: matched?.status ?? 500 },
    )
  }

  const result = (data ?? {}) as {
    payroll_month?: number
    payroll_year?: number
    audit_id?: string
    results_deleted?: number
    removed_counts?: Record<string, number>
  }

  return NextResponse.json({
    success:           true,
    payroll_period_id: periodId,
    payroll_month:     result.payroll_month ?? month,
    payroll_year:      result.payroll_year ?? year,
    period_label:      payrollDeletionConfirmationText(month, year),
    results_deleted:   result.results_deleted ?? 0,
    removed_counts:    result.removed_counts ?? {},
    audit_id:          result.audit_id ?? null,
  })
}

/** Strip the machine marker so the admin reads the sentence, not the code. */
function cleanRpcMessage(message: string): string {
  return message.replace(/^PAYROLL_DELETE_[A-Z_]+:\s*/, '').trim()
}
