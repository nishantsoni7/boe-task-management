// Custom Review Submissions — the pure rules both the form and the route use.
//
// An employee submits proof that a review THEY arranged was published. It is
// not a generated, assigned or booked review, and nothing here touches one.
// A verifier approves it (BOE Credits are awarded by the database, once) or
// rejects it with a reason; a rejected review is corrected and REAPPLIED on the
// same row. See
// supabase/migrations/20261205000000_customer_review_custom_submissions.sql and
// supabase/migrations/20261206000000_customer_review_custom_reapply_and_monthly_rules.sql.
//
// THE DATABASE IS THE BOUNDARY. Every check below is restated in the
// registration, reapplication, approval and rejection functions; these exist so
// a form refuses before a five-megabyte upload and so the refusals can be
// tested without a database.

import { formatCredits, hasCreditPrecision } from '../boeCredits/ledger'
import { MAX_REVIEW_REWARD_CREDITS } from '../boeCredits/settings'
import type { BadgeMeta, ReviewType } from './types'

/** The private bucket the proof screenshots live in. Must match the migration. */
export const CUSTOM_PROOF_BUCKET = 'customer-review-custom-proofs'

/**
 * The stored statuses. `pending_verification` is shown as "Pending Approval":
 * the stored value is the audit history's word and is not renamed.
 */
export const CUSTOM_SUBMISSION_STATUSES = ['pending_verification', 'approved', 'rejected'] as const
export type CustomSubmissionStatus = (typeof CUSTOM_SUBMISSION_STATUSES)[number]

export const MAX_CUSTOM_REMARK_LENGTH = 300
export const MAX_REJECTION_REASON_LENGTH = 300
export const MAX_CANDIDATE_NOTE_LENGTH = 500
export const MAX_REVIEWER_NAME_LENGTH = 80
export const MAX_REVIEW_TEXT_LENGTH = 2000

/** The review types, in this workflow's words. The stored values are the Review Workflow's own. */
export const CUSTOM_REVIEW_TYPE_LABELS: Record<ReviewType, string> = {
  text:  'Text Review',
  image: 'Image Review',
}

export const CUSTOM_SUBMISSION_STATUS_META: Record<CustomSubmissionStatus, BadgeMeta> = {
  pending_verification: { label: 'Pending Approval', bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved:             { label: 'Approved',         bg: '#ECFDF5', color: '#047857', border: '#A7F3D0' },
  rejected:             { label: 'Rejected',         bg: '#FEF2F2', color: '#B91C1C', border: '#FECACA' },
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
  /** The FIRST submission — it decides the month (slot and credit). Never overwritten. */
  submitted_at: string
  approved_by: string | null
  approved_at: string | null
  /** Numeric(12,2) — 1.5 stays 1.5. Null until approved. */
  credits_awarded: number | null
  rejected_by: string | null
  rejected_at: string | null
  rejection_reason: string | null
  /** The employee's note on their latest reapplication. */
  candidate_note: string | null
  /** How many times this review was reapplied. Still one slot. */
  reapplication_count: number
  last_reapplied_at: string | null
  /** How many times the employee edited it in place. The submission date never moves. */
  edit_count: number
  last_edited_at: string | null
  /** An edited approved review: waiting for re-approval, its credit still on the ledger. */
  reward_held: boolean
  /** Set when the employee deleted it. Only verifiers can still read a deleted row. */
  deleted_at: string | null
  deleted_by: string | null
  /** The ledger reversal, when a paid review was deleted or its edit was rejected. */
  reward_reversal_transaction_id: string | null
  /** The customer or reviewer name and the review text, as the employee typed them. Optional. */
  reviewer_name: string | null
  review_text: string | null
}

export const CUSTOM_SUBMISSION_COLUMNS =
  'id, submission_ref, submitted_by, review_type, published_on, remark, proof_storage_path, proof_file_name, status, submitted_at, approved_by, approved_at, credits_awarded, rejected_by, rejected_at, rejection_reason, candidate_note, reapplication_count, last_reapplied_at, edit_count, last_edited_at, reward_held, deleted_at, deleted_by, reward_reversal_transaction_id, reviewer_name, review_text'

export function isCustomSubmissionStatus(value: unknown): value is CustomSubmissionStatus {
  return typeof value === 'string' && (CUSTOM_SUBMISSION_STATUSES as readonly string[]).includes(value)
}

// ─── The history ──────────────────────────────────────────────────────────────

export const CUSTOM_SUBMISSION_EVENT_TYPES = [
  'submitted', 'rejected', 'reapplied', 'approved', 'edited', 'deleted', 'duplicate_flagged', 'duplicate_decided',
] as const
export type CustomSubmissionEventType = (typeof CUSTOM_SUBMISSION_EVENT_TYPES)[number]

/** One row of public.customer_review_custom_submission_events. Append-only. */
export type CustomSubmissionEvent = {
  id: string
  submission_id: string
  event_type: CustomSubmissionEventType
  actor_id: string | null
  /** The rejection reason, on a 'rejected' event. */
  reason: string | null
  /** The employee's note, on a 'reapplied' event. */
  note: string | null
  details: Record<string, unknown>
  created_at: string
}

export const CUSTOM_SUBMISSION_EVENT_COLUMNS =
  'id, submission_id, event_type, actor_id, reason, note, details, created_at'

export const CUSTOM_SUBMISSION_EVENT_LABELS: Record<CustomSubmissionEventType, string> = {
  submitted: 'Submitted for approval',
  rejected:  'Rejected',
  reapplied: 'Reapplied for approval',
  approved:  'Approved',
  edited:    'Edited',
  deleted:   'Deleted by the employee',
  duplicate_flagged: 'Possible duplicate flagged',
  duplicate_decided: 'Duplicate decision recorded',
}

// ─── The submission form ──────────────────────────────────────────────────────

export type CustomSubmissionField = 'review_type' | 'published_on' | 'remark' | 'proof' | 'note'

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

// ─── Reapplying a rejected review ─────────────────────────────────────────────

export type CustomReapplicationInput = {
  reviewType: unknown
  publishedOn: unknown
  remark: unknown
  /** The employee's optional note on what they changed. */
  note: unknown
}

export type ParsedCustomReapplication =
  | { ok: true; value: { reviewType: ReviewType; publishedOn: string; remark: string | null; note: string | null } }
  | { ok: false; issues: { field: CustomSubmissionField; message: string }[] }

/**
 * Validate a reapplication. The screenshot is OPTIONAL: the current proof is
 * kept unless a new one is attached.
 */
export function parseCustomReapplicationInput(input: CustomReapplicationInput, today: string): ParsedCustomReapplication {
  const base = parseCustomSubmissionInput({ ...input, hasProof: true }, today)
  const issues = base.ok ? [] : [...base.issues]

  const noteRaw = typeof input.note === 'string' ? input.note.trim() : ''
  if (noteRaw.length > MAX_CANDIDATE_NOTE_LENGTH) {
    issues.push({ field: 'note', message: `Keep the note under ${MAX_CANDIDATE_NOTE_LENGTH} characters.` })
  }

  if (issues.length > 0 || !base.ok) return { ok: false, issues }
  return { ok: true, value: { ...base.value, note: noteRaw === '' ? null : noteRaw } }
}

// ─── The optional name and text the duplicate check compares ──────────────────

export type ParsedMatchFields =
  | { ok: true; value: { reviewerName: string | null; reviewText: string | null } }
  | { ok: false; message: string }

/** Trim, empty → null, and the length limits the database restates. */
export function parseMatchFields(input: { reviewerName: unknown; reviewText: unknown }): ParsedMatchFields {
  const name = typeof input.reviewerName === 'string' ? input.reviewerName.trim() : ''
  const text = typeof input.reviewText === 'string' ? input.reviewText.trim() : ''
  if (name.length > MAX_REVIEWER_NAME_LENGTH) {
    return { ok: false, message: `Keep the reviewer name under ${MAX_REVIEWER_NAME_LENGTH} characters.` }
  }
  if (text.length > MAX_REVIEW_TEXT_LENGTH) {
    return { ok: false, message: `Keep the review text under ${MAX_REVIEW_TEXT_LENGTH} characters.` }
  }
  return { ok: true, value: { reviewerName: name === '' ? null : name, reviewText: text === '' ? null : text } }
}

/** Only the submitter, only a rejected review. The database asks again. */
export function canReapplySubmission(
  row: Pick<CustomReviewSubmission, 'status' | 'submitted_by'>,
  viewerId: string | null,
): boolean {
  return viewerId != null && row.submitted_by === viewerId && row.status === 'rejected'
}

// ─── Editing and deleting your own review ─────────────────────────────────────

/** A review the employee may still change in place: pending, or approved (which goes back to approval). */
export function canEditSubmission(
  row: Pick<CustomReviewSubmission, 'status' | 'submitted_by' | 'deleted_at'>,
  viewerId: string | null,
): boolean {
  return viewerId != null && row.submitted_by === viewerId && row.deleted_at == null
    && (row.status === 'pending_verification' || row.status === 'approved')
}

/** Any review of the employee's own that is not already deleted. */
export function canDeleteSubmission(
  row: Pick<CustomReviewSubmission, 'submitted_by' | 'deleted_at'>,
  viewerId: string | null,
): boolean {
  return viewerId != null && row.submitted_by === viewerId && row.deleted_at == null
}

/** True while the review's credit is held for re-approval, or it is approved (editing sends it back). */
export function editSendsBackForApproval(row: Pick<CustomReviewSubmission, 'status'>): boolean {
  return row.status === 'approved'
}

/** What the employee is told before editing an approved review. */
export const APPROVED_EDIT_NOTICE =
  'This review is approved. Saving your changes puts it back to Pending Approval. Its credit stays in your BOE Credits balance while it waits — nothing is added or taken away yet — but the review does not count in the leaderboard or eligible totals until it is approved again. Approving it again pays nothing more; if the edit is rejected, or you delete the review, the credit is withdrawn once. The review type cannot change.'

/** What the employee is told before deleting a review. */
export function deleteConfirmationText(row: Pick<CustomReviewSubmission, 'status' | 'credits_awarded' | 'submission_ref'>): string {
  const paid = row.credits_awarded != null && Number(row.credits_awarded) > 0 && row.status !== 'rejected'
  return paid
    ? `Delete ${row.submission_ref}? Its ${formatCredits(Number(row.credits_awarded))} will be taken back from your balance. Reviewers keep a record of the deletion.`
    : `Delete ${row.submission_ref}? It leaves your list. Reviewers keep a record of the deletion.`
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

/**
 * The HTTP status a route answers with for a database refusal, by its marker.
 * Null for anything unrecognised — the route answers 500 without the message.
 */
export function customSubmissionFailureStatus(message: string | null | undefined): number | null {
  const raw = message ?? ''
  const MARKERS: [string, number][] = [
    ['CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', 403],
    ['CUSTOMER_REVIEW_CUSTOM_NOT_OWNER', 403],
    ['CUSTOMER_REVIEW_CUSTOM_NOT_FOUND', 404],
    ['CUSTOMER_REVIEW_CUSTOM_DUPLICATE', 409],
    ['CUSTOMER_REVIEW_CUSTOM_DECIDED', 409],
    ['CUSTOMER_REVIEW_CUSTOM_NOT_EDITABLE', 409],
    ['CUSTOMER_REVIEW_CUSTOM_STALE', 409],
    ['CUSTOMER_REVIEW_CUSTOM_DUPLICATE_WARNING', 409],
    ['CUSTOMER_REVIEW_CUSTOM_DUPLICATE_CONFIRMED', 409],
    ['CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED', 409],
    ['CUSTOMER_REVIEW_CUSTOM_INVALID', 422],
    ['CUSTOMER_REVIEW_CUSTOM_MONTHLY_LIMIT', 422],
    ['CUSTOMER_REVIEW_CUSTOM_IMAGE_REQUIRED', 422],
  ]
  for (const [marker, status] of MARKERS) {
    if (raw.startsWith(marker)) return status
  }
  return null
}

/** "12 Sep 2026" from a YYYY-MM-DD date, without a timezone shift. */
export function formatSubmissionDay(isoDate: string): string {
  if (!isCalendarDate(isoDate)) return isoDate
  const [y, m, d] = isoDate.split('-').map(Number)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
  return `${d} ${month} ${y}`
}
