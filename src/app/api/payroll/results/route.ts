// GET /api/payroll/results?period_id=...
// Returns payroll results with employee names for a given period.
// Admin only.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const periodId = req.nextUrl.searchParams.get('period_id')
  if (!periodId) return NextResponse.json({ error: 'period_id is required' }, { status: 400 })

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

  const { data: results, error: resultsErr } = await svc
    .from('payroll_results')
    .select(`
      id,
      employee_id,
      working_days_in_month,
      gross_salary,
      total_deductions,
      pending_adjustment_total,
      net_salary,
      status,
      users!payroll_results_employee_id_fkey (
        full_name,
        employee_code
      )
    `)
    .eq('payroll_period_id', periodId)
    .order('created_at', { ascending: true })

  if (resultsErr) return NextResponse.json({ error: resultsErr.message }, { status: 500 })

  const rows = (results ?? []).map((r: Record<string, unknown>) => {
    const u = r.users as { full_name: string; employee_code: string | null } | null
    return {
      id: r.id,
      employee_id: r.employee_id,
      employee_name: u?.full_name ?? 'Unknown',
      employee_code: u?.employee_code ?? null,
      working_days_in_month: r.working_days_in_month,
      gross_salary: r.gross_salary,
      total_deductions: r.total_deductions,
      pending_adjustment_total: r.pending_adjustment_total,
      net_salary: r.net_salary,
      status: r.status,
    }
  })

  return NextResponse.json({ results: rows })
}
