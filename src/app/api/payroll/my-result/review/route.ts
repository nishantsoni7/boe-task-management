// POST /api/payroll/my-result/review
// Body: { period_id: string }
// Marks the caller's payroll result for that period as reviewed.
// Idempotent: calling again when already reviewed returns ok.

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

  let body: { period_id?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { period_id } = body
  if (!period_id) return NextResponse.json({ error: 'period_id is required' }, { status: 400 })

  // Block review once the period is locked
  const { data: periodRow } = await svc
    .from('payroll_periods')
    .select('status')
    .eq('id', period_id)
    .single()

  if (periodRow?.status === 'locked') {
    return NextResponse.json(
      { error: 'Payroll period is locked — the review window is closed.' },
      { status: 422 },
    )
  }

  // Find the result owned by this employee for this period
  const { data: existing, error: findErr } = await svc
    .from('payroll_results')
    .select('id, employee_reviewed_at')
    .eq('payroll_period_id', period_id)
    .eq('employee_id', caller.id)
    .single()

  if (findErr || !existing) return NextResponse.json({ error: 'Result not found' }, { status: 404 })

  // Idempotent
  if (existing.employee_reviewed_at) {
    return NextResponse.json({ ok: true, already_reviewed: true })
  }

  const { error: updateErr } = await svc
    .from('payroll_results')
    .update({ employee_reviewed_at: new Date().toISOString() })
    .eq('id', existing.id)

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
