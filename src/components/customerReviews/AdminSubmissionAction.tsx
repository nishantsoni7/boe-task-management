'use client'

import { useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import {
  MAX_REJECTION_REASON_LENGTH,
  customSubmissionErrorMessage,
  rejectionReasonIssue,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'
import {
  ADMIN_REJECT_REASON_HINT,
  adminDeleteDoneMessage,
  adminDeleteWarning,
  adminRejectDoneMessage,
  adminRejectWarning,
} from '@/lib/customerReviews/submissionList'

// An administrator's two actions on a review: take an approval back (a reason is required) and
// delete. Each is its own confirmation — the dialog states the consequence and the red button is
// the confirmation — and each is one database call that decides everything: the function checks
// the administrator itself, locks the review, reverses the credit once, recounts the original
// month and writes the history in one transaction. A repeat answers "already …" and changes
// nothing, so a double click, a second tab or a retry cannot act twice.
//
// NO FALSE SUCCESS. The dialog closes, and the list is refreshed, only after the database answered
// without an error. A refusal or a failed request keeps the dialog open with the reason shown and
// nothing is reported as done.

export type AdminActionKind = 'reject' | 'delete'

export function AdminSubmissionAction({
  kind, row, employee, supabase, onClose, onDone,
}: {
  kind: AdminActionKind
  row: CustomReviewSubmission
  employee: string
  supabase: SupabaseClient
  onClose: () => void
  /** Called once, after the database confirmed. The caller refreshes the list and the counts. */
  onDone: (message: string) => Promise<void> | void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // State is too slow to stop a double click; the database is what makes a repeat harmless.
  const acting = useRef(false)

  const reject = kind === 'reject'
  const issue = reject ? rejectionReasonIssue(reason) : null

  const confirm = async () => {
    if (acting.current) return
    if (issue) { setError(issue); return }
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { data, error: rpcError } = reject
        ? await supabase.rpc('admin_reject_customer_review_custom_submission', {
          p_submission_id: row.id,
          p_reason: reason.trim(),
        })
        : await supabase.rpc('admin_delete_customer_review_custom_submission', {
          p_submission_id: row.id,
        })
      if (rpcError) {
        setError(customSubmissionErrorMessage(
          rpcError.message,
          reject ? 'That review could not be rejected.' : 'That review could not be deleted.',
        ))
        return
      }
      const result = data as { already_decided?: boolean; already_deleted?: boolean; credit_reversed?: boolean; credit_expired?: boolean } | null
      if (result == null) {
        // An answer with no body is not a confirmation.
        setError('The server did not confirm the change. Refresh the list to see where the review stands.')
        return
      }
      await onDone(reject
        ? adminRejectDoneMessage(row.submission_ref, employee, result)
        : adminDeleteDoneMessage(row.submission_ref, employee, result))
    } catch {
      setError('The request failed. Check your connection, then refresh the list before trying again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  return (
    <ReviewSheet
      title={reject ? 'Reject an approved review' : 'Delete this review'}
      subtitle={`${row.submission_ref} · ${employee}`}
      maxWidth="520px"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose() }}
      footer={(
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            onClick={onClose}
            disabled={busy}
            style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            onClick={() => { void confirm() }}
            disabled={busy || (reject && reason.trim() === '')}
            style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px', background: '#B91C1C', borderColor: '#B91C1C' }}
          >
            {busy
              ? (reject ? 'Rejecting…' : 'Deleting…')
              : (reject ? 'Confirm rejection' : 'Confirm delete')}
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {error && <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: colors.red }}>{error}</p>}

        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: colors.primary }}>
          {reject ? adminRejectWarning(row, employee) : adminDeleteWarning(row, employee)}
        </p>

        {reject && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>Reason for rejecting</span>
            <textarea
              value={reason}
              rows={3}
              maxLength={MAX_REJECTION_REASON_LENGTH}
              disabled={busy}
              autoFocus
              placeholder={ADMIN_REJECT_REASON_HINT}
              onChange={e => { setReason(e.target.value); setError(null) }}
              style={{
                width: '100%', padding: '9px 11px', borderRadius: '8px', fontSize: '13.5px', resize: 'vertical',
                border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
                fontFamily: 'inherit', boxSizing: 'border-box', minHeight: '80px',
              }}
            />
          </label>
        )}
      </div>
    </ReviewSheet>
  )
}
