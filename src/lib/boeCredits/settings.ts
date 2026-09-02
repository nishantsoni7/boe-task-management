// BOE Credits settings — the defaults, and the one parser both the form and
// the API use, so the form cannot accept something the server will reject.
//
// TWO NUMBERS, TWO DIFFERENT THINGS.
//
//   review_reward_credits   how many credits ONE verified review earns. Phase 1B
//                           will read it when it posts a review_reward row.
//   credit_value            how many rupees ONE credit is worth. Phase 1D will
//                           read it when Payroll turns a redemption into money.
//
// They are stored side by side because an administrator changes them on the
// same screen, not because they are related: doubling the reward does not
// change what a credit is worth, and vice versa.
//
// Deliberately NOT here: a rules engine, department-specific rates, or
// date-effective history. The table is append-only, so history is a
// consequence of the shape — every save is its own row — and nothing more is
// needed until a phase actually asks for it.

import type { BoeCreditSettings } from './types'

/**
 * The Phase 1A defaults. Seeded by 20261101000000_boe_credits_foundation.sql
 * and asserted against it by settings.test.ts, so the two cannot drift.
 */
export const DEFAULT_BOE_CREDIT_SETTINGS: BoeCreditSettings = {
  review_reward_credits: 100,
  credit_value: 1.0,
}

/** Bounds the database CHECKs also enforce. Stated once, here. */
export const MAX_REVIEW_REWARD_CREDITS = 100_000

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
 * Validate a candidate settings object in full. Returns the issues rather than
 * throwing, so a form can show every problem at once.
 */
export function parseBoeCreditSettings(input: unknown): ParsedSettings {
  const issues: SettingsValidationIssue[] = []
  const obj = (input ?? {}) as Record<string, unknown>

  const reward = asNumber(obj.review_reward_credits)
  if (reward == null) {
    issues.push({ key: 'review_reward_credits', message: 'Review reward must be a number.' })
  } else if (!Number.isInteger(reward)) {
    issues.push({ key: 'review_reward_credits', message: 'Review reward must be a whole number of credits.' })
  } else if (reward < 1 || reward > MAX_REVIEW_REWARD_CREDITS) {
    issues.push({
      key: 'review_reward_credits',
      message: `Review reward must be between 1 and ${MAX_REVIEW_REWARD_CREDITS.toLocaleString('en-IN')} credits.`,
    })
  }

  const value = asNumber(obj.credit_value)
  if (value == null) {
    issues.push({ key: 'credit_value', message: 'Credit value must be a number.' })
  } else if (value < 0) {
    issues.push({ key: 'credit_value', message: 'Credit value cannot be negative.' })
  } else if (Math.round(value * 100) !== value * 100) {
    issues.push({ key: 'credit_value', message: 'Credit value is in rupees and paise — at most two decimal places.' })
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    settings: { review_reward_credits: reward as number, credit_value: value as number },
  }
}
