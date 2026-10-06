// Custom Submissions — the list's pure rules: its filters, the review month it shows,
// the "Not recorded" wording, and what an administrator may do to a row.
//
// THE DATABASE IS THE BOUNDARY. admin_reject_customer_review_custom_submission() and
// admin_delete_customer_review_custom_submission() (20270304000000) each check
// `users.role = 'admin'` themselves; the predicates here only decide whether a button
// is drawn. A verifier who is not an administrator and posts the RPC directly is refused
// with CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED (supabase/tests/custom_review_admin_actions_assertions.sql).

import { formatCredits } from '../boeCredits/ledger'
import { istDateOf } from '../istDate'
import {
  CUSTOM_SUBMISSION_STATUSES,
  formatSubmissionDay,
  type CustomReviewSubmission,
  type CustomSubmissionStatus,
} from './customSubmissions'

// ─── Filters ──────────────────────────────────────────────────────────────────

/** The status filter: every live review, one status, or the deleted ones (history). */
export const SUBMISSION_STATUS_FILTERS = ['all', ...CUSTOM_SUBMISSION_STATUSES, 'deleted'] as const
export type SubmissionStatusFilter = (typeof SUBMISSION_STATUS_FILTERS)[number]

export const SUBMISSION_STATUS_FILTER_LABELS: Record<SubmissionStatusFilter, string> = {
  all: 'All',
  pending_verification: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  deleted: 'Deleted',
}

export function isSubmissionStatusFilter(value: unknown): value is SubmissionStatusFilter {
  return typeof value === 'string' && (SUBMISSION_STATUS_FILTERS as readonly string[]).includes(value)
}

/** What the list asks the database for. `month` is YYYY-MM (IST); '' / '' means no filter. */
export type SubmissionListFilters = {
  status: SubmissionStatusFilter
  month: string
  employeeId: string
}

export const NO_SUBMISSION_FILTERS: SubmissionListFilters = { status: 'all', month: '', employeeId: '' }

// ─── The review month ─────────────────────────────────────────────────────────
//
// The month a review belongs to is the Asia/Kolkata calendar month of `submitted_at`,
// the FIRST submission — the month its slot and its credit are attributed to. An edit,
// a reapplication, an approval, a rejection or a deletion never moves it.

/** "2026-09" — the review month of a review submitted at `submittedAt`. */
export function reviewMonthOf(submittedAt: string): string {
  return istDateOf(submittedAt).slice(0, 7)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isReviewMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** "Sep 2026" from "2026-09". */
export function reviewMonthLabel(month: string): string {
  if (!isReviewMonth(month)) return month
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

/**
 * The UTC instants [from, to) that bound an IST calendar month, for `.gte` / `.lt` on
 * submitted_at. IST is a fixed UTC+05:30, so 1 Sep 00:00 IST is 31 Aug 18:30 UTC.
 */
export function reviewMonthRange(month: string): { from: string; to: string } | null {
  if (!isReviewMonth(month)) return null
  const [y, m] = month.split('-').map(Number)
  const offset = 5.5 * 60 * 60 * 1000
  return {
    from: new Date(Date.UTC(y, m - 1, 1) - offset).toISOString(),
    to: new Date(Date.UTC(y, m, 1) - offset).toISOString(),
  }
}

/** The distinct review months of some submission times, newest first. */
export function reviewMonthOptions(submittedAts: readonly string[]): string[] {
  return [...new Set(submittedAts.map(reviewMonthOf))].sort().reverse()
}

// ─── Wording ──────────────────────────────────────────────────────────────────

export const NOT_RECORDED = 'Not recorded'

/** A person-entered value, or "Not recorded" — never a guess. */
export function recordedOrNot(value: string | null | undefined): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? NOT_RECORDED : text
}

/** "12 Sep 2026" for a timestamp, in Asia/Kolkata. */
export function submissionDayOf(instant: string): string {
  return formatSubmissionDay(istDateOf(instant))
}

// ─── What an administrator may do ─────────────────────────────────────────────

type AdminRow = Pick<CustomReviewSubmission, 'status' | 'submitted_by' | 'deleted_at'>

/** Take an approval back: an administrator, an approved review, not their own. */
export function canAdminRejectApproved(row: AdminRow, viewerId: string | null, isAdmin: boolean): boolean {
  return isAdmin && viewerId != null && row.status === 'approved'
    && row.deleted_at == null && row.submitted_by !== viewerId
}

/** Delete any review that is not already deleted, whatever its status. */
export function canAdminDelete(row: Pick<AdminRow, 'deleted_at'>, isAdmin: boolean): boolean {
  return isAdmin && row.deleted_at == null
}

export const ADMIN_REJECT_REASON_HINT = 'e.g. The review was removed from the platform'

/** The sentence an administrator reads before confirming a rejection. */
export function adminRejectWarning(
  row: Pick<CustomReviewSubmission, 'submission_ref' | 'credits_awarded' | 'submitted_at'>,
  employee: string,
): string {
  const credits = row.credits_awarded != null && Number(row.credits_awarded) > 0
    ? ` Its ${formatCredits(Number(row.credits_awarded))} will be taken back from ${employee}'s balance once.`
    : ''
  return `${row.submission_ref} is approved. Rejecting it takes the approval back: it stops counting as approved for ${reviewMonthLabel(reviewMonthOf(row.submitted_at))} (the month it was submitted in) and in targets, reports and the leaderboard.${credits} The review, its screenshot and its history are kept, and the reason you give is shown with it.`
}

/** The sentence an administrator reads before confirming a deletion. */
export function adminDeleteWarning(
  row: Pick<CustomReviewSubmission, 'submission_ref' | 'status' | 'credits_awarded' | 'submitted_at' | 'reward_held'>,
  employee: string,
): string {
  const paid = row.credits_awarded != null && Number(row.credits_awarded) > 0
    && (row.status === 'approved' || row.reward_held)
  const credits = paid
    ? ` Its ${formatCredits(Number(row.credits_awarded))} will be taken back from ${employee}'s balance once, and it stops counting for ${reviewMonthLabel(reviewMonthOf(row.submitted_at))}.`
    : ''
  return `Delete ${row.submission_ref} by ${employee}? It leaves every list, count, target and report.${credits} The record, its screenshot and its history are kept under Deleted, and it still counts as evidence for duplicate checks.`
}

/** The message after a successful admin rejection, from the function's answer. */
export function adminRejectDoneMessage(
  ref: string,
  employee: string,
  result: { already_decided?: boolean; credit_reversed?: boolean; credit_expired?: boolean } | null,
): string {
  if (result?.already_decided) return `${ref} was already rejected. Nothing more changed.`
  if (result?.credit_reversed) return `${ref} rejected. Its credit was taken back from ${employee} once.`
  if (result?.credit_expired) return `${ref} rejected. Its credit had already expired with a closed month, so nothing more was taken back.`
  return `${ref} rejected.`
}

/** The message after a successful admin deletion. */
export function adminDeleteDoneMessage(
  ref: string,
  employee: string,
  result: { already_deleted?: boolean; credit_reversed?: boolean; credit_expired?: boolean } | null,
): string {
  if (result?.already_deleted) return `${ref} was already deleted. Nothing more changed.`
  if (result?.credit_reversed) return `${ref} deleted. Its credit was taken back from ${employee} once.`
  if (result?.credit_expired) return `${ref} deleted. Its credit had already expired with a closed month, so nothing more was taken back.`
  return `${ref} deleted.`
}

/** The stored status as the filter bar shows it. */
export function statusFilterOf(row: Pick<CustomReviewSubmission, 'status' | 'deleted_at'>): SubmissionStatusFilter {
  return row.deleted_at ? 'deleted' : (row.status satisfies CustomSubmissionStatus)
}
