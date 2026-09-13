// Custom Review Submissions — the pure rules both the form and the route use.
//
// An employee submits proof that a review THEY arranged was published. It is
// not a generated, assigned or booked review, and nothing here touches one.
// A verifier approves it (BOE Credits are awarded by the database, once) or
// rejects it with a reason. See
// supabase/migrations/20261205000000_customer_review_custom_submissions.sql.
//
// THE DATABASE IS THE BOUNDARY. Every check below is restated in
// create_customer_review_custom_submission() and in the approve / reject
// functions; these exist so a form refuses before a five-megabyte upload and so
// the refusals can be tested without a database.

import { hasCreditPrecision } from '../boeCredits/ledger'
import { MAX_REVIEW_REWARD_CREDITS } from '../boeCredits/settings'
import type { BadgeMeta, ReviewType } from './types'

/** The private bucket the proof screenshots live in. Must match the migration. */
export const CUSTOM_PROOF_BUCKET = 'customer-review-custom-proofs'

export const CUSTOM_SUBMISSION_STATUSES = ['pending_verification', 'approved', 'rejected'] as const
export type CustomSubmissionStatus = (typeof CUSTOM_SUBMISSION_STATUSES)[number]

export const MAX_CUSTOM_REMARK_LENGTH = 300
export const MAX_REJECTION_REASON_LENGTH = 300

/** The review types, in this workflow's words. The stored values are the Review Workflow's own. */
export const CUSTOM_REVIEW_TYPE_LABELS: Record<ReviewType, string> = {
  text:  'Text-based Review',
  image: 'Image-based Review',
}

export const CUSTOM_SUBMISSION_STATUS_META: Record<CustomSubmissionStatus, BadgeMeta> = {
  pending_verification: { label: 'Pending Verification', bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved:             { label: 'Approved',             bg: '#ECFDF5', color: '#047857', border: '#A7F3D0' },
  rejected:             { label: 'Rejected',             bg: '#FEF2F2', color: '#B91C1C', border: '#FECACA' },
}

/** One row of public.customer_review_custom_submissions, as the screens read it. */
export type CustomReviewSubmission = {
  id: string
  submission_ref: string
  submitted_by: string
  review_type: ReviewType
  /** YYYY-MM-DD — the employee's claim. */
  published_on: string
  remark: string | null
  proof_storage_path: string
  proof_file_name: string
  status: CustomSubmissionStatus
  submitted_at: string
  approved_by: string | null
  approved_at: string | null
  /** Numeric(12,2) — 1.5 stays 1.5. Null until approved. */
  credits_awarded: number | null
  rejected_by: string | null
  rejected_at: string | null
  rejection_reason: string | null
}

export const CUSTOM_SUBMISSION_COLUMNS =
  'id, submission_ref, submitted_by, review_type, published_on, remark, proof_storage_path, proof_file_name, status, submitted_at, approved_by, approved_at, credits_awarded, rejected_by, rejected_at, rejection_reason'

export function isCustomSubmissionStatus(value: unknown): value is CustomSubmissionStatus {
  return typeof value === 'string' && (CUSTOM_SUBMISSION_STATUSES as readonly string[]).includes(value)
}

// ─── The submission form ──────────────────────────────────────────────────────

export type CustomSubmissionField = 'review_type' | 'published_on' | 'remark' | 'proof'

export type CustomSubmissionInput = {
  reviewType: unknown
  publishedOn: unknown
  remark: unknown
  /** Whether a screenshot file is attached. The route decides what the bytes are. */
  hasProof: boolean
}

export type ParsedCustomSubmission =
  | { ok: true; value: { reviewType: ReviewType; publishedOn: string; remark: string | null } }
  | { ok: false; issues: { field: CustomSubmissionField; message: string }[] }

/** A real calendar date written YYYY-MM-DD — 2026-02-30 is not one. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * Validate a submission. `today` is the Asia/Kolkata date (istToday()), the
 * same "today" the database compares against.
 */
export function parseCustomSubmissionInput(input: CustomSubmissionInput, today: string): ParsedCustomSubmission {
  const issues: { field: CustomSubmissionField; message: string }[] = []

  const reviewType = input.reviewType === 'text' || input.reviewType === 'image' ? input.reviewType : null
  if (!reviewType) issues.push({ field: 'review_type', message: 'Choose Text-based or Image-based review.' })

  const publishedOn = typeof input.publishedOn === 'string' ? input.publishedOn.trim() : ''
  if (publishedOn === '' || !isCalendarDate(publishedOn)) {
    issues.push({ field: 'published_on', message: 'Enter the date the review was published.' })
  } else if (publishedOn > today) {
    issues.push({ field: 'published_on', message: 'The published date cannot be in the future.' })
  }

  const remarkRaw = typeof input.remark === 'string' ? input.remark.trim() : ''
  if (remarkRaw.length > MAX_CUSTOM_REMARK_LENGTH) {
    issues.push({ field: 'remark', message: `Keep the remark under ${MAX_CUSTOM_REMARK_LENGTH} characters.` })
  }

  if (!input.hasProof) issues.push({ field: 'proof', message: 'Upload a screenshot of the published review.' })

  if (issues.length > 0 || !reviewType) return { ok: false, issues }
  return { ok: true, value: { reviewType, publishedOn, remark: remarkRaw === '' ? null : remarkRaw } }
}

// ─── The decision ─────────────────────────────────────────────────────────────

/** The amount a verifier is about to award. Mirrors the approval function's checks. */
export function approvalCreditsIssue(value: unknown): string | null {
  const n = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value.trim())) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'Enter the number of credits to award.'
  if (n <= 0) return 'The credit amount must be above 0.'
  if (!hasCreditPrecision(n)) return 'Credits have at most two decimal places.'
  if (n > MAX_REVIEW_REWARD_CREDITS) return 'That is more credits than one review can earn.'
  return null
}

/** A rejection must say why. Trimmed; empty is refused. */
export function rejectionReasonIssue(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return 'Give a short reason for rejecting.'
  if (s.length > MAX_REJECTION_REASON_LENGTH) return `Keep the reason under ${MAX_REJECTION_REASON_LENGTH} characters.`
  return null
}

/** The sentence after a database marker ("CUSTOMER_REVIEW_CUSTOM_SELF: You cannot…"). */
export function customSubmissionErrorMessage(message: string | null | undefined, fallback: string): string {
  const text = (message ?? '').replace(/^[A-Z_]+:\s*/, '').trim()
  return text === '' ? fallback : text
}

/** "12 Sep 2026" from a YYYY-MM-DD date, without a timezone shift. */
export function formatSubmissionDay(isoDate: string): string {
  if (!isCalendarDate(isoDate)) return isoDate
  const [y, m, d] = isoDate.split('-').map(Number)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
  return `${d} ${month} ${y}`
}
