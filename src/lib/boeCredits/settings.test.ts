/**
 * BOE Credits settings — the defaults, the parser, and the migration seed.
 *
 * The two numbers are two different things: review_reward_credits (credits per
 * verified review) and credit_value (rupees per credit). The seed in
 * 20261101000000_boe_credits_foundation.sql is asserted against
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
import { DEFAULT_BOE_CREDIT_SETTINGS, MAX_REVIEW_REWARD_CREDITS, parseBoeCreditSettings } from './settings'

const ROOT = process.cwd()
const MIGRATION = 'supabase/migrations/20261101000000_boe_credits_foundation.sql'
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

describe('the defaults', () => {
  test('reward = 100 credits, credit value = 1.00', () => {
    assert.equal(DEFAULT_BOE_CREDIT_SETTINGS.review_reward_credits, 100)
    assert.equal(DEFAULT_BOE_CREDIT_SETTINGS.credit_value, 1.0)
  })

  test('the migration seeds exactly those values, once, only into an empty table', () => {
    const sql = read(MIGRATION)
    const seed = sql.match(
      /insert into public\.boe_credit_settings \(review_reward_credits, credit_value, created_by, note\)\s*\nselect (\d+), ([\d.]+), null, '[^']*'\s*\nwhere not exists \(select 1 from public\.boe_credit_settings\);/,
    )
    assert.ok(seed, 'the seed statement is present in the expected shape')
    assert.equal(Number(seed![1]), DEFAULT_BOE_CREDIT_SETTINGS.review_reward_credits)
    assert.equal(Number(seed![2]), DEFAULT_BOE_CREDIT_SETTINGS.credit_value)
  })

  test("the migration's own post-condition asserts the same pair", () => {
    const sql = read(MIGRATION)
    assert.match(sql, /v_reward is distinct from 100 or v_value is distinct from 1\.00/)
  })
})

describe('the parser', () => {
  test('accepts the defaults', () => {
    const r = parseBoeCreditSettings(DEFAULT_BOE_CREDIT_SETTINGS)
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.settings, DEFAULT_BOE_CREDIT_SETTINGS)
  })

  test('accepts numeric strings, as a form and PostgREST both produce', () => {
    const r = parseBoeCreditSettings({ review_reward_credits: '150', credit_value: '2.50' })
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.settings, { review_reward_credits: 150, credit_value: 2.5 })
  })

  test('the reward must be a whole positive number of credits', () => {
    for (const bad of [0, -1, 1.5, 'abc', null, MAX_REVIEW_REWARD_CREDITS + 1]) {
      const r = parseBoeCreditSettings({ review_reward_credits: bad, credit_value: 1 })
      assert.equal(r.ok, false, `reward ${String(bad)} must be refused`)
      assert.ok(!r.ok && r.issues.some(i => i.key === 'review_reward_credits'))
    }
  })

  test('the credit value may be zero, never negative, and is rupees and paise', () => {
    assert.ok(parseBoeCreditSettings({ review_reward_credits: 100, credit_value: 0 }).ok)
    assert.ok(parseBoeCreditSettings({ review_reward_credits: 100, credit_value: 0.5 }).ok)
    const neg = parseBoeCreditSettings({ review_reward_credits: 100, credit_value: -1 })
    assert.equal(neg.ok, false)
    const paise = parseBoeCreditSettings({ review_reward_credits: 100, credit_value: 1.005 })
    assert.equal(paise.ok, false)
  })

  test('every problem is reported at once', () => {
    const r = parseBoeCreditSettings({ review_reward_credits: 0, credit_value: -1 })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.issues.length, 2)
  })
})
