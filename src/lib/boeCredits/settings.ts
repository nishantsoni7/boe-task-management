// BOE Credits settings — the defaults, and the one parser both the form and
// the API use, so the form cannot accept something the server will reject.
//
// EIGHT NUMBERS, EIGHT DIFFERENT THINGS.
//
//   review_reward_credits         how many credits ONE approved TEXT review
//                                 earns. It keeps its name because it keeps its
//                                 meaning: before review types existed every
//                                 review was a text review and this was the
//                                 reward, so every history row already stored
//                                 under this name still says what it said.
//   image_review_reward_credits   how many credits ONE approved IMAGE review
//                                 earns. Set on its own, never derived from the
//                                 text reward. THE DATABASE CHOOSES BETWEEN THE
//                                 TWO from the review's own stored review_type —
//                                 no screen and no request decides which one is
//                                 paid.
//   credit_value                  how many rupees ONE credit is worth when an
//                                 employee applies credits to payroll. It is
//                                 SNAPSHOTTED on the application, so a later
//                                 change never re-prices an existing one.
//   half_day_redemption_credits   what covering a chargeable Half Day costs.
//   full_day_redemption_credits   what covering a chargeable Absent day costs.
//                                 Independent of the half day — never derived.
//   minimum_monthly_reviews       approved reviews a month needs before that
//                                 month's review rewards stop being provisional.
//                                 Snapshotted on the month row the first time
//                                 the month earns a reward. Below it nothing is
//                                 taken away that the employee already held.
//   max_monthly_review_submissions  custom reviews an employee may submit for
//                                 approval in one month (20261206000000).
//   minimum_monthly_image_reviews of those, how many must be Image Reviews.
//
// AND TWO SWITCHES (20261208000000).
//
//   half_day_redemption_enabled   whether a chargeable Half Day may be covered
//                                 with credits at all.
//   full_day_redemption_enabled   the same for a chargeable Absent day.
//                                 Independent of the half day. A switched-off
//                                 price is KEPT — neither required nor
//                                 validated, carried as it was — so switching
//                                 it back on restores it without re-entry.
//
// EVERY CHANGE APPLIES TO FUTURE ACTIONS ONLY. Rewards, redemptions and payroll
// applications already recorded keep the numbers written on them.
//
// Deliberately NOT here: a rules engine, department- or employee-specific
// rates, date-effective schedules, campaigns. The table is append-only, so
// history is a consequence of the shape — every save is its own row.

import type { BoeCreditSettings } from './types'
import { hasCreditPrecision, roundCredits } from './ledger'

/**
 * The Custom Review phase values. Seeded by
 * 20261206000000_customer_review_custom_reapply_and_monthly_rules.sql and
 * asserted against it by settings.test.ts, so the two cannot drift. Used only
 * when no settings row can be read.
 *
 * THE TWO SWITCHES DEFAULT TO OFF HERE, deliberately: this object is what a
 * screen shows while the real row is loading or could not be read, and a
 * redemption the business has switched off must never flash into view. The
 * database columns default to OFF as well (20261208000000): redemption is an
 * optional feature that only an administrator switches on.
 */
export const DEFAULT_BOE_CREDIT_SETTINGS: BoeCreditSettings = {
  review_reward_credits: 1,
  image_review_reward_credits: 1.5,
  credit_value: 50.0,
  half_day_redemption_credits: 8,
  full_day_redemption_credits: 15,
  minimum_monthly_reviews: 3,
  max_monthly_review_submissions: 10,
  minimum_monthly_image_reviews: 3,
  half_day_redemption_enabled: false,
  full_day_redemption_enabled: false,
}

/** Bounds the database CHECKs also enforce. Stated once, here. */
export const MAX_REVIEW_REWARD_CREDITS = 100_000
export const MAX_REDEMPTION_CREDITS = 100_000
export const MAX_MINIMUM_MONTHLY_REVIEWS = 1_000
export const MAX_MONTHLY_REVIEW_SUBMISSIONS = 1_000
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

/**
 * The two review rewards may be DECIMAL — an image review earns 1.5 credits
 * (numeric(12,2) in the database). Above zero, at most two decimal places.
 */
const REWARD_FIELDS: { key: 'review_reward_credits' | 'image_review_reward_credits'; label: string; max: number }[] = [
  { key: 'review_reward_credits',       label: 'Text review reward',  max: MAX_REVIEW_REWARD_CREDITS },
  { key: 'image_review_reward_credits', label: 'Image review reward', max: MAX_REVIEW_REWARD_CREDITS },
]

/** The two redemption switches. */
export type RedemptionSwitchKey = 'half_day_redemption_enabled' | 'full_day_redemption_enabled'

/** Required, like every other setting — a payload that omits one is refused, not defaulted. */
const SWITCH_FIELDS: { key: RedemptionSwitchKey; label: string }[] = [
  { key: 'half_day_redemption_enabled', label: 'Half Day redemption' },
  { key: 'full_day_redemption_enabled', label: 'Full Day redemption' },
]

function asBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return null
}

/** The whole-number fields that must be at least 1. */
const WHOLE_FIELDS: {
  key: 'half_day_redemption_credits' | 'full_day_redemption_credits' | 'minimum_monthly_reviews' | 'max_monthly_review_submissions'
  label: string; unit: string; max: number
  /** The switch that makes this price optional while it is off. */
  switchKey?: RedemptionSwitchKey
}[] = [
  { key: 'half_day_redemption_credits',    label: 'Half Day redemption',              unit: 'credits', max: MAX_REDEMPTION_CREDITS, switchKey: 'half_day_redemption_enabled' },
  { key: 'full_day_redemption_credits',    label: 'Full Day redemption',              unit: 'credits', max: MAX_REDEMPTION_CREDITS, switchKey: 'full_day_redemption_enabled' },
  { key: 'minimum_monthly_reviews',        label: 'Minimum reviews per month',        unit: 'reviews', max: MAX_MINIMUM_MONTHLY_REVIEWS },
  { key: 'max_monthly_review_submissions', label: 'Maximum review submissions a month', unit: 'reviews', max: MAX_MONTHLY_REVIEW_SUBMISSIONS },
]

/**
 * Validate a candidate settings object in full. Returns the issues rather than
 * throwing, so a form can show every problem at once.
 *
 * `keep` is the settings in force. A redemption price whose switch is OFF is
 * not required: when the candidate's value is missing or unusable, the price in
 * `keep` is carried unchanged (the built-in default when none is given), so
 * switching a redemption off never deletes or rewrites its price.
 */
export function parseBoeCreditSettings(input: unknown, keep: BoeCreditSettings = DEFAULT_BOE_CREDIT_SETTINGS): ParsedSettings {
  const issues: SettingsValidationIssue[] = []
  const obj = (input ?? {}) as Record<string, unknown>
  const out: Partial<BoeCreditSettings> = {}

  for (const f of SWITCH_FIELDS) {
    const b = asBoolean(obj[f.key])
    if (b == null) issues.push({ key: f.key, message: `${f.label} must be switched on or off.` })
    else out[f.key] = b
  }

  for (const f of REWARD_FIELDS) {
    const n = asNumber(obj[f.key])
    if (n == null) {
      issues.push({ key: f.key, message: `${f.label} must be a number.` })
    } else if (n <= 0 || n > f.max) {
      issues.push({ key: f.key, message: `${f.label} must be above 0 and at most ${f.max.toLocaleString('en-IN')} credits.` })
    } else if (!hasCreditPrecision(n)) {
      issues.push({ key: f.key, message: `${f.label} can have at most two decimal places.` })
    } else {
      out[f.key] = roundCredits(n)
    }
  }

  for (const f of WHOLE_FIELDS) {
    const n = asNumber(obj[f.key])
    const usable = n != null && Number.isInteger(n) && n >= 1 && n <= f.max
    if (!usable && f.switchKey != null && out[f.switchKey] === false) {
      out[f.key] = keep[f.key]
    } else if (n == null) {
      issues.push({ key: f.key, message: `${f.label} must be a number.` })
    } else if (!Number.isInteger(n)) {
      issues.push({ key: f.key, message: `${f.label} must be a whole number of ${f.unit}.` })
    } else if (n < 1 || n > f.max) {
      issues.push({ key: f.key, message: `${f.label} must be between 1 and ${f.max.toLocaleString('en-IN')} ${f.unit}.` })
    } else {
      out[f.key] = n
    }
  }

  // The image minimum may be 0 — that turns the image rule off.
  const images = asNumber(obj.minimum_monthly_image_reviews)
  if (images == null) {
    issues.push({ key: 'minimum_monthly_image_reviews', message: 'Minimum image reviews must be a number.' })
  } else if (!Number.isInteger(images) || images < 0 || images > MAX_MONTHLY_REVIEW_SUBMISSIONS) {
    issues.push({ key: 'minimum_monthly_image_reviews', message: 'Minimum image reviews must be a whole number, 0 or more.' })
  } else {
    out.minimum_monthly_image_reviews = images
  }

  // Two numbers that only make sense together. The database holds the first
  // (a CHECK on the row); the second is a form rule, because a month whose
  // target cannot be reached inside its own cap is a setting nobody meant.
  if (out.max_monthly_review_submissions != null && out.minimum_monthly_image_reviews != null
      && out.minimum_monthly_image_reviews > out.max_monthly_review_submissions) {
    issues.push({ key: 'minimum_monthly_image_reviews', message: 'Minimum image reviews cannot be more than the monthly maximum.' })
  }
  if (out.max_monthly_review_submissions != null && out.minimum_monthly_reviews != null
      && out.minimum_monthly_reviews > out.max_monthly_review_submissions) {
    issues.push({ key: 'minimum_monthly_reviews', message: 'Minimum reviews per month cannot be more than the monthly maximum.' })
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

/**
 * A settings ROW, as PostgREST returns it, parsed. A row written before a
 * column existed carries nothing for it; the built-in default stands in, so a
 * screen never goes blank because one column is younger than one row.
 */
export function parseBoeCreditSettingsRow(row: Record<string, unknown>): ParsedSettings {
  const or = <K extends keyof BoeCreditSettings>(key: K) => row[key] ?? DEFAULT_BOE_CREDIT_SETTINGS[key]
  return parseBoeCreditSettings({
    review_reward_credits:          row.review_reward_credits,
    image_review_reward_credits:    or('image_review_reward_credits'),
    credit_value:                   row.credit_value,
    half_day_redemption_credits:    or('half_day_redemption_credits'),
    full_day_redemption_credits:    or('full_day_redemption_credits'),
    minimum_monthly_reviews:        or('minimum_monthly_reviews'),
    max_monthly_review_submissions: or('max_monthly_review_submissions'),
    minimum_monthly_image_reviews:  or('minimum_monthly_image_reviews'),
    half_day_redemption_enabled:    or('half_day_redemption_enabled'),
    full_day_redemption_enabled:    or('full_day_redemption_enabled'),
  })
}

/** True when two settings objects carry the same eight values and the same two switches. */
export function sameBoeCreditSettings(a: BoeCreditSettings, b: BoeCreditSettings): boolean {
  return roundCredits(a.review_reward_credits) === roundCredits(b.review_reward_credits)
    && roundCredits(a.image_review_reward_credits) === roundCredits(b.image_review_reward_credits)
    && Math.abs(a.credit_value - b.credit_value) < 0.005
    && a.half_day_redemption_credits === b.half_day_redemption_credits
    && a.full_day_redemption_credits === b.full_day_redemption_credits
    && a.minimum_monthly_reviews === b.minimum_monthly_reviews
    && a.max_monthly_review_submissions === b.max_monthly_review_submissions
    && a.minimum_monthly_image_reviews === b.minimum_monthly_image_reviews
    && a.half_day_redemption_enabled === b.half_day_redemption_enabled
    && a.full_day_redemption_enabled === b.full_day_redemption_enabled
}

/**
 * What an approved review of this type earns, under these settings.
 *
 * FOR LABELS ONLY, AND THAT IS NOT A HEDGE — it is the point. What is actually
 * paid is decided inside the database, from the newest settings row and the
 * review's own stored review_type, in the same transaction that approves the
 * review. This function exists so a screen can say "1.5 credits" before anyone
 * presses anything; if the settings change between the render and the press,
 * the database pays the new amount. That is the correct order of authority.
 *
 * An unknown type reads as text, which is what every review was before types
 * existed and what the database's own default says.
 */
export function rewardForReviewType(
  settings: BoeCreditSettings,
  reviewType: string | null | undefined,
): number {
  return reviewType === 'image'
    ? settings.image_review_reward_credits
    : settings.review_reward_credits
}

/** "₹100" / "₹100.50" — the rupee value of one credit, for labels. */
export function formatCreditValue(value: number): string {
  const whole = Math.abs(value - Math.round(value)) < 0.005
  return '₹' + value.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })
}
