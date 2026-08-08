// GET /api/payroll/my-result
// Returns the authenticated employee's own payroll results.
//
// Without period_id  →  list of all periods where a result exists for the caller.
// With period_id     →  full detail for that period (including deduction lines).
//
// Any authenticated user may call this — they only ever see their own data.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { buildResultDetailPayload } from '@/lib/payroll/resultDetailPayload'

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
  // ─── Detail view ─────────────────────────────────────────────────────────────
  //
  // Built by the SAME module the admin detail route uses, so the employee sees
  // the approved presentation of their own payslip rather than an older, thinner
  // rendering of it that drifts every time the admin page improves.
  //
  // The employee id is the caller's, taken from the token. There is no
  // employee_id parameter on this route to tamper with, and canEdit is hard-false:
  // reading your own payslip is not permission to correct attendance, which stays
  // admin-only in its own route.
  if (periodId) {
    const outcome = await buildResultDetailPayload(svc, {
      periodId,
      employeeId:  caller.id,
      canEdit:     false,
      editBlocked: null,
    })

    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json(outcome.payload)
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
