'use client'

// The attendance request form — one component for the full page an employee
// opens (/my-attendance/request) and the modal used to correct an earlier
// request, so the two cannot drift apart.
//
// Built for a phone and for a hurry: an urgent late arrival is type (already
// selected), reason (one tap), Submit. Only the fields the chosen type needs are
// shown, the date defaults to today in IST, the expected time is optional, and a
// note is required only for "Other". THE RULES ARE UNCHANGED — validation here
// mirrors validateRequestInput in src/lib/attendance/requests.ts, which the
// server runs again on every submit; this component only decides what to show
// and when to say what is missing.
//
// What the form guarantees the person filling it in:
//   • Nothing they typed is lost when a submit fails — the values live in state
//     and an error only adds a message above the button.
//   • A second tap while a submit is in flight does nothing (a ref, because
//     state would not update between two taps in the same frame).
//   • The Submit button is always enabled until sending; a form that says
//     nothing about why a button is dead is worse than one that names what is
//     missing.
//
// Identity is never asked for: the API takes the employee from the bearer token.

import { useRef, useState } from 'react'
import {
  REQUEST_TYPES,
  REQUEST_TYPE_LABEL,
  REASON_CODES,
  REASON_LABEL,
  MAX_DAYS_AHEAD,
  MAX_DAYS_BACK,
  NOTE_MAX_LENGTH,
  toClock,
  type AttendanceRequestRow,
  type RequestType,
  type ReasonCode,
} from '@/lib/attendance/requests'
import { formatMinutesOfDay, istAddDays, istToday } from '@/lib/istDate'
import styles from './attendanceRequests.module.css'

export type RequestPayload = Record<string, unknown>
export type ShiftContext = { scheduled_in_minutes: number; scheduled_out_minutes: number }

/** One line saying what each type is for — the label alone is not always enough on a phone. */
const TYPE_HINT: Record<RequestType, string> = {
  late_arrival:    'Arriving after the shift starts',
  early_departure: 'Leaving before the shift ends',
  time_out:        'Stepping out and coming back',
  half_day:        'First or second half',
  full_day_leave:  'One day or several',
}

export function AttendanceRequestForm({
  original, shift, variant, onSubmit, onSubmitted, onCancel,
}: {
  /** A correction pre-fills from this request and points back at it. */
  original?: AttendanceRequestRow | null
  /** The company working day, when known. Shown only beside the times it explains. */
  shift?: ShiftContext | null
  /** `page`: the full request page. `modal`: the correction dialog. */
  variant: 'page' | 'modal'
  /** Resolves to an error message, or null when saved. */
  onSubmit: (payload: RequestPayload) => Promise<string | null>
  /** Called after a successful submit. */
  onSubmitted: () => void
  /** Modal only — closes without submitting. */
  onCancel?: () => void
}) {
  const today = istToday()
  const [type, setType]       = useState<RequestType>(original?.request_type ?? 'late_arrival')
  const [date, setDate]       = useState(original?.start_date ?? today)
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
  const [tried, setTried]     = useState(false)
  const inFlight = useRef(false)

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

  // What is still missing, in the order the form asks for it.
  const missing = {
    date:   !date,
    depart: (type === 'early_departure' || type === 'time_out') && !depart,
    back:   type === 'time_out' && !back,
    kind:   type === 'time_out' && !kind,
    half:   type === 'half_day' && !half,
    reason: !reason,
    note:   reason === 'other' && !note.trim(),
  }
  const problems: string[] = [
    missing.date   && 'the date',
    missing.half   && 'which half',
    missing.depart && 'the time you leave',
    missing.back   && 'the time you return',
    missing.kind   && 'personal or company work',
    missing.reason && 'a reason',
    missing.note   && 'a note for “Other”',
  ].filter((p): p is string => !!p)

  const submit = async () => {
    if (inFlight.current) return
    if (problems.length > 0) {
      setTried(true)
      setError(`Still needed: ${problems.join(', ')}.`)
      return
    }
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const message = await onSubmit(payload())
      if (message) { setError(message); return }
      onSubmitted()
    } catch {
      // A dropped connection is a message, not a lost form.
      setError('Could not reach the server. Your entries are kept — check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const invalid = (isMissing: boolean) => (tried && isMissing ? true : undefined)

  const shiftLine = shift && (() => {
    const start = formatMinutesOfDay(shift.scheduled_in_minutes)
    const end = formatMinutesOfDay(shift.scheduled_out_minutes)
    switch (type) {
      case 'late_arrival':    return `Your shift starts at ${start}.`
      case 'early_departure': return `Your shift ends at ${end}.`
      case 'time_out':        return `Times must fall within your shift, ${start}–${end}.`
      default:                return null
    }
  })()

  return (
    <form
      className={`${styles.form}${variant === 'page' ? ` ${styles.pageForm}` : ''}`}
      onSubmit={e => { e.preventDefault(); void submit() }}
      noValidate
    >
      {error && <div role="alert" className={styles.alert}>{error}</div>}

      <fieldset className={styles.group}>
        <legend className={styles.label}>Request type</legend>
        <div role="radiogroup" aria-label="Request type" className={styles.typeGrid}>
          {REQUEST_TYPES.map(t => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={`${styles.typeCard}${type === t ? ` ${styles.typeCardActive}` : ''}`}
            >
              <span className={styles.typeName}>{REQUEST_TYPE_LABEL[t]}</span>
              <span className={styles.typeHint}>{TYPE_HINT[t]}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className={styles.fields}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ar-date">{type === 'full_day_leave' ? 'From' : 'Date'}</label>
          <input
            id="ar-date" type="date" className={styles.input}
            value={date} min={istAddDays(today, -MAX_DAYS_BACK)} max={istAddDays(today, MAX_DAYS_AHEAD)}
            aria-invalid={invalid(missing.date)}
            onChange={e => setDate(e.target.value)}
          />
        </div>

        {type === 'full_day_leave' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ar-end">To <span className={styles.optional}>(optional)</span></label>
            <input
              id="ar-end" type="date" className={styles.input}
              value={endDate} min={date}
              onChange={e => setEndDate(e.target.value)}
            />
            <span className={styles.hint}>Leave blank for one day.</span>
          </div>
        )}

        {type === 'late_arrival' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ar-expected">Expected arrival <span className={styles.optional}>(optional)</span></label>
            <input id="ar-expected" type="time" className={styles.input} value={expected} onChange={e => setExpected(e.target.value)} />
          </div>
        )}

        {type === 'early_departure' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ar-depart">Leaving at</label>
            <input
              id="ar-depart" type="time" className={styles.input} value={depart}
              aria-invalid={invalid(missing.depart)} onChange={e => setDepart(e.target.value)}
            />
          </div>
        )}

        {type === 'time_out' && (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ar-depart">Leaving at</label>
              <input
                id="ar-depart" type="time" className={styles.input} value={depart}
                aria-invalid={invalid(missing.depart)} onChange={e => setDepart(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ar-back">Back by</label>
              <input
                id="ar-back" type="time" className={styles.input} value={back}
                aria-invalid={invalid(missing.back)} onChange={e => setBack(e.target.value)}
              />
            </div>
          </>
        )}

        {shiftLine && <div className={`${styles.shiftNote} ${styles.fieldFull}`}>{shiftLine}</div>}
      </div>

      {type === 'time_out' && (
        <fieldset className={styles.group}>
          <legend className={styles.label}>Personal or company work</legend>
          <div role="radiogroup" aria-label="Personal or company work" className={styles.chips}>
            {(['personal', 'company'] as const).map(k => (
              <button
                key={k} type="button" role="radio" aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={`${styles.chip}${kind === k ? ` ${styles.chipActive}` : ''}`}
              >
                {k === 'personal' ? 'Personal' : 'Company work'}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {type === 'half_day' && (
        <fieldset className={styles.group}>
          <legend className={styles.label}>Which half</legend>
          <div role="radiogroup" aria-label="Which half" className={styles.chips}>
            {(['first_half', 'second_half'] as const).map(h => (
              <button
                key={h} type="button" role="radio" aria-checked={half === h}
                onClick={() => setHalf(h)}
                className={`${styles.chip}${half === h ? ` ${styles.chipActive}` : ''}`}
              >
                {h === 'first_half' ? 'First half' : 'Second half'}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className={styles.group}>
        <legend className={styles.label}>Reason</legend>
        <div role="radiogroup" aria-label="Reason" className={styles.chips}>
          {REASON_CODES.map(r => (
            <button
              key={r} type="button" role="radio" aria-checked={reason === r}
              onClick={() => setReason(r)}
              className={`${styles.chip}${reason === r ? ` ${styles.chipActive}` : ''}`}
            >
              {REASON_LABEL[r]}
            </button>
          ))}
        </div>
      </fieldset>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ar-note">
          Note {reason === 'other' ? '(required)' : <span className={styles.optional}>(optional)</span>}
        </label>
        <textarea
          id="ar-note" className={styles.input} rows={3} maxLength={NOTE_MAX_LENGTH}
          value={note} aria-invalid={invalid(missing.note)}
          onChange={e => setNote(e.target.value)}
        />
      </div>

      <p className={styles.footnote}>
        The time you submit is recorded by the server. Approval records permission;
        it does not by itself decide whether the missed time is paid.
      </p>

      <div className={styles.actions}>
        {variant === 'modal' && onCancel && (
          <button type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: 44, padding: '0 18px', fontSize: 14 }} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className={`boe-btn boe-btn-primary ${styles.submit}`}
          disabled={saving}
        >
          {saving ? 'Submitting…' : original ? 'Submit correction' : 'Submit request'}
        </button>
      </div>
    </form>
  )
}
