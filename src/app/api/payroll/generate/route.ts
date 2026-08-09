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
  fetchEmployeesForGeneration,
  fetchAllPayrollActiveEmployees,
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchPendingAdjustments,
  fetchCurrentCorrections,
  createGenerationRow,
  writeEngineResult,
  markAdjustmentsApplied,
  finalizeGenerationRow,
  setPeriodStatus,
} from '@/lib/payroll/store'
import { fetchPrecedingPeriod, materialiseSettlement } from '@/lib/payroll/settlementStore'

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
    .select('role, full_name')
    .eq('id', caller.id)
    .single()
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }
  const actor = { id: caller.id, name: callerProfile?.full_name ?? null }

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

  // ── Lock guard ──────────────────────────────────────────────────────────────
  if (period.status === 'locked') {
    return NextResponse.json(
      { error: 'Payroll period is locked — generation and regeneration are not allowed.' },
      { status: 422 },
    )
  }

  // ── Fetch employees ─────────────────────────────────────────────────────────
  // Both paths are filtered by participation in the store. An employee excluded
  // from Attendance & Payroll never reaches the engine on either one — see
  // src/lib/payroll/participation.ts for what exclusion does and does not mean.
  let employees: Awaited<ReturnType<typeof fetchAllPayrollActiveEmployees>>
  let excludedIds: string[] = []
  try {
    if (employee_ids && employee_ids.length > 0) {
      const named = await fetchEmployeesForGeneration(svc, employee_ids)
      employees   = named.included
      excludedIds = named.excludedIds
    } else {
      employees = await fetchAllPayrollActiveEmployees(svc)
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // Naming ONLY excluded employees is a different situation from naming nobody,
  // and answering both with "no employees found" would leave the admin guessing.
  if (employees.length === 0 && excludedIds.length > 0) {
    return NextResponse.json(
      { error: 'Every employee named is excluded from Attendance & Payroll. Include them again to generate payroll for them.' },
      { status: 422 },
    )
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

  // ── Preceding payroll period, for the carry-forward proposal ───────────────
  // The previous period in the PAYROLL SEQUENCE, not the previous calendar
  // month: if June was never run, July's predecessor is May. Fetched once for
  // the whole run rather than per employee, since it is a property of the month
  // and not of any employee. Non-fatal — a payroll run must not fail because the
  // prior period could not be looked up; the settlement starts at zero and an
  // admin can correct it.
  const previousPeriodId = await fetchPrecedingPeriod(svc, period.payroll_month, period.payroll_year)
    .then(p => p?.id ?? null)
    .catch(err => {
      console.error('[payroll/generate] previous period lookup:', err)
      return null
    })

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

  // Excluded members are reported, not silently absent: an admin who named one
  // explicitly needs to be told the request was understood and declined.
  const outcomes: Outcome[] = excludedIds.map(id => ({
    employee_id: id,
    status: 'skipped' as const,
    reason: 'excluded_from_attendance_and_payroll',
  }))
  let skippedCount = excludedIds.length
  const failedIds: string[] = []

  for (const employee of employees) {
    try {
      // Per-employee fetches run in parallel — attendance, corrections and
      // adjustments are independent
      const [attendance, adjustments, corrections] = await Promise.all([
        fetchAttendanceForPeriod(svc, employee.id, period.payroll_month, period.payroll_year),
        fetchPendingAdjustments(svc, employee.id, payroll_period_id, period.payroll_month, period.payroll_year),
        fetchCurrentCorrections(svc, employee.id, period.payroll_month, period.payroll_year),
      ])

      // Approved manual corrections outrank the raw biometric record, so a
      // regeneration re-applies them instead of reverting to the machine values.
      const outcome = generatePayrollForEmployee(
        employee,
        period,
        attendance,
        holidays,
        adjustments,
        corrections,
      )

      if (isSkip(outcome)) {
        skippedCount++
        outcomes.push({ employee_id: employee.id, status: 'skipped', reason: outcome.reason })
        continue
      }

      const resultId = await writeEngineResult(svc, generationId, outcome)
      await markAdjustmentsApplied(svc, outcome.applied_adjustment_ids, resultId, payroll_period_id)

      // The carry-forward proposal becomes a stored fact here, with the source
      // period recorded, so the balance has an auditable lineage rather than
      // being re-derived on every read. A manual override and a recorded payment
      // both survive this untouched — see materialiseSettlement.
      //
      // Non-fatal: payroll has already been written and is correct. A settlement
      // that could not be materialised is recoverable (the next regeneration, or
      // the first settlement edit, creates it) and must not turn a successful
      // payroll run into a failed one.
      await materialiseSettlement(svc, {
        periodId:   payroll_period_id,
        employeeId: employee.id,
        resultId,
        previousPeriodId,
        actor,
      }).catch(err =>
        console.error(`[payroll/generate] settlement for ${employee.id}:`, err),
      )

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

  // ── Promote period to 'generated' ───────────────────────────────────────────
  // Non-fatal: a status update failure must not mask primary outcomes.
  if (generatedCount > 0) {
    await setPeriodStatus(svc, payroll_period_id, 'generated').catch(err =>
      console.error('[payroll/generate] setPeriodStatus error:', err),
    )
  }

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
