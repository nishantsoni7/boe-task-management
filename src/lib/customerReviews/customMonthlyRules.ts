// Custom Reviews — the monthly rules and the month summaries, as pure functions.
//
// THE DATABASE IS THE BOUNDARY. check_customer_review_custom_month_rules() in
// 20261206000000 decides, under a per-employee lock, whether a submission or a
// reapplication is accepted. These functions exist so the form can explain the
// rule BEFORE a five-megabyte upload, and so the candidate's Current Month and
// Last Month panels can be computed — and tested — without a database. The
// sentences match the database's word for word; customMonthlyRules.test.ts pins
// them to the migration.
//
// THE DEFINITIONS, AND WHY NO METRIC IS DERIVED FROM ANOTHER
//
//   submitted          rows whose FIRST submission falls in the month
//                      (Asia/Kolkata). Pending, approved and rejected all count:
//                      each took its slot when it was submitted. A reapplication
//                      is the same row, so it is never counted twice.
//   image / text       those rows by their CURRENT review type.
//   pending / approved / rejected
//                      those rows by their current status.
//   approved for the target
//                      the BOE Credits month row's qualifying_review_count — the
//                      count the credits system actually qualifies on. It can
//                      differ from `approved` (a reversed reward, or a generated
//                      review verified that month), so it is read, not derived.
//   earned credits     the month row's earned_review_credits: still-valid
//                      rewards. Spendable only when the month is qualified,
//                      pending while it is open, gone when it lapsed.

import type { BoeCreditSettings, CreditReviewMonth, CreditReviewMonthStatus } from '../boeCredits/types'
import type { ReviewType } from './types'
import type { CustomSubmissionStatus } from './customSubmissions'

export type CustomReviewMonthRules = {
  /** Custom reviews one employee may submit in a month. */
  maxMonthlySubmissions: number
  /** Of those, how many must be Image Reviews. 0 turns the rule off. */
  minMonthlyImageReviews: number
  /** Approved reviews a month needs before its review credits become spendable. */
  minMonthlyApprovedReviews: number
}

export function monthRulesFromSettings(settings: BoeCreditSettings): CustomReviewMonthRules {
  return {
    maxMonthlySubmissions: settings.max_monthly_review_submissions,
    minMonthlyImageReviews: settings.minimum_monthly_image_reviews,
    minMonthlyApprovedReviews: settings.minimum_monthly_reviews,
  }
}

export type MonthUsage = {
  /** Rows that took a slot this month. */
  submitted: number
  /** Of those, Image Reviews. */
  imageReviews: number
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function monthlyLimitMessage(rules: CustomReviewMonthRules): string {
  return `You have reached your monthly limit of ${rules.maxMonthlySubmissions} review submissions.`
}

/** The sentence the database raises when a new Text Review would break the image mix. */
export function imageRequiredMessage(usage: MonthUsage, rules: CustomReviewMonthRules): string {
  const remaining = rules.maxMonthlySubmissions - usage.submitted
  const min = rules.minMonthlyImageReviews
  return `You have submitted ${usage.submitted} ${plural(usage.submitted, 'review', 'reviews')} this month. `
    + `Your remaining ${remaining} ${plural(remaining, 'review must be an Image Review', 'reviews must be Image Reviews')} `
    + `to complete the monthly requirement of ${min} ${plural(min, 'Image Review', 'Image Reviews')}.`
}

export function reapplyImageRequiredMessage(rules: CustomReviewMonthRules): string {
  const min = rules.minMonthlyImageReviews
  return `Changing this review to a Text Review would leave too few slots for the monthly requirement of ${min} `
    + `${plural(min, 'Image Review', 'Image Reviews')}. Keep it as an Image Review.`
}

export type SubmissionAllowance = {
  /** Slots left this month. Never negative. */
  remainingSlots: number
  /** Image Reviews still needed to meet the monthly requirement. Never negative. */
  imagesStillRequired: number
  canSubmitAny: boolean
  canSubmitImage: boolean
  canSubmitText: boolean
  /** Why nothing can be submitted, or null. */
  limitMessage: string | null
  /** Why a Text Review cannot be submitted, or null. */
  textBlockedMessage: string | null
}

/**
 * What a NEW submission may be, this month.
 *
 * The general formula, not a special case for seven text reviews: a Text Review
 * is allowed only when the slots left AFTER it are at least the Image Reviews
 * still required.
 */
export function submissionAllowance(usage: MonthUsage, rules: CustomReviewMonthRules): SubmissionAllowance {
  const remainingSlots = Math.max(0, rules.maxMonthlySubmissions - usage.submitted)
  const imagesStillRequired = Math.max(0, rules.minMonthlyImageReviews - usage.imageReviews)
  const canSubmitAny = usage.submitted + 1 <= rules.maxMonthlySubmissions
  const remainingAfterText = rules.maxMonthlySubmissions - (usage.submitted + 1)
  const textFitsMix = remainingAfterText >= imagesStillRequired
  const canSubmitText = canSubmitAny && textFitsMix
  return {
    remainingSlots,
    imagesStillRequired,
    canSubmitAny,
    canSubmitImage: canSubmitAny,
    canSubmitText,
    limitMessage: canSubmitAny ? null : monthlyLimitMessage(rules),
    textBlockedMessage: !canSubmitAny ? monthlyLimitMessage(rules)
      : textFitsMix ? null
      : imageRequiredMessage(usage, rules),
  }
}

/**
 * Why a REAPPLICATION of this review may not use `nextType`, or null.
 *
 * `usageWithoutThisReview` excludes the row being reapplied — its slot is its
 * own. The cap never applies (the slot was taken at the first submission); the
 * image mix applies only when an Image Review becomes a Text Review.
 */
export function reapplicationIssue(
  usageWithoutThisReview: MonthUsage,
  previousType: ReviewType,
  nextType: ReviewType,
  rules: CustomReviewMonthRules,
): string | null {
  if (nextType !== 'text' || previousType !== 'image') return null
  const remainingAfter = rules.maxMonthlySubmissions - (usageWithoutThisReview.submitted + 1)
  const required = Math.max(0, rules.minMonthlyImageReviews - usageWithoutThisReview.imageReviews)
  return remainingAfter < required ? reapplyImageRequiredMessage(rules) : null
}

// ─── Months ─────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** "2026-09-01" — the Asia/Kolkata month an instant falls in. */
export function istMonthOf(instant: string | Date): string {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant)
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 7) + '-01'
}

/** "2026-08-01" for "2026-09-01". */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10)
}

/** The UTC instants bounding an IST month: [from, to). */
export function istMonthBoundsUtc(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS).toISOString()
  const to = new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS).toISOString()
  return { from, to }
}

/** Usage for one month, optionally leaving one review out. */
export function usageForMonth(
  rows: readonly Pick<SummaryRow, 'id' | 'submitted_at' | 'review_type'>[],
  month: string,
  excludingId: string | null = null,
): MonthUsage {
  const inMonth = rows.filter(r => r.id !== excludingId && istMonthOf(r.submitted_at) === month)
  return { submitted: inMonth.length, imageReviews: inMonth.filter(r => r.review_type === 'image').length }
}

// ─── The month summary ──────────────────────────────────────────────────────

export type SummaryRow = {
  id: string
  submitted_at: string
  review_type: ReviewType
  status: CustomSubmissionStatus
  reapplication_count: number
}

export type CustomReviewMonthSummary = {
  month: string
  submitted: number
  textReviews: number
  imageReviews: number
  pending: number
  approved: number
  rejected: number
  /** Rows reapplied at least once. They are still one slot each. */
  reapplied: number

  /** The count BOE Credits qualifies the month on. */
  approvedForTarget: number
  minimumApproved: number
  /** 'none' when the month has no BOE Credits row yet (nothing approved). */
  monthStatus: CreditReviewMonthStatus | 'none'
  qualified: boolean
  finalized: boolean

  maxSubmissions: number
  remainingSlots: number
  minImageReviews: number
  imagesStillRequired: number
  imageRequirementMet: boolean
  minimumTargetMet: boolean

  /** Still-valid review rewards attributed to the month. */
  recordedCredits: number
  /** Spendable because the month qualified. */
  spendableCredits: number
  /** Waiting for the monthly minimum. */
  pendingCredits: number
  /** Removed when the month closed below its minimum. */
  lapsedCredits: number
}

export function summarizeCustomReviewMonth(input: {
  month: string
  rows: readonly SummaryRow[]
  monthRow: Pick<CreditReviewMonth, 'review_month' | 'minimum_reviews_snapshot' | 'qualifying_review_count' | 'earned_review_credits' | 'status' | 'finalized_at'> | null
  rules: CustomReviewMonthRules
}): CustomReviewMonthSummary {
  const { month, rules } = input
  const rows = input.rows.filter(r => istMonthOf(r.submitted_at) === month)
  const monthRow = input.monthRow && input.monthRow.review_month === month ? input.monthRow : null

  const imageReviews = rows.filter(r => r.review_type === 'image').length
  const approvedForTarget = monthRow?.qualifying_review_count ?? 0
  const minimumApproved = monthRow?.minimum_reviews_snapshot ?? rules.minMonthlyApprovedReviews
  const status = monthRow?.status ?? 'none'
  const recorded = Number(monthRow?.earned_review_credits ?? 0)

  return {
    month,
    submitted: rows.length,
    textReviews: rows.length - imageReviews,
    imageReviews,
    pending: rows.filter(r => r.status === 'pending_verification').length,
    approved: rows.filter(r => r.status === 'approved').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
    reapplied: rows.filter(r => r.reapplication_count > 0).length,

    approvedForTarget,
    minimumApproved,
    monthStatus: status,
    qualified: status === 'qualified',
    finalized: monthRow?.finalized_at != null,

    maxSubmissions: rules.maxMonthlySubmissions,
    remainingSlots: Math.max(0, rules.maxMonthlySubmissions - rows.length),
    minImageReviews: rules.minMonthlyImageReviews,
    imagesStillRequired: Math.max(0, rules.minMonthlyImageReviews - imageReviews),
    imageRequirementMet: imageReviews >= rules.minMonthlyImageReviews,
    minimumTargetMet: status === 'qualified' || approvedForTarget >= minimumApproved,

    recordedCredits: recorded,
    spendableCredits: status === 'qualified' ? recorded : 0,
    pendingCredits: status === 'open' ? recorded : 0,
    lapsedCredits: status === 'lapsed' ? recorded : 0,
  }
}
