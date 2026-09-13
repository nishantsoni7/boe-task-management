/**
 * BOE Credits — decimal credits (20261204000000).
 *
 * An image review may earn ₹75 = 1.5 credits. Before this, every credit amount
 * was `integer` in the schema AND in the PL/pgSQL variables that carried it, so
 * a 1.5 did not fail — it ROUNDED (an integer variable assigned 1.5 holds 2),
 * and a 7.5 spendable balance read as 8 would have admitted an 8-credit
 * redemption. These tests pin the numeric shape at both ends: the migration,
 * and the arithmetic and formatting the screens use.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/decimalCredits.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  creditAmountIssue,
  describeCreditTransaction,
  formatCreditNumber,
  formatCredits,
  hasCreditPrecision,
  roundCredits,
  sumCredits,
  withRunningBalance,
} from './ledger'
import { DEFAULT_BOE_CREDIT_SETTINGS as D, parseBoeCreditSettings, rewardForReviewType, sameBoeCreditSettings } from './settings'
import { creditsWord } from './attendanceRedemption'
import { verifiedNotice } from '@/app/customer-reviews/MyReviewsScreen'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20261204000000_boe_credits_decimal_credits.sql')
/** Executable SQL only: the header describes the integer shapes it removes. */
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** One `create or replace function public.<name>(` statement, to its closing `$$;`. */
function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start !== -1, `${name} is not re-created`)
  const body = code.indexOf('$$', start)
  const end = code.indexOf('$$;', body + 2)
  return code.slice(start, end)
}

// ── 10. 1.5 credits can be configured and stored ────────────────────────────

describe('10. a 1.5-credit review reward can be configured', () => {
  test('the settings parser accepts 1.5 for either review reward, exactly', () => {
    const r = parseBoeCreditSettings({ ...D, image_review_reward_credits: 1.5, review_reward_credits: '1' })
    assert.ok(r.ok)
    assert.equal(r.ok && r.settings.image_review_reward_credits, 1.5)
    assert.equal(r.ok && rewardForReviewType(r.settings, 'image'), 1.5)
    assert.equal(r.ok && rewardForReviewType(r.settings, 'text'), 1)
  })

  test('a third decimal place is refused rather than rounded', () => {
    assert.equal(parseBoeCreditSettings({ ...D, image_review_reward_credits: 1.555 }).ok, false)
  })

  test('a change from 1 to 1.5 is a change, so the Save button is not silently disabled', () => {
    // The defaults already carry 1.5 (the Custom Review phase), so start from 1.
    assert.equal(sameBoeCreditSettings({ ...D, image_review_reward_credits: 1 }, { ...D, image_review_reward_credits: 1.5 }), false)
  })

  test('the attendance prices and the monthly minimum are still whole numbers', () => {
    for (const key of ['half_day_redemption_credits', 'full_day_redemption_credits', 'minimum_monthly_reviews'] as const) {
      // Both redemptions switched ON: a switched-off price is not validated.
      assert.equal(parseBoeCreditSettings({ ...D, half_day_redemption_enabled: true, full_day_redemption_enabled: true, [key]: 1.5 }).ok, false, key)
    }
  })

  test('the settings columns are numeric(12,2) in the database', () => {
    assert.match(code, /alter column review_reward_credits type numeric\(12,2\) using review_reward_credits::numeric\(12,2\)/)
    assert.match(code, /alter column image_review_reward_credits type numeric\(12,2\) using image_review_reward_credits::numeric\(12,2\)/)
  })
})

// ── 11. A 1.5 transaction stays exactly 1.5 ─────────────────────────────────

describe('11. a 1.5-credit ledger row is stored as 1.5', () => {
  test('the ledger column is numeric(12,2), converted exactly', () => {
    assert.match(code, /alter table public\.boe_credit_transactions\s+alter column credits type numeric\(12,2\) using credits::numeric\(12,2\)/)
  })

  test('the one write path takes a numeric amount; the integer signature is gone', () => {
    assert.match(code, /drop function if exists public\.post_boe_credit_transaction\(uuid, text, integer, text, uuid, text, uuid, uuid\)/)
    const post = fn('post_boe_credit_transaction')
    assert.match(post, /p_credits\s+numeric,/)
    assert.match(code, /grant  execute on function public\.post_boe_credit_transaction\(uuid, text, numeric, text, uuid, text, uuid, uuid\)\s*\n\s*to service_role/)
  })

  test('a third decimal place is REFUSED by the database, never rounded by the column', () => {
    assert.match(fn('post_boe_credit_transaction'), /if p_credits <> round\(p_credits, 2\) then\s*\n\s*raise exception 'BOE_CREDITS_PRECISION/)
    assert.match(fn('apply_boe_credits_to_payroll'), /if p_credits <> round\(p_credits, 2\) then/)
  })

  test('the form and the route agree: 1.5 passes, 1.555 does not', () => {
    assert.equal(creditAmountIssue(1.5), null)
    assert.equal(creditAmountIssue('1.5'), null)
    assert.ok(creditAmountIssue(1.555))
    assert.equal(hasCreditPrecision(2.5), true)
    assert.equal(hasCreditPrecision(0.105), false)
  })

  test('the review reward is priced as numeric — 1.5 is posted as 1.5, not 2', () => {
    const reward = fn('post_boe_credit_review_reward')
    assert.match(reward, /v_credits\s+numeric;/)
    assert.equal(/v_credits\s+integer/.test(reward), false)
  })
})

// ── 12. The balance preserves the decimal ───────────────────────────────────

describe('12. balances keep every hundredth', () => {
  test('sums are exact, including the float cases that are not', () => {
    assert.equal(sumCredits([{ credits: 1.5 }, { credits: 1 }, { credits: -0.5 }]), 2)
    assert.equal(sumCredits([{ credits: 0.1 }, { credits: 0.2 }]), 0.3)
    assert.equal(sumCredits([{ credits: 1.5 }, { credits: 1.5 }, { credits: 1.5 }]), 4.5)
  })

  test('the running balance walks back through decimals without drift', () => {
    const rows = withRunningBalance([{ credits: -0.1 }, { credits: 1.5 }, { credits: 0.2 }], 1.6)
    assert.deepEqual(rows.map(r => r.balance_after), [1.6, 1.7, 0.2])
  })

  test('the three balance functions return numeric and the view casts nothing to integer', () => {
    for (const name of ['boe_credit_balance', 'boe_credit_provisional_credits', 'boe_credit_spendable_balance']) {
      assert.match(fn(name), /returns numeric/, name)
    }
    const view = code.slice(code.indexOf('create view public.boe_credit_balances'), code.indexOf('group by employee_id;'))
    assert.equal(/credits[^\n]*::integer/.test(view), false, 'a credit figure is still cast to integer')
    assert.match(view, /::numeric\(12,2\)\s+as spendable_credits/)
  })

  test('the spendable-balance check compares as numeric, so 7.5 cannot pass for 8', () => {
    const post = fn('post_boe_credit_transaction')
    assert.match(post, /v_balance\s+numeric;/)
    assert.match(post, /v_balance := public\.boe_credit_spendable_balance\(p_employee_id\);\s*\n\s*if v_balance \+ p_credits < 0 then/)
  })

  test("a month's earned credits are summed as numeric", () => {
    const refresh = fn('refresh_boe_credit_review_month')
    assert.match(refresh, /v_credits numeric;/)
    assert.equal(/sum\(t\.credits\), 0\)::integer/.test(refresh), false)
    assert.match(code, /alter column earned_review_credits type numeric\(12,2\)/)
  })
})

// ── 13. Existing whole-number records keep working ──────────────────────────

describe('13. whole-number credits are unchanged', () => {
  test('the Phase 1A arithmetic still holds', () => {
    assert.equal(sumCredits([{ credits: 100 }, { credits: 100 }, { credits: -50 }]), 150)
    assert.equal(formatCredits(1), '1 credit')
    assert.equal(formatCredits(2), '2 credits')
    assert.equal(formatCredits(-50), '−50 credits')
    assert.equal(formatCredits(100, { signed: true }), '+100 credits')
  })

  test('the migration converts types only: it writes, edits and deletes no ledger row', () => {
    // The one INSERT is inside post_boe_credit_transaction()'s body — the write
    // path itself — and a self-assertion refuses any row created by the apply.
    const inserts = code.match(/insert into public\.boe_credit_transactions/g) ?? []
    assert.equal(inserts.length, 1)
    assert.ok(fn('post_boe_credit_transaction').includes('insert into public.boe_credit_transactions'))
    assert.equal(/update public\.boe_credit_transactions|delete from public\.boe_credit_transactions/.test(code), false)
    assert.match(code, /this migration posted % ledger row\(s\); it must post none/)
  })

  test('every rule the ledger enforced is still there: signs, reversal exactness, spendable check, admin gates', () => {
    const post = fn('post_boe_credit_transaction')
    for (const needle of [
      "BOE_CREDITS_SIGN: a review reward earns credits",
      "BOE_CREDITS_SIGN: a redemption spends credits",
      "BOE_CREDITS_REVERSAL: a reversal must negate the original amount exactly",
      "BOE_CREDITS_DUPLICATE_SOURCE",
      "BOE_CREDITS_INSUFFICIENT",
      "BOE_CREDITS_DENIED: only an administrator can post a reversal",
      "perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));",
    ]) {
      assert.ok(post.includes(needle), needle)
    }
  })

  test('the payroll application function keeps its lock rules and snapshot', () => {
    const apply = fn('apply_boe_credits_to_payroll')
    assert.ok(apply.includes('BOE_CREDITS_PERIOD_LOCKED'))
    assert.ok(apply.includes('v_amount := round(p_credits * v_settings.credit_value, 2);'))
    assert.match(code, /drop function if exists public\.apply_boe_credits_to_payroll\(uuid, uuid, integer, uuid\)/)
  })
})

// ── 14. Attendance and the reward balance do not truncate 1.5 ───────────────

describe('14. attendance redemption and payroll read decimal balances', () => {
  test('the redemption and its reversal report the balance as numeric', () => {
    assert.match(fn('redeem_boe_credits_for_attendance'), /v_balance\s+numeric;/)
    assert.match(fn('reverse_boe_credit_attendance_redemption'), /v_balance numeric;/)
    // The PRICE is still a whole number from the settings.
    assert.match(fn('redeem_boe_credits_for_attendance'), /v_cost\s+integer;/)
  })

  test('a decimal balance minus a whole price reads cleanly', () => {
    assert.equal(creditsWord(8.5 - 8), '0.5 credits')
    assert.equal(creditsWord(9.3 - 8), '1.3 credits')
    assert.equal(creditsWord(1), '1 credit')
    assert.equal(creditsWord(8), '8 credits')
  })

  test('the payroll panel no longer truncates the amount an employee applies', () => {
    const panel = read('src/components/boeCredits/PayrollCreditsPanel.tsx')
    assert.equal(/Math\.trunc/.test(panel), false)
    assert.ok(panel.includes('roundCredits('))
    const route = read('src/app/api/boe-credits/payroll-applications/route.ts')
    assert.equal(/Number\.isInteger\(credits\)/.test(route), false)
    assert.ok(route.includes('hasCreditPrecision(credits)'))
  })

  test('the verification flag carries 1.5 instead of truncating it to 1', () => {
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    assert.equal(/Math\.trunc\(reward\.credits\)/.test(detail), false)
    assert.equal(verifiedNotice('1.5'), 'Review verified · +1.5 credits awarded.')
  })
})

// ── 15. Formatting ──────────────────────────────────────────────────────────

describe('15. decimal credits are formatted naturally', () => {
  test('1.5 reads "1.5 credits" — never "1.50", never rounded to 1 or 2', () => {
    assert.equal(formatCredits(1.5), '1.5 credits')
    assert.equal(formatCredits(2.5), '2.5 credits')
    assert.equal(formatCredits(0.5), '0.5 credits')
    assert.equal(formatCredits(1.25), '1.25 credits')
    assert.equal(formatCredits(1.5, { signed: true }), '+1.5 credits')
    assert.equal(formatCredits(-1.5), '−1.5 credits')
    assert.equal(formatCredits(1.5).includes('1.50'), false)
  })

  test('float noise never reaches a label', () => {
    assert.equal(formatCredits(0.1 + 0.2), '0.3 credits')
    assert.equal(formatCreditNumber(12500.5), '12,500.5')
    assert.equal(roundCredits(1.15 * 3), 3.45)
  })

  test('a custom review reward is described as approved, a generated one as verified', () => {
    const base = { transaction_type: 'review_reward' as const, credits: 1.5, description: null }
    const custom = describeCreditTransaction(base, { kind: 'review_reward', card_ref: 'CR-000001', review_month: '2026-09-01', month_status: 'open', reversed: false, custom: true })
    assert.equal(custom.title, 'Custom review approved · September')
    assert.equal(custom.detail, 'Custom review CR-000001')
    const generated = describeCreditTransaction(base, { kind: 'review_reward', card_ref: 'RW-000001', review_month: '2026-09-01', month_status: 'open', reversed: false })
    assert.equal(generated.title, 'Review verified · September')
  })
})
