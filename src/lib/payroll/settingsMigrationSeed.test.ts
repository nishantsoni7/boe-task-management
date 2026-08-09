/**
 * The seeded settings row and the code defaults must agree.
 *
 *   npx tsx --test src/lib/payroll/settingsMigrationSeed.test.ts
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Migration 20260828000000 seeds public.payroll_settings with a literal jsonb
 * object, because SQL cannot import a TypeScript constant. That literal is
 * therefore a SECOND statement of every payroll parameter, and a second
 * statement of a number is a number that can drift.
 *
 * The drift would be close to invisible. Nothing in the application reads the
 * seed on a machine where the table already has a row, so a wrong seed value
 * would sit unnoticed until the day a fresh environment was provisioned — and
 * then it would produce a whole company's payroll that was subtly wrong, with
 * every test still green.
 *
 * So the migration is read as text and its seed object compared, field by field,
 * against DEFAULT_PAYROLL_SETTINGS. This is the only place the two are ever
 * checked against each other.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_PAYROLL_SETTINGS, parsePayrollSettings } from './settings'

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260828000000_payroll_settings.sql',
)

const sql = readFileSync(MIGRATION, 'utf8')

/**
 * Pull the seeded scalars out of the jsonb_build_object call.
 *
 * Deliberately a text scrape rather than a database round trip: the point is to
 * check what the migration SAYS, and it must be checkable without credentials,
 * in CI, on a machine that has never been linked to a project.
 */
function seededScalars(): Map<string, number> {
  const out = new Map<string, number>()
  // 'key', 123.45   — the scalar pairs. Pairs whose value is a jsonb_build_*
  // call (the tier array) simply do not match this and are handled separately.
  const pattern = /'([a-z_]+)',\s*(-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(sql)) !== null) {
    out.set(m[1]!, Number(m[2]!))
  }
  return out
}

function seededTiers(): Array<{ min_days_present: number; leave: number }> {
  // Bounded by the key that follows it rather than by paren balancing: the
  // array's own closing paren is preceded by the objects' closing parens, and a
  // non-greedy match would stop at the first of those.
  const start = sql.indexOf("'paid_leave_tiers'")
  const end   = sql.indexOf("'half_days_per_paid_leave'")
  assert.ok(start !== -1, 'could not find the paid_leave_tiers seed block')
  assert.ok(end > start, 'paid_leave_tiers is not followed by half_days_per_paid_leave')
  const block = sql.slice(start, end)

  const tiers: Array<{ min_days_present: number; leave: number }> = []
  const pattern = /jsonb_build_object\(\s*'min_days_present',\s*(-?\d+(?:\.\d+)?)\s*,\s*'leave',\s*(-?\d+(?:\.\d+)?)\s*\)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(block)) !== null) {
    tiers.push({ min_days_present: Number(m[1]!), leave: Number(m[2]!) })
  }
  return tiers
}

describe('the migration seed matches the code defaults', () => {
  const scalars = seededScalars()

  test('the scrape found something, so a silent regex failure cannot pass this file', () => {
    assert.ok(scalars.size >= 18, `only scraped ${scalars.size} scalar settings from the migration`)
    assert.equal(seededTiers().length, 3)
  })

  test('every scalar setting is seeded with the code default', () => {
    for (const [key, expected] of Object.entries(DEFAULT_PAYROLL_SETTINGS)) {
      if (key === 'paid_leave_tiers') continue
      const seeded = scalars.get(key)
      assert.notEqual(seeded, undefined, `${key} is missing from the migration seed`)
      assert.equal(
        seeded, expected,
        `${key}: migration seeds ${seeded}, code default is ${expected}`,
      )
    }
  })

  test('no setting is seeded that the code does not know about', () => {
    const known = new Set(Object.keys(DEFAULT_PAYROLL_SETTINGS))
    // The scrape also picks up the tier members, which are legitimately not
    // top-level settings keys.
    known.add('min_days_present')
    known.add('leave')
    for (const key of scalars.keys()) {
      assert.ok(known.has(key), `migration seeds unknown setting ${key}`)
    }
  })

  test('the paid-leave bands are seeded with the code defaults', () => {
    assert.deepEqual(seededTiers(), DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers)
  })

  test('the assembled seed object passes the application validator', () => {
    const assembled: Record<string, unknown> = { paid_leave_tiers: seededTiers() }
    for (const [key, value] of scalars) {
      if (key === 'min_days_present' || key === 'leave') continue
      assembled[key] = value
    }
    const parsed = parsePayrollSettings(assembled)
    assert.equal(
      parsed.ok, true,
      `seed rejected by parsePayrollSettings: ${parsed.ok ? '' : JSON.stringify(parsed.issues)}`,
    )
  })
})

describe('the migration keeps its safety properties', () => {
  test('the settings table is append-only, by trigger', () => {
    assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.payroll_settings/)
  })

  test('RLS is enabled and only admins are granted', () => {
    assert.match(sql, /ALTER TABLE public\.payroll_settings ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /admins_read_payroll_settings/)
    assert.match(sql, /admins_write_payroll_settings/)
  })

  test('no employee-facing policy is granted on settings', () => {
    // A self-service predicate on this table would hand calculation policy to
    // every employee. There must not be one.
    assert.doesNotMatch(sql, /auth\.uid\(\)\s*=\s*employee_id/)
    assert.doesNotMatch(sql, /employees_read_payroll_settings/)
  })

  test('the snapshot column is added without a default, so no table is rewritten', () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS settings_snapshot jsonb;/)
  })

  test('the seed is guarded, so re-running cannot add a second active row', () => {
    assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM public\.payroll_settings\)/)
  })

  test('no backfill of existing periods is attempted', () => {
    // Writing today's settings onto a period that ran under the old constants
    // would record a claim the data cannot support.
    assert.doesNotMatch(sql, /UPDATE public\.payroll_periods/)
  })
})
