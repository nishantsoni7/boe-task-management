// GET /api/payroll/periods
// Returns all payroll periods with latest generation metadata.
// Admin only.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
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
    .select('role')
    .eq('id', caller.id)
    .single()
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: periods, error: periodsErr } = await svc
    .from('payroll_periods')
    .select('*')
    .order('payroll_year', { ascending: false })
    .order('payroll_month', { ascending: false })

  if (periodsErr) return NextResponse.json({ error: periodsErr.message }, { status: 500 })

  // Fetch latest done generation per period for employee count + timestamp
  const { data: generations, error: genErr } = await svc
    .from('payroll_generation')
    .select('payroll_period_id, employee_count, completed_at')
    .eq('status', 'done')
    .order('completed_at', { ascending: false })

  if (genErr) return NextResponse.json({ error: genErr.message }, { status: 500 })

  // Keep only the first (latest) done generation per period
  const latestGen: Record<string, { employee_count: number; completed_at: string }> = {}
  for (const g of generations ?? []) {
    if (!latestGen[g.payroll_period_id]) {
      latestGen[g.payroll_period_id] = {
        employee_count: g.employee_count ?? 0,
        completed_at: g.completed_at,
      }
    }
  }

  const result = (periods ?? []).map(p => ({
    ...p,
    generated_employees: latestGen[p.id]?.employee_count ?? null,
    last_generated_at:   latestGen[p.id]?.completed_at ?? null,
  }))

  return NextResponse.json({ periods: result })
}
