// GET /api/payroll/results/detail?period_id=...&employee_id=...
// Returns one employee payroll result with deduction lines and adjustments.
// Admin only.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const periodId   = req.nextUrl.searchParams.get('period_id')
  const employeeId = req.nextUrl.searchParams.get('employee_id')
  if (!periodId || !employeeId)
    return NextResponse.json({ error: 'period_id and employee_id are required' }, { status: 400 })

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
  if (callerProfile?.role !== 'admin')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Fetch the payroll result row
  const { data: result, error: resultErr } = await svc
    .from('payroll_results')
    .select(`
      id,
      employee_id,
      monthly_salary,
      working_days_in_month,
      days_present,
      days_absent,
      half_day_count,
      gross_salary,
      total_deductions,
      pending_adjustment_total,
      net_salary,
      status,
      generated_at,
      users!payroll_results_employee_id_fkey (
        full_name,
        employee_code
      )
    `)
    .eq('payroll_period_id', periodId)
    .eq('employee_id', employeeId)
    .single()

  if (resultErr) return NextResponse.json({ error: resultErr.message }, { status: 500 })
  if (!result)   return NextResponse.json({ error: 'Result not found' }, { status: 404 })

  // Fetch deduction lines
  const { data: lines, error: linesErr } = await svc
    .from('payroll_deduction_lines')
    .select('id, line_date, deduction_type, hours_deducted, amount_deducted')
    .eq('payroll_result_id', result.id)
    .order('line_date', { ascending: true })

  if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 })

  // Fetch applied adjustments linked to this result
  const { data: adjustments, error: adjErr } = await svc
    .from('payroll_pending_adjustments')
    .select('id, description, amount, status')
    .eq('payroll_result_id', result.id)

  if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 500 })

  const u = result.users as unknown as { full_name: string; employee_code: string | null } | null

  return NextResponse.json({
    result: {
      id:                       result.id,
      employee_id:              result.employee_id,
      employee_name:            u?.full_name ?? 'Unknown',
      employee_code:            u?.employee_code ?? null,
      monthly_salary:           result.monthly_salary,
      working_days_in_month:    result.working_days_in_month,
      days_present:             result.days_present,
      days_absent:              result.days_absent,
      half_day_count:           result.half_day_count,
      gross_salary:             result.gross_salary,
      total_deductions:         result.total_deductions,
      pending_adjustment_total: result.pending_adjustment_total,
      net_salary:               result.net_salary,
      status:                   result.status,
      generated_at:             result.generated_at,
      deduction_lines:          lines ?? [],
      adjustments:              adjustments ?? [],
    },
  })
}
