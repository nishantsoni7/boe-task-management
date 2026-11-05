/**
 * The review credits card on a payslip — what a reader is shown.
 *
 * The card is a pure function of its block, so it is rendered to static markup
 * and read as text: each review with its credit, the totals, the month's target
 * sentence, and the one line only the admin gets.
 *
 * Run:
 *   npx tsx --test src/components/payroll/ReviewCreditsCard.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReviewCreditsCard } from './ReviewCreditsCard'
import type { PayslipReviewCreditsBlock } from '@/lib/payroll/reviewCredits'

// What a reader sees: markup stripped, and the entity React writes for an apostrophe decoded.
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()

const BLOCK: PayslipReviewCreditsBlock = {
  review_month: '2026-10-01',
  reviews: [
    { transaction_id: 'a', card_ref: 'CR-000001', submitted_on: '2026-10-05', review_type: 'text',  credits: 1,   reversed: false },
    { transaction_id: 'b', card_ref: 'CR-000002', submitted_on: '2026-10-12', review_type: 'text',  credits: 1,   reversed: false },
    { transaction_id: 'c', card_ref: 'CR-000003', submitted_on: '2026-10-19', review_type: 'text',  credits: 1,   reversed: false },
    { transaction_id: 'd', card_ref: 'CR-000004', submitted_on: '2026-10-27', review_type: 'image', credits: 1.5, reversed: false },
  ],
  earned_credits: 4.5,
  earned_amount: 225,
  credit_value: 50,
  month: { status: 'qualified', qualifying_review_count: 4, minimum_reviews: 3 },
  spendable_credits: 3,
  provisional_credits: 0,
}

/** What the settlement says is on this month: Jasvi applied 1.5 credits = ₹75. */
const APPLIED = { credits_used: 1.5, amount: 75 }

describe('ReviewCreditsCard', () => {
  const html = renderToStaticMarkup(<ReviewCreditsCard credits={BLOCK} isAdmin applied={APPLIED} />)
  const t = text(html)

  test('titles the card with the month', () => {
    assert.match(t, /BOE Credits · October reviews/)
  })

  test('lists every review with its reference, kind, day and credit', () => {
    for (const ref of ['CR-000001', 'CR-000002', 'CR-000003', 'CR-000004']) assert.ok(t.includes(ref), ref)
    assert.equal((t.match(/Text review/g) ?? []).length, 3)
    assert.equal((t.match(/Image review/g) ?? []).length, 1)
    assert.ok(t.includes('5 Oct') && t.includes('27 Oct'))
    assert.ok(t.includes('+1.5 credits'))
    assert.equal((t.match(/\+1 credit\b/g) ?? []).length, 3)
  })

  test('shows earned, applied and spendable, with the rupees at the rate', () => {
    assert.match(t, /Earned from October reviews 4\.5 credits/)
    assert.match(t, /Worth ₹225 at ₹50 a credit/)
    assert.match(t, /Applied to this salary 1\.5 credits/)
    assert.match(t, /₹75 added as the BOE Credit Addition/)
    assert.match(t, /Spendable now 3 credits/)
  })

  test("says where the month stands against its target", () => {
    assert.match(t, /October's target of 3 reviews was reached/)
  })

  test('nothing applied reads "None", with no rupee line', () => {
    const t2 = text(renderToStaticMarkup(<ReviewCreditsCard credits={BLOCK} isAdmin={false} applied={null} />))
    assert.match(t2, /Applied to this salary None/)
    assert.ok(!t2.includes('added as the BOE Credit Addition'))
  })

  test('"Applied" follows the settlement it is given, so Apply, Change and Remove show at once', () => {
    // The employee page keeps settlement.credits current after each of these.
    const render = (applied: { credits_used: number; amount: number } | null) =>
      text(renderToStaticMarkup(<ReviewCreditsCard credits={BLOCK} isAdmin={false} applied={applied} />))
    assert.match(render({ credits_used: 1, amount: 50 }), /Applied to this salary 1 credit ₹50 added/)
    assert.match(render({ credits_used: 3, amount: 150 }), /Applied to this salary 3 credits ₹150 added/)
    assert.match(render(null), /Applied to this salary None/)
  })

  test('only the admin is told that credits are applied by the employee', () => {
    assert.match(t, /only when the employee applies them from their own payslip/)
    const t2 = text(renderToStaticMarkup(<ReviewCreditsCard credits={BLOCK} isAdmin={false} applied={APPLIED} />))
    assert.ok(!t2.includes('only when the employee applies'))
  })

  test('a reversed credit is marked and struck through', () => {
    const reversed = { ...BLOCK, reviews: BLOCK.reviews.map(r => (r.transaction_id === 'd' ? { ...r, reversed: true } : r)), earned_credits: 3, earned_amount: 150 }
    const h = renderToStaticMarkup(<ReviewCreditsCard credits={reversed} isAdmin applied={APPLIED} />)
    assert.match(text(h), /Reversed/)
    assert.match(h, /line-through/)
    assert.match(text(h), /Earned from October reviews 3 credits/)
  })

  test('a month below target explains why the credits cannot be applied yet', () => {
    const open = { ...BLOCK, month: { status: 'open' as const, qualifying_review_count: 2, minimum_reviews: 3 } }
    assert.match(text(renderToStaticMarkup(<ReviewCreditsCard credits={open} isAdmin applied={APPLIED} />)), /2 of 3 reviews approved so far/)
  })

  test('a review that is not a custom submission is just "Review"', () => {
    const generic = { ...BLOCK, reviews: [{ ...BLOCK.reviews[0], review_type: null }] }
    const t2 = text(renderToStaticMarkup(<ReviewCreditsCard credits={generic} isAdmin applied={APPLIED} />))
    assert.ok(!t2.includes('Text review') && !t2.includes('Image review'))
    assert.match(t2, / Review /)
  })
})
