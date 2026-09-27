'use client'

// "Attendance request" — one short form for late arrival, early departure,
// time out, half day and leave.
//
// Built for a phone and for a hurry: an urgent late arrival is type (already
// selected), reason (one tap), Submit. The date defaults to today in IST, the
// expected time is optional, and a note is required only for "Other".
//
// Used for corrections too: opened with `original`, it pre-fills and submits
// a replacement that points at the original, so the first submission stays in
// the audit trail.

import { useState } from 'react'
import { PayrollModal, PayrollModalActions, PayrollModalError, PayrollField } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import {
  REQUEST_TYPES,
  REQUEST_TYPE_LABEL,
  REASON_CODES,
  REASON_LABEL,
  NOTE_MAX_LENGTH,
  toClock,
  type AttendanceRequestRow,
  type RequestType,
  type ReasonCode,
} from '@/lib/attendance/requests'
import { istToday } from '@/lib/istDate'

export type RequestPayload = Record<string, unknown>

const chip = (active: boolean): React.CSSProperties => ({
  padding: '9px 12px',
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 600,
  border: `1px solid ${active ? colors.primary : colors.border}`,
  background: active ? colors.primary : colors.base,
  color: active ? '#fff' : colors.primary,
  cursor: 'pointer',
  minHeight: 40,
})

const input: React.CSSProperties = { padding: '10px 11px', fontSize: 15, width: '100%', minHeight: 42 }

export function AttendanceRequestModal({
  original, onClose, onSubmit,
}: {
  original?: AttendanceRequestRow | null
  onClose: () => void
  /** Resolves to an error message, or null when saved. */
  onSubmit: (payload: RequestPayload) => Promise<string | null>
}) {
  const [type, setType]       = useState<RequestType>(original?.request_type ?? 'late_arrival')
  const [date, setDate]       = useState(original?.start_date ?? istToday())
  const [endDate, setEndDate] = useState(original && original.end_date !== original.start_date ? original.end_date : '')
  const [expected, setExpected] = useState(toClock(original?.expected_arrival_time ?? null) ?? '')
  const [depart, setDepart]   = useState(toClock(original?.departure_time ?? null) ?? '')
  const [back, setBack]       = useState(toClock(original?.return_time ?? null) ?? '')
  const [half, setHalf]       = useState<'first_half' | 'second_half' | ''>(original?.half_session ?? '')
  const [kind, setKind]       = useState<'personal' | 'company' | ''>(original?.work_kind ?? '')
  const [reason, setReason]   = useState<ReasonCode | ''>(original?.reason_code ?? '')
  const [note, setNote]       = useState(original?.reason_note ?? '')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Only what the chosen type needs, so a switch never submits stale fields.
  const payload = (): RequestPayload => ({
    request_type: type,
    start_date: date,
    end_date: type === 'full_day_leave' && endDate ? endDate : null,
    expected_arrival_time: type === 'late_arrival' && expected ? expected : null,
    departure_time: type === 'early_departure' || type === 'time_out' ? depart : null,
    return_time: type === 'time_out' ? back : null,
    half_session: type === 'half_day' ? half : null,
    work_kind: type === 'time_out' ? kind : null,
    reason_code: reason,
    reason_note: note.trim() || null,
    replaces_request_id: original?.id ?? null,
  })

  const missing =
    !reason || !date ||
    (reason === 'other' && !note.trim()) ||
    (type === 'early_departure' && !depart) ||
    (type === 'time_out' && (!depart || !back || !kind)) ||
    (type === 'half_day' && !half)

  const submit = async () => {
    if (missing || saving) return
    setSaving(true)
    setError(null)
    const message = await onSubmit(payload())
    if (message) { setError(message); setSaving(false); return }
    onClose()
  }

  return (
    <PayrollModal
      title={original ? 'Correct attendance request' : 'Attendance request'}
      subtitle={original ? 'Your original request stays in the history.' : 'Tell us before your shift starts if you can.'}
      onClose={onClose}
      width={480}
    >
      {error && <PayrollModalError message={error} />}

      <div role="radiogroup" aria-label="Request type" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {REQUEST_TYPES.map(t => (
          <button key={t} type="button" role="radio" aria-checked={type === t}
            onClick={() => setType(t)} style={chip(type === t)}>
            {REQUEST_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: type === 'full_day_leave' ? '1fr 1fr' : '1fr', gap: 10 }}>
        <PayrollField label={type === 'full_day_leave' ? 'From' : 'Date'}>
          <input type="date" className="boe-input" style={input} value={date} onChange={e => setDate(e.target.value)} />
        </PayrollField>
        {type === 'full_day_leave' && (
          <PayrollField label="To (optional)" hint="Leave blank for one day.">
            <input type="date" className="boe-input" style={input} value={endDate} min={date} onChange={e => setEndDate(e.target.value)} />
          </PayrollField>
        )}
      </div>

      {type === 'late_arrival' && (
        <PayrollField label="Expected arrival (optional)">
          <input type="time" className="boe-input" style={input} value={expected} onChange={e => setExpected(e.target.value)} />
        </PayrollField>
      )}
      {type === 'early_departure' && (
        <PayrollField label="Leaving at">
          <input type="time" className="boe-input" style={input} value={depart} onChange={e => setDepart(e.target.value)} />
        </PayrollField>
      )}
      {type === 'time_out' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <PayrollField label="Leaving at">
              <input type="time" className="boe-input" style={input} value={depart} onChange={e => setDepart(e.target.value)} />
            </PayrollField>
            <PayrollField label="Back by">
              <input type="time" className="boe-input" style={input} value={back} onChange={e => setBack(e.target.value)} />
            </PayrollField>
          </div>
          <div role="radiogroup" aria-label="Personal or company work" style={{ display: 'flex', gap: 8 }}>
            {(['personal', 'company'] as const).map(k => (
              <button key={k} type="button" role="radio" aria-checked={kind === k}
                onClick={() => setKind(k)} style={chip(kind === k)}>
                {k === 'personal' ? 'Personal' : 'Company work'}
              </button>
            ))}
          </div>
        </>
      )}
      {type === 'half_day' && (
        <div role="radiogroup" aria-label="Which half" style={{ display: 'flex', gap: 8 }}>
          {(['first_half', 'second_half'] as const).map(h => (
            <button key={h} type="button" role="radio" aria-checked={half === h}
              onClick={() => setHalf(h)} style={chip(half === h)}>
              {h === 'first_half' ? 'First half' : 'Second half'}
            </button>
          ))}
        </div>
      )}

      <PayrollField label="Reason">
        <div role="radiogroup" aria-label="Reason" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {REASON_CODES.map(r => (
            <button key={r} type="button" role="radio" aria-checked={reason === r}
              onClick={() => setReason(r)} style={chip(reason === r)}>
              {REASON_LABEL[r]}
            </button>
          ))}
        </div>
      </PayrollField>

      <PayrollField label={reason === 'other' ? 'Note (required)' : 'Note (optional)'}>
        <textarea
          className="boe-input"
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          value={note}
          onChange={e => setNote(e.target.value)}
          style={{ ...input, resize: 'vertical', lineHeight: 1.45 }}
        />
      </PayrollField>

      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
        The time you submit is recorded by the server. Approval records permission;
        it does not by itself decide whether the missed time is paid.
      </div>

      <PayrollModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel={original ? 'Submit correction' : 'Submit request'}
        disabled={missing}
      />
    </PayrollModal>
  )
}
