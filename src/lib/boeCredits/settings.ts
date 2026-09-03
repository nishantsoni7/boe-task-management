// BOE Credits settings — the defaults, and the one parser both the form and
// the API use, so the form cannot accept something the server will reject.
//
// FIVE NUMBERS, FIVE DIFFERENT THINGS.
//
//   review_reward_credits         how many credits ONE verified review earns.
//   credit_value                  how many rupees ONE credit is worth when an
//                                 employee applies credits to payroll. It is
//                                 SNAPSHOTTED on the application, so a later
//                                 change never re-prices an existing one.
//   half_day_redemption_credits   what covering a chargeable Half Day costs.
//   full_day_redemption_credits   what covering a chargeable Absent day costs.
//                                 Independent of the half day — never derived.
//   minimum_monthly_reviews       verified reviews a month needs before that
//                                 month's rewards stop being provisional. It is
//                                 snapshotted on the month row the first time
//                                 the month earns a reward.
//
// EVERY CHANGE APPLIES TO FUTURE ACTIONS ONLY. Rewards, redemptions and payroll
// applications already recorded keep the numbers written on them.
//
// Deliberately NOT here: a rules engine, department- or employee-specific
// rates, date-effective schedules, campaigns. The table is append-only, so
// history is a consequence of the shape — every save is its own row.

import type { BoeCreditSettings } from './types'

/**
 * The Phase 1D production values. Seeded by 20261104000000_boe_credits_phase_1d.sql
 * and asserted against it by settings.test.ts, so the two cannot drift.
 */
export const DEFAULT_BOE_CREDIT_SETTINGS: BoeCreditSettings = {
  review_reward_credits: 1,
  credit_value: 100.0,
  half_day_redemption_credits: 8,
  full_day_redemption_credits: 15,
  minimum_monthly_reviews: 3,
}

/** Bounds the database CHECKs also enforce. Stated once, here. */
export const MAX_REVIEW_REWARD_CREDITS = 100_000
export const MAX_REDEMPTION_CREDITS = 100_000
export const MAX_MINIMUM_MONTHLY_REVIEWS = 1_000
/** numeric(12,2): ten digits before the point. */
export const MAX_CREDIT_VALUE = 9_999_999_999.99

export type SettingsValidationIssue = { key: keyof BoeCreditSettings; message: string }

export type ParsedSettings =
  | { ok: true; settings: BoeCreditSettings }
  | { ok: false; issues: SettingsValidationIssue[] }

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** The four whole-credit fields share one rule: a positive whole number within its bound. */
const WHOLE_FIELDS: { key: keyof BoeCreditSettings; label: string; unit: string; max: number }[] = [
  { key: 'review_reward_credits',       label: 'Verified review reward',     unit: 'credits', max: MAX_REVIEW_REWARD_CREDITS },
  { key: 'half_day_redemption_credits', label: 'Half Day redemption',        unit: 'credits', max: MAX_REDEMPTION_CREDITS },
  { key: 'full_day_redemption_credits', label: 'Full Day redemption',        unit: 'credits', max: MAX_REDEMPTION_CREDITS },
  { key: 'minimum_monthly_reviews',     label: 'Minimum reviews per month',  unit: 'reviews', max: MAX_MINIMUM_MONTHLY_REVIEWS },
]

/**
 * Validate a candidate settings object in full. Returns the issues rather than
 * throwing, so a form can show every problem at once.
 */
export function parseBoeCreditSettings(input: unknown): ParsedSettings {
  const issues: SettingsValidationIssue[] = []
  const obj = (input ?? {}) as Record<string, unknown>
  const out: Partial<BoeCreditSettings> = {}

  for (const f of WHOLE_FIELDS) {
    const n = asNumber(obj[f.key])
    if (n == null) {
      issues.push({ key: f.key, message: `${f.label} must be a number.` })
    } else if (!Number.isInteger(n)) {
      issues.push({ key: f.key, message: `${f.label} must be a whole number of ${f.unit}.` })
    } else if (n < 1 || n > f.max) {
      issues.push({ key: f.key, message: `${f.label} must be between 1 and ${f.max.toLocaleString('en-IN')} ${f.unit}.` })
    } else {
      out[f.key] = n
    }
  }

  const value = asNumber(obj.credit_value)
  if (value == null) {
    issues.push({ key: 'credit_value', message: 'Value of 1 credit must be a number.' })
  } else if (value <= 0) {
    issues.push({ key: 'credit_value', message: 'Value of 1 credit must be more than ₹0.' })
  } else if (value > MAX_CREDIT_VALUE) {
    issues.push({ key: 'credit_value', message: 'Value of 1 credit is too large.' })
  } else if (Math.round(value * 100) !== Math.round(value * 100 * 1e6) / 1e6 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    issues.push({ key: 'credit_value', message: 'Value of 1 credit is in rupees and paise — at most two decimal places.' })
  } else {
    out.credit_value = Math.round(value * 100) / 100
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, settings: out as BoeCreditSettings }
}

/** True when two settings objects carry the same five values. */
export function sameBoeCreditSettings(a: BoeCreditSettings, b: BoeCreditSettings): boolean {
  return a.review_reward_credits === b.review_reward_credits
    && Math.abs(a.credit_value - b.credit_value) < 0.005
    && a.half_day_redemption_credits === b.half_day_redemption_credits
    && a.full_day_redemption_credits === b.full_day_redemption_credits
    && a.minimum_monthly_reviews === b.minimum_monthly_reviews
}

/** "₹100" / "₹100.50" — the rupee value of one credit, for labels. */
export function formatCreditValue(value: number): string {
  const whole = Math.abs(value - Math.round(value)) < 0.005
  return '₹' + value.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })
}
