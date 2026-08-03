'use client'

import { useMemo, useState } from 'react'
import { colors } from '@/lib/tokens'
import { istClockToUtc, istClockOf } from '@/lib/istDate'
import { DAY_TREATMENTS, type DayTreatment } from '@/lib/attendance/corrections'
import { PayrollModal, PayrollField, PayrollModalActions, PayrollModalError } from '@/components/payroll/PayrollModal'

// One correction modal for one employee and one date.
//
// It edits the DATE, not the individual deduction rows. A day that produced a
// Missing Punch-Out and a Late Arrival is one situation with one cause, and
// resolving it row by row is how the two end up contradicting each other. The
// modal therefore shows everything currently charged to the date, takes the
// corrected punches once, and lets the server recalculate the whole day.

export type CorrectionDayContext = {
  date: string
  classification: string
  /** What the machine recorded, before any correction. */
  raw_check_in_at: string | null
  raw_check_out_at: string | null
  /** What payroll is currently using — differs from raw when already corrected. */
  effective_check_in_at: string | null
  effective_check_out_at: string | null
  /** Deduction lines currently charged to this date. */
  lines: { deduction_type: string; hours_deducted: number; amount_deducted: number }[]
  total_amount: number
  existing?: {
    remark: string
    day_treatment: DayTreatment
    waive_late_arrival: boolean
    waive_early_checkout: boolean
    waive_missing_punch: boolean
    corrected_at: string
  } | null
}

export type CorrectionPayload = {
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  day_treatment: DayTreatment
  waive_late_arrival: boolean
  waive_early_checkout: boolean
  waive_missing_punch: boolean
  remark: string
}

const TREATMENT_LABELS: Record<DayTreatment, string> = {
  auto:     'Recalculate from the corrected punches',
  full_day: 'Approve as a full paid day',
  half_day: 'Treat as a half day',
  absent:   'Treat as absent',
}

const DEDUCTION_LABELS: Record<string, string> = {
  late_arrival:      'Late Arrival',
  early_checkout:    'Early Checkout',
  missing_punch_in:  'Missing Punch-In',
  missing_punch_out: 'Missing Punch-Out',
  absent:            'Absent',
  half_day:          'Half Day',
  short_hours:       'Short Hours',
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  full_present:          'Full Present',
  present_with_shortfall:'Present (short hours)',
  short_present:         'Short Present',
  half_day:              'Half Day',
  full_absent:           'Absent',
  missing_punch:         'Missing Punch',
  weekly_off:            'Weekly Off',
  holiday:               'Holiday',
  pre_joining:           'Before Joining',
}

function fmtMoney(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

function clockValue(ts: string | null): string {
  return ts ? istClockOf(ts) : ''
}

export function AttendanceCorrectionModal({
  employeeName, day, saving, error, onCancel, onSave,
}: {
  employeeName: string
  day: CorrectionDayContext
  saving: boolean
  error: string | null
  onCancel: () => void
  onSave: (payload: CorrectionPayload) => void
}) {
  const [checkIn,  setCheckIn]  = useState(() => clockValue(day.effective_check_in_at))
  const [checkOut, setCheckOut] = useState(() => clockValue(day.effective_check_out_at))
  const [treatment, setTreatment] = useState<DayTreatment>(day.existing?.day_treatment ?? 'auto')
  const [waiveLate,    setWaiveLate]    = useState(day.existing?.waive_late_arrival   ?? false)
  const [waiveEarly,   setWaiveEarly]   = useState(day.existing?.waive_early_checkout ?? false)
  const [waiveMissing, setWaiveMissing] = useState(day.existing?.waive_missing_punch  ?? false)
  const [remark, setRemark] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  // Waivers only mean anything under 'auto' — any other treatment already
  // decides the whole day, so the checkboxes are disabled rather than silently
  // ignored.
  const waiversApply = treatment === 'auto'
  const remarkEmpty  = remark.trim() === ''

  const rawSummary = useMemo(() => {
    const inText  = day.raw_check_in_at  ? istClockOf(day.raw_check_in_at)  : 'missing'
    const outText = day.raw_check_out_at ? istClockOf(day.raw_check_out_at) : 'missing'
    return `IN ${inText} · OUT ${outText}`
  }, [day.raw_check_in_at, day.raw_check_out_at])

  const handleSave = () => {
    setLocalError(null)

    if (remarkEmpty) {
      setLocalError('A correction remark is required.')
      return
    }

    const inAt  = checkIn.trim()  === '' ? null : istClockToUtc(day.date, checkIn)
    const outAt = checkOut.trim() === '' ? null : istClockToUtc(day.date, checkOut)

    if (checkIn.trim()  !== '' && inAt  === null) { setLocalError('Punch-in time is not a valid time.');  return }
    if (checkOut.trim() !== '' && outAt === null) { setLocalError('Punch-out time is not a valid time.'); return }
    if (inAt && outAt && new Date(outAt).getTime() <= new Date(inAt).getTime()) {
      setLocalError('Punch-out must be later than punch-in.')
      return
    }

    onSave({
      attendance_date: day.date,
      check_in_at:  inAt,
      check_out_at: outAt,
      day_treatment: treatment,
      waive_late_arrival:   waiversApply && waiveLate,
      waive_early_checkout: waiversApply && waiveEarly,
      waive_missing_punch:  waiversApply && waiveMissing,
      remark: remark.trim(),
    })
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 10px', boxSizing: 'border-box', width: '100%',
  }

  return (
    <PayrollModal
      title="Correct Attendance"
      subtitle={`${employeeName} · ${fmtDayDate(day.date)}`}
      onClose={onCancel}
      width={540}
    >
      {/* What the machine said, and what payroll made of it. Shown together so
          the admin corrects against the evidence rather than from memory. */}
      <div style={{
        background: colors.raised, border: `1px solid ${colors.border}`,
        borderRadius: 9, padding: '11px 13px', fontSize: 12.5, color: colors.secondary,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: colors.tertiary }}>Machine record</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{rawSummary}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 5, flexWrap: 'wrap' }}>
          <span style={{ color: colors.tertiary }}>Currently counted as</span>
          <span style={{ fontWeight: 600 }}>
            {CLASSIFICATION_LABELS[day.classification] ?? day.classification}
          </span>
        </div>

        {day.lines.length > 0 && (
          <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${colors.border}` }}>
            {day.lines.map((l, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: i > 0 ? 4 : 0 }}>
                <span>{DEDUCTION_LABELS[l.deduction_type] ?? l.deduction_type} · {l.hours_deducted}h</span>
                <span style={{ color: '#C13030', fontVariantNumeric: 'tabular-nums' }}>
                  −{fmtMoney(l.amount_deducted)}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 7, fontWeight: 700 }}>
              <span>Deducted for this date</span>
              <span style={{ color: '#C13030', fontVariantNumeric: 'tabular-nums' }}>−{fmtMoney(day.total_amount)}</span>
            </div>
          </div>
        )}

        {day.existing && (
          <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${colors.border}`, fontSize: 12 }}>
            <span style={{ color: colors.tertiary }}>Already corrected — </span>
            {day.existing.remark}
          </div>
        )}
      </div>

      {/* Corrected punches. Two narrow fields side by side on desktop, stacked
          on a phone. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <PayrollField label="Punch-In (IST)" hint="Leave blank for no punch-in">
            <input type="time" value={checkIn} onChange={e => setCheckIn(e.target.value)} style={inputStyle} />
          </PayrollField>
        </div>
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <PayrollField label="Punch-Out (IST)" hint="Leave blank for no punch-out">
            <input type="time" value={checkOut} onChange={e => setCheckOut(e.target.value)} style={inputStyle} />
          </PayrollField>
        </div>
      </div>

      <PayrollField label="Payroll day treatment">
        <select
          value={treatment}
          onChange={e => setTreatment(e.target.value as DayTreatment)}
          style={inputStyle}
        >
          {DAY_TREATMENTS.map(t => (
            <option key={t} value={t}>{TREATMENT_LABELS[t]}</option>
          ))}
        </select>
      </PayrollField>

      <PayrollField
        label="Deduction treatment"
        hint={waiversApply ? undefined : 'Not applicable — the day treatment above already settles this date.'}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 }}>
          <Waiver label="Waive late arrival"     checked={waiveLate}    disabled={!waiversApply} onChange={setWaiveLate} />
          <Waiver label="Waive early exit"       checked={waiveEarly}   disabled={!waiversApply} onChange={setWaiveEarly} />
          <Waiver label="Waive missing punch"    checked={waiveMissing} disabled={!waiversApply} onChange={setWaiveMissing} />
        </div>
      </PayrollField>

      <PayrollField label="Remark (required)" hint="Why this correction is being made — kept in the audit history.">
        <textarea
          value={remark}
          onChange={e => setRemark(e.target.value)}
          rows={2}
          placeholder="e.g. Forgot to punch in; actual arrival confirmed by manager."
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </PayrollField>

      {(localError || error) && <PayrollModalError message={localError ?? error!} />}

      <PayrollModalActions
        onClose={onCancel}
        onSave={handleSave}
        saving={saving}
        saveLabel="Save & Recalculate"
        disabled={remarkEmpty}
      />
    </PayrollModal>
  )
}

function Waiver({
  label, checked, disabled, onChange,
}: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
      color: disabled ? colors.muted : colors.secondary,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}>
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}
