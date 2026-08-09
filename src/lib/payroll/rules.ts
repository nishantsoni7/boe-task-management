// The payroll rules BOE actually runs — the numbers, and the catalogue that
// explains them.
//
// Why this file exists
// --------------------
// "How Attendance & Payroll Is Calculated" on Payroll Result Detail has to
// describe the engine, not a document about the engine. docs/PAYROLL_RULES_V1.md
// is the business brief and it has already drifted from the code in at least one
// place that matters (see PER_DAY_DIVISOR below), so explanatory copy written
// from it would be wrong the moment an employee checked the arithmetic.
//
// So the catalogue is assembled here, from the same constants engine.ts
// calculates with, and the engine imports them from here. Change a rule and the
// explanation changes with it, or the build breaks.
//
// Nothing in this file calculates anything. It is constants plus prose.

import {
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  SCHEDULED_OUT_MINUTES,
  FULL_DAY_HOURS,
  HALF_DAY_HOURS,
  LUNCH_HOURS,
  PRESENCE_THRESHOLD_HOURS,
  ROUNDING_BLOCK_MINUTES,
  ROUNDING_BLOCK_HOURS,
  WEEKLY_OFF_DAY,
} from '../attendance/scheduleRules'

export {
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  SCHEDULED_OUT_MINUTES,
  FULL_DAY_HOURS,
  HALF_DAY_HOURS,
  ROUNDING_BLOCK_MINUTES,
  ROUNDING_BLOCK_HOURS,
  WEEKLY_OFF_DAY,
}

// ─── Money ────────────────────────────────────────────────────────────────────

/**
 * Per-day salary = monthly salary ÷ 26.
 *
 * NOTE, deliberately recorded: docs/PAYROLL_RULES_V1.md §"Salary Formula" says
 * ÷ 30, and a stale comment in engine.ts said so too. The engine has divided by
 * 26 since it was written — 26 being the working days in a six-day week month —
 * and every generated payroll in the database was produced that way. The code is
 * therefore the rule, and this constant is the single place it is stated.
 */
export const PER_DAY_DIVISOR = 26

/** Per-hour salary = per-day salary ÷ the paid hours in a working day. */
export const PER_HOUR_DIVISOR = FULL_DAY_HOURS

/** A missing punch-in or punch-out costs this many hours, flat. */
export const MISSING_PUNCH_HOURS = 2


// ─── Paid leave ───────────────────────────────────────────────────────────────

/**
 * How much paid leave a month earns, by days actually present.
 *
 * Read top-down: the first band the employee reaches is what they get. This is
 * the whole of BOE's "first paid leave is on the company" rule — there is no
 * separate counter anywhere, and there must not be one: the entitlement is
 * recomputed from attendance on every payroll run, which is exactly why
 * regenerating a period, or correcting a date inside it, cannot consume the
 * allowance twice.
 */
export const PAID_LEAVE_TIERS = [
  { min_days_present: 16, leave: 1 },
  { min_days_present: 11, leave: 0.5 },
  { min_days_present: 0,  leave: 0 },
] as const

/** Half-days that one full paid leave can absorb instead. */
export const HALF_DAYS_PER_PAID_LEAVE = 2

/** Hourly deductions one full paid leave can absorb instead. */
export const HOURS_PER_PAID_LEAVE = FULL_DAY_HOURS

// ─── The rule catalogue ───────────────────────────────────────────────────────

export type RuleGroup =
  | 'day'        // how a date is classified
  | 'deduction'  // what a classification costs
  | 'leave'      // the paid-leave allowance
  | 'settlement' // carry-forward, adjustments, payment, closing balance
  | 'process'    // corrections, regeneration, locking

export type RuleCard = {
  key: string
  group: RuleGroup
  title: string
  /** One sentence. What the rule does. */
  body: string
  /** The number the rule turns on, when there is one. */
  detail?: string
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** The five steps a punch travels to become money. */
export const CALCULATION_FLOW = [
  { key: 'attendance',     label: 'Attendance',      body: 'Machine punches, or an approved correction where one exists.' },
  { key: 'classification', label: 'Day Classification', body: 'Present · Half Day · Absent · Missing Punch · Weekly Off · Holiday.' },
  { key: 'rules',          label: 'Payroll Rules',   body: 'Late arrival, early departure, short hours, missing punch, leave.' },
  { key: 'deductions',     label: 'Deductions',      body: 'Each applicable rule × the salary rate for its unit.' },
  { key: 'net',            label: 'Net Payable',     body: 'Gross salary − deductions ± adjustments.' },
] as const

// ─── The salary, step by step ─────────────────────────────────────────────────

/**
 * The nine figures on a payslip, in the order they are worked out.
 *
 * This is the spine of /payroll/how-it-works and the same sequence the
 * Adjustments & Settlement section renders. `formula` is the arithmetic in one
 * line; where a step is a plain input rather than a calculation, it is null.
 *
 * `sign` says what a figure can be, which is the thing employees get wrong most
 * often: a balance is the only one that is genuinely two-directional.
 */
export type SalaryStep = {
  key: string
  label: string
  body: string
  formula?: string
  sign?: 'positive' | 'negative' | 'signed'
  /** Marks the three figures that are conclusions rather than ingredients. */
  emphasis?: boolean
}

export const SALARY_FLOW: SalaryStep[] = [
  {
    key: 'gross_salary',
    label: 'Gross Salary',
    body: 'Your agreed monthly salary. It is recorded when payroll is generated, so a later change to your salary never rewrites a month that has already been run.',
    sign: 'positive',
  },
  {
    key: 'working_days',
    label: 'Working Days',
    body: `Every day of the month except Sundays, company holidays, and any date before you joined. Your daily rate is the monthly salary ÷ ${PER_DAY_DIVISOR}, and your hourly rate is that ÷ ${PER_HOUR_DIVISOR}.`,
    formula: `Per day = Monthly Salary ÷ ${PER_DAY_DIVISOR}   ·   Per hour = Per day ÷ ${PER_HOUR_DIVISOR}`,
  },
  {
    key: 'daily_attendance',
    label: 'Daily Attendance',
    body: 'Each working day is classified from your punches — full present, half day, absent, missing punch, and so on. The cards below say exactly what each one means.',
  },
  {
    key: 'attendance_deductions',
    label: 'Attendance Deductions',
    body: 'Every rule that applied to a day, charged at the rate for its unit, added together. Days covered by your paid leave stay on the list showing ₹0, so the month still adds up.',
    sign: 'negative',
  },
  {
    key: 'salary_after_attendance',
    label: 'Salary After Attendance',
    body: 'What the month itself earned, before anything carried over from an earlier month.',
    formula: 'Gross Salary − Attendance Deductions',
    emphasis: true,
  },
  {
    key: 'previous_balance',
    label: 'Previous Balance',
    body: 'Anything left unsettled in your previous payroll month. A positive balance means BOE still owes you it. A negative balance means you have already received that much in advance, and it is recovered here. If that month’s payment has not been recorded yet, nothing is carried across — the balance is not guessed at.',
    sign: 'signed',
  },
  {
    key: 'other_adjustments',
    label: 'Other Adjustments',
    body: 'Additions and recoveries an admin has entered for this month — a reimbursement, an approved correction, an advance being recovered. Each one is listed separately with its reason; they are never merged into a single unexplained number.',
    sign: 'signed',
  },
  {
    key: 'salary_payable',
    label: 'Salary Payable',
    body: 'What BOE should settle for this month, once the balance and the adjustments are applied.',
    formula: 'Salary After Attendance + Previous Balance + Other Adjustments',
    emphasis: true,
  },
  {
    key: 'amount_paid',
    label: 'Amount Paid',
    body: 'What was actually paid to you for this month. It can be equal to, less than, or more than Salary Payable — recording it never changes any figure above it.',
    sign: 'positive',
  },
  {
    key: 'closing_balance',
    label: 'Balance Carried Forward',
    body: 'What is still outstanding after the payment. Positive means BOE owes you; negative means you are in advance and it will be adjusted next month; zero means the month is fully settled. Whatever it is becomes next month’s Previous Balance. Until the payment is recorded there is no balance at all, and the payslip says so rather than showing a figure.',
    formula: 'Salary Payable − Amount Paid',
    sign: 'signed',
    emphasis: true,
  },
]

// ─── A worked example, derived rather than written ────────────────────────────

/**
 * The example salary the deduction figures below are worked from.
 *
 * A round number so the arithmetic is followable, and DERIVED — every amount in
 * EXAMPLE_DEDUCTIONS is computed from the same constants the engine divides by,
 * so an example cannot quietly start disagreeing with the rule above it. That is
 * the whole reason this lives in rules.ts rather than being typed into the page.
 */
export const EXAMPLE_MONTHLY_SALARY = 18_000

const EXAMPLE_PER_DAY  = EXAMPLE_MONTHLY_SALARY / PER_DAY_DIVISOR
const EXAMPLE_PER_HOUR = EXAMPLE_PER_DAY / PER_HOUR_DIVISOR

export type ExampleDeduction = { label: string; detail: string; amount: number }

export const EXAMPLE_DEDUCTIONS: ExampleDeduction[] = [
  {
    label:  'Late Arrival',
    detail: `${ROUNDING_BLOCK_HOURS}h × per-hour rate`,
    amount: ROUNDING_BLOCK_HOURS * EXAMPLE_PER_HOUR,
  },
  {
    label:  'Absent',
    detail: '1 day × per-day rate',
    amount: EXAMPLE_PER_DAY,
  },
  {
    label:  'Half Day',
    detail: 'Half a day × per-day rate',
    amount: EXAMPLE_PER_DAY / 2,
  },
]

export const EXAMPLE_DEDUCTION_TOTAL =
  EXAMPLE_DEDUCTIONS.reduce((sum, line) => sum + line.amount, 0)

/** What BOE payroll deliberately does not do. Stated rather than left to be discovered. */
export const NOT_CALCULATED = [
  'Overtime. Extra hours are not paid automatically; anything owed for them is entered as an adjustment.',
  'Tax, PF and other statutory deductions. Payroll shows gross salary and attendance, not take-home after tax.',
  'Bonuses and incentives. These reach payroll as adjustments, with a reason, rather than being calculated here.',
]

/**
 * Every rule the engine actually applies.
 *
 * If a rule is not implemented it is not here. Two things employees might expect
 * are deliberately absent because the engine does not do them: there is no
 * overtime, and there is no separate "unpaid leave" status — a day nobody
 * punched and no admin corrected is an absence, and an absence beyond the paid
 * leave allowance is what unpaid time off looks like in BOE payroll.
 */
export const RULE_CARDS: RuleCard[] = [
  // ── How a day is classified ────────────────────────────────────────────────
  {
    key: 'working_day',
    group: 'day',
    title: 'Working day',
    body: 'Every calendar day of the month except Sundays, company holidays, and dates before the employee joined.',
    detail: 'Sundays and holidays are paid and consume no leave.',
  },
  {
    key: 'full_present',
    group: 'day',
    title: 'Full Present',
    body: `In by ${clock(GRACE_END_MINUTES)} and out at or after ${clock(SCHEDULED_OUT_MINUTES)} counts as a full day. Otherwise ${PRESENCE_THRESHOLD_HOURS.full_present} effective hours or more does.`,
    detail: `Effective hours = time on site − ${LUNCH_HOURS}h lunch, when the day spans the lunch break.`,
  },
  {
    key: 'present_with_shortfall',
    group: 'day',
    title: 'Present (short hours)',
    body: `${PRESENCE_THRESHOLD_HOURS.present_with_shortfall}–${PRESENCE_THRESHOLD_HOURS.full_present} effective hours. A full present day, still open to late-arrival and early-departure deductions.`,
  },
  {
    key: 'half_day',
    group: 'day',
    title: 'Half Day',
    body: `${PRESENCE_THRESHOLD_HOURS.half_day}–${PRESENCE_THRESHOLD_HOURS.present_with_shortfall} effective hours. Counts as half a payable day.`,
  },
  {
    key: 'short_present',
    group: 'day',
    title: 'Short Present',
    body: `${PRESENCE_THRESHOLD_HOURS.short_present}–${PRESENCE_THRESHOLD_HOURS.half_day} effective hours. Counted as a present day, with no additional hourly cut.`,
  },
  {
    key: 'absent',
    group: 'day',
    title: 'Absent',
    body: `No punches at all, or under ${PRESENCE_THRESHOLD_HOURS.short_present} effective hours.`,
    detail: 'A month with no present days at all pays ₹0.',
  },
  {
    key: 'weekly_off',
    group: 'day',
    title: 'Weekly Off',
    body: 'Sunday. Never an absence, never a deduction, never leave.',
  },
  {
    key: 'holiday',
    group: 'day',
    title: 'Holiday',
    body: 'A date on the company holiday list. Paid, and excluded from the working-day count.',
  },

  // ── What it costs ──────────────────────────────────────────────────────────
  {
    key: 'salary_rate',
    group: 'deduction',
    title: 'Salary rate',
    body: `Per day = monthly salary ÷ ${PER_DAY_DIVISOR}. Per hour = per day ÷ ${PER_HOUR_DIVISOR}.`,
    detail: 'Every deduction below is one of these two rates × the units the rule charges.',
  },
  {
    key: 'late_arrival',
    group: 'deduction',
    title: 'Late Arrival',
    body: `Measured from ${clock(SCHEDULED_IN_MINUTES)}. Up to ${GRACE_END_MINUTES - SCHEDULED_IN_MINUTES} minutes late is free; past that it rounds up to the next ${ROUNDING_BLOCK_MINUTES} minutes and costs ${ROUNDING_BLOCK_HOURS}h per block.`,
    // Worked from roundDeductionHours() in engine.ts, not from the brief:
    // 45 minutes past 10:00 rounds up to two 30-minute blocks = 1 hour.
    detail: `In at ${clock(SCHEDULED_IN_MINUTES + 45)} is 45 min past ${clock(SCHEDULED_IN_MINUTES)} → 1h × per-hour rate.`,
  },
  {
    key: 'early_checkout',
    group: 'deduction',
    title: 'Early Departure',
    body: `Measured from ${clock(SCHEDULED_OUT_MINUTES)}, rounded up the same way — ${ROUNDING_BLOCK_HOURS}h per ${ROUNDING_BLOCK_MINUTES}-minute block, with the first ${GRACE_END_MINUTES - SCHEDULED_IN_MINUTES} minutes free.`,
  },
  {
    key: 'short_hours',
    group: 'deduction',
    title: 'Short Hours',
    body: 'Charged at the per-hour rate when it applies. A day short of full hours is normally settled by its classification — Half Day, or a late/early deduction — rather than by a separate short-hours line.',
  },
  {
    key: 'missing_punch',
    group: 'deduction',
    title: 'Missing Punch-In / Punch-Out',
    body: `One punch present and the other missing costs a flat ${MISSING_PUNCH_HOURS} hours. The day still counts as present.`,
    detail: 'A missing punch-out also carries a late-arrival deduction if the punch-in was late. Both punches missing is an absence, not a missing punch.',
  },
  {
    key: 'absent_deduction',
    group: 'deduction',
    title: 'Absent deduction',
    body: 'One per-day rate for each absent day not covered by paid leave.',
  },
  {
    key: 'half_day_deduction',
    group: 'deduction',
    title: 'Half-day deduction',
    body: 'Half a per-day rate for each half day not covered by paid leave.',
  },

  // ── Paid leave ─────────────────────────────────────────────────────────────
  {
    key: 'paid_leave',
    group: 'leave',
    title: 'Paid Leave',
    body: `Earned by attendance in the same month: ${PAID_LEAVE_TIERS[0].min_days_present}+ days present earns ${PAID_LEAVE_TIERS[0].leave} day, ${PAID_LEAVE_TIERS[1].min_days_present}–${PAID_LEAVE_TIERS[0].min_days_present - 1} days earns ${PAID_LEAVE_TIERS[1].leave}, below that none.`,
    detail: 'The allowance is per payroll month and does not carry forward.',
  },
  {
    key: 'company_paid_leave',
    group: 'leave',
    title: 'First paid leave is on the company',
    body: 'The allowance is spent on the EARLIEST item of the month it can cover, and that item is charged ₹0 — it stays visible in Deductions so the month still adds up.',
    detail: `Earliest by attendance date, never by when the record was imported or edited. In order of what it covers: one absent day, then ${HALF_DAYS_PER_PAID_LEAVE} half days, then one half day against a ${PAID_LEAVE_TIERS[1].leave}-day allowance, then up to ${HOURS_PER_PAID_LEAVE}h of late / early / missing-punch deductions.`,
  },
  {
    key: 'unpaid_leave',
    group: 'leave',
    title: 'Unpaid leave',
    body: 'Anything past the allowance. A second absent day, or a half day the allowance did not reach, is deducted at the rates above.',
  },

  // ── Process ────────────────────────────────────────────────────────────────
  {
    key: 'corrections',
    group: 'process',
    title: 'Attendance corrections',
    body: 'An admin can restate a date — its punches, or the whole day as full day / half day / absent — and can waive a late, early or missing-punch deduction with a written reason.',
    detail: 'The machine record is never overwritten. Every version is kept, and payroll uses the current one.',
  },
  // ── Adjustments and settlement ─────────────────────────────────────────────
  {
    key: 'other_adjustments',
    group: 'settlement',
    title: 'Other Adjustments',
    body: 'Manual additions and recoveries an admin enters against a month — a reimbursement, an approved correction, an advance being recovered. Applied after attendance deductions.',
    detail: 'Every entry carries a written reason and is listed separately on the payslip. Unrelated amounts are never combined into one figure.',
  },
  {
    key: 'previous_balance',
    group: 'settlement',
    title: 'Previous Balance',
    body: 'The closing balance of your preceding payroll month, brought forward. Positive means BOE still owes you; negative means you have already received that much and it is being recovered.',
    detail: 'Taken from the preceding payroll period that actually ran — if a month was never processed, the one before it is used. A period whose payment has not been recorded has no confirmed balance, so nothing is carried from it. An admin may correct the figure, but only with a written reason, and the originally proposed amount is kept alongside the correction.',
  },
  {
    key: 'salary_payable',
    group: 'settlement',
    title: 'Salary Payable',
    body: 'Salary After Attendance, plus the previous month’s balance, plus or minus this month’s adjustments. This is what BOE should settle for the month.',
    detail: 'It can be negative, when a recovery is larger than the month’s pay. That is not an error — it means more has already been paid than the month earned.',
  },
  {
    key: 'amount_paid',
    group: 'settlement',
    title: 'Amount Paid',
    body: 'What was actually paid for the month. It is a record of a payment, not an input to the calculation.',
    detail: 'Recording it never reruns attendance, never changes a deduction and never alters gross salary. It changes one figure: the balance carried forward.',
  },
  {
    key: 'closing_balance',
    group: 'settlement',
    title: 'Balance Carried Forward',
    body: 'Salary Payable minus Amount Paid. Positive means BOE owes you, negative means you are in advance, zero means the month is settled.',
    detail: 'There is no balance until the payment has been recorded — an unrecorded month shows “Payment not recorded” rather than a figure. Once recorded, the balance becomes the proposed Previous Balance on your next payslip, and the month it came from stays recorded.',
  },
  {
    key: 'regeneration',
    group: 'process',
    title: 'Regeneration',
    body: 'Payroll is recalculated from attendance every time, never accumulated. Regenerating a month replaces its figures and its deduction ledger, and cannot double-charge or double-credit anything.',
  },
  {
    key: 'locking',
    group: 'process',
    title: 'Locked payroll',
    body: 'Locking freezes the month: no regeneration and no corrections. The figures and these explanations stay readable, and an admin can reopen the month by unlocking it.',
  },
]

export const RULE_GROUP_LABELS: Record<RuleGroup, string> = {
  day:        'How the day is classified',
  deduction:  'What each rule costs',
  leave:      'Paid leave',
  settlement: 'Adjustments and salary settlement',
  process:    'Corrections, regeneration and locking',
}

/** Reading order for the rule sections. */
export const RULE_GROUP_ORDER: RuleGroup[] = ['day', 'deduction', 'leave', 'settlement', 'process']
