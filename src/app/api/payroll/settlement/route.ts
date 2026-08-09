// PATCH /api/payroll/settlement
//
// Admin only. Records the two settlement facts payroll cannot derive:
//
//   action: 'carry_forward'  — override or reset the previous balance
//   action: 'payment'        — record, correct or clear the amount actually paid
//
// WHAT THIS ROUTE MUST NEVER DO
// -----------------------------
// It never calls the payroll engine. Recording a payment must not rerun
// attendance, must not restate gross salary, must not move a deduction and must
// not be used to force Salary Payable to equal what was paid. The only figures
// it writes are carry-forward and payment; everything else on the payslip is
// computed from payroll_results, which this route does not touch.
//
// LOCKING IS ENFORCED TWICE, ON PURPOSE
// -------------------------------------
// Here, so the caller gets a clear 422 with a message, and again in the database
// via the payroll_settlements lock trigger from migration 20260826000000, which
// holds even for a service-role client that skipped this route entirely.
//
// There is no GET. The settlement figures are served with the payslip they
// belong to, through buildResultDetailPayload — one payload, one set of numbers,
// for the admin and the employee alike.

import { NextRequest, NextResponse } from 'next/server'
import {
  requireAdmin,
  isResponse,
  type ServiceClient,
} from '@/lib/security/attendancePayrollApiAuth'
import { periodLockStateById, isLocked, LOCKED_PERIOD_MESSAGE } from '@/lib/payroll/lockGuard'
import {
  ensureSettlement,
  logSettlementEvent,
  type SettlementRow,
} from '@/lib/payroll/settlementStore'
import { sameMoney } from '@/lib/payroll/settlement'

/**
 * A failure the admin can act on, with the technical detail kept server-side.
 *
 * This route used to return `String(e)` and `error.message` straight to the
 * browser. When payroll_settlements had not been migrated yet, an admin opening
 * Previous Balance was shown, in red, on the payslip:
 *
 *   "Could not find the table 'public.payroll_settlements' in the schema cache"
 *
 * That names an internal table, leaks the storage layer's vocabulary, and tells
 * the person reading it nothing they can do. The detail belongs in the server
 * log, where it is actually diagnosable; the screen gets one sentence and keeps
 * its Try again control.
 *
 * Deliberately NOT a silent success — the operation genuinely failed, the caller
 * still gets a 500, and the dialog stays open with the entered values intact.
 */
function serverFailure(where: string, detail: unknown) {
  console.error(`[payroll/settlement] ${where}:`, detail)
  return NextResponse.json(
    { error: 'Settlement details could not be saved. Please try again.' },
    { status: 500 },
  )
}

/**
 * Authorisation. Two outcomes, and they are NOT the same thing.
 *
 * This route used to roll its own admin check, and it collapsed four distinct
 * conditions — no Authorization header, a token the auth server rejected, no
 * profile row, and a real non-admin — into one bare 403 "Forbidden". An admin
 * whose access token had simply gone stale was therefore told, on the payslip,
 * that they lacked permission to edit payroll they in fact owned. The message
 * pointed at the wrong problem, so the obvious remedy (sign in again) was the
 * one thing it did not suggest.
 *
 * The check itself is now `requireAdmin` from the attendance/payroll auth
 * module — the same helper /api/payroll/results/detail uses to decide who may
 * READ this payslip, so the reader and the writer can no longer disagree about
 * who the admin is. This route does not define a role rule of its own.
 *
 * What is kept local is only the wording: `requireAdmin` answers 401/403 with
 * the deliberately flat "Unauthorized"/"Forbidden" that the isolation tests
 * assert on, which is right for a probe and useless to an admin looking at a
 * dialog. So the status is taken from the helper and the sentence is replaced.
 */
const EXPIRED_SESSION_MESSAGE =
  'Your session has expired. Please sign in again and retry.'
const NO_PERMISSION_MESSAGE =
  'You do not have permission to update payroll settlement details.'

function authFailure(res: NextResponse) {
  // A refusal here writes nothing and returns no detail, so without this line
  // it leaves no trace at all — which is exactly why the failure this replaces
  // could not be diagnosed from the server side.
  console.error(`[payroll/settlement] authorisation refused with ${res.status}`)
  return NextResponse.json(
    { error: res.status === 401 ? EXPIRED_SESSION_MESSAGE : NO_PERMISSION_MESSAGE },
    { status: res.status },
  )
}

type Body = {
  payroll_period_id?: string
  employee_id?: string
  action?: 'carry_forward' | 'payment'
  // carry_forward
  amount?: number | null
  remark?: string
  reset?: boolean
  // payment
  amount_paid?: number | null
  payment_date?: string | null
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return authFailure(auth)
  const svc = auth.svc

  // The audit trail denormalises who acted, so the name is read here rather
  // than widening the shared Caller shape for one route's benefit. A failed
  // lookup costs the trail a name, never the write — `actor_name` is nullable
  // for exactly this reason.
  const { data: profile } = await svc
    .from('users')
    .select('full_name')
    .eq('id', auth.id)
    .maybeSingle()

  const actor = { id: auth.id, name: (profile?.full_name as string | null) ?? null }

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { payroll_period_id, employee_id, action } = body

  if (!payroll_period_id || !employee_id) {
    return NextResponse.json({ error: 'payroll_period_id and employee_id are required' }, { status: 400 })
  }
  if (action !== 'carry_forward' && action !== 'payment') {
    return NextResponse.json({ error: "action must be 'carry_forward' or 'payment'" }, { status: 400 })
  }

  // ── Lock guard, before anything is written ────────────────────────────────
  let lockState
  try {
    lockState = await periodLockStateById(svc, payroll_period_id)
  } catch (e) {
    return serverFailure('lock state lookup', e)
  }
  if (!lockState.found) {
    return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })
  }
  if (isLocked(lockState)) {
    return NextResponse.json({ error: LOCKED_PERIOD_MESSAGE }, { status: 422 })
  }

  let settlement: SettlementRow
  try {
    settlement = await ensureSettlement(svc, payroll_period_id, employee_id)
  } catch (e) {
    // The exact failure that surfaced on the payslip in red before this existed.
    return serverFailure('ensureSettlement', e)
  }

  return action === 'carry_forward'
    ? handleCarryForward(svc, settlement, body, actor)
    : handlePayment(svc, settlement, body, actor)
}

// ─── Carry forward ────────────────────────────────────────────────────────────

async function handleCarryForward(
  svc: ServiceClient,
  settlement: SettlementRow,
  body: Body,
  actor: { id: string | null; name: string | null },
) {
  const previous = Number(settlement.carry_forward_amount)
  const proposed = Number(settlement.proposed_carry_forward)

  // ── Reset to the proposed value ─────────────────────────────────────────
  // The original proposal is never lost, which is what makes this possible at
  // all: proposed_carry_forward is written once at materialisation and no
  // override path touches it.
  if (body.reset === true) {
    const { error } = await svc
      .from('payroll_settlements')
      .update({
        carry_forward_amount:    proposed,
        carry_forward_is_manual: false,
        carry_forward_remark:    null,
        carry_forward_set_by:    actor.id,
        carry_forward_set_at:    new Date().toISOString(),
        updated_at:              new Date().toISOString(),
      })
      .eq('id', settlement.id)

    if (error) return serverFailure('carry-forward reset', error)

    await logSettlementEvent(svc, settlement.id, 'carry_forward_reset', {
      previousAmount: previous,
      newAmount:      proposed,
      remark:         'Returned to the automatically proposed balance',
      actorId:        actor.id,
      actorName:      actor.name,
    })

    return NextResponse.json({ ok: true, carry_forward_amount: proposed, is_manual: false })
  }

  // ── Manual override ─────────────────────────────────────────────────────
  const amount = body.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    // Signed on purpose: negative IS a valid balance (the employee is in
    // advance). Only a non-number is refused.
    return NextResponse.json({ error: 'amount must be a number' }, { status: 400 })
  }

  const remark = (body.remark ?? '').trim()
  if (!remark) {
    // Also enforced by a CHECK constraint on the table, so a caller that skips
    // this route cannot write an unexplained restatement of somebody's balance.
    return NextResponse.json(
      { error: 'A remark is required when the carry-forward balance is changed manually.' },
      { status: 400 },
    )
  }

  const { error } = await svc
    .from('payroll_settlements')
    .update({
      carry_forward_amount:    amount,
      carry_forward_is_manual: true,
      carry_forward_remark:    remark,
      carry_forward_set_by:    actor.id,
      carry_forward_set_at:    new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    })
    .eq('id', settlement.id)

  if (error) return serverFailure('carry-forward override', error)

  await logSettlementEvent(svc, settlement.id, 'carry_forward_overridden', {
    previousAmount: previous,
    newAmount:      amount,
    remark,
    actorId:        actor.id,
    actorName:      actor.name,
  })

  return NextResponse.json({ ok: true, carry_forward_amount: amount, is_manual: true })
}

// ─── Payment ──────────────────────────────────────────────────────────────────

async function handlePayment(
  svc: ServiceClient,
  settlement: SettlementRow,
  body: Body,
  actor: { id: string | null; name: string | null },
) {
  const previous = settlement.amount_paid == null ? null : Number(settlement.amount_paid)
  const remark   = (body.remark ?? '').trim() || null

  // ── Clearing a recorded payment ─────────────────────────────────────────
  // null means "not recorded", which is a different state from ₹0 ("paid
  // nothing"), so withdrawing a payment has to be expressible.
  if (body.amount_paid === null) {
    const { error } = await svc
      .from('payroll_settlements')
      .update({
        amount_paid:         null,
        payment_date:        null,
        payment_remark:      remark,
        payment_recorded_by: actor.id,
        payment_recorded_at: new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      })
      .eq('id', settlement.id)

    if (error) return serverFailure('payment clear', error)

    await logSettlementEvent(svc, settlement.id, 'payment_cleared', {
      previousAmount: previous,
      remark,
      actorId:        actor.id,
      actorName:      actor.name,
    })

    return NextResponse.json({ ok: true, amount_paid: null })
  }

  const amountPaid = body.amount_paid
  if (typeof amountPaid !== 'number' || !Number.isFinite(amountPaid)) {
    return NextResponse.json({ error: 'amount_paid must be a number' }, { status: 400 })
  }
  if (amountPaid < 0) {
    // A negative payment is a refund — a different transaction, and one that
    // would silently invert the closing balance. Also a CHECK on the table.
    return NextResponse.json({ error: 'amount_paid cannot be negative' }, { status: 400 })
  }

  const paymentDate = body.payment_date ?? null
  if (paymentDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    return NextResponse.json({ error: 'payment_date must be a YYYY-MM-DD date' }, { status: 400 })
  }

  const { error } = await svc
    .from('payroll_settlements')
    .update({
      amount_paid:         amountPaid,
      payment_date:        paymentDate,
      payment_remark:      remark,
      payment_recorded_by: actor.id,
      payment_recorded_at: new Date().toISOString(),
      updated_at:          new Date().toISOString(),
    })
    .eq('id', settlement.id)

  if (error) return serverFailure('payment record', error)

  // 'recorded' the first time, 'changed' thereafter — so the trail distinguishes
  // "this is what we paid" from "we corrected what we said we paid".
  const isFirst = previous == null
  await logSettlementEvent(
    svc,
    settlement.id,
    isFirst ? 'payment_recorded' : 'payment_changed',
    {
      previousAmount: previous,
      newAmount:      amountPaid,
      remark:         remark ?? (isFirst || previous == null || sameMoney(previous, amountPaid)
        ? null
        : 'Recorded payment corrected'),
      actorId:        actor.id,
      actorName:      actor.name,
    },
  )

  return NextResponse.json({ ok: true, amount_paid: amountPaid })
}
