'use client'

// "Attendance request" — the one form for leave, coming late, leaving early and
// going out briefly. Phone first: a full-screen sheet with one scrolling body
// and a "Send request" button that stays reachable; on a desktop a compact
// centred dialog (see PayrollModal `sheet`).
//
// The four tiles are only a way of asking. Each maps to one of the five request
// types the server already knows (src/lib/attendance/requestForm.ts), and the
// server still validates exactly as before. Only the chosen tile's fields are
// sent, so changing tile never carries a stale time across.
//
// Used for corrections too: opened with `original` it pre-fills and submits a
// replacement that points at the original, so the first submission stays in the
// audit trail.

import { useEffect, useId, useRef, useState } from 'react'
import { CalendarDays, Check, CheckCircle2, Clock, Footprints, LogOut, Plus } from 'lucide-react'
import { PayrollModal } from '@/components/payroll/PayrollModal'
import {
  REASON_CODES,
  REASON_LABEL,
  NOTE_MAX_LENGTH,
  REQUEST_TYPE_LABEL,
  type AttendanceRequestRow,
  type ReasonCode,
} from '@/lib/attendance/requests'
import {
  FIELD_ORDER,
  FORM_TILES,
  TILE_LABEL,
  buildPayload,
  dateShortcuts,
  dateChoice,
  initialFormState,
  requestTypeFor,
  validateForm,
  type FormField,
  type FormState,
  type FormTile,
} from '@/lib/attendance/requestForm'
import { istToday } from '@/lib/istDate'

export type RequestPayload = Record<string, unknown>

const TILE_ICON: Record<FormTile, React.ReactNode> = {
  leave: <CalendarDays size={18} strokeWidth={1.9} aria-hidden="true" />,
  late:  <Clock size={18} strokeWidth={1.9} aria-hidden="true" />,
  early: <LogOut size={18} strokeWidth={1.9} aria-hidden="true" />,
  out:   <Footprints size={18} strokeWidth={1.9} aria-hidden="true" />,
}

/** "Mon 5 Oct" from a YYYY-MM-DD business date, whatever the device's zone. */
function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}

// ─── Small building blocks ───────────────────────────────────────────────────

/**
 * Native radios inside labels: arrow keys, focus and screen-reader semantics
 * for free. The selected choice carries a check mark and a heavier outline as
 * well as its fill, so it never relies on colour alone.
 */
function ChoiceGroup<T extends string>({
  label, name, value, onChange, options, columns, tiles = false, required = false, error, field,
}: {
  label: string
  name: string
  value: T | ''
  onChange: (v: T) => void
  options: { value: T; label: string; icon?: React.ReactNode }[]
  columns: 2 | 3
  tiles?: boolean
  required?: boolean
  error?: string
  field?: FormField
}) {
  const errId = useId()
  return (
    <div className="boe-req-field" data-req-field={field}>
      <div id={`${errId}-l`} className="boe-req-label">
        {label}{required && <span className="boe-req-star" aria-hidden="true"> *</span>}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${errId}-l`}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className={`boe-choice-grid boe-choice-grid--${columns}${tiles ? ' boe-choice-grid--tiles' : ''}`}
      >
        {options.map(o => (
          <label key={o.value} className="boe-choice">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.icon && <span className="boe-choice-icon">{o.icon}</span>}
            <span className="boe-choice-text">{o.label}</span>
            <Check size={15} strokeWidth={2.6} className="boe-choice-check" aria-hidden="true" />
          </label>
        ))}
      </div>
      {error && <div id={errId} className="boe-req-error">{error}</div>}
    </div>
  )
}

function Field({
  id, label, required, error, hint, field, children,
}: {
  id: string
  label: string
  required?: boolean
  error?: string
  hint?: string
  field: FormField
  children: React.ReactNode
}) {
  return (
    <div className="boe-req-field" data-req-field={field}>
      <label htmlFor={id} className="boe-req-label">
        {label}{required && <span className="boe-req-star" aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && !error && <div className="boe-req-hint">{hint}</div>}
      {error && <div id={`${id}-err`} className="boe-req-error">{error}</div>}
    </div>
  )
}

// ─── The form ────────────────────────────────────────────────────────────────

export function AttendanceRequestModal({
  original, onClose, onSubmit, onViewRequests,
}: {
  original?: AttendanceRequestRow | null
  onClose: () => void
  /** Resolves to an error message, or null when saved. */
  onSubmit: (payload: RequestPayload) => Promise<string | null>
  /** "View my requests" on the success screen. Omit to show only Done. */
  onViewRequests?: () => void
}) {
  const uid = useId()
  const [form, setForm] = useState<FormState>(() => initialFormState(new Date(), original))
  const [pickOther, setPickOther] = useState(() => {
    const d = initialFormState(new Date(), original).date
    return !!original && dateChoice(d) === 'other'
  })
  const [multiDay, setMultiDay] = useState(() => !!original && original.end_date !== original.start_date)
  const [noteOpen, setNoteOpen] = useState(() => !!original?.reason_note)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ what: string } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const inFlight = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sentRef = useRef<HTMLDivElement>(null)

  // IST midnight can pass while the form is open. Re-reading the clock keeps
  // "Today" and "Tomorrow" honest; the date already chosen never changes
  // silently — it just stops being labelled "Today".
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => { if (sent) sentRef.current?.focus() }, [sent])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }))

  const type = requestTypeFor(form.tile, form.leave)
  const errors = attempted ? validateForm(form) : {}
  const { today, tomorrow } = dateShortcuts(now)
  const chip = pickOther ? 'other' : dateChoice(form.date, now)
  const showPicker = chip === 'other'
  const isPast = !!form.date && form.date < istToday(now)
  const noteRequired = form.reason === 'other'
  const showNote = noteOpen || noteRequired || form.note !== ''

  const focusField = (field: FormField) => {
    const wrap = bodyRef.current?.querySelector<HTMLElement>(`[data-req-field="${field}"]`)
    const target = wrap?.querySelector<HTMLElement>('input:checked, input, select, textarea, button')
    target?.focus()
    wrap?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const send = async () => {
    if (inFlight.current) return          // a second tap in the same tick
    const found = validateForm(form)
    const first = FIELD_ORDER.find(f => found[f])
    if (first) { setAttempted(true); focusField(first); return }

    inFlight.current = true
    setSaving(true)
    setError(null)
    let message: string | null
    try {
      message = await onSubmit(buildPayload(form, original?.id ?? null))
    } catch {
      message = 'Could not reach BOE. Check your connection and try again — what you entered is still here.'
    }
    inFlight.current = false
    setSaving(false)
    if (message) {
      setError(message)
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setSent({ what: `${REQUEST_TYPE_LABEL[type]} · ${longDate(form.date)}` })
  }

  const inputId = (n: string) => `${uid}-${n}`
  const inv = (f: FormField) => (errors[f] ? true : undefined)
  const describe = (f: FormField, id: string) => (errors[f] ? `${id}-err` : undefined)

  // ── Sent ──
  if (sent) {
    return (
      <PayrollModal
        sheet
        title={original ? 'Correction sent' : 'Attendance request'}
        onClose={onClose}
        width={500}
        footer={
          <div className="boe-req-actions">
            <button type="button" className="boe-btn boe-btn-ghost boe-req-secondary" onClick={onClose}>Done</button>
            {onViewRequests && (
              <button type="button" className="boe-btn boe-btn-primary boe-req-send" onClick={onViewRequests}>
                View my requests
              </button>
            )}
          </div>
        }
      >
        <div ref={sentRef} tabIndex={-1} className="boe-req-sent" role="status">
          <CheckCircle2 size={40} strokeWidth={1.7} className="boe-req-sent-icon" aria-hidden="true" />
          <div className="boe-req-sent-title">Request sent · Awaiting approval</div>
          <div className="boe-req-sent-what">{sent.what}</div>
          <div className="boe-req-hint">An admin will review it, and you will get a notification with the decision.</div>
        </div>
      </PayrollModal>
    )
  }

  return (
    <PayrollModal
      sheet
      title={original ? 'Correct attendance request' : 'Attendance request'}
      subtitle={original
        ? 'Your original request stays in the history.'
        : 'Request leave or permission for a change in your working hours.'}
      onClose={onClose}
      width={500}
      footer={
        <div className="boe-req-actions">
          <button type="button" className="boe-btn boe-btn-ghost boe-req-secondary boe-req-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="boe-btn boe-btn-primary boe-req-send"
            onClick={send}
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? 'Sending…' : original ? 'Send correction' : 'Send request'}
          </button>
        </div>
      }
    >
      <div ref={bodyRef} className="boe-req-form">
        {error && <div role="alert" className="boe-req-alert">{error}</div>}

        <ChoiceGroup<FormTile>
          label="What do you need?"
          name={`${uid}-tile`}
          value={form.tile}
          onChange={v => set('tile', v)}
          options={FORM_TILES.map(t => ({ value: t, label: TILE_LABEL[t], icon: TILE_ICON[t] }))}
          columns={2}
          tiles
        />

        {form.tile === 'leave' && (
          <ChoiceGroup<'full' | 'half'>
            label="How much of the day?"
            name={`${uid}-leave`}
            value={form.leave}
            onChange={v => set('leave', v)}
            options={[{ value: 'full', label: 'Full day' }, { value: 'half', label: 'Half day' }]}
            columns={2}
          />
        )}

        {/* One date control. Today / Tomorrow are one tap; "Another date" opens
            the native picker in place, so there is never a second date field. */}
        <div className="boe-req-field" data-req-field="date">
          <div id={`${uid}-dl`} className="boe-req-label">
            {type === 'full_day_leave' && multiDay ? 'First day' : 'Date'}
            <span className="boe-req-star" aria-hidden="true"> *</span>
          </div>
          <div role="radiogroup" aria-labelledby={`${uid}-dl`} className="boe-choice-grid boe-choice-grid--3">
            {([
              { key: 'today', label: 'Today' },
              { key: 'tomorrow', label: 'Tomorrow' },
              { key: 'other', label: 'Another date' },
            ] as const).map(o => (
              <label key={o.key} className="boe-choice">
                <input
                  type="radio"
                  name={`${uid}-date`}
                  value={o.key}
                  checked={chip === o.key}
                  onChange={() => {
                    if (o.key === 'other') { setPickOther(true); return }
                    setPickOther(false)
                    set('date', o.key === 'today' ? today : tomorrow)
                  }}
                />
                <span className="boe-choice-text">{o.label}</span>
                <Check size={15} strokeWidth={2.6} className="boe-choice-check" aria-hidden="true" />
              </label>
            ))}
          </div>
          {showPicker ? (
            <input
              id={inputId('date')}
              type="date"
              className="boe-input boe-req-control"
              aria-label="Choose a date"
              aria-invalid={inv('date')}
              value={form.date}
              onChange={e => set('date', e.target.value)}
            />
          ) : (
            <div className="boe-req-datetext">{longDate(form.date)}</div>
          )}
          {errors.date && <div className="boe-req-error">{errors.date}</div>}
          {isPast && !errors.date && (
            <div className="boe-req-hint">This date has passed, so your request will be marked as sent after the event.</div>
          )}
        </div>

        {type === 'full_day_leave' && (
          multiDay ? (
            <Field id={inputId('end')} label="Last day" field="endDate" error={errors.endDate}>
              <input
                id={inputId('end')}
                type="date"
                className="boe-input boe-req-control"
                min={form.date}
                aria-invalid={inv('endDate')}
                aria-describedby={describe('endDate', inputId('end'))}
                value={form.endDate}
                onChange={e => set('endDate', e.target.value)}
              />
            </Field>
          ) : (
            <button type="button" className="boe-req-linkbtn" onClick={() => setMultiDay(true)}>
              <Plus size={15} aria-hidden="true" /> Leave for more than one day
            </button>
          )
        )}

        {type === 'half_day' && (
          <ChoiceGroup<'first_half' | 'second_half'>
            label="Which half?"
            name={`${uid}-half`}
            value={form.half}
            onChange={v => set('half', v)}
            options={[{ value: 'first_half', label: 'First half' }, { value: 'second_half', label: 'Second half' }]}
            columns={2}
            required
            error={errors.half}
            field="half"
          />
        )}

        {type === 'late_arrival' && (
          <Field id={inputId('exp')} label="Expected arrival time (optional)" field="expected" error={errors.expected}>
            <input
              id={inputId('exp')}
              type="time"
              className="boe-input boe-req-control"
              value={form.expected}
              onChange={e => set('expected', e.target.value)}
            />
          </Field>
        )}

        {type === 'early_departure' && (
          <Field id={inputId('dep')} label="Planned departure time" required field="depart" error={errors.depart}>
            <input
              id={inputId('dep')}
              type="time"
              className="boe-input boe-req-control"
              aria-required="true"
              aria-invalid={inv('depart')}
              aria-describedby={describe('depart', inputId('dep'))}
              value={form.depart}
              onChange={e => set('depart', e.target.value)}
            />
          </Field>
        )}

        {type === 'time_out' && (
          <>
            <div className="boe-req-pair">
              <Field id={inputId('dep')} label="Leaving at" required field="depart" error={errors.depart}>
                <input
                  id={inputId('dep')}
                  type="time"
                  className="boe-input boe-req-control"
                  aria-required="true"
                  aria-invalid={inv('depart')}
                  aria-describedby={describe('depart', inputId('dep'))}
                  value={form.depart}
                  onChange={e => set('depart', e.target.value)}
                />
              </Field>
              <Field id={inputId('back')} label="Expected return" required field="back" error={errors.back}>
                <input
                  id={inputId('back')}
                  type="time"
                  className="boe-input boe-req-control"
                  aria-required="true"
                  aria-invalid={inv('back')}
                  aria-describedby={describe('back', inputId('back'))}
                  value={form.back}
                  onChange={e => set('back', e.target.value)}
                />
              </Field>
            </div>
          </>
        )}

        <Field id={inputId('reason')} label="Reason" required field="reason" error={errors.reason}>
          <select
            id={inputId('reason')}
            className="boe-input boe-req-control"
            aria-required="true"
            aria-invalid={inv('reason')}
            aria-describedby={describe('reason', inputId('reason'))}
            value={form.reason}
            onChange={e => set('reason', e.target.value as ReasonCode)}
          >
            <option value="" disabled>Select a reason</option>
            {REASON_CODES.map(r => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
          </select>
        </Field>

        {showNote ? (
          <Field
            id={inputId('note')}
            label={noteRequired ? 'Explain briefly' : 'Note'}
            required={noteRequired}
            field="note"
            error={errors.note}
          >
            <textarea
              id={inputId('note')}
              className="boe-input boe-req-control boe-req-note"
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
              aria-required={noteRequired || undefined}
              aria-invalid={inv('note')}
              aria-describedby={describe('note', inputId('note'))}
              value={form.note}
              onChange={e => set('note', e.target.value)}
            />
          </Field>
        ) : (
          <button
            type="button"
            className="boe-req-linkbtn"
            aria-expanded={false}
            onClick={() => setNoteOpen(true)}
          >
            <Plus size={15} aria-hidden="true" /> Add a note
          </button>
        )}
      </div>
    </PayrollModal>
  )
}
