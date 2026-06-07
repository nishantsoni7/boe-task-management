// POST /api/payroll/generate
//
// Generates payroll for one period + a set of employees (or all payroll-active employees
// if no list is supplied).
//
// Request body
//   payroll_period_id  string    required
//   employee_ids       string[]  optional — omit to run for all payroll-active employees
//
// Response  200
//   generation   { id, status, employee_count, skipped_count, failed_count }
//   outcomes     Array<GeneratedOutcome | SkippedOutcome | FailedOutcome>
//
// Auth: admin only (service-role token verification)

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { isSkip } from '@/lib/payroll/types'
import {
  fetchPeriod,
  fetchEmployee,
  fetchAllPayrollActiveEmployees,
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchPendingAdjustments,
  createGenerationRow,
  writeEngineResult,
  markAdjustmentsApplied,
  finalizeGenerationRow,
} from '@/lib/payroll/store'

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
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
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { payroll_period_id?: string; employee_ids?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { payroll_period_id, employee_ids } = body
  if (!payroll_period_id) {
    return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })
  }

  // ── Fetch period ────────────────────────────────────────────────────────────
  let period: Awaited<ReturnType<typeof fetchPeriod>>
  try {
    period = await fetchPeriod(svc, payroll_period_id)
  } catch {
    return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })
  }

  // ── Fetch employees ─────────────────────────────────────────────────────────
  let employees: Awaited<ReturnType<typeof fetchAllPayrollActiveEmployees>>
  try {
    if (employee_ids && employee_ids.length > 0) {
      const rows = await Promise.all(employee_ids.map(id => fetchEmployee(svc, id)))
      employees = rows.filter((e): e is NonNullable<typeof e> => e !== null)
    } else {
      employees = await fetchAllPayrollActiveEmployees(svc)
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  if (employees.length === 0) {
    return NextResponse.json({ error: 'No employees found to process' }, { status: 400 })
  }

  // ── Fetch holidays once (shared across all employees in this period) ─────────
  let holidays: Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  try {
    holidays = await fetchHolidaysForPeriod(svc, period.payroll_month, period.payroll_year)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // ── Create generation row ────────────────────────────────────────────────────
  let generationId: string
  try {
    generationId = await createGenerationRow(svc, payroll_period_id, caller.id)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // ── Process each employee ────────────────────────────────────────────────────
  type Outcome =
    | { employee_id: string; status: 'generated'; payroll_result_id: string }
    | { employee_id: string; status: 'skipped';   reason: string }
    | { employee_id: string; status: 'failed';    error: string }

  const outcomes: Outcome[] = []
  let skippedCount = 0
  const failedIds: string[] = []

  for (const employee of employees) {
    try {
      // Per-employee fetches run in parallel — attendance and adjustments are independent
      const [attendance, adjustments] = await Promise.all([
        fetchAttendanceForPeriod(svc, employee.id, period.payroll_month, period.payroll_year),
        fetchPendingAdjustments(svc, employee.id, payroll_period_id),
      ])

      const outcome = generatePayrollForEmployee(
        employee,
        period,
        attendance,
        holidays,
        adjustments,
      )

      if (isSkip(outcome)) {
        skippedCount++
        outcomes.push({ employee_id: employee.id, status: 'skipped', reason: outcome.reason })
        continue
      }

      const resultId = await writeEngineResult(svc, generationId, outcome)
      await markAdjustmentsApplied(svc, outcome.applied_adjustment_ids, resultId)

      outcomes.push({ employee_id: employee.id, status: 'generated', payroll_result_id: resultId })
    } catch (e) {
      failedIds.push(employee.id)
      outcomes.push({ employee_id: employee.id, status: 'failed', error: String(e) })
    }
  }

  // ── Finalize generation row ──────────────────────────────────────────────────
  const generatedCount = outcomes.filter(o => o.status === 'generated').length
  // 'failed' only when every employee errored; partial success is still 'done'
  const overallStatus  = generatedCount === 0 && failedIds.length > 0 ? 'failed' : 'done'

  // Non-fatal: a finalize failure must not mask the primary outcomes
  await finalizeGenerationRow(svc, generationId, {
    status:              overallStatus,
    employee_count:      employees.length,
    skipped_count:       skippedCount,
    failed_employee_ids: failedIds,
    error_message:       failedIds.length > 0
      ? `${failedIds.length} employee(s) failed — see failed_employee_ids`
      : undefined,
  }).catch(err => console.error('[payroll/generate] finalizeGenerationRow error:', err))

  return NextResponse.json({
    generation: {
      id:             generationId,
      status:         overallStatus,
      employee_count: employees.length,
      skipped_count:  skippedCount,
      failed_count:   failedIds.length,
    },
    outcomes,
  })
}
