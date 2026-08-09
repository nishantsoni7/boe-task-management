// DELETE /api/payroll/adjustments/[id]
//
// Admin only. VOIDS the adjustment rather than deleting it, and only while it is
// still 'pending'.
//
// WHAT CHANGED AND WHY
// --------------------
// This used to hard-DELETE the row, which took the amount, the reason and the
// author out of the database with it — on a financial record, in a module whose
// whole point is being able to explain a figure months later. The status column
// has always allowed 'cancelled'; nothing ever set it. Voiding keeps the record
// and adds who removed it, when, and why.
//
// The existing restriction is deliberately kept: only a 'pending' adjustment can
// be removed. Once generation has applied one it is part of a calculated
// payroll, and voiding it would move net_salary underneath a result that was
// already produced — a silent restatement of somebody's pay. Removing it then
// requires the period to be regenerated, which is a decision an admin makes
// explicitly, not a side effect of this route.
//
// It also had NO payroll-period lock check, so an adjustment could be removed
// from a locked month. It has one now.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { periodLockStateByMonth, isLocked, LOCKED_PERIOD_MESSAGE } from '@/lib/payroll/lockGuard'

/**
 * A failure the admin can act on, with the technical detail kept server-side.
 *
 * This route used to return `String(e)` and the raw Postgres `error.message` to
 * the browser, so a storage-layer problem surfaced on the payslip naming an
 * internal table. The detail goes to the server log where it is diagnosable;
 * the screen gets one sentence and keeps its retry.
 *
 * Still a 500 — the write genuinely failed and nothing pretends otherwise.
 */
function serverFailure(where: string, detail: unknown) {
  console.error(`[payroll/adjustments] ${where}:`, detail)
  return NextResponse.json(
    { error: 'The adjustment could not be removed. Please try again.' },
    { status: 500 },
  )
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await svc.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params

  // A reason is optional here — the UI offers one — but when supplied it is
  // recorded, because "why was this removed" is the question asked later.
  const body = await req.json().catch(() => null)
  const reason: string | null = typeof body?.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : null

  const { data: existing } = await svc
    .from('payroll_pending_adjustments')
    .select('id, status, payroll_month, payroll_year')
    .eq('id', id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Adjustment not found' }, { status: 404 })

  if (existing.status === 'cancelled') {
    return NextResponse.json({ error: 'This adjustment has already been removed' }, { status: 409 })
  }
  if (existing.status !== 'pending') {
    return NextResponse.json(
      { error: 'This adjustment has already been applied to a generated payroll. Regenerate the period to change it.' },
      { status: 409 },
    )
  }

  // Locked month: refuse. A pending adjustment inside a locked period is still
  // part of that month's record.
  if (existing.payroll_month != null && existing.payroll_year != null) {
    try {
      if (isLocked(await periodLockStateByMonth(svc, existing.payroll_month, existing.payroll_year))) {
        return NextResponse.json({ error: LOCKED_PERIOD_MESSAGE }, { status: 422 })
      }
    } catch (e) {
      return serverFailure('lock state lookup', e)
    }
  }

  const { error } = await svc
    .from('payroll_pending_adjustments')
    .update({
      status:      'cancelled',
      voided_by:   user.id,
      voided_at:   new Date().toISOString(),
      void_reason: reason,
    })
    .eq('id', id)
    // Concurrency: only void a row that is STILL pending. Two admins removing
    // the same adjustment cannot both succeed, and the second gets the 409 below
    // rather than overwriting the first one's audit trail.
    .eq('status', 'pending')

  if (error) return serverFailure('void adjustment', error)

  return NextResponse.json({ ok: true, status: 'cancelled' })
}
