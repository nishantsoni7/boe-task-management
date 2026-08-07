// The BOE working day, as numbers.
//
// These were literals repeated across classification.ts and the payroll engine —
// `10 * 60 + 15` appeared in four places, `18 * 60 + 30` in three, and the hours
// thresholds only in classification. Naming them once means a rule can be
// stated to an employee (Payroll Result Detail → "How Attendance & Payroll Is
// Calculated") from the same value the calculation uses, so the explanation
// cannot drift from the behaviour.
//
// Everything here is IST minutes past midnight, or hours. Nothing here is money.

/** The weekly off, as JavaScript numbers days. 0 = Sunday. */
export const WEEKLY_OFF_DAY = 0

/** Official start of the working day — 10:00 IST. */
export const SCHEDULED_IN_MINUTES = 10 * 60

/** End of the grace period — 10:15 IST. Late deduction starts after this. */
export const GRACE_END_MINUTES = 10 * 60 + 15

/** Official end of the working day — 18:30 IST. */
export const SCHEDULED_OUT_MINUTES = 18 * 60 + 30

/** Paid hours in a full working day. */
export const FULL_DAY_HOURS = 8.5

/** Paid hours in a half day. */
export const HALF_DAY_HOURS = FULL_DAY_HOURS / 2

/** Lunch is deducted when the punch-in is before this — 14:00 IST. */
export const LUNCH_IN_BEFORE_MINUTES = 14 * 60

/** …and the punch-out is after this — 13:00 IST. */
export const LUNCH_OUT_AFTER_MINUTES = 13 * 60

/** Hours removed from a day that spans the lunch break. */
export const LUNCH_HOURS = 1

/**
 * Effective-hours thresholds, highest first. The first band a day reaches is
 * what it is classified as; below the last one the day is an absence.
 */
export const PRESENCE_THRESHOLD_HOURS = {
  full_present:           7.5,
  present_with_shortfall: 5,
  half_day:               3.75,
  short_present:          2,
} as const

/**
 * Lateness and early departure are measured from the scheduled boundary and
 * rounded UP to the next block of this many minutes, then charged in half-hour
 * units. 0–15 minutes costs nothing at all.
 */
export const ROUNDING_BLOCK_MINUTES = 30

/** Hours one rounded block is worth. */
export const ROUNDING_BLOCK_HOURS = 0.5
