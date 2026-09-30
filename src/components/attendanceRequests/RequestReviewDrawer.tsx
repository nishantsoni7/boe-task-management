'use client'

// The panel an admin reviews ONE attendance request in: everything already known
// about it, its audit history, and the decision.
//
// It is the Approve / Reject dialog that used to open over the queue, moved into
// a side panel so the request can be read while it is decided (the list stays
// put behind it, and a phone gets a full-width sheet). NOTHING ABOUT THE RULES
// CHANGED:
//   • the admin who raised a request cannot decide it (the route refuses too);
//   • rejecting needs a reason, and so does changing an earlier decision;
//   • approval records permission only — pay is decided in the payroll review;
//   • every change is written to the audit trail by the database trigger, which
//     this panel shows.
//
// It follows the BOE Form Modal Dismissal Rule (src/lib/ui/modalDismissal.ts):
// Escape, ✕ and Back close it; a click on the dimmed page does nothing; a
// failed save keeps it open with the remark intact; Tab cannot leave it and
// focus returns to whatever opened it.

import { useEffect, useId, useRef, useState } from 'react'
import {
  REQUEST_TYPE_LABEL,
  REQUEST_STATUS_LABEL,
  REASON_LABEL,
  requestSummary,
  submissionTiming,
  SUBMISSION_TIMING_LABEL,
  type AttendanceRequestRow,
} from '@/lib/attendance/requests'
import { formatMinutesOfDay, istClockOf } from '@/lib/istDate'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'
import { useScrollLock } from '@/hooks/useScrollLock'
import { RequestHistoryList } from './RequestHistoryModal'
import { formatIstDateTime, statusTone } from './format'
import styles from './attendanceRequests.module.css'

export type QueueRow = AttendanceRequestRow & {
  employee?: { full_name: string | null; employee_code: string | null; is_active: boolean } | null
  decider?: { full_name: string | null } | null
}
export type Punch = { check_in_at: string | null; check_out_at: string | null; corrected: boolean }
export type Shift = { scheduled_in_minutes: number; scheduled_out_minutes: number }

export function actualPunchText(p: Punch | undefined): string {
  return p
    ? `${p.check_in_at ? istClockOf(p.check_in_at) : '—'} → ${p.check_out_at ? istClockOf(p.check_out_at) : '—'}${p.corrected ? ' (corrected)' : ''}`
    : 'No punches recorded'
}

export function RequestReviewDrawer({
  row, punch, shift, own, getToken, onClose, onDecide,
}: {
  row: QueueRow
  punch: Punch | undefined
  shift: Shift | null
  /** The signed-in admin raised this request, so somebody else must decide it. */
  own: boolean
  getToken: () => Promise<string | null>
  onClose: () => void
  /** Resolves to an error message, or null when the decision was saved. */
  onDecide: (status: 'approved' | 'rejected', note: string) => Promise<string | null>
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [mode, setMode] = useState<'approved' | 'rejected' | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  useScrollLock()

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => { previouslyFocused?.focus?.() }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!saving && shouldCloseFormModal('escape')) onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = panelRef.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      const target = resolveTrapTarget({
        count: focusables.length,
        activeIndex: focusables.indexOf(document.activeElement as HTMLElement),
        shiftKey: e.shiftKey,
      })
      if (target === null) return
      e.preventDefault()
      if (target === 'block') { root.focus(); return }
      focusables[target === 'first' ? 0 : focusables.length - 1]?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, saving])

  const revising = row.status !== 'pending'
  const noteRequired = mode === 'rejected' || revising
  const tone = statusTone(row.status)
  const canApprove = !own && row.status !== 'cancelled' && row.status !== 'approved'
  const canReject  = !own && row.status !== 'cancelled' && row.status !== 'rejected'

  const confirm = async () => {
    if (!mode || inFlight.current) return
    if (noteRequired && !note.trim()) { setError('Add a reason — it is kept in the audit history.'); return }
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const message = await onDecide(mode, note.trim())
      if (message) setError(message)
      // On success the parent closes the drawer.
    } catch {
      setError('Could not reach the server. Your remark is kept — try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const employee = row.employee
  const actionLabel = mode === 'approved'
    ? (revising ? 'Change to approved' : 'Approve')
    : (revising ? 'Change to rejected' : 'Reject')

  return (
    <>
      {/* Dims the page. Deliberately no click handler: it never dismisses. */}
      <div className={styles.drawerScrim} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.drawer}
      >
        <div className={styles.drawerHead}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className={styles.drawerTitle}>{employee?.full_name ?? 'Employee'}</h2>
            <div className={styles.cellSub} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{REQUEST_TYPE_LABEL[row.request_type]}</span>
              <span className={styles.badge} style={{ background: tone.bg, color: tone.fg }}>{REQUEST_STATUS_LABEL[row.status]}</span>
            </div>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={() => { if (!saving && shouldCloseFormModal('close-icon')) onClose() }}
          >✕</button>
        </div>

        <div className={styles.drawerBody}>
          {error && <div role="alert" className={styles.alert}>{error}</div>}

          <dl className={styles.facts}>
            <dt>Employee</dt>
            <dd>
              {employee?.full_name ?? 'Employee'}
              {employee?.employee_code && <span style={{ color: '#6B7384' }}> · {employee.employee_code}</span>}
              {employee && !employee.is_active && <span style={{ color: '#DC2626', fontWeight: 600 }}> · inactive</span>}
            </dd>
            <dt>Request</dt>
            <dd>{REQUEST_TYPE_LABEL[row.request_type]}</dd>
            <dt>When</dt>
            <dd>{requestSummary(row)}</dd>
            <dt>Reason</dt>
            <dd>{REASON_LABEL[row.reason_code]}{row.reason_note ? ` — ${row.reason_note}` : ''}</dd>
            <dt>Submitted</dt>
            <dd>
              {formatIstDateTime(row.submitted_at)}
              {' · '}
              <span style={{ color: submissionTiming(row) === 'before_shift' ? '#047857' : '#B45309', fontWeight: 600 }}>
                {SUBMISSION_TIMING_LABEL[submissionTiming(row)]}
              </span>
            </dd>
            {shift && (
              <>
                <dt>Scheduled shift</dt>
                <dd>{formatMinutesOfDay(shift.scheduled_in_minutes)}–{formatMinutesOfDay(shift.scheduled_out_minutes)} IST</dd>
              </>
            )}
            <dt>Actual punches</dt>
            <dd>{actualPunchText(punch)}</dd>
            {row.decided_at && (row.status === 'approved' || row.status === 'rejected') && (
              <>
                <dt>Decision</dt>
                <dd>
                  {REQUEST_STATUS_LABEL[row.status]} by {row.decider?.full_name ?? 'Admin'} · {formatIstDateTime(row.decided_at)}
                  {row.decision_note ? ` — ${row.decision_note}` : ''}
                </dd>
              </>
            )}
          </dl>

          {mode ? (
            <div>
              <label className={styles.label} htmlFor="review-note">
                {noteRequired ? 'Reason (required)' : <>Note <span className={styles.optional}>(optional)</span></>}
              </label>
              <textarea
                id="review-note" className={styles.input} rows={4} maxLength={500} value={note} autoFocus
                onChange={e => setNote(e.target.value)} style={{ marginTop: 6 }}
              />
              <p className={styles.footnote} style={{ margin: '8px 0 0' }}>
                This records permission only. Whether any missed time is paid is decided in the
                payroll review, and pay changes only through an attendance correction.
              </p>
            </div>
          ) : (
            <section>
              <h3 className={styles.sectionTitle}>History</h3>
              <RequestHistoryList requestId={row.id} getToken={getToken} />
            </section>
          )}

          {own && row.status !== 'cancelled' && (
            <div className={styles.shiftNote} style={{ color: '#B45309' }}>
              Your own request — another admin must decide it.
            </div>
          )}
        </div>

        <div className={styles.drawerFoot}>
          {mode ? (
            <>
              <button
                type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: 44, padding: '0 18px', fontSize: 14 }}
                disabled={saving} onClick={() => { setMode(null); setError(null) }}
              >
                Back
              </button>
              <button
                type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 44, padding: '0 20px', fontSize: 14 }}
                disabled={saving || (noteRequired && !note.trim())}
                onClick={() => void confirm()}
              >
                {saving ? 'Saving…' : actionLabel}
              </button>
            </>
          ) : (
            <>
              {canReject && (
                <button
                  type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: 44, padding: '0 18px', fontSize: 14 }}
                  onClick={() => { setMode('rejected'); setError(null) }}
                >
                  {row.status === 'approved' ? 'Change to rejected' : 'Reject'}
                </button>
              )}
              {canApprove && (
                <button
                  type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 44, padding: '0 20px', fontSize: 14 }}
                  onClick={() => { setMode('approved'); setError(null) }}
                >
                  {row.status === 'rejected' ? 'Change to approved' : 'Approve'}
                </button>
              )}
              {!canApprove && !canReject && (
                <button
                  type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: 44, padding: '0 18px', fontSize: 14 }}
                  onClick={onClose}
                >
                  Close
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
