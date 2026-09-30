'use client'

// Admin list of attendance requests: who, what, when, the reason, whether it was
// informed before the shift started, and its status. Review opens the request in
// a side panel (RequestReviewDrawer) where its history is read and the decision
// is made.
//
// Pending is the default because it is the work. Pending / Approved / Rejected /
// All are compact filters on this one list — not another row of page tabs — and
// each is one read of /api/attendance-requests, which also carries the actual
// punches for those dates, so there is no request per row.
//
// A slow answer to a filter the admin has already left is ignored, so the list
// can never show one status under another's heading.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  REQUEST_TYPE_LABEL,
  REQUEST_STATUS_LABEL,
  REASON_LABEL,
  requestSummary,
  submissionTiming,
  SUBMISSION_TIMING_LABEL,
} from '@/lib/attendance/requests'
import { formatMinutesOfDay } from '@/lib/istDate'
import { RequestReviewDrawer, actualPunchText, type Punch, type QueueRow, type Shift } from './RequestReviewDrawer'
import { formatIstDateTime, statusTone } from './format'
import { StatusFilter, StateBlock, Notice } from '@/components/attendancePayroll/ui'
import styles from './attendanceRequests.module.css'

const FILTERS = [
  { key: 'pending',  label: 'Pending',  empty: ['No pending requests', 'New attendance requests will appear here.'] },
  { key: 'approved', label: 'Approved', empty: ['No approved requests', 'Requests you approve will be listed here.'] },
  { key: 'rejected', label: 'Rejected', empty: ['No rejected requests', 'Requests you reject will be listed here.'] },
  { key: 'all',      label: 'All',      empty: ['No requests yet', 'Requests employees submit will be listed here.'] },
] as const
type FilterKey = (typeof FILTERS)[number]['key']

export function RequestQueue({ getToken, focusId = null }: {
  getToken: () => Promise<string | null>
  /** A request opened from a notification: listed under All, highlighted and opened. */
  focusId?: string | null
}) {
  const [filter, setFilter] = useState<FilterKey>(focusId ? 'all' : 'pending')
  const [rows, setRows] = useState<QueueRow[]>([])
  const [punches, setPunches] = useState<Record<string, Punch>>({})
  const [shift, setShift] = useState<Shift | null>(null)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The request the admin opened, and whether the notification's request has
  // already been dealt with (closed or decided), so it opens only once.
  const [picked, setPicked] = useState<QueueRow | null>(null)
  const [focusDone, setFocusDone] = useState(false)
  const latest = useRef(0)

  const load = useCallback(async (f: FilterKey) => {
    const ticket = ++latest.current
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`/api/attendance-requests?scope=queue&status=${f}`, { headers: { authorization: `Bearer ${token ?? ''}` } })
      const json = await res.json().catch(() => ({}))
      if (ticket !== latest.current) return
      if (!res.ok) setError(json.error ?? 'Could not load requests.')
      else {
        setRows(json.requests ?? [])
        setPunches(json.punches ?? {})
        setShift(json.shift ?? null)
        setViewerId(json.viewer_id ?? null)
        setError(null)
      }
    } catch {
      if (ticket === latest.current) setError('Could not reach the server. Check your connection and try again.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    const run = async () => { await load(filter) }
    void run()
  }, [filter, load])

  const decide = async (status: 'approved' | 'rejected', note: string): Promise<string | null> => {
    if (!reviewing) return null
    const target = reviewing
    const token = await getToken()
    const res = await fetch(`/api/attendance-requests/${target.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ status, note }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not save the decision.'
    closeReview()
    setNotice(`${target.employee?.full_name ?? 'Employee'}’s ${REQUEST_TYPE_LABEL[target.request_type].toLowerCase()} request was ${status}.`)
    await load(filter)
    return null
  }

  const current = FILTERS.find(f => f.key === filter)!
  const showEmpty = !loading && rows.length === 0 && !error
  const showRows = rows.length > 0

  const openReview = (r: QueueRow) => { setNotice(null); setPicked(r) }
  const closeReview = () => { setPicked(null); setFocusDone(true) }

  // A request a notification (or the salary review) pointed at: once it is
  // listed, bring it into view and open it once. Closing the drawer leaves the
  // list where it is; the highlight stays so the admin can see which one it was.
  // Opened by derivation, not by an effect: nothing to set once the row is listed.
  const focusRow = focusId && !focusDone && !loading ? rows.find(r => r.id === focusId) ?? null : null
  const reviewing = picked ?? focusRow
  useEffect(() => {
    if (!focusId || loading || !rows.some(r => r.id === focusId)) return
    const anchor = document.getElementById(`request-${focusId}`)
    const visible = anchor && anchor.offsetParent !== null ? anchor : document.getElementById(`request-mobile-${focusId}`)
    visible?.scrollIntoView({ block: 'center' })
  }, [focusId, loading, rows])

  return (
    <div>
      <div className={styles.toolbar}>
        <StatusFilter
          label="Filter requests by status"
          value={filter}
          options={FILTERS}
          onChange={key => { setNotice(null); setFilter(key) }}
        />
        {shift && (
          <span className={styles.shiftLabel}>
            Scheduled shift {formatMinutesOfDay(shift.scheduled_in_minutes)}–{formatMinutesOfDay(shift.scheduled_out_minutes)} IST
          </span>
        )}
      </div>

      {notice && <div style={{ marginBottom: 12 }}><Notice kind="success">{notice}</Notice></div>}

      {error && (
        <div style={{ marginBottom: 12 }}>
          <Notice
            kind="error"
            action={
              <button type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }} onClick={() => void load(filter)}>
                Try again
              </button>
            }
          >
            {error}
          </Notice>
        </div>
      )}

      {loading && !showRows && <StateBlock kind="loading">Loading requests…</StateBlock>}

      {showEmpty && <StateBlock kind="empty" title={current.empty[0]}>{current.empty[1]}</StateBlock>}

      {showRows && (
        <div aria-busy={loading} style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.12s' }}>
          {/* Desktop: a scannable table. */}
          <div className={`${styles.surface} ${styles.desktopOnly}`} style={{ overflow: 'hidden' }}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Employee</th>
                    <th scope="col">Request</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const tone = statusTone(r.status)
                    return (
                      <tr key={r.id} id={`request-${r.id}`} className={r.id === focusId ? styles.focusRow : undefined}>
                        <td>
                          <div className={styles.cellName}>{r.employee?.full_name ?? 'Employee'}</div>
                          <div className={styles.cellSub}>
                            {r.employee?.employee_code}
                            {r.employee && !r.employee.is_active && <span style={{ color: '#DC2626', fontWeight: 600 }}> · inactive</span>}
                          </div>
                        </td>
                        <td>
                          <div className={styles.cellName}>{REQUEST_TYPE_LABEL[r.request_type]}</div>
                          <div className={styles.cellSub}>{requestSummary(r)}</div>
                        </td>
                        <td className={styles.cellReason}>
                          <div className={styles.clamp}>{REASON_LABEL[r.reason_code]}{r.reason_note ? ` — ${r.reason_note}` : ''}</div>
                        </td>
                        <td>
                          <div>{formatIstDateTime(r.submitted_at)}</div>
                          <div className={styles.cellSub} style={{ color: submissionTiming(r) === 'before_shift' ? '#047857' : '#B45309', fontWeight: 600 }}>
                            {SUBMISSION_TIMING_LABEL[submissionTiming(r)]}
                          </div>
                        </td>
                        <td>
                          <span className={styles.badge} style={{ background: tone.bg, color: tone.fg }}>{REQUEST_STATUS_LABEL[r.status]}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className={`boe-btn ${r.status === 'pending' ? 'boe-btn-primary' : 'boe-btn-ghost'} ${styles.reviewBtn}`}
                            aria-label={`Review ${REQUEST_TYPE_LABEL[r.request_type].toLowerCase()} request from ${r.employee?.full_name ?? 'employee'}`}
                            onClick={() => openReview(r)}
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phone: one card per request. */}
          <ul className={styles.cards}>
            {rows.map(r => {
              const tone = statusTone(r.status)
              return (
                <li key={r.id} id={`request-mobile-${r.id}`} className={`${styles.surface} ${styles.card}${r.id === focusId ? ` ${styles.focusCard}` : ''}`}>
                  <div className={styles.cardHead}>
                    <div style={{ minWidth: 0 }}>
                      <div className={styles.cellName}>{r.employee?.full_name ?? 'Employee'}</div>
                      <div className={styles.cellSub}>
                        {r.employee?.employee_code}
                        {r.employee && !r.employee.is_active && <span style={{ color: '#DC2626', fontWeight: 600 }}> · inactive</span>}
                      </div>
                    </div>
                    <span className={styles.badge} style={{ background: tone.bg, color: tone.fg }}>{REQUEST_STATUS_LABEL[r.status]}</span>
                  </div>
                  <div style={{ fontSize: 13.5 }}>
                    <strong>{REQUEST_TYPE_LABEL[r.request_type]}</strong> · {requestSummary(r)}
                  </div>
                  <div className={styles.cellSub}>
                    {REASON_LABEL[r.reason_code]}{r.reason_note ? ` — ${r.reason_note}` : ''}
                  </div>
                  <div className={styles.cellSub}>
                    Submitted {formatIstDateTime(r.submitted_at)} ·{' '}
                    <span style={{ color: submissionTiming(r) === 'before_shift' ? '#047857' : '#B45309', fontWeight: 600 }}>
                      {SUBMISSION_TIMING_LABEL[submissionTiming(r)]}
                    </span>
                  </div>
                  <div className={styles.cellSub}>Actual: {actualPunchText(punches[`${r.employee_id}|${r.start_date}`])}</div>
                  <button
                    type="button"
                    className={`boe-btn ${r.status === 'pending' ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
                    style={{ minHeight: 44, justifyContent: 'center', fontSize: 14, marginTop: 4 }}
                    onClick={() => openReview(r)}
                  >
                    Review
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {reviewing && (
        <RequestReviewDrawer
          row={reviewing}
          punch={punches[`${reviewing.employee_id}|${reviewing.start_date}`]}
          shift={shift}
          own={reviewing.employee_id === viewerId}
          getToken={getToken}
          onClose={closeReview}
          onDecide={decide}
        />
      )}

    </div>
  )
}
