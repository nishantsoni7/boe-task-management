/**
 * The review credits behind a payslip month — what the month's approved reviews
 * earned, shown next to the credits the employee applied.
 *
 * Two layers: the pure builder (totals, ordering, reversals, the IST day) and the
 * reader, driven through a fake that APPLIES eq/in filters, so a wrong column or a
 * wrong month key fails here instead of quietly returning nothing in production.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/reviewCredits.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPayslipReviewCredits,
  reviewMonthNote,
  withLiveSpendable,
  type ReviewCreditInputs,
} from './reviewCredits'
import { fetchPayslipReviewCredits } from './reviewCreditsStore'

// ─── The pure builder ─────────────────────────────────────────────────────────

const reward = (n: number, submitted_at: string) => ({
  transaction_id: `tx-${n}`, card_id: `card-${n}`, card_ref: `CR-00000${n}`, submitted_at,
})

/** Jasvi's October: three text reviews and one image review. */
function october(over: Partial<ReviewCreditInputs> = {}): ReviewCreditInputs {
  return {
    reviewMonth: '2026-10-01',
    rewards: [
      reward(1, '2026-10-05T06:00:00Z'),
      reward(2, '2026-10-12T06:00:00Z'),
      reward(3, '2026-10-19T06:00:00Z'),
      reward(4, '2026-10-27T06:00:00Z'),
    ],
    ledger: new Map([['tx-1', { credits: 1 }], ['tx-2', { credits: 1 }], ['tx-3', { credits: 1 }], ['tx-4', { credits: 1.5 }]]),
    reversedIds: new Set<string>(),
    reviewTypes: new Map([['card-1', 'text'], ['card-2', 'text'], ['card-3', 'text'], ['card-4', 'image']]) as ReviewCreditInputs['reviewTypes'],
    month: { status: 'qualified', qualifying_review_count: 4, minimum_reviews_snapshot: 3 },
    creditValue: 50,
    balance: { spendable_credits: 3, provisional_credits: 0 },
    ...over,
  }
}

describe('buildPayslipReviewCredits', () => {
  test('four approved reviews: each listed with its own credit, totals add up', () => {
    const b = buildPayslipReviewCredits(october())!
    assert.equal(b.reviews.length, 4)
    assert.deepEqual(b.reviews.map(r => r.credits), [1, 1, 1, 1.5])
    assert.deepEqual(b.reviews.map(r => r.review_type), ['text', 'text', 'text', 'image'])
    assert.equal(b.earned_credits, 4.5)
    assert.equal(b.earned_amount, 225)
    assert.equal(b.spendable_credits, 3)
  })

  test('the block carries no copy of the application: it would go stale when the employee applies', () => {
    const b = buildPayslipReviewCredits(october())! as unknown as Record<string, unknown>
    assert.ok(!('applied_credits' in b) && !('applied_amount' in b))
  })

  test('the earned total is the sum of the rows shown, never a separate figure', () => {
    const b = buildPayslipReviewCredits(october())!
    assert.equal(b.earned_credits, b.reviews.reduce((t, r) => t + r.credits, 0))
  })

  test('rows are oldest first whatever order they were read in', () => {
    const i = october()
    i.rewards = [...i.rewards].reverse()
    const b = buildPayslipReviewCredits(i)!
    assert.deepEqual(b.reviews.map(r => r.card_ref), ['CR-000001', 'CR-000002', 'CR-000003', 'CR-000004'])
  })

  test('a reversed credit is shown but not counted', () => {
    const b = buildPayslipReviewCredits(october({ reversedIds: new Set(['tx-4']) }))!
    assert.equal(b.reviews.length, 4)
    assert.equal(b.reviews.find(r => r.transaction_id === 'tx-4')!.reversed, true)
    assert.equal(b.earned_credits, 3)
    assert.equal(b.earned_amount, 150)
  })

  test('hundredths are summed without float noise (0.1 + 0.2 is 0.3)', () => {
    const b = buildPayslipReviewCredits(october({
      rewards: [reward(1, '2026-10-05T06:00:00Z'), reward(2, '2026-10-06T06:00:00Z')],
      ledger: new Map([['tx-1', { credits: 0.1 }], ['tx-2', { credits: 0.2 }]]),
    }))!
    assert.equal(b.earned_credits, 0.3)
  })

  test('no review credit in the month: no block at all', () => {
    assert.equal(buildPayslipReviewCredits(october({ rewards: [] })), null)
  })

  test('a reward whose ledger row is missing is left out, not guessed', () => {
    const b = buildPayslipReviewCredits(october({ ledger: new Map([['tx-1', { credits: 1 }]]) }))!
    assert.equal(b.reviews.length, 1)
    assert.equal(b.earned_credits, 1)
  })

  test('the day is the Asia/Kolkata day: 19:00 UTC on 31 Oct is already 1 Nov in India', () => {
    const b = buildPayslipReviewCredits(october({
      rewards: [reward(1, '2026-10-31T19:00:00Z')],
      ledger: new Map([['tx-1', { credits: 1 }]]),
    }))!
    assert.equal(b.reviews[0].submitted_on, '2026-11-01')
  })

  test('a review that is not a custom submission has no type', () => {
    const b = buildPayslipReviewCredits(october({ reviewTypes: new Map() }))!
    assert.ok(b.reviews.every(r => r.review_type === null))
  })
})

describe('withLiveSpendable', () => {
  const block = () => buildPayslipReviewCredits(october())!

  test("the employee's page figure replaces the one the payslip loaded with", () => {
    // They applied 1.5 credits after the payslip loaded: the balance went 3 → 1.5.
    assert.equal(withLiveSpendable(block(), 1.5).spendable_credits, 1.5)
  })

  test('a live balance of zero is a balance, not "missing"', () => {
    assert.equal(withLiveSpendable(block(), 0).spendable_credits, 0)
  })

  test('the admin has no live figure: the loaded one stands', () => {
    assert.equal(withLiveSpendable(block(), undefined).spendable_credits, 3)
    assert.equal(withLiveSpendable(block(), null).spendable_credits, 3)
  })

  test('it never changes the reviews or what they earned', () => {
    const before = block()
    const after = withLiveSpendable(before, 1.5)
    assert.deepEqual(after.reviews, before.reviews)
    assert.equal(after.earned_credits, before.earned_credits)
  })
})

describe('reviewMonthNote', () => {
  const base = { review_month: '2026-10-01' }
  test('open: how far the month is from its target', () => {
    const n = reviewMonthNote({ ...base, month: { status: 'open', qualifying_review_count: 2, minimum_reviews: 3 } })!
    assert.equal(n.tone, 'pending')
    assert.match(n.text, /2 of 3 reviews approved so far/)
    assert.match(n.text, /October reaches 3/)
  })
  test('qualified', () => {
    const n = reviewMonthNote({ ...base, month: { status: 'qualified', qualifying_review_count: 4, minimum_reviews: 3 } })!
    assert.equal(n.tone, 'ok')
    assert.match(n.text, /October's target of 3 reviews was reached/)
  })
  test('lapsed says the credits cannot be applied', () => {
    const n = reviewMonthNote({ ...base, month: { status: 'lapsed', qualifying_review_count: 1, minimum_reviews: 3 } })!
    assert.equal(n.tone, 'lapsed')
    assert.match(n.text, /lapsed and cannot be applied/)
  })
  test('a target of one review reads in the singular', () => {
    const n = reviewMonthNote({ ...base, month: { status: 'qualified', qualifying_review_count: 1, minimum_reviews: 1 } })!
    assert.match(n.text, /target of 1 review was reached/)
  })
  test('a month with no record: no sentence', () => {
    assert.equal(reviewMonthNote({ ...base, month: null }), null)
  })
})

// ─── The reader ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/** A Supabase fake that applies eq/in for real and records which tables were read. */
function fakeSvc(tables: Record<string, Row[]>, errors: Record<string, string> = {}) {
  const reads: string[] = []
  return {
    reads,
    from(table: string) {
      reads.push(table)
      let rows = [...(tables[table] ?? [])]
      const builder = {
        select() { return builder },
        eq(col: string, val: unknown) { rows = rows.filter(r => r[col] === val); return builder },
        in(col: string, vals: unknown[]) { rows = rows.filter(r => vals.includes(r[col])); return builder },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: errors[table] ? { message: errors[table] } : null }) },
        then(resolve: (v: { data: Row[]; error: { message: string } | null }) => unknown) {
          return Promise.resolve({ data: rows, error: errors[table] ? { message: errors[table] } : null }).then(resolve)
        },
      }
      return builder
    },
  }
}

const EMP = 'emp-1'
const tables = (): Record<string, Row[]> => ({
  boe_credit_review_rewards: [
    { employee_id: EMP, review_month: '2026-10-01', transaction_id: 'tx-1', card_id: 'card-1', card_ref: 'CR-000001', submitted_at: '2026-10-05T06:00:00Z' },
    { employee_id: EMP, review_month: '2026-10-01', transaction_id: 'tx-2', card_id: 'card-2', card_ref: 'CR-000002', submitted_at: '2026-10-12T06:00:00Z' },
    // Another month, and another employee: neither may leak in.
    { employee_id: EMP, review_month: '2026-09-01', transaction_id: 'tx-9', card_id: 'card-9', card_ref: 'CR-000009', submitted_at: '2026-09-12T06:00:00Z' },
    { employee_id: 'someone-else', review_month: '2026-10-01', transaction_id: 'tx-8', card_id: 'card-8', card_ref: 'CR-000008', submitted_at: '2026-10-12T06:00:00Z' },
  ],
  boe_credit_transactions: [
    { id: 'tx-1', credits: '1.00', transaction_type: 'review_reward', source_id: 'card-1' },
    { id: 'tx-2', credits: '1.50', transaction_type: 'review_reward', source_id: 'card-2' },
    { id: 'rev-2', credits: '-1.50', transaction_type: 'reversal', source_id: 'tx-2' },
  ],
  customer_review_custom_submissions: [
    { id: 'card-1', review_type: 'text' },
    { id: 'card-2', review_type: 'image' },
  ],
  boe_credit_review_months: [
    { employee_id: EMP, review_month: '2026-10-01', status: 'qualified', qualifying_review_count: 1, minimum_reviews_snapshot: 3 },
  ],
  boe_credit_balances: [
    { employee_id: EMP, available_credits: 4, provisional_credits: 0, spendable_credits: 4, transaction_count: 3, last_transaction_at: null },
  ],
})

const INPUT = { employeeId: EMP, month: 10, year: 2026, creditValue: 50 }

describe('fetchPayslipReviewCredits', () => {
  test("reads only that employee's reviews of that month, with types, reversals, month and balance", async () => {
    const b = (await fetchPayslipReviewCredits(fakeSvc(tables()), INPUT))!
    assert.equal(b.review_month, '2026-10-01')
    assert.deepEqual(b.reviews.map(r => [r.card_ref, r.review_type, r.credits, r.reversed]), [
      ['CR-000001', 'text', 1, false],
      ['CR-000002', 'image', 1.5, true],
    ])
    assert.equal(b.earned_credits, 1)
    assert.equal(b.spendable_credits, 4)
    assert.equal(b.month?.status, 'qualified')
  })

  test('the payroll month is keyed as the first of that month (single-digit months are padded)', async () => {
    const t = tables()
    t.boe_credit_review_rewards = [
      { employee_id: EMP, review_month: '2026-03-01', transaction_id: 'tx-1', card_id: 'card-1', card_ref: 'CR-000001', submitted_at: '2026-03-05T06:00:00Z' },
    ]
    const b = await fetchPayslipReviewCredits(fakeSvc(t), { ...INPUT, month: 3 })
    assert.equal(b?.review_month, '2026-03-01')
  })

  test('no reviews that month: null, and nothing else is read', async () => {
    const svc = fakeSvc({ ...tables(), boe_credit_review_rewards: [] })
    assert.equal(await fetchPayslipReviewCredits(svc, INPUT), null)
    assert.deepEqual(svc.reads, ['boe_credit_review_rewards'])
  })

  test('a read error throws, so the payload builder can drop the card rather than the payslip', async () => {
    await assert.rejects(
      fetchPayslipReviewCredits(fakeSvc(tables(), { boe_credit_review_months: 'boom' }), INPUT),
      /Could not read the review month: boom/,
    )
    await assert.rejects(
      fetchPayslipReviewCredits(fakeSvc(tables(), { boe_credit_review_rewards: 'boom' }), INPUT),
      /Could not read the review rewards: boom/,
    )
  })
})
