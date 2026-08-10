// How Payroll Works — the content, derived rather than written.
//
// THE RULE THIS FILE LIVES BY
// ---------------------------
// Not one threshold, divisor or rate is typed in here. Every number comes from
// the constants engine.ts and classification.ts calculate with, so the guide
// cannot drift away from what an employee is actually paid. A page that says
// "45 minutes" while the engine charges an hour is worse than no page at all.
//
// Prose that DESCRIBES a rule is written here; the rule itself is imported. The
// separation matters: `guide.test.tsx` asserts the described bands against the
// classifier's own thresholds, so a settings or threshold change that this file
// has not kept up with breaks a test rather than quietly misinforming somebody.
//
// WHY THE PAGE IS STATIC
// ----------------------
// Payroll parameters are configurable (payroll_settings), but that table is
// admin-read-only under RLS and /api/payroll/settings refuses a non-admin. An
// employee therefore cannot be shown live settings, so the guide states the
// STANDARD rules — the defaults, which the seeded settings row matches field for
// field (settingsMigrationSeed.test.ts). A month that has already been generated
// was calculated with the settings pinned to it, which is what its own payslip
// reflects; the page says so rather than implying otherwise.

import {
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  SCHEDULED_OUT_MINUTES,
  LUNCH_HOURS,
  PRESENCE_THRESHOLD_HOURS,
  ROUNDING_BLOCK_MINUTES,
  ROUNDING_BLOCK_HOURS,
} from '@/lib/attendance/scheduleRules'
import {
  PER_DAY_DIVISOR,
  PER_HOUR_DIVISOR,
  MISSING_PUNCH_HOURS,
  PAID_LEAVE_TIERS,
  HALF_DAYS_PER_PAID_LEAVE,
  HOURS_PER_PAID_LEAVE,
} from '@/lib/payroll/rules'
import { minutesToClock } from '@/lib/payroll/settings'
import { payableDayValue } from '@/lib/payroll/resultTabs'
import type { DayClassification } from '@/lib/payroll/types'

const GRACE_MINUTES = GRACE_END_MINUTES - SCHEDULED_IN_MINUTES

// ─── The formula strip ────────────────────────────────────────────────────────

/**
 * The whole calculation in four words, using the payslip's own labels.
 *
 * Deliberately the engine's terms and not friendlier invented ones: an employee
 * who reads this strip then opens their payslip must find the same four words
 * there, or the strip has taught them a vocabulary nobody else uses.
 */
export type FormulaTerm = {
  label: string
  note: string
  /** The operator printed BEFORE this term. Empty on the first one. */
  op: string
}

export const FORMULA_STRIP: FormulaTerm[] = [
  { op: '',  label: 'Gross Salary',          note: 'your agreed monthly salary' },
  { op: '−', label: 'Attendance Deductions', note: 'what the month’s attendance cost' },
  { op: '+', label: 'Net Adjustments',       note: 'balance brought forward, plus approved additions and recoveries' },
  { op: '=', label: 'Salary Payable',        note: 'what BOE settles for the month' },
]

// ─── The journey ──────────────────────────────────────────────────────────────

export type JourneyStep = {
  id: string
  /** Short enough that the eight titles alone tell the whole story. */
  title: string
  /** One sentence. */
  summary: string
  /** What goes in. */
  input: string
  /** What comes out, and is used by the next step. */
  result: string
  /** Only where a step is genuinely misunderstood. Omitted otherwise. */
  why?: string
}

/**
 * The eight steps, in the order the system actually performs them.
 *
 * Steps 1–2 happen in the Attendance module, 3–7 inside the payroll engine on
 * generation, and 8 is the employee's. The chain of `result` → next `input` is
 * asserted in the test, because the point of the section is that each step
 * consumes the one above it.
 */
export const JOURNEY: JourneyStep[] = [
  {
    id: 'recorded',
    title: 'Attendance is recorded',
    summary: 'Your punches come from the fingerprint machine, imported once a month from its export file.',
    input: 'Fingerprint machine export',
    result: 'A punch-in and punch-out for each day you attended',
  },
  {
    id: 'reviewed',
    title: 'Attendance is reviewed and corrected',
    summary: 'An admin can restate a date — its punches, or the whole day as full day, half day or absent — and can waive a late, early or missing-punch charge.',
    input: 'The imported punches',
    result: 'The attendance payroll will actually use',
    why: 'The machine record is never overwritten. Every version is kept, and a correction always carries a written reason.',
  },
  {
    id: 'payable-days',
    title: 'Payable days are determined',
    summary: `Each working day is classified from your hours and becomes ${payableDayValue('full_present')}, ½ or 0 payable days. Sundays, company holidays and dates before you joined are not working days at all.`,
    input: 'Reviewed attendance, day by day',
    result: 'A classification and a payable-day value for every working day',
  },
  {
    id: 'rates',
    title: 'Your salary becomes a daily and hourly rate',
    summary: `Your monthly salary is divided by ${PER_DAY_DIVISOR} for a day’s pay, and that by ${PER_HOUR_DIVISOR} for an hour’s.`,
    input: 'Your agreed monthly salary',
    result: `A per-day rate and a per-hour rate`,
    why: `${PER_DAY_DIVISOR} is the working days in a six-day week month, so the rate does not change with the length of the month.`,
  },
  {
    id: 'deductions',
    title: 'Attendance deductions are calculated',
    summary: 'Every rule that applied to a day is charged at the rate for its unit — a day, half a day, or an hour — and rounded to a whole rupee.',
    input: 'The classified days and your two rates',
    result: 'One deduction line per rule, per date, each with its own amount',
    why: 'Each line is rounded on its own and the total is the sum of those lines, so the column always adds up to the total beneath it.',
  },
  {
    id: 'paid-leave',
    title: 'Paid leave absorbs the first thing it can',
    summary: `Attendance in the same month earns an allowance — ${PAID_LEAVE_TIERS[0].min_days_present}+ days present earns ${PAID_LEAVE_TIERS[0].leave} day, ${PAID_LEAVE_TIERS[1].min_days_present}–${PAID_LEAVE_TIERS[0].min_days_present - 1} earns ${PAID_LEAVE_TIERS[1].leave} — and it is spent on the earliest item of the month it can cover.`,
    input: 'The deduction lines, and your days present',
    result: 'The covered line charged ₹0, still listed, so the month adds up',
    why: 'The allowance is earned per month and does not carry forward. It is recalculated on every payroll run, so correcting a date can never spend it twice.',
  },
  {
    id: 'after-attendance',
    title: 'Salary After Attendance is produced',
    summary: 'Gross salary minus the deduction total. This is what the month itself earned, before anything carried over.',
    input: 'Gross salary and the deduction total',
    result: 'Salary After Attendance',
    why: 'A month with no present days at all pays ₹0 rather than going negative.',
  },
  {
    id: 'payable',
    title: 'Balance and adjustments give Salary Payable',
    summary: 'Anything unsettled from your previous payroll month is brought forward, approved additions and recoveries are applied, and the result is what BOE settles for the month.',
    input: 'Salary After Attendance, previous balance, approved adjustments',
    result: 'Salary Payable — and, once a payment is recorded, the balance carried into next month',
    why: 'It can be negative when a recovery is larger than the month’s pay. That is not an error — it means more has already been paid than the month earned.',
  },
]

// ─── Attendance states ────────────────────────────────────────────────────────

export type AttendanceState = {
  classification: DayClassification
  /** The same label Payroll Result Detail prints. Asserted in the test. */
  label: string
  /** Payable-day value, from the engine's own function. */
  payable: number
  /** How it reads without the colour: "1 day" / "½ day" / "Not counted". */
  payableLabel: string
  meaning: string
  salaryEffect: string
  /** Whether an admin may open a correction on this date. */
  correctable: boolean
  /** Presentation tone. Never the only signal — every row states its value in words. */
  tone: 'good' | 'caution' | 'half' | 'neutral'
}

function payableLabel(value: number): string {
  if (value === 1) return '1 day'
  if (value === 0.5) return '½ day'
  return 'Not counted'
}

function state(
  classification: DayClassification,
  label: string,
  meaning: string,
  salaryEffect: string,
  correctable: boolean,
  tone: AttendanceState['tone'],
): AttendanceState {
  const payable = payableDayValue(classification)
  return { classification, label, payable, payableLabel: payableLabel(payable), meaning, salaryEffect, correctable, tone }
}

/**
 * Every day state the engine produces today, in the order a month is read.
 *
 * `payable` is taken from payableDayValue rather than restated, and the labels
 * are asserted against Payroll Result Detail's own map — so this table cannot
 * describe a day differently from the screen it is explaining.
 *
 * `short_present` is NOT here: classification.ts stopped producing it when the
 * half-day band was widened to the presence floor. It is called out separately
 * as something older payslips can still show — see LEGACY_STATE_NOTE.
 */
export const ATTENDANCE_STATES: AttendanceState[] = [
  state('full_present', 'Full Present',
    `In within the grace period and out at or after ${minutesToClock(SCHEDULED_OUT_MINUTES)}, or ${PRESENCE_THRESHOLD_HOURS.full_present} effective hours or more.`,
    'No deduction for the day itself.',
    true, 'good'),
  state('present_with_shortfall', 'Present (short hours)',
    `${PRESENCE_THRESHOLD_HOURS.present_with_shortfall}–${PRESENCE_THRESHOLD_HOURS.full_present} effective hours.`,
    'Paid as a full day. A late-arrival or early-departure charge can still apply.',
    true, 'caution'),
  state('half_day', 'Half Day',
    `${PRESENCE_THRESHOLD_HOURS.short_present}–${PRESENCE_THRESHOLD_HOURS.present_with_shortfall} effective hours.`,
    'Half a day’s pay is deducted, unless the month’s paid leave covers it.',
    true, 'half'),
  state('missing_punch', 'Missing Punch',
    'One punch recorded and the other missing.',
    `A flat ${MISSING_PUNCH_HOURS} hours at the hourly rate. The day still counts as present.`,
    true, 'caution'),
  state('full_absent', 'Absent',
    `No punches at all, or under ${PRESENCE_THRESHOLD_HOURS.short_present} effective hours.`,
    'A full day’s pay is deducted, unless the month’s paid leave covers it.',
    true, 'caution'),
  state('weekly_off', 'Weekly Off',
    'Sunday.',
    'Paid. Never an absence, never a deduction, never leave.',
    false, 'neutral'),
  state('holiday', 'Paid Holiday',
    'A date on the company holiday list.',
    'Paid, and excluded from the working-day count.',
    false, 'neutral'),
  state('pre_joining', 'Before Joining',
    'A date before your joining date.',
    'Excluded from payroll entirely.',
    false, 'neutral'),
]

export const LEGACY_STATE_NOTE =
  'Older payslips may show “Short Present”. That band was merged into Half Day, because working fewer hours must never cost less than working more. Months already generated keep whatever they were calculated with.'

// ─── The numbers that decide your pay ─────────────────────────────────────────

export type KeyNumber = { label: string; value: string; note?: string }

/**
 * The parameters that most directly move a salary, for the guide rail.
 *
 * Every value is formatted from the constant, never retyped.
 */
export const KEY_NUMBERS: KeyNumber[] = [
  { label: 'A day’s pay',    value: `Monthly salary ÷ ${PER_DAY_DIVISOR}` },
  { label: 'An hour’s pay',  value: `A day’s pay ÷ ${PER_HOUR_DIVISOR}` },
  { label: 'Office hours',   value: `${minutesToClock(SCHEDULED_IN_MINUTES)} – ${minutesToClock(SCHEDULED_OUT_MINUTES)}` },
  { label: 'Arrival grace',  value: `${GRACE_MINUTES} minutes`, note: `until ${minutesToClock(GRACE_END_MINUTES)}` },
  { label: 'Full day needs', value: `${PRESENCE_THRESHOLD_HOURS.full_present} effective hours`, note: `after the ${LUNCH_HOURS}h lunch break` },
  { label: 'Late is charged', value: `${ROUNDING_BLOCK_HOURS}h per ${ROUNDING_BLOCK_MINUTES} min`, note: 'rounded up to the next block' },
  { label: 'Missing punch',  value: `${MISSING_PUNCH_HOURS} hours` },
  { label: 'Paid leave',     value: `${PAID_LEAVE_TIERS[0].leave} day at ${PAID_LEAVE_TIERS[0].min_days_present}+ days present`, note: `${PAID_LEAVE_TIERS[1].leave} day at ${PAID_LEAVE_TIERS[1].min_days_present}–${PAID_LEAVE_TIERS[0].min_days_present - 1}` },
]

// ─── The parameter table ──────────────────────────────────────────────────────

export type ParameterRow = {
  rule: string
  /** What the attendance condition is. */
  condition: string
  /** What it does to the salary. Never implies a charge that review can waive. */
  effect: string
  /** Whether an admin can correct or waive it during review. */
  adminCanChange: string
}

/**
 * Attendance rule → salary effect → whether review can change it.
 *
 * The third column exists because the old page implied every attendance flag
 * automatically became a deduction. Three of these are waivable outright, and
 * any day can be restated, so a flag is a proposal until the month is generated.
 */
export const PARAMETERS: ParameterRow[] = [
  {
    rule: 'Late arrival',
    condition: `In after ${minutesToClock(GRACE_END_MINUTES)}. The first ${GRACE_MINUTES} minutes past ${minutesToClock(SCHEDULED_IN_MINUTES)} cost nothing.`,
    effect: `Rounds up to the next ${ROUNDING_BLOCK_MINUTES} minutes and costs ${ROUNDING_BLOCK_HOURS}h of pay per block.`,
    adminCanChange: 'Can be waived with a reason',
  },
  {
    rule: 'Early departure',
    condition: `Out before ${minutesToClock(SCHEDULED_OUT_MINUTES)}, measured the same way.`,
    effect: `${ROUNDING_BLOCK_HOURS}h of pay per ${ROUNDING_BLOCK_MINUTES}-minute block.`,
    adminCanChange: 'Can be waived with a reason',
  },
  {
    rule: 'Missing punch',
    condition: 'One punch recorded, the other missing.',
    effect: `A flat ${MISSING_PUNCH_HOURS} hours of pay. The day still counts as present.`,
    adminCanChange: 'Can be waived with a reason',
  },
  {
    rule: 'Half day',
    condition: `${PRESENCE_THRESHOLD_HOURS.short_present}–${PRESENCE_THRESHOLD_HOURS.present_with_shortfall} effective hours.`,
    effect: 'Half a day’s pay, unless paid leave covers it.',
    adminCanChange: 'The day can be restated as a full day',
  },
  {
    rule: 'Absence',
    condition: `No punches, or under ${PRESENCE_THRESHOLD_HOURS.short_present} effective hours.`,
    effect: 'One day’s pay, unless paid leave covers it.',
    adminCanChange: 'The day can be restated as full or half day',
  },
  {
    rule: 'Paid leave',
    condition: `Earned by days present in the same month.`,
    effect: `Charges the earliest item it can reach ₹0 — one absent day, or ${HALF_DAYS_PER_PAID_LEAVE} half days, or up to ${HOURS_PER_PAID_LEAVE}h of late, early and missing-punch charges.`,
    adminCanChange: 'Applied automatically, not requested',
  },
  {
    rule: 'Weekly off and holidays',
    condition: 'Sundays and dates on the company holiday list.',
    effect: 'Paid, and excluded from the working-day count. Never leave.',
    adminCanChange: 'Holidays are managed by an admin',
  },
  {
    rule: 'Additions and recoveries',
    condition: 'Entered by an admin against the month.',
    effect: 'Applied after attendance, each as its own line with a written reason.',
    adminCanChange: 'Entered and corrected by an admin',
  },
  {
    rule: 'Advance recovery',
    condition: 'Money already received — a negative previous balance, or a recovery entered for this month.',
    effect: 'Subtracted from Salary Payable. Can take it below zero.',
    adminCanChange: 'Entered and corrected by an admin',
  },
]

// ─── What can change my salary ────────────────────────────────────────────────

export const WHAT_CHANGES_PAY: string[] = [
  'Arriving late, or leaving early, beyond the grace period',
  'A day with too few hours to count as a full day',
  'An absence the month’s paid leave does not reach',
  'A punch the machine missed',
  'An addition or recovery an admin entered, with a reason',
  'A balance carried in from your previous payroll month',
]

// ─── Corrections and issues ───────────────────────────────────────────────────

export type FlowStep = { actor: 'admin' | 'you'; title: string; body: string }

/**
 * The review loop, as it actually works.
 *
 * The last step is the one employees do not know they have: an issue that was
 * answered can be raised again. Only a still-open issue blocks a new one — see
 * canRaiseIssue in src/lib/objections.ts.
 */
export const ISSUE_FLOW: FlowStep[] = [
  { actor: 'admin', title: 'Attendance is uploaded',   body: 'The month’s punches are imported from the machine.' },
  { actor: 'admin', title: 'Records are reviewed',     body: 'An admin corrects anything wrong, with a written reason.' },
  { actor: 'admin', title: 'Payroll is generated',     body: 'The month is calculated from the reviewed attendance.' },
  { actor: 'you',   title: 'You check the month',      body: 'Open your attendance and your payslip and compare them with what you remember.' },
  { actor: 'you',   title: 'You raise an issue',       body: 'Report the day or the figure that looks wrong. Raising an issue does not change your salary by itself.' },
  { actor: 'admin', title: 'An admin reviews it',      body: 'They accept it and correct the record, or explain why not.' },
  { actor: 'you',   title: 'You get the outcome',      body: 'You are notified either way, and the whole history stays visible.' },
  { actor: 'you',   title: 'You can raise it again',   body: 'If the answer does not settle it, you can raise the issue again once it has been answered.' },
]

// ─── Sections, for the jump list ──────────────────────────────────────────────

export const SECTIONS = [
  { id: 'journey',    label: 'How a month is calculated' },
  { id: 'example',    label: 'A month, worked through' },
  { id: 'states',     label: 'What each day counts as' },
  { id: 'parameters', label: 'The rules that affect pay' },
  { id: 'issues',     label: 'If something looks wrong' },
  { id: 'reference',  label: 'Full rules and glossary' },
] as const

// ─── Role-safe actions ────────────────────────────────────────────────────────

export type GuideAction = { label: string; href: string; note: string }

/**
 * Where the guide sends somebody next.
 *
 * Split by role and NOT merged: every employee destination is self-service, and
 * an employee handed an /attendance or /payroll link would only be bounced by
 * the guard. This is a usability split, never the control — see
 * resolveManagementAccess in src/lib/moduleAccess.ts.
 */
export const EMPLOYEE_ACTIONS: GuideAction[] = [
  { label: 'My Attendance', href: '/my-attendance', note: 'Your month, day by day' },
  { label: 'My Payroll',    href: '/my-payroll',    note: 'Your payslips and the figures above' },
  { label: 'My Issues',     href: '/my-issues',     note: 'Report something, and track the answer' },
]

export const ADMIN_ACTIONS: GuideAction[] = [
  { label: 'Monthly Attendance Review', href: '/attendance/monthly-review', note: 'The month, per employee' },
  { label: 'Payroll Runs',              href: '/payroll',                   note: 'Generate, review and lock a month' },
  { label: 'Payroll Settings',          href: '/payroll/settings',          note: 'The numbers every calculation uses' },
]

export function guideActionsFor(isAdmin: boolean): GuideAction[] {
  return isAdmin ? ADMIN_ACTIONS : EMPLOYEE_ACTIONS
}
