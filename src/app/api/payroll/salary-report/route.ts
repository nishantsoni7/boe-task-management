// GET /api/payroll/salary-report?period_id=…
//
// The stored payroll figures for one period, for the salary-processing report.
// Admin only — this is every employee's salary in one response, so it is the
// single most sensitive read in the payroll API.
//
// WHY THIS RETURNS ROWS AND NOT A RENDERED REPORT
// -----------------------------------------------
// The admin changes the selection constantly while deciding who to pay, and a
// round trip per checkbox would be unusable. So the route returns the period's
// stored figures once and the page assembles the report from them with
// buildSalaryReport.
//
// That is NOT a client-side salary calculation, and the distinction matters:
// buildSalaryReport groups and formats figures that payroll already computed and
// stored. It never derives a net salary — it reads net_salary as written. A
// report that recomputed would eventually disagree with the payslip it claims to
// summarise.
//
// WHAT IS NOT SELECTED
// --------------------
// No punches, no objections, no comments, no correction remarks, no settings,
// and deliberately not the adjustment `description` — admins write things like
// "advance for medical, see chat" in it, and this data ends up in a WhatsApp
// message. The adjustment CATEGORY is what the report states.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { participatesInPayroll } from '@/lib/payroll/participation'
import type {
  ReportResultRow,
  ReportAdjustmentRow,
  ReportSettlementRow,
} from '@/lib/payroll/salaryReport'
import type { AdjustmentType } from '@/lib/payroll/adjustments'

export async function GET(req: NextRequest) {
  // The whole boundary. The route runs on the service role, which bypasses RLS,
  // so an employee must never reach this — and cannot: requireAdmin resolves the
  // caller from the bearer token, never from a query parameter. There is no
  // employee_id input here at all, so there is nothing for a non-admin to aim at.
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const periodId = req.nextUrl.searchParams.get('period_id')
  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const { data: periodRow, error: periodErr } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status')
    .eq('id', periodId)
    .single()

  if (periodErr || !periodRow) {
    return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })
  }
  const period = periodRow as { id: string; payroll_month: number; payroll_year: number; status: string }

  // The stored results for this period, with the employee's display fields.
  //
  // Only the columns the report needs. `monthly_salary` is deliberately absent:
  // the report shows gross_salary, which is what payroll RECORDED for the month,
  // and an employee's current salary is a different fact that has no business
  // travelling with a processing report.
  //
  // `pending_adjustment_total` and `days_present` are the two further stored
  // figures computeSettlement needs to reach the same Salary Payable the Payroll
  // Result Detail page shows. Neither is stated on the report — days_present is
  // read only to apply the absence floor, which is a RULE rather than a count,
  // and no day count reaches the message.
  const { data: resultRows, error: resultErr } = await svc
    .from('payroll_results')
    .select(`
      employee_id,
      gross_salary,
      total_deductions,
      pending_adjustment_total,
      days_present,
      net_salary,
      users:employee_id ( full_name, employee_code, payroll_active, is_deleted )
    `)
    .eq('payroll_period_id', periodId)

  if (resultErr) {
    console.error('[payroll/salary-report] results:', resultErr)
    return NextResponse.json({ error: 'Could not load payroll results.' }, { status: 500 })
  }

  type JoinedUser = {
    full_name: string
    employee_code: string | null
    payroll_active: boolean | null
    is_deleted: boolean | null
  }

  // PostgREST types an embedded relation as an array even when the foreign key
  // makes it at most one row, so both shapes are accepted rather than asserted
  // away — a cast here would be the kind that compiles and then reads undefined.
  type JoinedRow = {
    employee_id: string
    gross_salary: number | null
    total_deductions: number | null
    pending_adjustment_total: number | null
    days_present: number | null
    net_salary: number | null
    users: JoinedUser | JoinedUser[] | null
  }

  const oneUser = (u: JoinedRow['users']): JoinedUser | null =>
    Array.isArray(u) ? (u[0] ?? null) : u

  // Deleted and payroll-excluded employees must not appear. The check goes
  // through the SAME shared predicate generation uses, so this list and the run
  // it reports on cannot disagree about who is in payroll.
  //
  // A row is kept only if the employee still participates AND is not deleted. An
  // employee removed after the month was generated keeps their stored payslip —
  // it is a record of what they were paid — but they are not on a processing
  // report for a payment that is about to be made.
  const results: ReportResultRow[] = []
  const excluded: string[] = []
  for (const raw of (resultRows ?? []) as unknown as JoinedRow[]) {
    const user = oneUser(raw.users)
    if (!user) continue
    // participatesInPayroll already refuses a deleted member, so both conditions
    // go through the one shared predicate rather than being restated here.
    if (!participatesInPayroll({ payroll_active: user.payroll_active, is_deleted: user.is_deleted })) {
      excluded.push(raw.employee_id)
      continue
    }
    results.push({
      employee_id:      raw.employee_id,
      employee_name:    user.full_name,
      employee_code:    user.employee_code,
      gross_salary:     raw.gross_salary,
      total_deductions: raw.total_deductions,
      pending_adjustment_total: raw.pending_adjustment_total,
      days_present:             raw.days_present,
      net_salary:       raw.net_salary,
    })
  }

  results.sort((a, b) => a.employee_name.localeCompare(b.employee_name))

  // The month's adjustments, by category. `description` is NOT selected.
  const { data: adjRows, error: adjErr } = await svc
    .from('payroll_pending_adjustments')
    .select('employee_id, adjustment_type, adjustment_category, amount')
    .eq('payroll_year',  period.payroll_year)
    .eq('payroll_month', period.payroll_month)
    .in('status', ['pending', 'applied'])

  if (adjErr) {
    console.error('[payroll/salary-report] adjustments:', adjErr)
    return NextResponse.json({ error: 'Could not load payroll adjustments.' }, { status: 500 })
  }

  const includedIds = new Set(results.map(r => r.employee_id))
  const adjustments: ReportAdjustmentRow[] = ((adjRows ?? []) as {
    employee_id: string
    adjustment_type: string | null
    adjustment_category: unknown
    amount: number
  }[])
    // An adjustment belonging to somebody not on this report cannot travel with
    // it, even unrendered — the response is the boundary, not the renderer.
    .filter(row => includedIds.has(row.employee_id))
    .map(row => ({
      employee_id:         row.employee_id,
      adjustment_type:     (row.adjustment_type === 'deduction' ? 'deduction' : 'addition') as AdjustmentType,
      adjustment_category: row.adjustment_category,
      amount:              row.amount,
    }))

  // The stored carry-forward, so the report's Advance is the same saved figure
  // the Payroll Result Detail page already shows.
  //
  // `amount_paid` is NOT selected: Salary Payable does not depend on it, and what
  // has been paid is not something this report states. A failure is an error
  // rather than a silent empty list — a missing carry-forward would not look
  // wrong on the message, it would just quietly overstate what is payable.
  const { data: settlementRows, error: settlementErr } = await svc
    .from('payroll_settlements')
    .select('employee_id, carry_forward_amount')
    .eq('payroll_period_id', periodId)

  if (settlementErr) {
    console.error('[payroll/salary-report] settlements:', settlementErr)
    return NextResponse.json({ error: 'Could not load payroll settlements.' }, { status: 500 })
  }

  const settlements: ReportSettlementRow[] = ((settlementRows ?? []) as {
    employee_id: string
    carry_forward_amount: number | null
  }[])
    // Same boundary as the adjustments: a row belonging to somebody not on this
    // report cannot travel with it, even unrendered.
    .filter(row => includedIds.has(row.employee_id))
    .map(row => ({
      employee_id:          row.employee_id,
      carry_forward_amount: row.carry_forward_amount,
    }))

  return NextResponse.json({
    period: {
      id:     period.id,
      month:  period.payroll_month,
      year:   period.payroll_year,
      status: period.status,
    },
    results,
    adjustments,
    settlements,
    excluded_count: excluded.length,
  })
}
