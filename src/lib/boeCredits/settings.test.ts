/**
 * BOE Credits settings — the defaults, the parser, and the migration seeds.
 *
 * Eight numbers, eight different things: review_reward_credits (the TEXT
 * review reward, which kept its name because it kept its meaning),
 * image_review_reward_credits, credit_value, half_day_redemption_credits,
 * full_day_redemption_credits, minimum_monthly_reviews, and the Custom Review
 * phase's max_monthly_review_submissions and minimum_monthly_image_reviews.
 * The phase seed in 20261206000000 is asserted against
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
  MAX_MONTHLY_REVIEW_SUBMISSIONS,
  parseBoeCreditSettings,
  parseBoeCreditSettingsRow,
  sameBoeCreditSettings,
  formatCreditValue,
} from './settings'

const ROOT = process.cwd()
const FOUNDATION = 'supabase/migrations/20261101000000_boe_credits_foundation.sql'
const PHASE_1D   = 'supabase/migrations/20261104000000_boe_credits_phase_1d.sql'
const PHASE_CR   = 'supabase/migrations/20261206000000_customer_review_custom_reapply_and_monthly_rules.sql'
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const D = DEFAULT_BOE_CREDIT_SETTINGS

describe('the defaults', () => {
  test('text 1, image 1.5, ₹50 a credit, half day 8, full day 15, 3 approved a month, at most 10, 3 of them images', () => {
    assert.deepEqual(D, {
      review_reward_credits: 1,
      // The business decided what an image review is worth for the Custom
      // Review phase: one and a half credits, ₹75 at ₹50 a credit.
      image_review_reward_credits: 1.5,
      credit_value: 50,
      half_day_redemption_credits: 8,
      full_day_redemption_credits: 15,
      minimum_monthly_reviews: 3,
      max_monthly_review_submissions: 10,
      minimum_monthly_image_reviews: 3,
    })
  })

  test('the Custom Review phase migration seeds exactly those values, once, into a new active row', () => {
    const sql = read(PHASE_CR)
    for (const needle of [
      'or v_newest.credit_value                   is distinct from 50.00',
      'or v_newest.review_reward_credits          is distinct from 1.00',
      'or v_newest.image_review_reward_credits    is distinct from 1.50',
      'or v_newest.minimum_monthly_reviews        is distinct from 3',
      'or v_newest.max_monthly_review_submissions is distinct from 10',
      'or v_newest.minimum_monthly_image_reviews  is distinct from 3 then',
    ]) assert.ok(sql.includes(needle), needle)
    const values = sql.match(/\) values \(\s*\n\s*([\d.]+), ([\d.]+), ([\d.]+),\s*\n\s*coalesce\(v_newest\.half_day_redemption_credits, (\d+)\), coalesce\(v_newest\.full_day_redemption_credits, (\d+)\),\s*\n\s*(\d+), (\d+), (\d+),/)
    assert.ok(values, 'the seed statement is present in the expected shape')
    assert.equal(Number(values![1]), D.review_reward_credits)
    assert.equal(Number(values![2]), D.image_review_reward_credits)
    assert.equal(Number(values![3]), D.credit_value)
    assert.equal(Number(values![4]), D.half_day_redemption_credits)
    assert.equal(Number(values![5]), D.full_day_redemption_credits)
    assert.equal(Number(values![6]), D.minimum_monthly_reviews)
    assert.equal(Number(values![7]), D.max_monthly_review_submissions)
    assert.equal(Number(values![8]), D.minimum_monthly_image_reviews)
    // The attendance prices are carried over from the row in force, not reset.
    assert.ok(sql.includes('coalesce(v_newest.half_day_redemption_credits, 8)'))
  })

  test('the two new columns default to the phase values, so every older row reads sensibly', () => {
    const sql = read(PHASE_CR)
    assert.match(sql, new RegExp(`max_monthly_review_submissions integer not null default ${D.max_monthly_review_submissions}\\b`))
    assert.match(sql, new RegExp(`minimum_monthly_image_reviews integer not null default ${D.minimum_monthly_image_reviews}\\b`))
    assert.match(sql, /check \(minimum_monthly_image_reviews <= max_monthly_review_submissions\)/)
  })

  test('review_reward_credits IS the text reward, and it kept its name for a reason', () => {
    // Renaming it would rewrite the meaning of every append-only history row
    // that already carries a value, and would be a deployment window in which a
    // released build selects a column that no longer exists. The image reward
    // is a NEW column beside it — see 20261107000000 § 11.
    const sql = read('supabase/migrations/20261107000000_review_types_assignment_and_image_groups.sql')
    assert.match(sql, /add column if not exists image_review_reward_credits integer not null default 1/)
    assert.equal(/rename column .*review_reward_credits/.test(sql), false)
    assert.equal(/alter table public\.boe_credit_settings\s+drop column/.test(sql), false)
  })

  test('half day and full day are two settings — neither is derived from the other', () => {
    assert.notEqual(D.full_day_redemption_credits, D.half_day_redemption_credits * 2)
  })

  test('the Phase 1D migration seeded its own values (history: 1 credit, ₹100, 8, 15, 3)', () => {
    const sql = read(PHASE_1D)
    const seed = sql.match(/\) values \((\d+), ([\d.]+), (\d+), (\d+), (\d+), null, 'BOE Credits Phase 1D defaults'\);/)
    assert.ok(seed, 'the seed statement is present in the expected shape')
    assert.deepEqual(seed!.slice(1, 6).map(Number), [1, 100, 8, 15, 3])
  })

  test('the Phase 1D column defaults match the attendance prices and the minimum still in force', () => {
    const sql = read(PHASE_1D)
    assert.match(sql, new RegExp(`half_day_redemption_credits integer not null default ${D.half_day_redemption_credits}\\b`))
    assert.match(sql, new RegExp(`full_day_redemption_credits integer not null default ${D.full_day_redemption_credits}\\b`))
    assert.match(sql, new RegExp(`minimum_monthly_reviews integer not null default ${D.minimum_monthly_reviews}\\b`))
  })

  test("the Phase 1D migration's own post-condition asserts its five values", () => {
    const sql = read(PHASE_1D)
    assert.match(sql, /review_reward_credits\s+is distinct from 1\s*\n\s*or v_settings\.credit_value\s+is distinct from 100\.00/)
    assert.match(sql, /half_day_redemption_credits is distinct from 8/)
    assert.match(sql, /full_day_redemption_credits is distinct from 15/)
    assert.match(sql, /minimum_monthly_reviews\s+is distinct from 3/)
  })

  test('every earlier settings row is history, kept and never edited', () => {
    const foundation = read(FOUNDATION)
    assert.match(foundation, /select 100, 1\.00, null, 'BOE Credits Phase 1A defaults'/)
    for (const file of [PHASE_1D, PHASE_CR]) {
      assert.equal(/update public\.boe_credit_settings|delete from public\.boe_credit_settings/.test(read(file)), false, file)
    }
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
    const cr = read(PHASE_CR)
    assert.equal(MAX_MONTHLY_REVIEW_SUBMISSIONS, 1_000)
    assert.match(cr, /max_monthly_review_submissions > 0 and max_monthly_review_submissions <= 1000/)
    assert.match(cr, /minimum_monthly_image_reviews >= 0 and minimum_monthly_image_reviews <= 1000/)
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
      review_reward_credits: '2', image_review_reward_credits: '5', credit_value: '150.50',
      half_day_redemption_credits: '10', full_day_redemption_credits: '20', minimum_monthly_reviews: '4',
      max_monthly_review_submissions: '12', minimum_monthly_image_reviews: '0',
    })
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.settings, {
      review_reward_credits: 2, image_review_reward_credits: 5, credit_value: 150.5,
      half_day_redemption_credits: 10, full_day_redemption_credits: 20, minimum_monthly_reviews: 4,
      max_monthly_review_submissions: 12, minimum_monthly_image_reviews: 0,
    })
  })

  test('THE IMAGE REWARD IS REQUIRED, not defaulted when a caller omits it', () => {
    // A settings save that silently filled in a reward nobody chose would be a
    // price nobody decided. The refusal names the missing field.
    const r = parseBoeCreditSettings({
      review_reward_credits: 1, credit_value: 100,
      half_day_redemption_credits: 8, full_day_redemption_credits: 15, minimum_monthly_reviews: 3,
      max_monthly_review_submissions: 10, minimum_monthly_image_reviews: 3,
    })
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.issues.some(i => i.key === 'image_review_reward_credits'))
  })

  test('THE TWO MONTHLY RULES ARE REQUIRED TOO — a pre-phase payload is refused', () => {
    const { max_monthly_review_submissions: _max, minimum_monthly_image_reviews: _min, ...older } = D
    void _max; void _min
    const r = parseBoeCreditSettings(older)
    assert.equal(r.ok, false)
    const keys = !r.ok ? r.issues.map(i => i.key).sort() : []
    assert.deepEqual(keys, ['max_monthly_review_submissions', 'minimum_monthly_image_reviews'])
  })

  test('the two review rewards are validated independently — 1 / 1 and 2 / 9 are both accepted', () => {
    assert.ok(parseBoeCreditSettings({ ...D, review_reward_credits: 1, image_review_reward_credits: 1 }).ok)
    assert.ok(parseBoeCreditSettings({ ...D, review_reward_credits: 2, image_review_reward_credits: 9 }).ok)
    // Neither is derived from the other, so a smaller image reward is legal too.
    assert.ok(parseBoeCreditSettings({ ...D, review_reward_credits: 9, image_review_reward_credits: 2 }).ok)
  })

  for (const key of ['half_day_redemption_credits', 'full_day_redemption_credits', 'minimum_monthly_reviews', 'max_monthly_review_submissions'] as const) {
    test(`${key} must be a whole positive number`, () => {
      for (const bad of [0, -1, 1.5, 'abc', null, undefined, NaN, Infinity]) {
        const r = parseBoeCreditSettings({ ...D, [key]: bad })
        assert.equal(r.ok, false, `${key} = ${String(bad)} must be refused`)
        assert.ok(!r.ok && r.issues.some(i => i.key === key))
      }
    })
  }

  test('the smallest allowed values are accepted together', () => {
    assert.ok(parseBoeCreditSettings({
      ...D, half_day_redemption_credits: 1, full_day_redemption_credits: 1,
      minimum_monthly_reviews: 1, max_monthly_review_submissions: 1, minimum_monthly_image_reviews: 0,
    }).ok)
  })

  test('the image minimum may be 0 (the rule off), but never negative or fractional', () => {
    assert.ok(parseBoeCreditSettings({ ...D, minimum_monthly_image_reviews: 0 }).ok)
    for (const bad of [-1, 1.5, 'x', null]) {
      const r = parseBoeCreditSettings({ ...D, minimum_monthly_image_reviews: bad })
      assert.equal(r.ok, false, String(bad))
      assert.ok(!r.ok && r.issues.some(i => i.key === 'minimum_monthly_image_reviews'))
    }
  })

  test('the image minimum and the approved minimum cannot exceed the monthly maximum', () => {
    const images = parseBoeCreditSettings({ ...D, max_monthly_review_submissions: 4, minimum_monthly_image_reviews: 5, minimum_monthly_reviews: 3 })
    assert.equal(images.ok, false)
    assert.ok(!images.ok && images.issues.some(i => i.key === 'minimum_monthly_image_reviews'))
    const approved = parseBoeCreditSettings({ ...D, max_monthly_review_submissions: 2, minimum_monthly_image_reviews: 1, minimum_monthly_reviews: 3 })
    assert.equal(approved.ok, false)
    assert.ok(!approved.ok && approved.issues.some(i => i.key === 'minimum_monthly_reviews'))
    assert.ok(parseBoeCreditSettings({ ...D, max_monthly_review_submissions: 3, minimum_monthly_image_reviews: 3, minimum_monthly_reviews: 3 }).ok)
  })

  // THE TWO REVIEW REWARDS MAY BE DECIMAL (20261204000000): an image review can
  // earn 1.5 credits. Above zero, at most two decimal places.
  for (const key of ['review_reward_credits', 'image_review_reward_credits'] as const) {
    test(`${key} must be above zero with at most two decimal places`, () => {
      for (const bad of [0, -1, -0.5, 1.555, 'abc', null, undefined, NaN, Infinity]) {
        const r = parseBoeCreditSettings({ ...D, [key]: bad })
        assert.equal(r.ok, false, `${key} = ${String(bad)} must be refused`)
        assert.ok(!r.ok && r.issues.some(i => i.key === key))
      }
      for (const good of [1, 1.5, 0.5, 2.25, '1.5']) {
        const r = parseBoeCreditSettings({ ...D, [key]: good })
        assert.ok(r.ok, `${key} = ${String(good)} is allowed`)
        assert.equal(r.ok && r.settings[key], Number(good))
      }
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
    const r = parseBoeCreditSettings({
      review_reward_credits: 0, image_review_reward_credits: -2, credit_value: -1, half_day_redemption_credits: 'x',
      full_day_redemption_credits: 0.5, minimum_monthly_reviews: null, max_monthly_review_submissions: 0, minimum_monthly_image_reviews: -1,
    })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.issues.length, 8)
  })

  test('a row written before the two monthly columns existed still parses, with the defaults standing in', () => {
    const r = parseBoeCreditSettingsRow({
      review_reward_credits: 1, image_review_reward_credits: 1, credit_value: 50,
      half_day_redemption_credits: 8, full_day_redemption_credits: 15, minimum_monthly_reviews: 3,
    })
    assert.ok(r.ok)
    assert.equal(r.ok && r.settings.max_monthly_review_submissions, D.max_monthly_review_submissions)
    assert.equal(r.ok && r.settings.minimum_monthly_image_reviews, D.minimum_monthly_image_reviews)
  })

  test('sameBoeCreditSettings compares all eight', () => {
    assert.ok(sameBoeCreditSettings(D, { ...D }))
    assert.ok(sameBoeCreditSettings(D, { ...D, credit_value: 50.001 }), 'sub-paisa noise is the same value')
    assert.equal(sameBoeCreditSettings(D, { ...D, minimum_monthly_reviews: 4 }), false)
    assert.equal(sameBoeCreditSettings(D, { ...D, full_day_redemption_credits: 16 }), false)
    // WITHOUT THESE the settings form would treat a change as no change at all,
    // disable its own Save button, and silently discard it.
    assert.equal(sameBoeCreditSettings(D, { ...D, image_review_reward_credits: 4 }), false)
    assert.equal(sameBoeCreditSettings(D, { ...D, max_monthly_review_submissions: 12 }), false)
    assert.equal(sameBoeCreditSettings(D, { ...D, minimum_monthly_image_reviews: 2 }), false)
  })

  test('formatCreditValue prints whole rupees without paise and paise when present', () => {
    assert.equal(formatCreditValue(100), '₹100')
    assert.equal(formatCreditValue(150.5), '₹150.50')
    assert.equal(formatCreditValue(1234567), '₹12,34,567')
  })
})
