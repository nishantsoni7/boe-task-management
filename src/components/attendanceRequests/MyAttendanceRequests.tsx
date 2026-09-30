'use client'

// The employee's own attendance requests on /my-attendance: the one obvious
// entry point ("Attendance request", a link to its own page), their recent
// requests with status, reviewer and time, and Correct / Cancel / History.
//
// Everything is read through /api/attendance-requests, which pins the list to
// the caller's own rows whatever this component asks for.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  REQUEST_TYPE_LABEL,
  REQUEST_STATUS_LABEL,
  REASON_LABEL,
  requestSummary,
  canEmployeeCancel,
  canEmployeeCorrect,
  type AttendanceRequestRow,
} from '@/lib/attendance/requests'
import { AttendanceRequestModal, type RequestPayload } from './AttendanceRequestModal'
import type { ShiftContext } from './AttendanceRequestForm'
import { RequestHistoryModal } from './RequestHistoryModal'
import { formatIstDateTime, statusTone } from './format'
import styles from './attendanceRequests.module.css'

type Row = AttendanceRequestRow & { decider?: { full_name: string | null } | null }

const COLLAPSED = 5

export function MyAttendanceRequests({ getToken }: { getToken: () => Promise<string | null> }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shift, setShift] = useState<ShiftContext | null>(null)
  const [correcting, setCorrecting] = useState<Row | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token) return
    const res = await fetch('/api/attendance-requests', { headers: { authorization: `Bearer ${token}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Could not load your requests.')
    else { setRows(json.requests ?? []); setShift(json.shift ?? null); setError(null) }
    setLoaded(true)
  }, [getToken])

  useEffect(() => {
    const run = async () => { await load() }
    void run()
  }, [load])

  // Used by the correction dialog only; a NEW request is submitted from its own
  // page (/my-attendance/request).
  const submit = async (payload: RequestPayload): Promise<string | null> => {
    const token = await getToken()
    const res = await fetch('/api/attendance-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not submit your request.'
    await load()
    return null
  }

  const cancel = async (r: Row) => {
    if (!window.confirm(`Cancel your ${REQUEST_TYPE_LABEL[r.request_type].toLowerCase()} request for ${r.start_date}?`)) return
    setBusyId(r.id)
    const token = await getToken()
    const res = await fetch(`/api/attendance-requests/${r.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      body: '{}',
    })
    const json = await res.json().catch(() => ({}))
    setBusyId(null)
    if (!res.ok) { setError(json.error ?? 'Could not cancel the request.'); return }
    await load()
  }

  const now = new Date().toISOString()
  const visible = showAll ? rows : rows.slice(0, COLLAPSED)

  return (
    <section id="my-requests" aria-labelledby="my-requests-heading" className={`${styles.surface} ${styles.mine}`}>
      <div className={styles.mineHead}>
        <div>
          <div id="my-requests-heading" className={styles.mineTitle}>My requests</div>
          <div className={styles.mineSub}>Late, early, time out, half day or leave</div>
        </div>
        <Link href="/my-attendance/request" className={`boe-btn boe-btn-primary ${styles.newBtn}`}>
          Attendance request
        </Link>
      </div>

      {error && (
        <div role="alert" className={styles.alert} style={{ marginTop: 10 }}>{error}</div>
      )}

      {!loaded && !error && (
        <div className={styles.mineMeta} style={{ marginTop: 10 }}>Loading your requests…</div>
      )}

      {loaded && rows.length === 0 && !error && (
        <div className={styles.mineMeta} style={{ marginTop: 10 }}>
          No requests yet. Use “Attendance request” to tell us about a late arrival, early departure, time out, half day or leave.
        </div>
      )}

      {visible.length > 0 && (
        <ul className={styles.mineList}>
          {visible.map(r => {
            const tone = statusTone(r.status)
            return (
              <li key={r.id} className={styles.mineItem}>
                <div className={styles.mineRow}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111318' }}>
                    {REQUEST_TYPE_LABEL[r.request_type]}
                  </div>
                  <span className={styles.badge} style={{ background: tone.bg, color: tone.fg }}>
                    {REQUEST_STATUS_LABEL[r.status]}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: '#111318' }}>{requestSummary(r)}</div>
                <div className={styles.mineMeta}>
                  {REASON_LABEL[r.reason_code]}{r.reason_note ? ` — ${r.reason_note}` : ''}
                </div>
                <div className={styles.mineMeta}>
                  Submitted {formatIstDateTime(r.submitted_at)}
                  {' · '}{r.informed_before_shift ? 'before shift start' : 'after shift start'}
                </div>
                {r.decided_at && (r.status === 'approved' || r.status === 'rejected') && (
                  <div className={styles.mineMeta}>
                    {REQUEST_STATUS_LABEL[r.status]} by {r.decider?.full_name ?? 'Admin'} · {formatIstDateTime(r.decided_at)}
                    {r.decision_note ? ` — ${r.decision_note}` : ''}
                  </div>
                )}
                {r.status === 'cancelled' && r.cancel_reason && (
                  <div className={styles.mineMeta}>{r.cancel_reason}</div>
                )}
                <div className={styles.rowActions}>
                  {canEmployeeCorrect(r, now) && (
                    <button type="button" className={`boe-btn boe-btn-ghost ${styles.rowBtn}`}
                      onClick={() => setCorrecting(r)}>Correct</button>
                  )}
                  {canEmployeeCancel(r, now) && (
                    <button type="button" className={`boe-btn boe-btn-ghost ${styles.rowBtn}`}
                      disabled={busyId === r.id} onClick={() => void cancel(r)}>Cancel</button>
                  )}
                  <button type="button" className={`boe-btn boe-btn-ghost ${styles.rowBtn}`}
                    onClick={() => setHistoryId(r.id)}>History</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {rows.length > COLLAPSED && (
        <button type="button" className={`boe-btn boe-btn-ghost ${styles.rowBtn}`} style={{ marginTop: 8 }}
          onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}

      {correcting && (
        <AttendanceRequestModal
          original={correcting}
          shift={shift}
          onClose={() => setCorrecting(null)}
          onSubmit={submit}
        />
      )}
      {historyId && (
        <RequestHistoryModal requestId={historyId} getToken={getToken} onClose={() => setHistoryId(null)} />
      )}
    </section>
  )
}
