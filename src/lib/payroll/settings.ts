// The payroll calculation parameters, as data rather than as literals.
//
// WHY THIS EXISTS
// ---------------
// Every number the engine divides, rounds or compares by used to be a module
// constant in ./rules and ../attendance/scheduleRules. That made them impossible
// to change without a deploy, and — more importantly — impossible to change
// SAFELY, because a payroll month already generated would silently start
// restating itself the moment a constant moved.
//
// So the numbers become a settings object, and the settings object gets pinned
// to the period that used it. See ./settingsSnapshot for the pinning; this
// module is only the vocabulary, the defaults, and the validation.
//
// WHAT IS AND IS NOT IN HERE
// --------------------------
// In: every shared numeric or time parameter the engine, the day classifier and
// the punch parser actually read.
//
// Out: anything that is a fact about a specific month rather than a rule —
// holidays, an employee's salary, the joining date. Those are rows, not
// settings.
//
// THE DEFAULTS ARE THE OLD CONSTANTS, EXACTLY
// -------------------------------------------
// DEFAULT_PAYROLL_SETTINGS is built FROM ./rules and ../attendance/scheduleRules
// rather than retyped from them. That is the whole reason moving to settings
// cannot change anybody's salary by itself: a default run and a pre-settings run
// divide by the same 26 and round in the same 30-minute blocks, because it is
// literally the same value. `settings.test.ts` asserts the correspondence field
// by field, so a constant that drifts from its default breaks a test rather than
// a payslip.

import {
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  SCHEDULED_OUT_MINUTES,
  FULL_DAY_HOURS,
  LUNCH_IN_BEFORE_MINUTES,
  LUNCH_OUT_AFTER_MINUTES,
  LUNCH_HOURS,
  PRESENCE_THRESHOLD_HOURS,
  ROUNDING_BLOCK_MINUTES,
  ROUNDING_BLOCK_HOURS,
  WEEKLY_OFF_DAY,
} from '../attendance/scheduleRules'
import { TEMP_SINGLE_PUNCH_DIVIDER_MINUTES } from '../attendance/punchDirection'
import {
  PER_DAY_DIVISOR,
  MISSING_PUNCH_HOURS,
  PAID_LEAVE_TIERS,
  HALF_DAYS_PER_PAID_LEAVE,
} from './rules'

// ─── The shape ────────────────────────────────────────────────────────────────

/**
 * One paid-leave band. The first band an employee reaches, reading top-down by
 * `min_days_present`, is the allowance they earn for the month.
 */
export type PaidLeaveTier = {
  min_days_present: number
  leave: number
}

/**
 * The most paid-leave bands that may be stored.
 *
 * A month has at most 31 days, so 31 distinct thresholds is already every band
 * that could ever be reachable. The cap exists to stop an unbounded array being
 * written by some future path — the settings jsonb is read on every payroll run,
 * and a runaway list would be carried into every period snapshot with it.
 */
export const MAX_PAID_LEAVE_BANDS = 12

/**
 * Every shared parameter the payroll calculation turns on.
 *
 * Times are IST minutes past midnight, which is the unit the engine and the
 * classifier already compare in — storing "10:00" as a string would mean parsing
 * it on every day of every employee of every month. The UI converts at the edge.
 */
export type PayrollSettings = {
  // ── Salary basis ────────────────────────────────────────────────────────────
  /** Monthly salary ÷ this = the per-day rate. 26 = working days in a six-day week month. */
  per_day_divisor: number
  /** Per-day rate ÷ this = the per-hour rate. Also the paid hours in a full working day. */
  full_day_hours: number
  /** What fraction of a day a half day is worth, for both classification and deduction. */
  half_day_fraction: number

  // ── The working day ─────────────────────────────────────────────────────────
  /** Official start of the working day. */
  scheduled_in_minutes: number
  /** End of the arrival grace period. Late deduction is measured past this. */
  grace_end_minutes: number
  /** Official end of the working day. */
  scheduled_out_minutes: number
  /** Lunch is deducted when the punch-in is before this… */
  lunch_in_before_minutes: number
  /** …and the punch-out is after this. */
  lunch_out_after_minutes: number
  /** Hours removed from a day that spans the lunch break. */
  lunch_hours: number
  /** The weekly off, as a JavaScript day number. 0 = Sunday. */
  weekly_off_day: number

  // ── Punch and attendance ────────────────────────────────────────────────────
  /**
   * The clock time that splits a lone unmarked punch. Before it reads as an
   * arrival; at or after it reads as a departure. A business decision, and
   * deliberately not the midpoint of the scheduled day.
   */
  single_punch_divider_minutes: number
  /** A missing punch-in or punch-out costs this many hours, flat. */
  missing_punch_hours: number
  /** Effective-hours floor for a full present day. */
  threshold_full_present_hours: number
  /** Effective-hours floor for a present-with-shortfall day. */
  threshold_present_with_shortfall_hours: number
  /** Effective-hours floor for a half day. */
  threshold_half_day_hours: number
  /** Effective-hours floor for a short-present day. Below it the day is an absence. */
  threshold_short_present_hours: number

  // ── Deduction rules ─────────────────────────────────────────────────────────
  /** Lateness and early departure round UP to the next block of this many minutes. */
  rounding_block_minutes: number
  /** Hours one rounded block is charged at. */
  rounding_block_hours: number

  // ── Leave ───────────────────────────────────────────────────────────────────
  /** Paid-leave allowance by days present, highest band first. */
  paid_leave_tiers: PaidLeaveTier[]
  /** Half-days one full paid leave can absorb instead of one absent day. */
  half_days_per_paid_leave: number
  /** Hourly deductions one full paid leave can absorb instead. */
  hours_per_paid_leave: number
}

// ─── The defaults ─────────────────────────────────────────────────────────────

/**
 * Today's behaviour, as a settings object.
 *
 * Every field is the constant the engine used before settings existed, so
 * generating with these is arithmetically identical to generating without
 * settings at all.
 */
export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  per_day_divisor:   PER_DAY_DIVISOR,
  full_day_hours:    FULL_DAY_HOURS,
  half_day_fraction: 0.5,

  scheduled_in_minutes:    SCHEDULED_IN_MINUTES,
  grace_end_minutes:       GRACE_END_MINUTES,
  scheduled_out_minutes:   SCHEDULED_OUT_MINUTES,
  lunch_in_before_minutes: LUNCH_IN_BEFORE_MINUTES,
  lunch_out_after_minutes: LUNCH_OUT_AFTER_MINUTES,
  lunch_hours:             LUNCH_HOURS,
  weekly_off_day:          WEEKLY_OFF_DAY,

  single_punch_divider_minutes:           TEMP_SINGLE_PUNCH_DIVIDER_MINUTES,
  missing_punch_hours:                    MISSING_PUNCH_HOURS,
  threshold_full_present_hours:           PRESENCE_THRESHOLD_HOURS.full_present,
  threshold_present_with_shortfall_hours: PRESENCE_THRESHOLD_HOURS.present_with_shortfall,
  threshold_half_day_hours:               PRESENCE_THRESHOLD_HOURS.half_day,
  threshold_short_present_hours:          PRESENCE_THRESHOLD_HOURS.short_present,

  rounding_block_minutes: ROUNDING_BLOCK_MINUTES,
  rounding_block_hours:   ROUNDING_BLOCK_HOURS,

  paid_leave_tiers:         PAID_LEAVE_TIERS.map(t => ({ ...t })),
  half_days_per_paid_leave: HALF_DAYS_PER_PAID_LEAVE,
  hours_per_paid_leave:     FULL_DAY_HOURS,
}

/**
 * What a payroll period generated before settings existed was calculated with.
 *
 * Identical to the defaults, and separately named on purpose. A legacy period
 * has no snapshot, and reading one must not mean "whatever the settings happen
 * to say today" — it means "the constants that were compiled into the build that
 * ran it", which is this. If DEFAULT_PAYROLL_SETTINGS is ever changed to
 * something other than the historical constants, this must NOT follow it.
 */
export const LEGACY_PAYROLL_SETTINGS: PayrollSettings = { ...DEFAULT_PAYROLL_SETTINGS }

// ─── Field metadata, for validation and for the form ──────────────────────────

export type SettingsGroup =
  | 'salary_basis'
  | 'working_day'
  | 'punch_attendance'
  | 'leave'
  | 'deduction_rules'

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  salary_basis:    'Salary basis',
  working_day:     'Working day',
  punch_attendance: 'Punch and attendance',
  leave:           'Leave',
  deduction_rules: 'Deduction rules',
}

export const SETTINGS_GROUP_ORDER: SettingsGroup[] = [
  'salary_basis',
  'working_day',
  'punch_attendance',
  'leave',
  'deduction_rules',
]

/** How a field is entered and shown. `time` is minutes-past-midnight behind an HH:MM control. */
export type SettingsFieldKind = 'number' | 'time' | 'day_of_week'

export type NumericSettingsKey = Exclude<keyof PayrollSettings, 'paid_leave_tiers'>

export type SettingsFieldSpec = {
  key: NumericSettingsKey
  group: SettingsGroup
  kind: SettingsFieldKind
  label: string
  /** Plain language. What the number does, for an admin who did not write the engine. */
  help: string
  min: number
  max: number
  /** Smallest legal increment. 0.25 for hours, 1 for minutes and counts. */
  step: number
  unit?: string
}

/**
 * Every editable field, with the range it is allowed to take.
 *
 * The ranges are deliberately wide enough to be useful and narrow enough to
 * exclude nonsense — a per-day divisor of 0 would divide by zero, a divisor of
 * 400 would silently pay everybody nothing. They are asserted in both the API
 * and the database (see the migration's CHECK constraints), because a settings
 * row written by some future path must not be able to poison every payroll run.
 */
export const SETTINGS_FIELDS: SettingsFieldSpec[] = [
  {
    key: 'per_day_divisor', group: 'salary_basis', kind: 'number',
    label: 'Monthly salary divisor',
    help: 'Monthly salary is divided by this to get one day’s pay. 26 is the working days in a six-day week month.',
    min: 1, max: 31, step: 0.5, unit: 'days',
  },
  {
    key: 'full_day_hours', group: 'salary_basis', kind: 'number',
    label: 'Paid hours in a full day',
    help: 'One day’s pay divided by this gives the hourly rate used for late, early and missing-punch deductions.',
    min: 1, max: 24, step: 0.25, unit: 'hours',
  },
  {
    key: 'half_day_fraction', group: 'salary_basis', kind: 'number',
    label: 'Half day is worth',
    help: 'The fraction of a day’s pay a half day earns, and the fraction deducted for one.',
    min: 0.1, max: 0.9, step: 0.05, unit: 'of a day',
  },

  {
    key: 'scheduled_in_minutes', group: 'working_day', kind: 'time',
    label: 'Office start time',
    help: 'Lateness is measured from here.',
    min: 0, max: 1439, step: 1,
  },
  {
    key: 'grace_end_minutes', group: 'working_day', kind: 'time',
    label: 'Late arrival grace ends',
    help: 'Arriving at or before this costs nothing. Must be at or after the office start time.',
    min: 0, max: 1439, step: 1,
  },
  {
    key: 'scheduled_out_minutes', group: 'working_day', kind: 'time',
    label: 'Office end time',
    help: 'Early departure is measured from here. Must be after the office start time.',
    min: 0, max: 1439, step: 1,
  },
  {
    key: 'lunch_out_after_minutes', group: 'working_day', kind: 'time',
    label: 'Lunch break starts',
    help: 'A day is treated as spanning lunch when the punch-out is after this…',
    min: 0, max: 1439, step: 1,
  },
  {
    key: 'lunch_in_before_minutes', group: 'working_day', kind: 'time',
    label: 'Lunch break ends',
    help: '…and the punch-in is before this. Must be after the lunch start.',
    min: 0, max: 1439, step: 1,
  },
  {
    key: 'lunch_hours', group: 'working_day', kind: 'number',
    label: 'Lunch deducted',
    help: 'Hours taken off a day that spans the lunch break, before it is classified.',
    min: 0, max: 4, step: 0.25, unit: 'hours',
  },
  {
    key: 'weekly_off_day', group: 'working_day', kind: 'day_of_week',
    label: 'Weekly off',
    help: 'Never an absence, never a deduction, never leave.',
    min: 0, max: 6, step: 1,
  },

  {
    key: 'single_punch_divider_minutes', group: 'punch_attendance', kind: 'time',
    label: 'Single punch divider',
    help: 'When a day has only one punch and the file does not say which door it was, a punch before this reads as an arrival and a punch at or after it reads as a departure.',
    min: 0, max: 1439, step: 1,
  },
  {
    key: 'missing_punch_hours', group: 'punch_attendance', kind: 'number',
    label: 'Missing punch costs',
    help: 'Charged when one punch is present and the other is missing. The day still counts as present.',
    min: 0, max: 24, step: 0.25, unit: 'hours',
  },
  {
    key: 'threshold_full_present_hours', group: 'punch_attendance', kind: 'number',
    label: 'Full day needs',
    help: 'Effective hours (after lunch) at or above this is a full present day.',
    min: 0, max: 24, step: 0.25, unit: 'hours',
  },
  {
    key: 'threshold_present_with_shortfall_hours', group: 'punch_attendance', kind: 'number',
    label: 'Present (short hours) needs',
    help: 'A full present day for pay, still open to late and early deductions.',
    min: 0, max: 24, step: 0.25, unit: 'hours',
  },
  {
    key: 'threshold_half_day_hours', group: 'punch_attendance', kind: 'number',
    label: 'Half day needs',
    help: 'Effective hours at or above this, but below the short-hours band, is a half day.',
    min: 0, max: 24, step: 0.25, unit: 'hours',
  },
  {
    key: 'threshold_short_present_hours', group: 'punch_attendance', kind: 'number',
    label: 'Short present needs',
    help: 'The floor for counting as present at all. Below this the day is an absence.',
    min: 0, max: 24, step: 0.25, unit: 'hours',
  },

  {
    key: 'rounding_block_minutes', group: 'deduction_rules', kind: 'number',
    label: 'Deduction rounds up to',
    help: 'Lateness and early departure are rounded up to the next whole block of this many minutes.',
    min: 1, max: 240, step: 1, unit: 'minutes',
  },
  {
    key: 'rounding_block_hours', group: 'deduction_rules', kind: 'number',
    label: 'Each block costs',
    help: 'Hours charged for one rounded block, at the hourly rate.',
    min: 0, max: 8, step: 0.25, unit: 'hours',
  },

  {
    key: 'half_days_per_paid_leave', group: 'leave', kind: 'number',
    label: 'Half days one paid leave covers',
    help: 'Instead of one absent day, the allowance can absorb this many half days.',
    min: 1, max: 10, step: 1, unit: 'half days',
  },
  {
    key: 'hours_per_paid_leave', group: 'leave', kind: 'number',
    label: 'Hours one paid leave covers',
    help: 'Instead of an absence or half days, the allowance can absorb up to this many hours of late, early and missing-punch deductions.',
    min: 0, max: 24, step: 0.25, unit: 'hours',
  },
]

const FIELD_BY_KEY = new Map(SETTINGS_FIELDS.map(f => [f.key, f]))

// ─── Validation ───────────────────────────────────────────────────────────────

export type SettingsValidationIssue = {
  /** The field the problem is on. `paid_leave_tiers` for the tier list as a whole. */
  key: string
  message: string
}

export type SettingsParseResult =
  | { ok: true;  settings: PayrollSettings }
  | { ok: false; issues: SettingsValidationIssue[] }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Whether a number sits on the field's step grid.
 *
 * Compared in integer thousandths rather than with a modulo on floats, because
 * `0.45 % 0.05` is not 0 in IEEE 754 and a plainly legal value would be
 * rejected. Every step in SETTINGS_FIELDS is a multiple of 0.001.
 */
function onStepGrid(value: number, step: number): boolean {
  const scaled = Math.round(value * 1000)
  const scaledStep = Math.round(step * 1000)
  if (scaledStep === 0) return true
  return scaled % scaledStep === 0
}

/**
 * Validate and narrow an arbitrary value into PayrollSettings.
 *
 * Every field must be present — a partial object is rejected rather than merged
 * over the defaults. Merging would mean a settings row that lost a column during
 * some future migration silently reverted that one rule to a default while the
 * rest stayed custom, which is the kind of half-state a payroll disagreement is
 * impossible to explain from.
 *
 * The cross-field rules at the end are the ones a per-field range cannot express
 * and that would produce nonsense rather than merely unusual results.
 */
export function parsePayrollSettings(value: unknown): SettingsParseResult {
  const issues: SettingsValidationIssue[] = []

  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: [{ key: '_', message: 'Settings must be an object.' }] }
  }
  const raw = value as Record<string, unknown>

  const out: Partial<Record<NumericSettingsKey, number>> = {}

  for (const field of SETTINGS_FIELDS) {
    const v = raw[field.key]
    if (!isFiniteNumber(v)) {
      issues.push({ key: field.key, message: `${field.label} must be a number.` })
      continue
    }
    if (v < field.min || v > field.max) {
      issues.push({
        key: field.key,
        message: `${field.label} must be between ${field.min} and ${field.max}${field.unit ? ` ${field.unit}` : ''}.`,
      })
      continue
    }
    if (!onStepGrid(v, field.step)) {
      issues.push({ key: field.key, message: `${field.label} must be a multiple of ${field.step}.` })
      continue
    }
    if (field.kind === 'time' && !Number.isInteger(v)) {
      issues.push({ key: field.key, message: `${field.label} must be a whole number of minutes.` })
      continue
    }
    out[field.key] = v
  }

  // ── Paid leave tiers ────────────────────────────────────────────────────────
  const tiersRaw = raw.paid_leave_tiers
  let tiers: PaidLeaveTier[] = []
  if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
    issues.push({ key: 'paid_leave_tiers', message: 'At least one paid-leave band is required.' })
  } else {
    for (let i = 0; i < tiersRaw.length; i++) {
      const t = tiersRaw[i] as Record<string, unknown> | null
      if (t == null || typeof t !== 'object') {
        issues.push({ key: 'paid_leave_tiers', message: `Band ${i + 1} is not valid.` })
        continue
      }
      const min = t.min_days_present
      const leave = t.leave
      if (!isFiniteNumber(min) || min < 0 || min > 31 || !Number.isInteger(min)) {
        issues.push({ key: 'paid_leave_tiers', message: `Band ${i + 1}: days present must be a whole number between 0 and 31.` })
        continue
      }
      if (!isFiniteNumber(leave) || leave < 0 || leave > 31 || !onStepGrid(leave, 0.5)) {
        issues.push({ key: 'paid_leave_tiers', message: `Band ${i + 1}: leave must be between 0 and 31, in steps of 0.5.` })
        continue
      }
      tiers.push({ min_days_present: min, leave })
    }
    if (tiersRaw.length > MAX_PAID_LEAVE_BANDS) {
      issues.push({
        key: 'paid_leave_tiers',
        message: `At most ${MAX_PAID_LEAVE_BANDS} paid-leave bands can be saved.`,
      })
    }

    // Two bands claiming the same days-present threshold OVERLAP: the engine
    // takes the first band an employee reaches, so the second could never be
    // awarded to anybody. It is not merely redundant — it is a rule an admin
    // wrote, saved, and would reasonably expect to apply. Rejecting is the only
    // honest answer, because silently keeping one and dropping the other means
    // the settings page shows something the engine does not do.
    //
    // This was missing: duplicates passed the descending check below, since
    // equal values are legitimately "sorted".
    const seen = new Map<number, number>()
    for (let i = 0; i < tiers.length; i++) {
      const days = tiers[i]!.min_days_present
      const firstAt = seen.get(days)
      if (firstAt != null) {
        issues.push({
          key: 'paid_leave_tiers',
          message: `Two bands both start at ${days} days present. Each band needs its own threshold — the lower one could never apply.`,
        })
      } else {
        seen.set(days, i)
      }
    }

    // The engine reads top-down and takes the first band reached, so an
    // unsorted list would silently award the wrong allowance rather than fail.
    const sorted = [...tiers].sort((a, b) => b.min_days_present - a.min_days_present)
    const isDescending = tiers.every((t, i) => t.min_days_present === sorted[i]?.min_days_present)
    if (tiers.length > 0 && !isDescending) {
      issues.push({ key: 'paid_leave_tiers', message: 'Bands must be ordered from the highest days-present down.' })
    }
    const lowest = sorted[sorted.length - 1]
    if (tiers.length > 0 && lowest && lowest.min_days_present !== 0) {
      issues.push({ key: 'paid_leave_tiers', message: 'The last band must start at 0 days present, so every employee falls into one.' })
    }

    // More attendance must never earn LESS leave. The rule is "paid leave earned
    // by attendance", so a band that pays an employee present 11 days more than
    // one present 16 days is incoherent rather than unusual — and it fails in the
    // direction nobody checks, because the better-attending employee is the one
    // short-changed. Read in engine order (highest threshold first), the
    // allowance must never increase as the threshold falls.
    for (let i = 1; i < sorted.length; i++) {
      const higher = sorted[i - 1]!
      const lower  = sorted[i]!
      if (lower.leave > higher.leave) {
        issues.push({
          key: 'paid_leave_tiers',
          message: `${lower.min_days_present}+ days present would earn more leave (${lower.leave}) than ${higher.min_days_present}+ days (${higher.leave}). More attendance cannot earn less leave.`,
        })
        break
      }
    }

    tiers = sorted
  }

  if (issues.length > 0) return { ok: false, issues }

  const n = out as Record<NumericSettingsKey, number>

  // ── Cross-field rules ───────────────────────────────────────────────────────
  if (n.grace_end_minutes < n.scheduled_in_minutes) {
    issues.push({ key: 'grace_end_minutes', message: 'The grace period cannot end before the office start time.' })
  }
  if (n.scheduled_out_minutes <= n.scheduled_in_minutes) {
    issues.push({ key: 'scheduled_out_minutes', message: 'The office end time must be after the office start time.' })
  }
  if (n.lunch_in_before_minutes <= n.lunch_out_after_minutes) {
    issues.push({ key: 'lunch_in_before_minutes', message: 'The lunch break must end after it starts.' })
  }
  // Thresholds are read highest-first; equal neighbours would make a band
  // unreachable rather than invalid, so only a true inversion is rejected.
  if (n.threshold_full_present_hours < n.threshold_present_with_shortfall_hours) {
    issues.push({ key: 'threshold_full_present_hours', message: 'The full-day threshold cannot be below the short-hours threshold.' })
  }
  if (n.threshold_present_with_shortfall_hours < n.threshold_half_day_hours) {
    issues.push({ key: 'threshold_present_with_shortfall_hours', message: 'The short-hours threshold cannot be below the half-day threshold.' })
  }
  if (n.threshold_half_day_hours < n.threshold_short_present_hours) {
    issues.push({ key: 'threshold_half_day_hours', message: 'The half-day threshold cannot be below the short-present threshold.' })
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    settings: {
      per_day_divisor:   n.per_day_divisor,
      full_day_hours:    n.full_day_hours,
      half_day_fraction: n.half_day_fraction,

      scheduled_in_minutes:    n.scheduled_in_minutes,
      grace_end_minutes:       n.grace_end_minutes,
      scheduled_out_minutes:   n.scheduled_out_minutes,
      lunch_in_before_minutes: n.lunch_in_before_minutes,
      lunch_out_after_minutes: n.lunch_out_after_minutes,
      lunch_hours:             n.lunch_hours,
      weekly_off_day:          n.weekly_off_day,

      single_punch_divider_minutes:           n.single_punch_divider_minutes,
      missing_punch_hours:                    n.missing_punch_hours,
      threshold_full_present_hours:           n.threshold_full_present_hours,
      threshold_present_with_shortfall_hours: n.threshold_present_with_shortfall_hours,
      threshold_half_day_hours:               n.threshold_half_day_hours,
      threshold_short_present_hours:          n.threshold_short_present_hours,

      rounding_block_minutes: n.rounding_block_minutes,
      rounding_block_hours:   n.rounding_block_hours,

      paid_leave_tiers:         tiers,
      half_days_per_paid_leave: n.half_days_per_paid_leave,
      hours_per_paid_leave:     n.hours_per_paid_leave,
    },
  }
}

/**
 * A stored snapshot, narrowed back into settings — or the legacy constants.
 *
 * A period generated before this phase has no snapshot at all, and one written
 * by a build whose shape has since changed may fail to parse. Both must stay
 * READABLE: a payslip from March is a record of what was paid, and it cannot
 * become un-openable because the settings schema moved on. So this never throws
 * and never returns null — an unreadable snapshot resolves to the documented
 * legacy constants, which is what such a period was in fact calculated with.
 *
 * It deliberately does NOT fall back to the currently active settings. Doing so
 * would make an old payslip restate itself every time an admin edited a rule,
 * which is the exact failure the snapshot exists to prevent.
 */
export function resolveSnapshotSettings(snapshot: unknown): PayrollSettings {
  if (snapshot == null) return LEGACY_PAYROLL_SETTINGS
  const parsed = parsePayrollSettings(snapshot)
  return parsed.ok ? parsed.settings : LEGACY_PAYROLL_SETTINGS
}

// ─── Time formatting, shared by the form and the rule catalogue ───────────────

/** Minutes past midnight → "HH:MM", the value an `<input type="time">` takes. */
export function minutesToTimeInput(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * "HH:MM" → minutes past midnight, or null if it is not a time.
 *
 * Rejects rather than coerces: `Number('')` is 0, so a cleared time input would
 * otherwise silently become midnight.
 */
export function timeInputToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/** Minutes past midnight → "10:00 AM", for prose and labels. */
export function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

export const DAY_OF_WEEK_LABELS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

/** The field spec for a key, for a form that renders from SETTINGS_FIELDS. */
export function settingsField(key: NumericSettingsKey): SettingsFieldSpec {
  const spec = FIELD_BY_KEY.get(key)
  if (!spec) throw new Error(`settingsField: no spec for ${key}`)
  return spec
}
