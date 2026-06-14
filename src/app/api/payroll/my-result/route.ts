// GET /api/payroll/my-result
// Returns the authenticated employee's own payroll results.
//
// Without period_id  →  list of all periods where a result exists for the caller.
// With period_id     →  full detail for that period (including deduction lines).
//
// Any authenticated user may call this — they only ever see their own data.

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

  const periodId = req.nextUrl.searchParams.get('period_id')

  // ─── Detail view ─────────────────────────────────────────────────────────────
  if (periodId) {
    const { data: rawResult, error: resultErr } = await svc
      .from('payroll_results')
      .select('id, monthly_salary, working_days_in_month, days_present, days_absent, half_day_count, paid_leave_used, late_deduction_hours, short_hours_deduction, missing_punch_hours, gross_salary, total_deductions, pending_adjustment_total, net_salary, status, employee_reviewed_at, generated_at, payroll_period_id')
      .eq('payroll_period_id', periodId)
      .eq('employee_id', caller.id)
      .single()

    if (resultErr) return NextResponse.json({ error: resultErr.message }, { status: 500 })
    if (!rawResult) return NextResponse.json({ error: 'Result not found' }, { status: 404 })

    const result = rawResult as Record<string, unknown>

    // Fetch period for month/year/lock display
    const { data: period } = await svc
      .from('payroll_periods')
      .select('payroll_month, payroll_year, status, locked_at')
      .eq('id', periodId)
      .single()

    // Fetch deduction lines
    const { data: lines } = await svc
      .from('payroll_deduction_lines')
      .select('id, line_date, deduction_type, hours_deducted, amount_deducted')
      .eq('payroll_result_id', result.id as string)
      .order('line_date', { ascending: true })

    return NextResponse.json({
      result: {
        id:                       result.id,
        payroll_month:            period?.payroll_month  ?? null,
        payroll_year:             period?.payroll_year   ?? null,
        period_status:            period?.status         ?? null,
        period_locked_at:         period?.locked_at      ?? null,
        monthly_salary:           result.monthly_salary,
        working_days_in_month:    result.working_days_in_month,
        days_present:             result.days_present,
        days_absent:              result.days_absent,
        half_day_count:           result.half_day_count,
        paid_leave_used:          result.paid_leave_used,
        late_deduction_hours:     result.late_deduction_hours,
        short_hours_deduction:    result.short_hours_deduction,
        missing_punch_hours:      result.missing_punch_hours,
        gross_salary:             result.gross_salary,
        total_deductions:         result.total_deductions,
        pending_adjustment_total: result.pending_adjustment_total,
        net_salary:               result.net_salary,
        status:                   result.status,
        employee_reviewed_at:     result.employee_reviewed_at,
        generated_at:             result.generated_at,
        deduction_lines:          lines ?? [],
      },
    })
  }

  // ─── List view ────────────────────────────────────────────────────────────────
  const { data: results, error: resultsErr } = await svc
    .from('payroll_results')
    .select('id, payroll_period_id, gross_salary, total_deductions, net_salary, status, employee_reviewed_at, generated_at')
    .eq('employee_id', caller.id)
    .order('created_at', { ascending: false })

  if (resultsErr) return NextResponse.json({ error: resultsErr.message }, { status: 500 })

  // Batch-fetch period info for all results
  const periodIds = [...new Set((results ?? []).map((r: Record<string, unknown>) => r.payroll_period_id as string))]
  const { data: periods } = periodIds.length > 0
    ? await svc.from('payroll_periods').select('id, payroll_month, payroll_year').in('id', periodIds)
    : { data: [] }

  const periodMap = new Map((periods ?? []).map((p: Record<string, unknown>) => [p.id as string, p]))

  const rows = (results ?? []).map((r: Record<string, unknown>) => {
    const p = periodMap.get(r.payroll_period_id as string)
    return {
      id:                   r.id,
      period_id:            r.payroll_period_id,
      payroll_month:        p ? (p as Record<string, unknown>).payroll_month : null,
      payroll_year:         p ? (p as Record<string, unknown>).payroll_year  : null,
      gross_salary:         r.gross_salary,
      total_deductions:     r.total_deductions,
      net_salary:           r.net_salary,
      status:               r.status,
      employee_reviewed_at: r.employee_reviewed_at,
      generated_at:         r.generated_at,
    }
  })

  return NextResponse.json({ results: rows })
}
