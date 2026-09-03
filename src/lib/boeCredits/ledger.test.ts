/**
 * BOE Credits — the pure ledger rules.
 *
 * The database derives the balance; these functions restate the arithmetic for
 * screens and must agree with it. The signed-sum rule is the one Phase 1A
 * promised: +100 +100 −50 = 150.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/ledger.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  sumCredits,
  formatCredits,
  creditTransactionLabel,
  creditTransactionTone,
  sortNewestFirst,
  creditAmountIssue,
  creditReasonIssue,
} from './ledger'
import { CREDIT_TRANSACTION_TYPES, isCreditTransactionType } from './types'
import { describeCreditTransaction, withRunningBalance, reviewMonthLabel, REWARD_STATUS_LABELS } from './ledger'

describe('ledger math', () => {
  test('+100 +100 −50 = 150', () => {
    assert.equal(sumCredits([{ credits: 100 }, { credits: 100 }, { credits: -50 }]), 150)
  })

  test('an empty ledger is zero, not undefined', () => {
    assert.equal(sumCredits([]), 0)
  })

  test('a reversal brings the original back to nothing, with both rows still present', () => {
    const rows = [{ credits: 100 }, { credits: -100 }]
    assert.equal(sumCredits(rows), 0)
    assert.equal(rows.length, 2, 'the original is not removed — it is compensated')
  })

  test('adjustments are signed and sum like everything else', () => {
    assert.equal(sumCredits([{ credits: 100 }, { credits: -30 }, { credits: 5 }]), 75)
  })
})

describe('the five kinds', () => {
  test('exactly review_reward, redemption, reversal, admin_adjustment and review_month_lapse', () => {
    assert.deepEqual([...CREDIT_TRANSACTION_TYPES], ['review_reward', 'redemption', 'reversal', 'admin_adjustment', 'review_month_lapse'])
    for (const t of CREDIT_TRANSACTION_TYPES) assert.ok(isCreditTransactionType(t))
    assert.equal(isCreditTransactionType('bonus'), false)
    assert.equal(isCreditTransactionType(null), false)
  })

  test('every kind has a label and a tone', () => {
    for (const t of CREDIT_TRANSACTION_TYPES) {
      assert.ok(creditTransactionLabel(t).length > 0)
      assert.ok(creditTransactionTone({ transaction_type: t, credits: 1 }).dot.startsWith('#'))
    }
  })

  test('a negative adjustment reads as a deduction, a positive one as an award', () => {
    const minus = creditTransactionTone({ transaction_type: 'admin_adjustment', credits: -10 })
    const plus  = creditTransactionTone({ transaction_type: 'admin_adjustment', credits: 10 })
    assert.notEqual(minus.dot, plus.dot)
  })
})

describe('formatting — credits, never rupees', () => {
  test('plural, singular, negative, signed', () => {
    assert.equal(formatCredits(350), '350 credits')
    assert.equal(formatCredits(1), '1 credit')
    assert.equal(formatCredits(0), '0 credits')
    assert.equal(formatCredits(-50), '−50 credits')
    assert.equal(formatCredits(100, { signed: true }), '+100 credits')
    assert.equal(formatCredits(-1, { signed: true }), '−1 credit')
  })

  test('no currency symbol ever appears', () => {
    for (const n of [0, 1, 99, 1000, -1000]) {
      assert.equal(/₹|Rs|INR/.test(formatCredits(n)), false)
    }
  })
})

describe('ordering', () => {
  test('newest first, ties broken by id, input untouched', () => {
    const rows = [
      { id: 'a', created_at: '2026-09-01T10:00:00Z' },
      { id: 'c', created_at: '2026-09-02T10:00:00Z' },
      { id: 'b', created_at: '2026-09-02T10:00:00Z' },
    ]
    const sorted = sortNewestFirst(rows)
    assert.deepEqual(sorted.map(r => r.id), ['c', 'b', 'a'])
    assert.deepEqual(rows.map(r => r.id), ['a', 'c', 'b'])
  })
})

describe('validation the form and the route share', () => {
  test('a zero-credit transaction is rejected', () => {
    assert.ok(creditAmountIssue(0))
    assert.ok(creditAmountIssue('0'))
  })

  test('fractions, NaN, blanks and absurd sizes are rejected; signed whole numbers pass', () => {
    assert.ok(creditAmountIssue(1.5))
    assert.ok(creditAmountIssue('abc'))
    assert.ok(creditAmountIssue(''))
    assert.ok(creditAmountIssue(null))
    assert.ok(creditAmountIssue(10_000_000))
    assert.equal(creditAmountIssue(100), null)
    assert.equal(creditAmountIssue(-25), null)
    assert.equal(creditAmountIssue(' -25 '), null)
  })

  test('a reason is mandatory, trimmed, and bounded', () => {
    assert.ok(creditReasonIssue(''))
    assert.ok(creditReasonIssue('   '))
    assert.ok(creditReasonIssue(undefined))
    assert.ok(creditReasonIssue('x'.repeat(501)))
    assert.equal(creditReasonIssue('Missed reward for August review'), null)
  })
})


// ─── Phase 1D: sentences, the running balance, the month label ───────────────

describe('describeCreditTransaction', () => {
  const base = { credits: 1, description: 'Review verified · TEST-001' } as const

  test('a review reward names its month and whether it can be spent yet', () => {
    const pending = describeCreditTransaction({ ...base, transaction_type: 'review_reward' }, { kind: 'review_reward', card_ref: 'TEST-001', review_month: '2026-09-01', month_status: 'open', reversed: false })
    assert.equal(pending.title, 'Review verified · September')
    assert.equal(pending.status, 'pending')
    assert.equal(REWARD_STATUS_LABELS.pending, 'Pending monthly target')
    const available = describeCreditTransaction({ ...base, transaction_type: 'review_reward' }, { kind: 'review_reward', card_ref: 'TEST-001', review_month: '2026-09-01', month_status: 'qualified', reversed: false })
    assert.equal(available.status, 'available')
    const lapsed = describeCreditTransaction({ ...base, transaction_type: 'review_reward' }, { kind: 'review_reward', card_ref: null, review_month: '2026-07-01', month_status: 'lapsed', reversed: false })
    assert.equal(lapsed.status, 'lapsed')
    const reversed = describeCreditTransaction({ ...base, transaction_type: 'review_reward' }, { kind: 'review_reward', card_ref: null, review_month: '2026-07-01', month_status: 'open', reversed: true })
    assert.equal(reversed.status, 'reversed')
  })

  test('a redemption says which day or which payroll month, in words', () => {
    const half = describeCreditTransaction({ transaction_type: 'redemption', credits: -8, description: null }, { kind: 'attendance_redemption', deduction_type: 'half_day', attendance_date: '2026-08-12', reversed: false })
    assert.equal(half.title, 'Half Day covered')
    assert.equal(half.detail, '12 Aug 2026')
    const full = describeCreditTransaction({ transaction_type: 'redemption', credits: -15, description: null }, { kind: 'attendance_redemption', deduction_type: 'absent', attendance_date: '2026-08-13', reversed: false })
    assert.equal(full.title, 'Full Day covered')
    const pay = describeCreditTransaction({ transaction_type: 'redemption', credits: -5, description: null }, { kind: 'payroll_redemption', payroll_month: 9, payroll_year: 2026, credit_amount: 500, reversed: false })
    assert.equal(pay.title, 'Applied to September 2026 payroll')
    assert.match(pay.detail ?? '', /₹500/)
  })

  test('a reversal is described by what it undid; a lapse by its month', () => {
    const r = describeCreditTransaction({ transaction_type: 'reversal', credits: 5, description: 'changed' }, { kind: 'reversal_of', original_type: 'redemption', original: { kind: 'payroll_redemption', payroll_month: 9, payroll_year: 2026, credit_amount: 500, reversed: true } })
    assert.equal(r.title, 'Payroll credit application reversed')
    const restored = describeCreditTransaction({ transaction_type: 'reversal', credits: 8, description: null }, { kind: 'reversal_of', original_type: 'redemption', original: { kind: 'attendance_redemption', deduction_type: 'half_day', attendance_date: '2026-08-12', reversed: true } })
    assert.equal(restored.title, 'Credits restored')
    const lapse = describeCreditTransaction({ transaction_type: 'review_month_lapse', credits: -2, description: null }, { kind: 'review_month_lapse', review_month: '2026-09-01' })
    assert.equal(lapse.title, 'September review credits lapsed')
  })

  test('no database code reaches a title', () => {
    for (const t of CREDIT_TRANSACTION_TYPES) {
      const d = describeCreditTransaction({ transaction_type: t, credits: t === 'redemption' || t === 'review_month_lapse' ? -1 : 1, description: null }, { kind: 'none' })
      assert.doesNotMatch(d.title, /_/, t)
    }
  })
})

describe('withRunningBalance', () => {
  test('walks newest-first from the recorded total, so a capped page is still exact', () => {
    const rows = withRunningBalance([{ credits: -5 }, { credits: 1 }, { credits: 17 }], 13)
    assert.deepEqual(rows.map(r => r.balance_after), [13, 18, 17])
  })
})

describe('reviewMonthLabel', () => {
  test('"September 2026", or the name alone', () => {
    assert.equal(reviewMonthLabel('2026-09-01'), 'September 2026')
    assert.equal(reviewMonthLabel('2026-09-01', { year: false }), 'September')
  })
})
