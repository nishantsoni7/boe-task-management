// POST   /api/boe-credits/payroll-applications   { payroll_period_id, credits }
// DELETE /api/boe-credits/payroll-applications   { payroll_period_id }
//
// The employee turns spendable BOE Credits into a salary addition for one
// payroll month (Phase 1D), or withdraws it.
//
// WHO. The caller from the bearer token, and nobody else. There is no
// employee_id in the body: the month is the caller's, the credits are the
// caller's, and apply_boe_credits_to_payroll() refuses an actor that is not
// the employee even if this route were bypassed. An administrator has no
// path here — applying credits is the employee's own decision.
//
// WHAT THE BROWSER MAY SAY: which month, and how many credits. NOT the rate,
// NOT the rupees, NOT the balance, NOT whether the month is locked. The
// database reads the active credit_value, snapshots it with the rupees on the
// application, checks the SPENDABLE balance (provisional rewards excluded)
// and the period lock, and replaces an existing application atomically — a
// reversal and a new redemption in one transaction, or nothing. The same
// number twice is a no-op, so a retry after a timeout cannot double-debit.
//
// AFTERWARDS the response carries the settlement block recomputed from the
// stored records — the same buildSettlementBlock the payslip is built from —
// so the page shows the confirmed Salary Payable without asking for the whole
// payslip again.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import {
  applyPayrollCredits,
  removePayrollCredits,
  getCreditBalance,
  CreditServiceError,
  creditErrorStatus,
} from '@/lib/boeCredits/service'
import { fetchActivePayrollCreditApplication } from '@/lib/payroll/store'
import { fetchSettlement } from '@/lib/payroll/settlementStore'
import { buildSettlementBlock } from '@/lib/payroll/resultDetailPayload'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

/** The confirmed figures after a write: the settlement block, from stored records only. */
async function confirmedSettlement(svc: Svc, periodId: string, employeeId: string) {
  const [{ data: result }, settlementRow, application] = await Promise.all([
    svc
      .from('payroll_results')
      .select('gross_salary, total_deductions, pending_adjustment_total, days_present')
      .eq('payroll_period_id', periodId)
      .eq('employee_id', employeeId)
      .maybeSingle(),
    fetchSettlement(svc, periodId, employeeId).catch(() => null),
    fetchActivePayrollCreditApplication(svc, periodId, employeeId).catch(() => null),
  ])
  if (!result) return null
  return buildSettlementBlock(result, settlementRow, application)
}

function readPeriodId(payload: unknown): string {
  const p = (payload ?? {}) as { payroll_period_id?: unknown }
  return typeof p.payroll_period_id === 'string' ? p.payroll_period_id.trim() : ''
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const svc = caller.svc

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const periodId = readPeriodId(body)
  if (!periodId) return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })

  const rawCredits = (body as { credits?: unknown }).credits
  const credits = typeof rawCredits === 'string' ? Number(rawCredits.trim()) : rawCredits
  if (typeof credits !== 'number' || !Number.isInteger(credits) || credits <= 0) {
    return NextResponse.json({ error: 'Choose a whole number of credits, at least 1.' }, { status: 422 })
  }

  try {
    const applied = await applyPayrollCredits(svc, {
      // The employee acts for themselves. Same id twice, on purpose.
      employeeId: caller.id,
      payrollPeriodId: periodId,
      credits,
      actorId: caller.id,
    })
    const [settlement, balance] = await Promise.all([
      confirmedSettlement(svc, periodId, caller.id),
      getCreditBalance(svc, caller.id),
    ])
    return NextResponse.json({
      application: {
        id:           applied.application_id,
        credits_used: applied.credits_used,
        credit_value: applied.credit_value,
        amount:       applied.credit_amount,
      },
      unchanged: applied.unchanged,
      replaced:  applied.replaced_application_id != null,
      spendable_credits:   balance.spendable_credits,
      provisional_credits: balance.provisional_credits,
      settlement,
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message, marker: e.marker }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const svc = caller.svc

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const periodId = readPeriodId(body)
  if (!periodId) return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })

  try {
    const removed = await removePayrollCredits(svc, {
      employeeId: caller.id,
      payrollPeriodId: periodId,
      actorId: caller.id,
    })
    const [settlement, balance] = await Promise.all([
      confirmedSettlement(svc, periodId, caller.id),
      getCreditBalance(svc, caller.id),
    ])
    return NextResponse.json({
      removed: removed.removed,
      spendable_credits:   balance.spendable_credits,
      provisional_credits: balance.provisional_credits,
      settlement,
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message, marker: e.marker }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
