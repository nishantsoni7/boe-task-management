// POST /api/payroll/unlock
//
// Reopens a locked payroll period (status: locked -> generated) so attendance
// corrections, regeneration and payroll-result changes become possible again.
//
// Body
//   payroll_period_id  string  required
//   reason             string  required, non-blank — recorded permanently
//
// Payroll results are NOT touched: unlocking changes the period's status and
// nothing else, so the figures an admin locked are the figures they see when it
// reopens. locked_at / locked_by are left in place too — the record of the
// original lock survives its own reversal, and the audit row carries the rest.
//
// Auth: admin only, enforced here and not merely in the UI.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  canUnlockPayroll,
  validateUnlockReason,
  UNLOCK_TARGET_STATUS,
  type PeriodStatus,
} from '@/lib/payroll/unlockRules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

export type UnlockPeriodResult =
  | {
      outcome: 'unlocked'
      period_id: string
      previous_status: 'locked'
      new_status: typeof UNLOCK_TARGET_STATUS
      event_id: string
    }
  | { outcome: 'not_found' }
  | { outcome: 'not_locked'; status: PeriodStatus }
  | { outcome: 'conflict' }

/**
 * The unlock transition itself, factored out of POST so it can be exercised
 * against a real Supabase client in tests without going through HTTP/auth —
 * the same arrangement as getOrCreatePayrollPeriod in ../periods/route.ts.
 *
 * Two orderings matter here:
 *
 *  * The status update is conditional on the row STILL being locked. That is
 *    what makes a duplicate submission — a double click, a retried request, two
 *    admins at once — land as 'conflict' rather than writing a second unlock
 *    event for a period that was already open.
 *
 *  * The status moves first and the audit row is written second, then the
 *    status is put back if the audit write fails. The other order would leave an
 *    audit entry claiming an unlock that never happened, and a payroll audit
 *    that can lie is worse than no audit at all. This stack has no transaction
 *    spanning the two writes, so the compensation is by hand.
 */
export async function unlockPayrollPeriod(
  svc: Svc,
  params: { periodId: string; actorId: string; actorName: string | null; reason: string },
): Promise<UnlockPeriodResult> {
  const { periodId, actorId, actorName, reason } = params

  const { data: period } = await svc
    .from('payroll_periods')
    .select('id, status')
    .eq('id', periodId)
    .maybeSingle()

  if (!period) return { outcome: 'not_found' }

  const status = (period as { status: PeriodStatus }).status
  if (status !== 'locked') return { outcome: 'not_locked', status }

  const { data: updated, error: updateErr } = await svc
    .from('payroll_periods')
    .update({ status: UNLOCK_TARGET_STATUS })
    .eq('id', periodId)
    .eq('status', 'locked')
    .select('id')

  if (updateErr) throw new Error(`unlockPayrollPeriod update: ${updateErr.message}`)
  if (!updated || updated.length === 0) return { outcome: 'conflict' }

  const { data: event, error: eventErr } = await svc
    .from('payroll_period_status_events')
    .insert({
      payroll_period_id: periodId,
      event:             'unlocked',
      previous_status:   'locked',
      new_status:        UNLOCK_TARGET_STATUS,
      actor_id:          actorId,
      actor_name:        actorName,
      reason,
    })
    .select('id')
    .single()

  if (eventErr || !event) {
    // Undo the reopen — an unlock nobody can account for must not stand.
    const { error: revertErr } = await svc
      .from('payroll_periods')
      .update({ status: 'locked' })
      .eq('id', periodId)
      .eq('status', UNLOCK_TARGET_STATUS)
    if (revertErr) {
      console.error('[payroll/unlock] revert to locked failed:', revertErr.message)
    }
    throw new Error(`unlockPayrollPeriod audit: ${eventErr?.message ?? 'no row returned'}`)
  }

  return {
    outcome:         'unlocked',
    period_id:       periodId,
    previous_status: 'locked',
    new_status:      UNLOCK_TARGET_STATUS,
    event_id:        (event as { id: string }).id,
  }
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user: caller }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await svc
    .from('users')
    .select('role, full_name')
    .eq('id', caller.id)
    .single()

  let body: { payroll_period_id?: unknown; reason?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const periodId = typeof body.payroll_period_id === 'string' ? body.payroll_period_id.trim() : ''
  if (!periodId) {
    return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })
  }

  // Role is checked before the period is read so a non-admin learns nothing
  // about which period ids exist. The status passed here is a placeholder: with
  // a non-admin role the decision never reaches the status branch.
  const role = (callerProfile as { role?: string } | null)?.role
  const permission = canUnlockPayroll(role, 'locked')
  if (!permission.allowed) {
    return NextResponse.json({ error: permission.message }, { status: 403 })
  }

  const reason = validateUnlockReason(body.reason)
  if (!reason.ok) return NextResponse.json({ error: reason.error }, { status: 400 })

  let result: UnlockPeriodResult
  try {
    result = await unlockPayrollPeriod(svc, {
      periodId,
      actorId:   caller.id,
      actorName: (callerProfile as { full_name?: string | null } | null)?.full_name ?? null,
      reason:    reason.value,
    })
  } catch (e) {
    return NextResponse.json(
      { error: `The payroll period was not unlocked. Nothing was changed. (${String(e)})` },
      { status: 500 },
    )
  }

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })
  }
  if (result.outcome === 'not_locked') {
    const denial = canUnlockPayroll('admin', result.status)
    return NextResponse.json(
      { error: denial.allowed ? 'This payroll period is not locked.' : denial.message },
      { status: 422 },
    )
  }
  if (result.outcome === 'conflict') {
    return NextResponse.json(
      { error: 'This payroll period was unlocked a moment ago. Reload to see its current state.' },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success:         true,
    payroll_period_id: result.period_id,
    previous_status: result.previous_status,
    new_status:      result.new_status,
    event_id:        result.event_id,
  })
}
