/**
 * Custom Submissions list — the pure rules: filters, the review month (IST), "Not recorded",
 * and who may be offered the administrator's two actions.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/submissionList.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOT_RECORDED,
  NO_SUBMISSION_FILTERS,
  SUBMISSION_STATUS_FILTERS,
  SUBMISSION_STATUS_FILTER_LABELS,
  adminDeleteDoneMessage,
  adminDeleteWarning,
  adminRejectDoneMessage,
  adminRejectWarning,
  canAdminDelete,
  canAdminRejectApproved,
  isReviewMonth,
  isSubmissionStatusFilter,
  recordedOrNot,
  reviewMonthLabel,
  reviewMonthOf,
  reviewMonthOptions,
  reviewMonthRange,
  statusFilterOf,
} from './submissionList'
import { customSubmissionFailureStatus } from './customSubmissions'

const ME = 'a0000000-0000-4000-8000-00000000000a'
const THEM = 'e1000000-0000-4000-8000-0000000000e1'

const row = (over: Partial<Parameters<typeof canAdminRejectApproved>[0]> = {}) => ({
  status: 'approved' as const, submitted_by: THEM, deleted_at: null, ...over,
})

describe('the status filter', () => {
  test('it offers every live review, each status, and the deleted ones — Pending, Approved and Rejected all visible', () => {
    assert.deepEqual([...SUBMISSION_STATUS_FILTERS], ['all', 'pending_verification', 'approved', 'rejected', 'deleted'])
    assert.equal(NO_SUBMISSION_FILTERS.status, 'all')
    assert.equal(SUBMISSION_STATUS_FILTER_LABELS.pending_verification, 'Pending Approval')
    for (const f of SUBMISSION_STATUS_FILTERS) assert.ok(isSubmissionStatusFilter(f))
    assert.equal(isSubmissionStatusFilter('everything'), false)
  })

  test('a deleted row is "deleted" whatever its stored status', () => {
    assert.equal(statusFilterOf({ status: 'approved', deleted_at: '2026-10-01T00:00:00Z' }), 'deleted')
    assert.equal(statusFilterOf({ status: 'rejected', deleted_at: null }), 'rejected')
  })
})

describe('the review month is the Asia/Kolkata month of the FIRST submission', () => {
  test('23:59 IST on the last day stays in the month; 00:00 IST starts the next', () => {
    // 2026-09-30 23:59:59 IST = 18:29:59 UTC
    assert.equal(reviewMonthOf('2026-09-30T18:29:59.000Z'), '2026-09')
    // 2026-10-01 00:00:00 IST = 2026-09-30 18:30:00 UTC
    assert.equal(reviewMonthOf('2026-09-30T18:30:00.000Z'), '2026-10')
    // 00:30 IST on 1 Oct is still 30 Sep in UTC, and it is October's review.
    assert.equal(reviewMonthOf('2026-09-30T19:00:00.000Z'), '2026-10')
  })

  test('the month filter bounds are those same IST instants, half-open', () => {
    assert.deepEqual(reviewMonthRange('2026-09'), { from: '2026-08-31T18:30:00.000Z', to: '2026-09-30T18:30:00.000Z' })
    assert.deepEqual(reviewMonthRange('2026-12'), { from: '2026-11-30T18:30:00.000Z', to: '2026-12-31T18:30:00.000Z' })
    assert.equal(reviewMonthRange(''), null)
    assert.equal(reviewMonthRange('2026-13'), null)
    // A row's month and the range agree for every boundary instant.
    const r = reviewMonthRange('2026-10')!
    assert.equal(reviewMonthOf(r.from), '2026-10')
    assert.equal(reviewMonthOf(new Date(Date.parse(r.to) - 1).toISOString()), '2026-10')
    assert.equal(reviewMonthOf(r.to), '2026-11')
  })

  test('labels and the menu: newest first, each month once', () => {
    assert.equal(reviewMonthLabel('2026-09'), 'Sep 2026')
    assert.equal(reviewMonthLabel('garbage'), 'garbage')
    assert.ok(isReviewMonth('2026-01') && !isReviewMonth('2026-1') && !isReviewMonth('2026-00'))
    assert.deepEqual(
      reviewMonthOptions(['2026-08-05T00:00:00Z', '2026-10-02T00:00:00Z', '2026-08-30T00:00:00Z', '2026-09-30T19:00:00Z']),
      ['2026-10', '2026-08'],
    )
  })
})

describe('missing historical data is shown as "Not recorded", never guessed', () => {
  test('null, empty and blank all read the same; a name is shown as typed', () => {
    assert.equal(NOT_RECORDED, 'Not recorded')
    assert.equal(recordedOrNot(null), 'Not recorded')
    assert.equal(recordedOrNot(undefined), 'Not recorded')
    assert.equal(recordedOrNot(''), 'Not recorded')
    assert.equal(recordedOrNot('   '), 'Not recorded')
    assert.equal(recordedOrNot('  Priya Nair '), 'Priya Nair')
  })
})

describe('what an administrator is offered', () => {
  test('Reject approval: an administrator, an approved live review, not their own', () => {
    assert.equal(canAdminRejectApproved(row(), ME, true), true)
    assert.equal(canAdminRejectApproved(row(), ME, false), false, 'a non-administrator is never offered it')
    assert.equal(canAdminRejectApproved(row({ status: 'pending_verification' }), ME, true), false)
    assert.equal(canAdminRejectApproved(row({ status: 'rejected' }), ME, true), false)
    assert.equal(canAdminRejectApproved(row({ deleted_at: '2026-10-01T00:00:00Z' }), ME, true), false)
    assert.equal(canAdminRejectApproved(row({ submitted_by: ME }), ME, true), false, 'nobody decides their own review')
    assert.equal(canAdminRejectApproved(row(), null, true), false)
  })

  test('Delete: an administrator, any status, not already deleted', () => {
    for (const status of ['pending_verification', 'approved', 'rejected'] as const) {
      assert.equal(canAdminDelete(row({ status }), true), true, status)
      assert.equal(canAdminDelete(row({ status }), false), false, `${status} (not an administrator)`)
    }
    assert.equal(canAdminDelete(row({ deleted_at: '2026-10-01T00:00:00Z' }), true), false)
  })
})

describe('what the administrator is told', () => {
  const approved = { submission_ref: 'CR-2026-0042', credits_awarded: 1.5, submitted_at: '2026-09-12T10:00:00Z', status: 'approved' as const, reward_held: false }

  test('the rejection warning names the month the review was submitted in and the credit', () => {
    const text = adminRejectWarning(approved, 'Ashok')
    assert.match(text, /CR-2026-0042/)
    assert.match(text, /Sep 2026/)
    assert.match(text, /1\.5 credits/)
    assert.match(text, /taken back from Ashok's balance once/)
    assert.match(text, /kept/)
  })

  test('the delete warning promises a reversal only for a paid review', () => {
    assert.match(adminDeleteWarning(approved, 'Ashok'), /taken back from Ashok's balance once/)
    assert.doesNotMatch(adminDeleteWarning({ ...approved, status: 'rejected', credits_awarded: null }, 'Ashok'), /taken back/)
    assert.doesNotMatch(adminDeleteWarning({ ...approved, status: 'pending_verification', credits_awarded: null }, 'Ashok'), /taken back/)
    assert.match(adminDeleteWarning({ ...approved, status: 'pending_verification', reward_held: true }, 'Ashok'), /taken back/, 'an edited review still holds its credit')
  })

  test('the answer is worded from what the database said, not assumed', () => {
    assert.match(adminRejectDoneMessage('CR-1', 'Ashok', { credit_reversed: true }), /taken back from Ashok once/)
    assert.match(adminRejectDoneMessage('CR-1', 'Ashok', { already_decided: true }), /already rejected/)
    assert.match(adminRejectDoneMessage('CR-1', 'Ashok', { credit_expired: true }), /already expired/)
    assert.equal(adminRejectDoneMessage('CR-1', 'Ashok', {}), 'CR-1 rejected.')
    assert.match(adminDeleteDoneMessage('CR-1', 'Ashok', { already_deleted: true }), /already deleted/)
    assert.match(adminDeleteDoneMessage('CR-1', 'Ashok', { credit_reversed: true }), /taken back from Ashok once/)
    assert.equal(adminDeleteDoneMessage('CR-1', 'Ashok', null), 'CR-1 deleted.')
  })

  test('the new refusals map to HTTP-style statuses', () => {
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_NOT_APPROVED: no'), 409)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_SELF: no'), 403)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: no'), 403)
  })
})
