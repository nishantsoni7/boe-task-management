// POST /api/payroll/attendance-correction
//
// Corrects the attendance considered for one employee on one date, then
// recalculates that employee's payroll for the period.
//
// Body
//   payroll_period_id  string   required
//   employee_id        string   required
//   attendance_date    string   required — YYYY-MM-DD
//   check_in_at        string?  ISO timestamp, or null for "no punch-in"
//   check_out_at       string?  ISO timestamp, or null for "no punch-out"
//   day_treatment      'auto' | 'full_day' | 'half_day' | 'absent'
//   waive_late_arrival / waive_early_checkout / waive_missing_punch  boolean
//   remark             string   required, non-blank
//
// The raw biometric row in attendance_records is never touched. The correction
// is a new row in attendance_day_corrections that supersedes any previous one
// for the same employee and date, and payroll is regenerated from raw
// attendance overlaid with it.
//
// Auth: admin only. Refused outright once the payroll period is locked.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee, EngineDay } from '@/lib/payroll/types'
import {
  fetchPeriod,
  fetchEmployee,
  fetchAttendanceForPeriod,
  fetchHolidaysForPeriod,
  fetchPendingAdjustments,
  fetchCurrentCorrections,
  fetchActiveAttendanceRedemptions,
  createGenerationRow,
  writeEngineResult,
  markAdjustmentsApplied,
  finalizeGenerationRow,
} from '@/lib/payroll/store'
import {
  canCorrectAttendance,
  validateCorrectionInput,
  toEngineCorrection,
  buildCorrectionAudit,
  type DaySnapshot,
} from '@/lib/payroll/correctionRules'
import { reconcileAttendanceCoverage } from '@/lib/payroll/creditCoverage'

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

  // ── Body ────────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const periodId   = typeof body.payroll_period_id === 'string' ? body.payroll_period_id : ''
  const employeeId = typeof body.employee_id       === 'string' ? body.employee_id       : ''
  if (!periodId || !employeeId)
    return NextResponse.json({ error: 'payroll_period_id and employee_id are required' }, { status: 400 })

  // ── Period, permission and lock ─────────────────────────────────────────────
  let period: Awaited<ReturnType<typeof fetchPeriod>>
  try { period = await fetchPeriod(svc, periodId) }
  catch { return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 }) }

  const permission = canCorrectAttendance(callerProfile?.role, period.status)
  if (!permission.allowed) {
    return NextResponse.json(
      { error: permission.message },
      { status: permission.reason === 'not_authorised' ? 403 : 422 },
    )
  }

  const validation = validateCorrectionInput(body)
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })
  const correction = validation.value

  // The date must belong to the period being corrected, or the recalculation
  // would write a result that does not contain the change.
  const [dYear, dMonth] = correction.attendance_date.split('-').map(Number)
  if (dYear !== period.payroll_year || dMonth !== period.payroll_month) {
    return NextResponse.json(
      { error: 'The attendance date is not inside this payroll period.' },
      { status: 400 },
    )
  }

  // ── Inputs ──────────────────────────────────────────────────────────────────
  const employee = await fetchEmployee(svc, employeeId)
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  let attendance:  Awaited<ReturnType<typeof fetchAttendanceForPeriod>>
  let holidays:    Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  let adjustments: Awaited<ReturnType<typeof fetchPendingAdjustments>>
  let existing:    Awaited<ReturnType<typeof fetchCurrentCorrections>>
  let redemptions: Awaited<ReturnType<typeof fetchActiveAttendanceRedemptions>>
  try {
    ;[attendance, holidays, adjustments, existing, redemptions] = await Promise.all([
      fetchAttendanceForPeriod(svc, employeeId, period.payroll_month, period.payroll_year),
      fetchHolidaysForPeriod(svc, period.payroll_month, period.payroll_year),
      fetchPendingAdjustments(svc, employeeId, periodId, period.payroll_month, period.payroll_year),
      fetchCurrentCorrections(svc, employeeId, period.payroll_month, period.payroll_year),
      // Days the employee covered with BOE Credits stay covered through a
      // correction; the recalculation below must not charge them again.
      fetchActiveAttendanceRedemptions(svc, employeeId, period.payroll_month, period.payroll_year),
    ])
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const run = (
    corrections: Parameters<typeof generatePayrollForEmployee>[5],
    coverage: Parameters<typeof generatePayrollForEmployee>[7] = redemptions,
  ) =>
    generatePayrollForEmployee(employee as EngineEmployee, period, attendance, holidays, adjustments, corrections, undefined, coverage)

  // ── Before ──────────────────────────────────────────────────────────────────
  const before = run(existing)
  if (isSkip(before)) {
    return NextResponse.json(
      { error: `Payroll cannot be calculated for this employee (${before.reason}).` },
      { status: 422 },
    )
  }
  const beforeSnapshot = snapshotDay(before.day_results, correction.attendance_date, before.net_salary)

  // ── After ───────────────────────────────────────────────────────────────────
  const nextCorrections = [
    ...existing.filter(c => c.attendance_date !== correction.attendance_date),
    toEngineCorrection(correction),
  ]
  const after = run(nextCorrections)
  if (isSkip(after)) {
    return NextResponse.json(
      { error: `Payroll cannot be calculated for this employee (${after.reason}).` },
      { status: 422 },
    )
  }
  const afterSnapshot = snapshotDay(after.day_results, correction.attendance_date, after.net_salary)

  const previous = existing.find(c => c.attendance_date === correction.attendance_date) ?? null

  // ── Write ───────────────────────────────────────────────────────────────────
  // Order matters, and it is forced by the partial unique index on
  // (user_id, attendance_date) WHERE is_current: the previous version has to
  // stop being current BEFORE the new one is inserted, or the insert collides
  // with it and every amendment fails. superseded_by is filled in afterwards,
  // once the new row has an id.
  //
  // Both writes are rolled back by hand on failure — this stack has no
  // transaction spanning them — so a failed save leaves the previous correction
  // current and payroll untouched.
  const audit = buildCorrectionAudit(beforeSnapshot, afterSnapshot)

  if (previous) {
    const { error: supersedeErr } = await svc
      .from('attendance_day_corrections')
      .update({ is_current: false, superseded_at: new Date().toISOString() })
      .eq('id', previous.id)
      .eq('is_current', true)

    if (supersedeErr) {
      return NextResponse.json(
        { error: `Failed to retire the previous correction: ${supersedeErr.message}` },
        { status: 500 },
      )
    }
  }

  const { data: inserted, error: insertErr } = await svc
    .from('attendance_day_corrections')
    .insert({
      user_id:                employeeId,
      attendance_date:        correction.attendance_date,
      corrected_check_in_at:  correction.corrected_check_in_at,
      corrected_check_out_at: correction.corrected_check_out_at,
      day_treatment:          correction.day_treatment,
      waive_late_arrival:     correction.waive_late_arrival,
      waive_early_checkout:   correction.waive_early_checkout,
      waive_missing_punch:    correction.waive_missing_punch,
      remark:                 correction.remark,
      payroll_period_id:      periodId,
      corrected_by:           caller.id,
      ...audit,
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    // Put the previous version back — it was retired for an amendment that
    // never landed.
    if (previous) await restorePrevious(svc, previous.id)

    // With the previous version already retired, a duplicate here means another
    // admin inserted a current row for this date in the meantime — so the
    // concurrency message is accurate rather than a misread of our own ordering.
    const duplicate = (insertErr?.code === '23505')
    return NextResponse.json(
      {
        error: duplicate
          ? 'This date was corrected by someone else a moment ago. Reload and try again.'
          : `Failed to save the correction: ${insertErr?.message ?? 'unknown error'}`,
      },
      { status: duplicate ? 409 : 500 },
    )
  }

  const correctionId = (inserted as { id: string }).id

  // Close the version chain. Cosmetic for the calculation — the row is already
  // out of the way — so a failure here is logged, not fatal.
  if (previous) {
    const { error: linkErr } = await svc
      .from('attendance_day_corrections')
      .update({ superseded_by: correctionId })
      .eq('id', previous.id)
    if (linkErr) console.error('[payroll/attendance-correction] superseded_by link:', linkErr.message)
  }

  // ── BOE Credits coverage follows the corrected attendance ───────────────────
  // With the correction now the truth, a redeemed day that no longer carries
  // the deduction its credits paid for has those credits restored, and one
  // whose price changed is re-priced — through the ledger, as reversals with
  // a reason, by this admin. The recalculation below then writes a result
  // that matches what the ledger holds. A reconciliation that cannot be
  // read at all is a failed recalculation and is rolled back with it.
  let settled = after
  try {
    const reconciled = await reconcileAttendanceCoverage(svc, {
      employeeId,
      periodId,
      month: period.payroll_month,
      year:  period.payroll_year,
      actorId: caller.id,
      run: coverage => run(nextCorrections, coverage),
    })
    if (!isSkip(reconciled.outcome)) settled = reconciled.outcome
    for (const f of reconciled.failures) {
      console.error('[payroll/attendance-correction] credit coverage:', f.action.action, f.error)
    }
  } catch (e) {
    await rollback(svc, correctionId, previous?.id)
    return NextResponse.json(
      {
        error:
          'The correction was not saved: the BOE Credits coverage for this month could not be reconciled. ' +
          `Nothing was changed. (${String(e)})`,
      },
      { status: 500 },
    )
  }

  // ── Recalculate ─────────────────────────────────────────────────────────────
  try {
    const generationId = await createGenerationRow(svc, periodId, caller.id)
    const resultId     = await writeEngineResult(svc, generationId, settled)
    await markAdjustmentsApplied(svc, settled.applied_adjustment_ids, resultId, periodId)
    // Close the run so the generation log does not accumulate rows stuck at
    // 'running'. Non-fatal: the payroll figures are already written.
    await finalizeGenerationRow(svc, generationId, {
      status: 'done',
      employee_count: 1,
      skipped_count: 0,
      failed_employee_ids: [],
    }).catch(err => console.error('[payroll/attendance-correction] finalizeGenerationRow:', err))
  } catch (e) {
    await rollback(svc, correctionId, previous?.id)
    return NextResponse.json(
      {
        error:
          'The correction was not saved: payroll could not be recalculated. ' +
          `Nothing was changed. (${String(e)})`,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    correction_id: correctionId,
    attendance_date: correction.attendance_date,
    before: beforeSnapshot,
    after:  afterSnapshot,
    net_salary: settled.net_salary,
    total_deductions: settled.total_deductions,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function snapshotDay(days: EngineDay[], date: string, netSalary: number): DaySnapshot {
  const day = days.find(d => d.date === date)
  return {
    check_in_at:      day?.check_in_at  ?? null,
    check_out_at:     day?.check_out_at ?? null,
    classification:   day?.classification ?? null,
    deduction_amount: day?.total_deduction_amount ?? 0,
    net_salary:       netSalary,
  }
}

/**
 * Undo the correction write after a failed recalculation.
 *
 * Deleting the new row is the one place this module removes correction history,
 * and it is sound: the row never took effect, so keeping it would misrepresent
 * payroll as corrected when it is not.
 */
async function rollback(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  correctionId: string,
  previousId?: string,
): Promise<void> {
  try {
    // Delete first: the partial unique index allows only one current row per
    // employee-date, so restoring the previous one while the new one still
    // stands would fail.
    await svc.from('attendance_day_corrections').delete().eq('id', correctionId)
    if (previousId) await restorePrevious(svc, previousId)
  } catch (e) {
    console.error('[payroll/attendance-correction] rollback failed:', e)
  }
}

/** Make a retired version current again after a failed amendment. */
async function restorePrevious(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  previousId: string,
): Promise<void> {
  const { error } = await svc
    .from('attendance_day_corrections')
    .update({ is_current: true, superseded_at: null, superseded_by: null })
    .eq('id', previousId)
  if (error) console.error('[payroll/attendance-correction] restorePrevious failed:', error.message)
}
