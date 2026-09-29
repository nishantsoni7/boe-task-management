'use client'

// The employee's own attendance requests on /my-attendance: the one obvious
// entry point ("Attendance request"), their recent requests with status,
// reviewer and time, and Correct / Cancel / History.
//
// Everything is read through /api/attendance-requests, which pins the list to
// the caller's own rows whatever this component asks for.

import { useCallback, useEffect, useState } from 'react'
import { colors } from '@/lib/tokens'
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
import { RequestHistoryModal } from './RequestHistoryModal'
import { formatIstDateTime, statusTone } from './format'

type Row = AttendanceRequestRow & { decider?: { full_name: string | null } | null }

const COLLAPSED = 5

export function MyAttendanceRequests({ getToken }: { getToken: () => Promise<string | null> }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formFor, setFormFor] = useState<Row | 'new' | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token) return
    const res = await fetch('/api/attendance-requests', { headers: { authorization: `Bearer ${token}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Could not load your requests.')
    else { setRows(json.requests ?? []); setError(null) }
    setLoaded(true)
  }, [getToken])

  useEffect(() => {
    const run = async () => { await load() }
    void run()
  }, [load])

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
    <section aria-labelledby="my-requests-heading" style={{
      border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.base,
      padding: 14, marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div id="my-requests-heading" style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>
            My requests
          </div>
          <div style={{ fontSize: 12, color: colors.tertiary }}>
            Late, early, time out, half day or leave
          </div>
        </div>
        <button
          type="button"
          onClick={() => setFormFor('new')}
          className="boe-btn boe-btn-primary"
          style={{ padding: '10px 16px', fontSize: 14, fontWeight: 600, minHeight: 44 }}
        >
          Attendance request
        </button>
      </div>

      {error && (
        <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: '#DC2626' }}>{error}</div>
      )}

      {loaded && rows.length === 0 && !error && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: colors.muted }}>No requests yet.</div>
      )}

      {visible.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visible.map(r => {
            const tone = statusTone(r.status)
            return (
              <li key={r.id} style={{
                border: `1px solid ${colors.border}`, borderRadius: 10, padding: '10px 12px',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: colors.primary }}>
                    {REQUEST_TYPE_LABEL[r.request_type]}
                  </div>
                  <span style={{
                    fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: tone.bg, color: tone.fg, whiteSpace: 'nowrap',
                  }}>
                    {REQUEST_STATUS_LABEL[r.status]}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: colors.primary }}>{requestSummary(r)}</div>
                <div style={{ fontSize: 12, color: colors.tertiary }}>
                  {REASON_LABEL[r.reason_code]}{r.reason_note ? ` — ${r.reason_note}` : ''}
                </div>
                <div style={{ fontSize: 11.5, color: colors.muted }}>
                  Submitted {formatIstDateTime(r.submitted_at)}
                  {' · '}{r.informed_before_shift ? 'before shift start' : 'after shift start'}
                </div>
                {r.decided_at && (r.status === 'approved' || r.status === 'rejected') && (
                  <div style={{ fontSize: 11.5, color: colors.muted }}>
                    {REQUEST_STATUS_LABEL[r.status]} by {r.decider?.full_name ?? 'Admin'} · {formatIstDateTime(r.decided_at)}
                    {r.decision_note ? ` — ${r.decision_note}` : ''}
                  </div>
                )}
                {r.status === 'cancelled' && r.cancel_reason && (
                  <div style={{ fontSize: 11.5, color: colors.muted }}>{r.cancel_reason}</div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                  {canEmployeeCorrect(r, now) && (
                    <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }}
                      onClick={() => setFormFor(r)}>Correct</button>
                  )}
                  {canEmployeeCancel(r, now) && (
                    <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }}
                      disabled={busyId === r.id} onClick={() => void cancel(r)}>Cancel</button>
                  )}
                  <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }}
                    onClick={() => setHistoryId(r.id)}>History</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {rows.length > COLLAPSED && (
        <button type="button" className="boe-btn boe-btn-ghost" style={{ marginTop: 8, padding: '6px 12px', fontSize: 12.5 }}
          onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}

      {formFor && (
        <AttendanceRequestModal
          original={formFor === 'new' ? null : formFor}
          onClose={() => setFormFor(null)}
          onSubmit={submit}
        />
      )}
      {historyId && (
        <RequestHistoryModal requestId={historyId} getToken={getToken} onClose={() => setHistoryId(null)} />
      )}
    </section>
  )
}
