// POST /api/boe-credits/redemptions
//   { payroll_period_id, attendance_date }
//
// The employee covers ONE attendance deduction of their own with BOE Credits:
// 1 credit for a half day, 2 for an absent day (Phase 1C).
//
// WHO. The caller from the bearer token, and nobody else. There is no
// employee_id in the body: the day redeemed is the caller's, the ledger row is
// the caller's, and redeem_boe_credits_for_attendance() refuses an actor that
// is not the employee even if this route were bypassed.
//
// WHAT QUALIFIES IS DECIDED HERE, FROM THE ENGINE, NOT FROM THE BROWSER. The
// page offered the day because the detail payload listed it as redeemable;
// this route does not trust that. It runs the payroll engine again over the
// caller's live attendance, corrections, settings snapshot and existing
// coverage, and refuses anything that is not a chargeable absent or half-day
// line: no deduction, a late mark, a missing punch, a company-paid day, a day
// already covered, a future date, a locked month. The cost is never read from
// the request either — the database fixes it from the kind.
//
// THEN THE DATABASE DECIDES THE REST, under locks: the period is unlocked and
// stays so until commit, payroll was generated, the date is in the month, the
// day is not already covered, the balance suffices, and the ledger row and the
// redemption record are written together. A retried or concurrent request
// lands on the per-employee advisory lock and is refused as a duplicate.
//
// AFTERWARDS the caller's payroll result is regenerated through the ordinary
// generation path — the same three store calls the attendance-correction
// route makes — so the stored figures carry the coverage immediately and
// exactly once. If that recalculation fails the redemption still stands (it
// is committed) and the day view's staleness check — a live engine run over
// the active coverage against the stored total, in buildDayView — reports
// the stored money as out of date until the period is regenerated; the
// response says so. resultDetailPayload.stale.test.ts proves that path.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { isSkip } from '@/lib/payroll/types'
import type { EngineEmployee, EnginePeriod } from '@/lib/payroll/types'
import {
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
import { fetchActiveSettings, settingsForPeriod } from '@/lib/payroll/settingsStore'
import { istToday } from '@/lib/istDate'
import {
  attendanceRedemptionEligibility,
  REDEMPTION_REFUSALS,
  type AttendanceCreditRedemption,
} from '@/lib/boeCredits/attendanceRedemption'
import { redeemAttendanceDay, CreditServiceError, creditErrorStatus } from '@/lib/boeCredits/service'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const svc = caller.svc

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload  = (body ?? {}) as { payroll_period_id?: unknown; attendance_date?: unknown }
  const periodId = typeof payload.payroll_period_id === 'string' ? payload.payroll_period_id.trim() : ''
  const date     = typeof payload.attendance_date   === 'string' ? payload.attendance_date.trim()   : ''
  if (!periodId) return NextResponse.json({ error: 'payroll_period_id is required' }, { status: 400 })
  if (!ISO_DATE.test(date)) return NextResponse.json({ error: 'A valid attendance date is required.' }, { status: 400 })

  // ── The period, with its settings snapshot ──────────────────────────────────
  const { data: periodRow } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status, settings_snapshot')
    .eq('id', periodId)
    .maybeSingle()
  if (!periodRow) return NextResponse.json({ error: 'Payroll period not found' }, { status: 404 })

  const period = periodRow as {
    id: string; payroll_month: number; payroll_year: number
    status: 'draft' | 'generated' | 'locked'; settings_snapshot: unknown
  }
  if (period.status === 'locked') {
    return NextResponse.json({ error: REDEMPTION_REFUSALS.locked }, { status: 409 })
  }

  // ── The caller's own inputs. The employee id is the token's. ────────────────
  const employeeId = caller.id
  const employee = await fetchEmployee(svc, employeeId)
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  let attendance:  Awaited<ReturnType<typeof fetchAttendanceForPeriod>>
  let holidays:    Awaited<ReturnType<typeof fetchHolidaysForPeriod>>
  let corrections: Awaited<ReturnType<typeof fetchCurrentCorrections>>
  let redemptions: AttendanceCreditRedemption[]
  let adjustments: Awaited<ReturnType<typeof fetchPendingAdjustments>>
  let settings:    Awaited<ReturnType<typeof fetchActiveSettings>>['settings']
  try {
    const [att, hols, corr, redeemed, adj, active] = await Promise.all([
      fetchAttendanceForPeriod(svc, employeeId, period.payroll_month, period.payroll_year),
      fetchHolidaysForPeriod(svc, period.payroll_month, period.payroll_year),
      fetchCurrentCorrections(svc, employeeId, period.payroll_month, period.payroll_year),
      fetchActiveAttendanceRedemptions(svc, employeeId, period.payroll_month, period.payroll_year),
      fetchPendingAdjustments(svc, employeeId, periodId, period.payroll_month, period.payroll_year),
      fetchActiveSettings(svc),
    ])
    attendance  = att
    holidays    = hols
    corrections = corr
    redemptions = redeemed
    adjustments = adj
    // The SAME settings the stored money was produced under, so the day
    // offered here is the day the payslip shows.
    settings = settingsForPeriod({ status: period.status, settings_snapshot: period.settings_snapshot }, active.settings)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const enginePeriod: EnginePeriod = {
    id: period.id, payroll_month: period.payroll_month, payroll_year: period.payroll_year, status: 'draft',
  }
  const run = (coverage: AttendanceCreditRedemption[]) =>
    generatePayrollForEmployee(
      employee as EngineEmployee, enginePeriod, attendance, holidays, adjustments, corrections, settings, coverage,
    )

  // ── Eligibility, from the engine ────────────────────────────────────────────
  const before = run(redemptions)
  if (isSkip(before)) {
    return NextResponse.json(
      { error: `Payroll cannot be calculated for you this month (${before.reason}).` },
      { status: 422 },
    )
  }

  const day = before.day_results.find(d => d.date === date)
  const eligibility = attendanceRedemptionEligibility(day, {
    periodStatus: period.status,
    today:        istToday(),
    periodMonth:  period.payroll_month,
    periodYear:   period.payroll_year,
  })
  if (!eligibility.eligible) {
    const status = eligibility.reason === 'already_covered' || eligibility.reason === 'locked' ? 409 : 422
    return NextResponse.json({ error: eligibility.message, reason: eligibility.reason }, { status })
  }

  // ── The redemption, atomically ──────────────────────────────────────────────
  let redeemed: Awaited<ReturnType<typeof redeemAttendanceDay>>
  try {
    redeemed = await redeemAttendanceDay(svc, {
      employeeId,
      payrollPeriodId: periodId,
      attendanceDate:  date,
      deductionType:   eligibility.deduction_type,
      // The employee acts for themselves. Same id twice, on purpose.
      actorId:         caller.id,
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message, marker: e.marker }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // ── Recalculate the caller's result through the ordinary generation path ────
  const after = run([
    ...redemptions,
    { attendance_date: date, deduction_type: redeemed.deduction_type, credits: redeemed.credits },
  ])

  let recalculated = false
  let recalculationError: string | null = null
  if (isSkip(after)) {
    recalculationError = `Payroll cannot be recalculated (${after.reason}).`
  } else {
    try {
      const generationId = await createGenerationRow(svc, periodId, caller.id)
      const resultId     = await writeEngineResult(svc, generationId, after)
      await markAdjustmentsApplied(svc, after.applied_adjustment_ids, resultId, periodId)
      await finalizeGenerationRow(svc, generationId, {
        status: 'done', employee_count: 1, skipped_count: 0, failed_employee_ids: [],
      }).catch(err => console.error('[boe-credits/redemptions] finalizeGenerationRow:', err))
      recalculated = true
    } catch (e) {
      console.error('[boe-credits/redemptions] recalculation after redemption:', e)
      recalculationError = String(e)
    }
  }

  return NextResponse.json({
    redemption_id:     redeemed.redemption_id,
    transaction_id:    redeemed.transaction_id,
    attendance_date:   redeemed.attendance_date,
    deduction_type:    redeemed.deduction_type,
    credits:           redeemed.credits,
    available_credits: redeemed.available_credits,
    // Whether the stored payslip already carries the coverage. When false the
    // credits are spent and the day is covered, but the salary figures wait
    // for the next regeneration; the detail page's stale banner says so.
    recalculated,
    recalculation_error: recalculationError,
    ...(isSkip(after) ? {} : { net_salary: after.net_salary, total_deductions: after.total_deductions }),
  })
}
