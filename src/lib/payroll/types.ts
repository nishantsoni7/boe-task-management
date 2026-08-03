// Payroll Calculation Engine V1 — internal types.
// These are engine-internal. UI types live in src/lib/types.ts.

// ─── Engine inputs ────────────────────────────────────────────────────────────

export type EngineEmployee = {
  id: string
  monthly_salary: number
  payroll_active: boolean
  joining_date: string | null   // ISO date, e.g. "2026-06-16"
  employment_type: 'permanent' | 'contract' | null
}

export type EnginePeriod = {
  id: string
  payroll_month: number   // 1–12
  payroll_year: number
  status: 'draft' | 'locked'
}

export type EngineAttendanceRecord = {
  id: string
  attendance_date: string   // ISO date
  check_in_at: string | null   // ISO timestamptz
  check_out_at: string | null  // ISO timestamptz
}

export type EngineHoliday = {
  holiday_date: string   // ISO date
}

// The manual override layer. Re-exported from the attendance module so payroll
// callers have one import for engine inputs, while the resolution rules stay
// where attendance owns them.
export type { AttendanceDayCorrection, DayTreatment } from '../attendance/corrections'

// ─── Per-day classification ───────────────────────────────────────────────────

export type DayClassification =
  | 'full_present'
  | 'present_with_shortfall'
  | 'short_present'
  | 'half_day'
  | 'full_absent'
  | 'missing_punch'   // one punch present, one missing — isolated deduction source
  | 'weekly_off'      // Sunday — excluded from all calculations
  | 'holiday'         // payroll_holidays entry — excluded from all calculations
  | 'pre_joining'     // before joining_date — excluded

export type DeductionType =
  | 'late_arrival'
  | 'early_checkout'
  | 'missing_punch_in'
  | 'missing_punch_out'
  | 'absent'
  | 'half_day'
  | 'short_hours'

// Result of classifying a single calendar day
export type DayResult = {
  date: string                        // ISO date
  classification: DayClassification
  effective_hours_worked: number      // post-lunch-deduction hours; 0 for absent/missing/excluded
  deduction_lines: PendingDeductionLine[]
  // The punches the classification was made from — corrected values when a
  // manual correction applies to the date, raw machine values otherwise.
  check_in_at: string | null
  check_out_at: string | null
  raw_check_in_at: string | null
  raw_check_out_at: string | null
  is_corrected: boolean
}

// One calendar day as the engine finally settled it: the classification, the
// effective punches, and every deduction line that landed on the date after
// leave absorption. This is what both result tabs read — the Deductions tab
// takes the days that carry a deduction, Days Considered takes the rest.
export type EngineDay = DayResult & {
  total_deduction_amount: number
}

// A deduction line before it is written to the database
export type PendingDeductionLine = {
  line_date: string
  deduction_type: DeductionType
  hours_deducted: number
  amount_deducted: number   // monetary; set to 0 if absorbed by leave
}

// ─── Monthly aggregates ───────────────────────────────────────────────────────

export type MonthlyAggregates = {
  working_days_in_month: number
  full_month_working_days: number   // denominator for paid leave proration
  days_present: number
  days_absent: number
  half_day_count: number
  late_deduction_hours: number
  short_hours_deduction: number
  missing_punch_hours: number
}

// ─── Monetary rates ───────────────────────────────────────────────────────────

export type PayrollRates = {
  per_day_rate: number
  per_hour_rate: number
}

// ─── Leave state ──────────────────────────────────────────────────────────────

export type LeaveState = {
  paid_leave_available: number   // 0, 0.5, or 1
  paid_leave_used: number        // 0, 0.5, or 1
  leave_absorbed_deductions: boolean
  // Aggregates after leave absorption (may differ from MonthlyAggregates values)
  remaining_absent_days: number
  remaining_half_days: number
  remaining_hourly_hours: number
}

// ─── Pending adjustment (loaded, not created by engine) ───────────────────────

export type EnginePendingAdjustment = {
  id: string
  amount: number   // positive = add to salary, negative = deduct from salary
  description: string
}

export type PendingAdjustmentsSummary = {
  additions: number
  deductions: number
  net_adjustment: number
}

// ─── Engine output ────────────────────────────────────────────────────────────

export type EngineResult = {
  // Period + employee
  payroll_period_id: string
  employee_id: string

  // Salary snapshot
  monthly_salary: number
  gross_salary: number

  // Attendance summary
  working_days_in_month: number
  days_present: number
  days_absent: number
  days_on_leave: number
  half_day_count: number
  paid_leave_available: number
  paid_leave_used: number

  // Deduction hour totals (raw, pre-absorption)
  late_deduction_hours: number
  short_hours_deduction: number
  missing_punch_hours: number

  // Leave absorption flag
  leave_absorbed_deductions: boolean

  // Monetary totals
  total_deductions: number
  pending_adjustment_total: number
  net_salary: number

  // Deduction lines to be written to payroll_deduction_lines
  deduction_lines: PendingDeductionLine[]

  // Every calendar day in the period, settled. Not persisted — it is the
  // day-level view the Payroll Result Detail tabs are built from.
  day_results: EngineDay[]

  // Adjustment ids that were applied — engine marks these 'applied' after writing result
  applied_adjustment_ids: string[]

  // Timestamp of this generation run
  generated_at: string
}

// ─── Step 9: Deduction breakdown ─────────────────────────────────────────────

export type TotalDeductions = {
  absent_deduction: number
  half_day_deduction: number
  hourly_deduction: number
  total_deduction: number
}

// ─── Guard failure ────────────────────────────────────────────────────────────

export type EngineSkip = {
  skipped: true
  reason: 'period_locked' | 'employee_inactive' | 'no_salary_configured'
}

export type EngineOutcome = EngineResult | EngineSkip

export function isSkip(outcome: EngineOutcome): outcome is EngineSkip {
  return (outcome as EngineSkip).skipped === true
}
