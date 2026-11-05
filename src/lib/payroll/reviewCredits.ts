// The review credits behind a payslip month — what the month's reviews earned.
//
// WHY THIS EXISTS. The payslip used to show only the credits an employee had
// APPLIED to the month ("BOE Credit Addition", Phase 1D). Every approved review
// posts its own credit to the employee's ledger, but a credit is not salary
// until the employee applies it, so a month with four approved reviews could
// show a single line of ₹75 and nothing to explain the rest. This block is that
// explanation: one row per review, what the month earned, what was applied, and
// what the employee still holds.
//
// DISPLAY ONLY. Nothing here writes anything or changes a salary figure — the
// addition is still the employee's stored application (settlement.ts). The
// numbers are computed once, here, so the screen formats and adds nothing.
//
// WHAT IS APPLIED IS NOT IN THIS BLOCK, ON PURPOSE. The employee can apply,
// change or remove credits on the open payslip, and the page then refreshes its
// `settlement` and `credits` in place, not this block. Carrying a second copy of
// the application here would go stale the moment they pressed Apply, so the card
// reads "applied" from settlement.credits and the live spendable balance from
// credits (withLiveSpendable below), the figures that do move.
//
// A REVIEW BELONGS TO THE MONTH OF ITS SUBMISSION (Asia/Kolkata), the same
// attribution the monthly target uses (boe_credit_review_rewards.review_month),
// so "October's reviews" on the October payslip are exactly the ones that count
// toward October's target.

import { istDateOf } from '@/lib/istDate'
import { reviewMonthLabel, roundCredits, sumCredits } from '@/lib/boeCredits/ledger'
import type { CreditReviewMonthStatus } from '@/lib/boeCredits/types'

export type PayslipReviewType = 'text' | 'image'

/** One approved review and the credit it earned. */
export type PayslipReviewCredit = {
  /** The ledger row, a stable key. */
  transaction_id: string
  /** The human reference, "CR-000123". */
  card_ref: string
  /** The Asia/Kolkata day it was submitted, YYYY-MM-DD. */
  submitted_on: string
  /** Null for a review that is not a Custom Review Submission (the older generated flow). */
  review_type: PayslipReviewType | null
  credits: number
  /** An admin took this credit back. Shown, but not counted. */
  reversed: boolean
}

export type PayslipReviewCreditsBlock = {
  /** The first day of the review month, YYYY-MM-01. */
  review_month: string
  reviews: PayslipReviewCredit[]
  /** Credits the month's reviews earned, reversed ones left out. */
  earned_credits: number
  /** earned_credits × the current rate, to the paisa. Informational. */
  earned_amount: number
  /** Rupees per credit now; the applied figure keeps the rate it was applied at. */
  credit_value: number
  /** The month's target state; null when the month has no record (older rewards). */
  month: {
    status: CreditReviewMonthStatus
    qualifying_review_count: number
    minimum_reviews: number
  } | null
  /** What they hold right now across every month, as of loading the payslip. */
  spendable_credits: number
  /** Credits held back until a month reaches its target. */
  provisional_credits: number
}

export type ReviewCreditInputs = {
  reviewMonth: string
  rewards: { transaction_id: string; card_id: string; card_ref: string; submitted_at: string }[]
  /** The ledger rows of those rewards, by id. */
  ledger: ReadonlyMap<string, { credits: number }>
  /** Ledger ids that a reversal row points at. */
  reversedIds: ReadonlySet<string>
  /** review_type by submission id, for custom submissions. */
  reviewTypes: ReadonlyMap<string, PayslipReviewType>
  month: { status: CreditReviewMonthStatus; qualifying_review_count: number; minimum_reviews_snapshot: number } | null
  creditValue: number
  balance: { spendable_credits: number; provisional_credits: number }
}

/**
 * The block, from rows already read. Null when the month has no review credit
 * at all, so an employee who posted no reviews sees no extra card.
 */
export function buildPayslipReviewCredits(i: ReviewCreditInputs): PayslipReviewCreditsBlock | null {
  const reviews: PayslipReviewCredit[] = []
  for (const r of i.rewards) {
    const row = i.ledger.get(r.transaction_id)
    // A reward without its ledger row cannot be priced; leave it out rather than guess.
    if (!row) continue
    reviews.push({
      transaction_id: r.transaction_id,
      card_ref:       r.card_ref,
      submitted_on:   istDateOf(r.submitted_at),
      review_type:    i.reviewTypes.get(r.card_id) ?? null,
      credits:        roundCredits(row.credits),
      reversed:       i.reversedIds.has(r.transaction_id),
    })
  }
  if (reviews.length === 0) return null

  reviews.sort((a, b) =>
    a.submitted_on !== b.submitted_on ? (a.submitted_on < b.submitted_on ? -1 : 1)
    : a.transaction_id < b.transaction_id ? -1 : 1)

  const earned = sumCredits(reviews.filter(r => !r.reversed))

  return {
    review_month: i.reviewMonth,
    reviews,
    earned_credits: earned,
    earned_amount: Math.round(earned * 100 * i.creditValue) / 100,
    credit_value: i.creditValue,
    month: i.month
      ? {
          status: i.month.status,
          qualifying_review_count: i.month.qualifying_review_count,
          minimum_reviews: i.month.minimum_reviews_snapshot,
        }
      : null,
    spendable_credits:   i.balance.spendable_credits,
    provisional_credits: i.balance.provisional_credits,
  }
}

/**
 * The block with the spendable balance the page holds NOW. The employee's page
 * updates `credits.spendable_credits` after every apply, change or remove; the
 * admin's page has no such figure and keeps the one the payslip loaded with.
 */
export function withLiveSpendable(
  block: PayslipReviewCreditsBlock,
  liveSpendable: number | null | undefined,
): PayslipReviewCreditsBlock {
  return typeof liveSpendable === 'number' ? { ...block, spendable_credits: liveSpendable } : block
}

/**
 * One sentence on where the month stands against its review target, or null
 * when the month has no record. Credits of a month below its target are held
 * back (pending) and, if the month is closed below it, lapse — the reader should
 * not have to infer why earned credits cannot be applied.
 */
export function reviewMonthNote(
  block: Pick<PayslipReviewCreditsBlock, 'month' | 'review_month'>,
): { tone: 'pending' | 'ok' | 'lapsed'; text: string } | null {
  const m = block.month
  if (!m) return null
  const name = reviewMonthLabel(block.review_month, { year: false })
  const reviews = (n: number) => (n === 1 ? '1 review' : `${n} reviews`)
  switch (m.status) {
    case 'open':
      return {
        tone: 'pending',
        text: `${m.qualifying_review_count} of ${reviews(m.minimum_reviews)} approved so far. `
          + `These credits can be applied once ${name} reaches ${m.minimum_reviews}.`,
      }
    case 'qualified':
      return { tone: 'ok', text: `${name}'s target of ${reviews(m.minimum_reviews)} was reached.` }
    case 'lapsed':
      return {
        tone: 'lapsed',
        text: `${name} closed below its target of ${reviews(m.minimum_reviews)}, so these credits lapsed and cannot be applied.`,
      }
  }
}
