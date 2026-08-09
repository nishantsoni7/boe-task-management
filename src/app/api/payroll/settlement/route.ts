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

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { periodLockStateById, isLocked, LOCKED_PERIOD_MESSAGE } from '@/lib/payroll/lockGuard'
import {
  ensureSettlement,
  logSettlementEvent,
  type SettlementRow,
} from '@/lib/payroll/settlementStore'
import { sameMoney } from '@/lib/payroll/settlement'

async function getAdminCaller(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error } = await svc.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await svc.from('users').select('role, full_name').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null

  return { svc, actor: { id: user.id, name: profile?.full_name ?? null } }
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
  const ctx = await getAdminCaller(req)
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { svc, actor } = ctx

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
    return NextResponse.json({ error: String(e) }, { status: 500 })
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
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  return action === 'carry_forward'
    ? handleCarryForward(svc, settlement, body, actor)
    : handlePayment(svc, settlement, body, actor)
}

// ─── Carry forward ────────────────────────────────────────────────────────────

async function handleCarryForward(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

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
