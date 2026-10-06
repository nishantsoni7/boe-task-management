'use client'

import { useState } from 'react'
import { ReviewBadge } from '@/components/customerReviews/ReviewPieces'
import { DuplicateBadge, type DuplicateSummary } from '@/components/customerReviews/DuplicateReview'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { REVIEW_TYPE_META } from '@/lib/customerReviews/types'
import {
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_STATUS_META,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'
import {
  canAdminDelete,
  canAdminRejectApproved,
  recordedOrNot,
  reviewMonthLabel,
  reviewMonthOf,
  submissionDayOf,
} from '@/lib/customerReviews/submissionList'
import styles from './customSubmissionList.module.css'

// The rows of Custom Submissions: one table row on a desktop, one card on a phone, from the
// same data. REVIEWER and SUBMITTED BY are two different people and are never merged: the
// reviewer is the customer who posted the public review (typed by the employee, optional,
// absent from older reviews — shown as "Not recorded", never guessed); the submitter is the BOE
// employee who uploaded the screenshot.

export type SubmissionListActions = {
  onOpen: (row: CustomReviewSubmission) => void
  onPreview: (row: CustomReviewSubmission) => void
  onAdminReject: (row: CustomReviewSubmission) => void
  onAdminDelete: (row: CustomReviewSubmission) => void
}

type ListProps = SubmissionListActions & {
  rows: CustomReviewSubmission[]
  names: Map<string, string>
  /** False until the submitters' names were read, so a name still loading is not shown as missing. */
  namesReady: boolean
  /** Signed thumbnail URLs by storage path: a URL, null when the file could not be signed, absent while loading. */
  thumbs: Map<string, string | null>
  duplicates: Map<string, DuplicateSummary> | null
  viewerId: string | null
  isAdmin: boolean
}

function Thumb({ row, url, onPreview }: { row: CustomReviewSubmission; url: string | null | undefined; onPreview: () => void }) {
  // A thumbnail that cannot be shown says so; the full-size preview re-requests the file itself.
  const [broken, setBroken] = useState(false)
  return (
    <button
      type="button"
      className={styles.thumb}
      onClick={onPreview}
      aria-label={`Preview the screenshot of ${row.submission_ref}`}
    >
      {url && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span>{url === undefined ? 'Loading…' : 'Image not available'}</span>
      )}
    </button>
  )
}

function Person({ value }: { value: string | null | undefined }) {
  const text = recordedOrNot(value)
  return value && value.trim() !== ''
    ? <span className={styles.person}>{text}</span>
    : <span className={styles.missing}>{text}</span>
}

export function CustomSubmissionList(props: ListProps) {
  const { rows, names, namesReady, thumbs, duplicates, viewerId, isAdmin } = props

  const submitter = (row: CustomReviewSubmission) =>
    names.get(row.submitted_by) ?? (namesReady ? null : '…')

  const adminButtons = (row: CustomReviewSubmission) => (
    <>
      {canAdminRejectApproved(row, viewerId, isAdmin) && (
        <button
          type="button"
          className="boe-btn boe-btn-ghost"
          onClick={() => props.onAdminReject(row)}
          style={{ padding: '6px 10px', fontSize: '12px', minHeight: '36px', color: '#B91C1C' }}
        >
          Reject approval
        </button>
      )}
      {canAdminDelete(row, isAdmin) && (
        <button
          type="button"
          className="boe-btn boe-btn-ghost"
          onClick={() => props.onAdminDelete(row)}
          style={{ padding: '6px 10px', fontSize: '12px', minHeight: '36px', color: '#B91C1C' }}
        >
          Delete
        </button>
      )}
    </>
  )

  const badges = (row: CustomReviewSubmission) => (
    <>
      {row.deleted_at
        ? <ReviewBadge meta={{ label: 'Deleted', bg: '#F3F4F6', color: '#4B5563', border: '#D1D5DB' }} />
        : <ReviewBadge meta={CUSTOM_SUBMISSION_STATUS_META[row.status]} />}
      <DuplicateBadge summary={duplicates?.get(row.id)} />
      {row.reward_held && !row.deleted_at && (
        <span style={{
          fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
          background: '#FFFBEB', color: '#92400E', border: '1px solid #FDE68A',
        }}>
          Edited after approval
        </span>
      )}
      {row.reapplication_count > 0 && row.status === 'pending_verification' && !row.deleted_at && (
        <span style={{
          fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
          background: 'rgba(79,111,208,0.10)', color: '#3B5BC0', border: '1px solid rgba(79,111,208,0.25)',
        }}>
          Reapplied
        </span>
      )}
    </>
  )

  const openLabel = (row: CustomReviewSubmission) =>
    row.status === 'pending_verification' && !row.deleted_at ? 'Open & Decide' : 'Open'
  const openClass = (row: CustomReviewSubmission) =>
    row.status === 'pending_verification' && !row.deleted_at ? 'boe-btn boe-btn-primary' : 'boe-btn boe-btn-ghost'

  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Screenshot</th>
              <th scope="col">Reviewer</th>
              <th scope="col">Submitted by</th>
              <th scope="col">Status</th>
              <th scope="col">Review month</th>
              <th scope="col">Submitted</th>
              <th scope="col" style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const who = submitter(row)
              return (
                <tr key={row.id}>
                  <td>
                    <Thumb row={row} url={thumbs.get(row.proof_storage_path)} onPreview={() => props.onPreview(row)} />
                  </td>
                  <td>
                    <Person value={row.reviewer_name} />
                    <div className={styles.sub}>
                      {row.submission_ref} · <span style={{ color: REVIEW_TYPE_META[row.review_type].color, fontWeight: 600 }}>
                        {CUSTOM_REVIEW_TYPE_LABELS[row.review_type]}
                      </span>
                    </div>
                  </td>
                  <td>
                    {who === null ? <span className={styles.missing}>Not recorded</span> : <span className={styles.person}>{who}</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' }}>{badges(row)}</div>
                    {row.status === 'approved' && !row.deleted_at && row.credits_awarded != null && (
                      <div className={styles.sub} style={{ color: '#047857', fontWeight: 700 }}>
                        {formatCredits(Number(row.credits_awarded), { signed: true })}
                      </div>
                    )}
                    {row.status === 'rejected' && !row.deleted_at && row.rejection_reason && (
                      <div className={styles.sub} title={row.rejection_reason}
                        style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.rejection_reason}
                      </div>
                    )}
                  </td>
                  <td className={styles.nowrap}>{reviewMonthLabel(reviewMonthOf(row.submitted_at))}</td>
                  <td className={styles.nowrap}>
                    {submissionDayOf(row.submitted_at)}
                    {row.deleted_at && <div className={styles.sub}>Deleted {submissionDayOf(row.deleted_at)}</div>}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={openClass(row)}
                        onClick={() => props.onOpen(row)}
                        style={{ padding: '6px 12px', fontSize: '12px', minHeight: '36px' }}
                      >
                        {openLabel(row)}
                      </button>
                      {adminButtons(row)}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ul className={styles.cards}>
        {rows.map(row => {
          const who = submitter(row)
          return (
            <li key={row.id} className={styles.card}>
              <div className={styles.cardTop}>
                <Thumb row={row} url={thumbs.get(row.proof_storage_path)} onPreview={() => props.onPreview(row)} />
                <div className={styles.cardBody}>
                  <Person value={row.reviewer_name} />
                  <div className={styles.sub}>{row.submission_ref} · {CUSTOM_REVIEW_TYPE_LABELS[row.review_type]}</div>
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center', marginTop: '3px' }}>{badges(row)}</div>
                </div>
              </div>
              <dl className={styles.cardFacts}>
                <dt>Reviewer</dt><dd>{recordedOrNot(row.reviewer_name)}</dd>
                <dt>Submitted by</dt><dd>{who === null ? 'Not recorded' : who}</dd>
                <dt>Review month</dt><dd>{reviewMonthLabel(reviewMonthOf(row.submitted_at))}</dd>
                <dt>Submitted</dt><dd>{submissionDayOf(row.submitted_at)}</dd>
                {row.deleted_at && (<><dt>Deleted</dt><dd>{submissionDayOf(row.deleted_at)}</dd></>)}
                {row.status === 'approved' && !row.deleted_at && row.credits_awarded != null && (
                  <><dt>Credits</dt><dd style={{ color: '#047857' }}>{formatCredits(Number(row.credits_awarded), { signed: true })}</dd></>
                )}
                {row.status === 'rejected' && !row.deleted_at && row.rejection_reason && (
                  <><dt>Reason</dt><dd>{row.rejection_reason}</dd></>
                )}
              </dl>
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={openClass(row)}
                  onClick={() => props.onOpen(row)}
                  style={{ padding: '8px 14px', fontSize: '13px', minHeight: '44px' }}
                >
                  {openLabel(row)}
                </button>
                {canAdminRejectApproved(row, viewerId, isAdmin) && (
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost"
                    onClick={() => props.onAdminReject(row)}
                    style={{ padding: '8px 14px', fontSize: '13px', minHeight: '44px', color: '#B91C1C' }}
                  >
                    Reject approval
                  </button>
                )}
                {canAdminDelete(row, isAdmin) && (
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost"
                    onClick={() => props.onAdminDelete(row)}
                    style={{ padding: '8px 14px', fontSize: '13px', minHeight: '44px', color: '#B91C1C' }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
