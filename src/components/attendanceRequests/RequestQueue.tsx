'use client'

// Admin queue of attendance requests: who, what, when, the scheduled shift,
// whether it was informed before the shift started, and the actual punches for
// that date. Approve, or reject with a reason; a decided request can be
// revised with a reason. Every change is recorded by the database trigger.
//
// One list read carries the punches too — no request per row.

import { useCallback, useEffect, useState } from 'react'
import { colors } from '@/lib/tokens'
import {
  REQUEST_TYPE_LABEL,
  REQUEST_STATUS_LABEL,
  REASON_LABEL,
  requestSummary,
  type AttendanceRequestRow,
} from '@/lib/attendance/requests'
import { formatMinutesOfDay, istClockOf } from '@/lib/istDate'
import { PayrollModal, PayrollModalActions, PayrollModalError, PayrollField } from '@/components/payroll/PayrollModal'
import { RequestHistoryModal } from './RequestHistoryModal'
import { formatIstDateTime, statusTone } from './format'

type QueueRow = AttendanceRequestRow & {
  employee?: { full_name: string | null; employee_code: string | null; is_active: boolean } | null
  decider?: { full_name: string | null } | null
}
type Punch = { check_in_at: string | null; check_out_at: string | null; corrected: boolean }
type Shift = { scheduled_in_minutes: number; scheduled_out_minutes: number }

const FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
] as const

export function RequestQueue({ getToken }: { getToken: () => Promise<string | null> }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('pending')
  const [rows, setRows] = useState<QueueRow[]>([])
  const [punches, setPunches] = useState<Record<string, Punch>>({})
  const [shift, setShift] = useState<Shift | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<{ row: QueueRow; status: 'approved' | 'rejected' } | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)

  const load = useCallback(async (f: string) => {
    const token = await getToken()
    setLoading(true)
    const res = await fetch(`/api/attendance-requests?scope=queue&status=${f}`, { headers: { authorization: `Bearer ${token ?? ''}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Could not load requests.')
    else {
      setRows(json.requests ?? [])
      setPunches(json.punches ?? {})
      setShift(json.shift ?? null)
      setError(null)
    }
    setLoading(false)
  }, [getToken])

  useEffect(() => {
    const run = async () => { await load(filter) }
    void run()
  }, [filter, load])

  const decide = async (note: string): Promise<string | null> => {
    if (!deciding) return null
    const token = await getToken()
    const res = await fetch(`/api/attendance-requests/${deciding.row.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ status: deciding.status, note }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not save the decision.'
    await load(filter)
    return null
  }

  return (
    <div>
      <div role="tablist" aria-label="Status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map(f => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} type="button"
            className={filter === f.key ? 'boe-btn boe-btn-primary' : 'boe-btn boe-btn-ghost'}
            style={{ padding: '6px 12px', fontSize: 12.5 }}
            onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
        {shift && (
          <span style={{ fontSize: 12, color: colors.muted, alignSelf: 'center', marginLeft: 6 }}>
            Scheduled shift {formatMinutesOfDay(shift.scheduled_in_minutes)}–{formatMinutesOfDay(shift.scheduled_out_minutes)} IST
          </span>
        )}
      </div>

      {error && <div role="alert" style={{ color: '#DC2626', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ fontSize: 13, color: colors.muted }}>Loading…</div>}
      {!loading && rows.length === 0 && !error && (
        <div style={{ fontSize: 13, color: colors.muted, padding: '20px 0' }}>Nothing here.</div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(r => {
          const tone = statusTone(r.status)
          const p = punches[`${r.employee_id}|${r.start_date}`]
          return (
            <li key={r.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12, background: colors.base }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>
                  {r.employee?.full_name ?? 'Employee'}
                  {r.employee?.employee_code && <span style={{ fontWeight: 400, color: colors.muted }}> · {r.employee.employee_code}</span>}
                  {r.employee && !r.employee.is_active && <span style={{ color: '#DC2626', fontWeight: 600 }}> · inactive</span>}
                </div>
                <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: tone.bg, color: tone.fg }}>
                  {REQUEST_STATUS_LABEL[r.status]}
                </span>
              </div>
              <div style={{ fontSize: 13, color: colors.primary, marginTop: 4 }}>
                <strong>{REQUEST_TYPE_LABEL[r.request_type]}</strong> · {requestSummary(r)}
              </div>
              <div style={{ fontSize: 12.5, color: colors.tertiary, marginTop: 2 }}>
                {REASON_LABEL[r.reason_code]}{r.reason_note ? ` — ${r.reason_note}` : ''}
              </div>
              <div style={{ fontSize: 12, color: colors.muted, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>Submitted {formatIstDateTime(r.submitted_at)}</span>
                <span style={{ color: r.informed_before_shift ? '#059669' : '#B45309', fontWeight: 600 }}>
                  {r.informed_before_shift ? 'Informed before shift' : 'After shift start'}
                </span>
                <span>
                  Actual: {p
                    ? `${p.check_in_at ? istClockOf(p.check_in_at) : '—'} → ${p.check_out_at ? istClockOf(p.check_out_at) : '—'}${p.corrected ? ' (corrected)' : ''}`
                    : 'no punches recorded'}
                </span>
              </div>
              {r.decided_at && (
                <div style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>
                  {REQUEST_STATUS_LABEL[r.status]} by {r.decider?.full_name ?? 'Admin'} · {formatIstDateTime(r.decided_at)}
                  {r.decision_note ? ` — ${r.decision_note}` : ''}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {r.status !== 'cancelled' && r.status !== 'approved' && (
                  <button type="button" className="boe-btn boe-btn-primary" style={{ padding: '7px 14px', fontSize: 13 }}
                    onClick={() => setDeciding({ row: r, status: 'approved' })}>
                    {r.status === 'rejected' ? 'Change to approved' : 'Approve'}
                  </button>
                )}
                {r.status !== 'cancelled' && r.status !== 'rejected' && (
                  <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '7px 14px', fontSize: 13 }}
                    onClick={() => setDeciding({ row: r, status: 'rejected' })}>
                    {r.status === 'approved' ? 'Change to rejected' : 'Reject'}
                  </button>
                )}
                <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '7px 14px', fontSize: 13 }}
                  onClick={() => setHistoryId(r.id)}>History</button>
              </div>
            </li>
          )
        })}
      </ul>

      {deciding && (
        <DecisionModal
          row={deciding.row}
          status={deciding.status}
          onClose={() => setDeciding(null)}
          onSubmit={decide}
        />
      )}
      {historyId && <RequestHistoryModal requestId={historyId} getToken={getToken} onClose={() => setHistoryId(null)} />}
    </div>
  )
}

function DecisionModal({
  row, status, onClose, onSubmit,
}: {
  row: QueueRow
  status: 'approved' | 'rejected'
  onClose: () => void
  onSubmit: (note: string) => Promise<string | null>
}) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revising = row.status !== 'pending'
  const noteRequired = status === 'rejected' || revising

  const save = async () => {
    if (saving || (noteRequired && !note.trim())) return
    setSaving(true)
    const msg = await onSubmit(note.trim())
    if (msg) { setError(msg); setSaving(false); return }
    onClose()
  }

  return (
    <PayrollModal
      title={status === 'approved' ? (revising ? 'Change to approved' : 'Approve request') : (revising ? 'Change to rejected' : 'Reject request')}
      subtitle={`${row.employee?.full_name ?? 'Employee'} · ${REQUEST_TYPE_LABEL[row.request_type]} · ${requestSummary(row)}`}
      onClose={onClose}
      width={440}
    >
      {error && <PayrollModalError message={error} />}
      <PayrollField label={noteRequired ? 'Reason (required)' : 'Note (optional)'}>
        <textarea className="boe-input" rows={3} maxLength={500} value={note} autoFocus
          onChange={e => setNote(e.target.value)} style={{ padding: '9px 11px', fontSize: 14, resize: 'vertical' }} />
      </PayrollField>
      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
        This records permission only. Whether any missed time is paid is decided in the
        payroll review, and pay changes only through an attendance correction.
      </div>
      <PayrollModalActions onClose={onClose} onSave={save} saving={saving}
        saveLabel={status === 'approved' ? 'Approve' : 'Reject'} disabled={noteRequired && !note.trim()} />
    </PayrollModal>
  )
}
