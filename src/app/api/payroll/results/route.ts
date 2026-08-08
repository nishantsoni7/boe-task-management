// GET /api/payroll/results?period_id=...
// Returns payroll results with employee names for a given period.
// Payroll module access required — admin, or a member named in Control Center →
// Module Visibility → Custom. Same decision the launcher and PayrollGuard use.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'

export async function GET(req: NextRequest) {
  const periodId = req.nextUrl.searchParams.get('period_id')
  if (!periodId) return NextResponse.json({ error: 'period_id is required' }, { status: 400 })

  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  // Fetch period metadata for the Lock button and lock display
  const { data: period } = await svc
    .from('payroll_periods')
    .select('payroll_month, payroll_year, status, locked_at')
    .eq('id', periodId)
    .single()

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
      employee_reviewed_at,
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
      net_salary:           r.net_salary,
      status:               r.status,
      employee_reviewed_at: r.employee_reviewed_at ?? null,
    }
  })

  return NextResponse.json({
    period: period
      ? {
          payroll_month: period.payroll_month,
          payroll_year:  period.payroll_year,
          status:        period.status,
          locked_at:     period.locked_at ?? null,
        }
      : null,
    results: rows,
  })
}
