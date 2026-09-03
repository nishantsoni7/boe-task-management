/**
 * BOE Credits settings — the defaults, the parser, and the migration seed.
 *
 * Five numbers, five different things: review_reward_credits, credit_value,
 * half_day_redemption_credits, full_day_redemption_credits and
 * minimum_monthly_reviews. The Phase 1D seed in
 * 20261104000000_boe_credits_phase_1d.sql is asserted against
 * DEFAULT_BOE_CREDIT_SETTINGS here, so a constant that changes on one side
 * without the other breaks a test rather than a payslip.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/settings.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_BOE_CREDIT_SETTINGS,
  MAX_REVIEW_REWARD_CREDITS,
  MAX_REDEMPTION_CREDITS,
  MAX_MINIMUM_MONTHLY_REVIEWS,
  parseBoeCreditSettings,
  sameBoeCreditSettings,
  formatCreditValue,
} from './settings'

const ROOT = process.cwd()
const FOUNDATION = 'supabase/migrations/20261101000000_boe_credits_foundation.sql'
const PHASE_1D   = 'supabase/migrations/20261104000000_boe_credits_phase_1d.sql'
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const D = DEFAULT_BOE_CREDIT_SETTINGS

describe('the defaults', () => {
  test('reward 1, ₹100 per credit, half day 8, full day 15, three reviews a month', () => {
    assert.deepEqual(D, {
      review_reward_credits: 1,
      credit_value: 100,
      half_day_redemption_credits: 8,
      full_day_redemption_credits: 15,
      minimum_monthly_reviews: 3,
    })
  })

  test('half day and full day are two settings — neither is derived from the other', () => {
    assert.notEqual(D.full_day_redemption_credits, D.half_day_redemption_credits * 2)
  })

  test('the Phase 1D migration seeds exactly those values into a new active row', () => {
    const sql = read(PHASE_1D)
    const seed = sql.match(/\) values \((\d+), ([\d.]+), (\d+), (\d+), (\d+), null, 'BOE Credits Phase 1D defaults'\);/)
    assert.ok(seed, 'the seed statement is present in the expected shape')
    assert.equal(Number(seed![1]), D.review_reward_credits)
    assert.equal(Number(seed![2]), D.credit_value)
    assert.equal(Number(seed![3]), D.half_day_redemption_credits)
    assert.equal(Number(seed![4]), D.full_day_redemption_credits)
    assert.equal(Number(seed![5]), D.minimum_monthly_reviews)
  })

  test('the column defaults on the settings table match too, so the Phase 1A row reads sensibly', () => {
    const sql = read(PHASE_1D)
    assert.match(sql, new RegExp(`half_day_redemption_credits integer not null default ${D.half_day_redemption_credits}\\b`))
    assert.match(sql, new RegExp(`full_day_redemption_credits integer not null default ${D.full_day_redemption_credits}\\b`))
    assert.match(sql, new RegExp(`minimum_monthly_reviews integer not null default ${D.minimum_monthly_reviews}\\b`))
  })

  test("the migration's own post-condition asserts the same five values", () => {
    const sql = read(PHASE_1D)
    assert.match(sql, /review_reward_credits\s+is distinct from 1\s*\n\s*or v_settings\.credit_value\s+is distinct from 100\.00/)
    assert.match(sql, /half_day_redemption_credits is distinct from 8/)
    assert.match(sql, /full_day_redemption_credits is distinct from 15/)
    assert.match(sql, /minimum_monthly_reviews\s+is distinct from 3/)
  })

  test('the Phase 1A seed (100 / 1.00) is history, not the active pair — it is kept, never edited', () => {
    const foundation = read(FOUNDATION)
    assert.match(foundation, /select 100, 1\.00, null, 'BOE Credits Phase 1A defaults'/)
    const phase1d = read(PHASE_1D)
    assert.equal(/update public\.boe_credit_settings|delete from public\.boe_credit_settings/.test(phase1d), false)
  })

  test('the bounds match the database CHECKs', () => {
    const sql = read(PHASE_1D)
    assert.equal(MAX_REDEMPTION_CREDITS, 100_000)
    assert.match(sql, /half_day_redemption_credits > 0 and half_day_redemption_credits <= 100000/)
    assert.match(sql, /full_day_redemption_credits > 0 and full_day_redemption_credits <= 100000/)
    assert.equal(MAX_MINIMUM_MONTHLY_REVIEWS, 1_000)
    assert.match(sql, /minimum_monthly_reviews > 0 and minimum_monthly_reviews <= 1000/)
    assert.equal(MAX_REVIEW_REWARD_CREDITS, 100_000)
    assert.match(sql, /check \(credit_value > 0\)/)
  })
})

describe('the parser', () => {
  test('accepts the defaults', () => {
    const r = parseBoeCreditSettings(D)
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.settings, D)
  })

  test('accepts numeric strings, as a form and PostgREST both produce', () => {
    const r = parseBoeCreditSettings({
      review_reward_credits: '2', credit_value: '150.50',
      half_day_redemption_credits: '10', full_day_redemption_credits: '20', minimum_monthly_reviews: '4',
    })
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.settings, {
      review_reward_credits: 2, credit_value: 150.5,
      half_day_redemption_credits: 10, full_day_redemption_credits: 20, minimum_monthly_reviews: 4,
    })
  })

  for (const key of ['review_reward_credits', 'half_day_redemption_credits', 'full_day_redemption_credits', 'minimum_monthly_reviews'] as const) {
    test(`${key} must be a whole positive number`, () => {
      for (const bad of [0, -1, 1.5, 'abc', null, undefined, NaN, Infinity]) {
        const r = parseBoeCreditSettings({ ...D, [key]: bad })
        assert.equal(r.ok, false, `${key} = ${String(bad)} must be refused`)
        assert.ok(!r.ok && r.issues.some(i => i.key === key))
      }
      const ok = parseBoeCreditSettings({ ...D, [key]: 1 })
      assert.ok(ok.ok, `${key} = 1 is the smallest allowed`)
    })
  }

  test('the credit value must be POSITIVE (zero is refused since Phase 1D), never negative, and is rupees and paise', () => {
    assert.equal(parseBoeCreditSettings({ ...D, credit_value: 0 }).ok, false)
    assert.equal(parseBoeCreditSettings({ ...D, credit_value: -1 }).ok, false)
    assert.equal(parseBoeCreditSettings({ ...D, credit_value: 1.005 }).ok, false)
    assert.equal(parseBoeCreditSettings({ ...D, credit_value: 'x' }).ok, false)
    assert.ok(parseBoeCreditSettings({ ...D, credit_value: 0.5 }).ok)
    assert.ok(parseBoeCreditSettings({ ...D, credit_value: 100.25 }).ok)
  })

  test('half day and full day are validated independently — 8 / 8 and 20 / 10 are both accepted', () => {
    assert.ok(parseBoeCreditSettings({ ...D, half_day_redemption_credits: 8, full_day_redemption_credits: 8 }).ok)
    assert.ok(parseBoeCreditSettings({ ...D, half_day_redemption_credits: 20, full_day_redemption_credits: 10 }).ok)
  })

  test('every problem is reported at once', () => {
    const r = parseBoeCreditSettings({ review_reward_credits: 0, credit_value: -1, half_day_redemption_credits: 'x', full_day_redemption_credits: 0.5, minimum_monthly_reviews: null })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.issues.length, 5)
  })

  test('sameBoeCreditSettings compares all five', () => {
    assert.ok(sameBoeCreditSettings(D, { ...D }))
    assert.ok(sameBoeCreditSettings(D, { ...D, credit_value: 100.001 }), 'sub-paisa noise is the same value')
    assert.equal(sameBoeCreditSettings(D, { ...D, minimum_monthly_reviews: 4 }), false)
    assert.equal(sameBoeCreditSettings(D, { ...D, full_day_redemption_credits: 16 }), false)
  })

  test('formatCreditValue prints whole rupees without paise and paise when present', () => {
    assert.equal(formatCreditValue(100), '₹100')
    assert.equal(formatCreditValue(150.5), '₹150.50')
    assert.equal(formatCreditValue(1234567), '₹12,34,567')
  })
})
