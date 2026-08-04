// POST /api/payroll/lock
// Locks a payroll period (status: generated -> locked).
// Admin only.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

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
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { payroll_period_id?: string }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const { payroll_period_id } = body
  if (!payroll_period_id) {
    return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })
  }

  const { data: period } = await svc
    .from('payroll_periods')
    .select('status')
    .eq('id', payroll_period_id)
    .single()

  if (!period) return NextResponse.json({ error: 'Period not found' }, { status: 404 })
  if (period.status === 'locked') {
    return NextResponse.json({ error: 'Period is already locked' }, { status: 422 })
  }
  if (period.status !== 'generated') {
    return NextResponse.json({ error: 'Only generated periods can be locked' }, { status: 422 })
  }

  const previousStatus = period.status as 'draft' | 'generated'

  const { error: updateErr } = await svc
    .from('payroll_periods')
    .update({ status: 'locked', locked_at: new Date().toISOString(), locked_by: caller.id })
    .eq('id', payroll_period_id)

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  // Record the lock in the append-only status trail, so a lock/unlock/re-lock
  // cycle reads as a sequence rather than as whatever locked_at happens to hold
  // now — those two columns are overwritten by each new lock, this is not.
  //
  // Best-effort: locked_at / locked_by already record that this lock happened,
  // so a failure here is logged rather than failing a lock that has landed. The
  // unlock route treats its own audit write as mandatory instead, because there
  // no column records it.
  const { error: eventErr } = await svc
    .from('payroll_period_status_events')
    .insert({
      payroll_period_id,
      event:           'locked',
      previous_status: previousStatus,
      new_status:      'locked',
      actor_id:        caller.id,
      actor_name:      (callerProfile as { full_name?: string | null } | null)?.full_name ?? null,
    })
  if (eventErr) console.error('[payroll/lock] status event insert:', eventErr.message)

  return NextResponse.json({ success: true })
}
