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

describe('the four kinds', () => {
  test('exactly review_reward, redemption, reversal and admin_adjustment', () => {
    assert.deepEqual([...CREDIT_TRANSACTION_TYPES], ['review_reward', 'redemption', 'reversal', 'admin_adjustment'])
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
