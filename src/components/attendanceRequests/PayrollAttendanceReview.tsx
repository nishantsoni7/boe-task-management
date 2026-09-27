'use client'

// Monthly attendance review for payroll — per employee, every salary-relevant
// attendance event, the request behind it (if any), and the reviewer's
// decision.
//
// This screen RECORDS decisions; it never changes pay. What the draft charges
// is read from the stored payroll draft and shown as it is. Where the decision
// and the draft disagree, the event says so and links to the payslip, where
// the existing attendance correction applies a waiver and recalculates — the
// one path that changes what payroll charges.
//
// One request for the whole month; decisions re-read it.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { colors } from '@/lib/tokens'
import { istClockOf } from '@/lib/istDate'
import {
  PAY_DECISIONS,
  PAY_DECISION_LABEL,
  LATE_POLICY_ALLOWANCE,
  type ReconEmployeeResult,
  type ReconEvent,
  type ReconResult,
  type PayDecision,
} from '@/lib/attendance/requestReconciliation'
import { REQUEST_STATUS_LABEL } from '@/lib/attendance/requests'
import { istCurrentYearMonth, selectableMonthsInYear, selectableYears } from '@/lib/attendance/monthAvailability'
import { PayrollModal, PayrollModalActions, PayrollModalError, PayrollField } from '@/components/payroll/PayrollModal'
import { formatShortDate, formatIstDateTime } from './format'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

type Loaded = {
  result: ReconResult
  period: { id: string; status: string } | null
  coverage_through: string | null
  reviewer_names: Record<string, string>
}

export function PayrollAttendanceReview({ getToken }: { getToken: () => Promise<string | null> }) {
  const now = istCurrentYearMonth()
  const [year, setYear] = useState(now.year)
  const [month, setMonth] = useState(now.month)
  const [data, setData] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [deciding, setDeciding] = useState<{ emp: ReconEmployeeResult; ev: ReconEvent } | null>(null)

  const load = useCallback(async (y: number, m: number) => {
    const token = await getToken()
    setLoading(true)
    const res = await fetch(`/api/attendance-requests/reconciliation?year=${y}&month=${m}`, {
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error ?? 'Could not load the review.'); setData(null) }
    else { setData(json); setError(null) }
    setLoading(false)
  }, [getToken])

  useEffect(() => {
    const run = async () => { await load(year, month) }
    void run()
  }, [year, month, load])

  const save = async (body: Record<string, unknown>): Promise<string | null> => {
    const token = await getToken()
    const res = await fetch('/api/attendance-requests/reconciliation', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not save the decision.'
    await load(year, month)
    return null
  }

  const locked = data?.period?.status === 'locked'
  const employees = (data?.result.employees ?? []).filter(e => !onlyOpen || e.unresolved_count > 0 || e.policy_flag_dates.length > 0)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <select aria-label="Month" className="boe-input" style={{ padding: '8px 10px', fontSize: 13 }}
          value={month} onChange={e => setMonth(Number(e.target.value))}>
          {selectableMonthsInYear(year).map(m => <option key={m} value={m}>{MONTHS[m - 1]}</option>)}
        </select>
        <select aria-label="Year" className="boe-input" style={{ padding: '8px 10px', fontSize: 13 }}
          value={year} onChange={e => {
            const y = Number(e.target.value)
            const allowed = selectableMonthsInYear(y)
            setYear(y)
            if (!allowed.includes(month)) setMonth(allowed[allowed.length - 1])
          }}>
          {selectableYears().map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <label style={{ fontSize: 12.5, color: colors.tertiary, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />
          Only employees needing review
        </label>
      </div>

      {error && <div role="alert" style={{ color: '#DC2626', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ fontSize: 13, color: colors.muted }}>Loading…</div>}

      {data && !loading && (
        <>
          <div style={{
            display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: colors.primary,
            padding: '10px 12px', border: `1px solid ${colors.border}`, borderRadius: 10, marginBottom: 12, background: colors.base,
          }}>
            <span><strong>{data.result.totals.unresolved}</strong> unresolved</span>
            <span><strong>{data.result.totals.events}</strong> events</span>
            <span><strong>{data.result.totals.policy_flagged_employees}</strong> over the late-arrival flag</span>
            <span style={{ color: colors.muted }}>
              {data.period
                ? `Payroll draft: ${data.period.status}`
                : 'No payroll draft for this month yet'}
              {data.coverage_through ? ` · attendance through ${formatShortDate(data.coverage_through)}` : ' · no attendance imported'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.55, marginBottom: 12 }}>
            A review decision is a record, not a calculation. The amounts shown are what the stored payroll
            draft already charges. The late-arrival flag marks the {LATE_POLICY_ALLOWANCE + 1}th and later
            uninformed, unexcused late arrival of the month for review — it deducts nothing.
            {locked && ' This month is locked: decisions are read-only; use the existing unlock or adjustment path.'}
          </div>

          {employees.length === 0 && (
            <div style={{ fontSize: 13, color: colors.muted, padding: '16px 0' }}>Nothing needs review.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {employees.map(emp => (
              <details key={emp.employee.id} open={emp.unresolved_count > 0 && employees.length <= 6}
                style={{ border: `1px solid ${colors.border}`, borderRadius: 10, background: colors.base }}>
                <summary style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 14, color: colors.primary }}>{emp.employee.full_name ?? 'Employee'}</strong>
                  {emp.employee.employee_code && <span style={{ fontSize: 12, color: colors.muted }}>{emp.employee.employee_code}</span>}
                  {!emp.employee.is_active && <span style={{ fontSize: 12, color: '#DC2626' }}>inactive</span>}
                  <span style={{ fontSize: 12, color: emp.unresolved_count ? '#B45309' : '#059669' }}>
                    {emp.unresolved_count ? `${emp.unresolved_count} to review` : 'all reviewed'}
                  </span>
                  <span style={{ fontSize: 12, color: colors.tertiary }}>
                    {emp.uninformed_late_count} uninformed late
                  </span>
                  {emp.policy_flag_dates.length > 0 && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#DC2626' }}>
                      Review flag: {emp.policy_flag_dates.map(formatShortDate).join(', ')}
                    </span>
                  )}
                  {data.period && (
                    <Link href={`/payroll/results/${data.period.id}/${emp.employee.id}`} style={{ fontSize: 12, marginLeft: 'auto' }}>
                      Open payslip
                    </Link>
                  )}
                </summary>
                <ul style={{ listStyle: 'none', margin: 0, padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {emp.events.map(ev => (
                    <EventRow key={`${ev.date}|${ev.event_key}`} ev={ev} names={data.reviewer_names}
                      canDecide={!locked && !ev.upcoming} onDecide={() => setDeciding({ emp, ev })} />
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </>
      )}

      {deciding && (
        <ReviewModal
          emp={deciding.emp}
          ev={deciding.ev}
          onClose={() => setDeciding(null)}
          onSave={save}
        />
      )}
    </div>
  )
}

function EventRow({ ev, names, canDecide, onDecide }: {
  ev: ReconEvent
  names: Record<string, string>
  canDecide: boolean
  onDecide: () => void
}) {
  const border = ev.policy_flag ? '#DC2626' : ev.resolved ? colors.border : '#E8A030'
  return (
    <li style={{ borderLeft: `3px solid ${border}`, padding: '6px 0 6px 10px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 13, color: colors.primary }}>{formatShortDate(ev.date)}</strong>
        <span style={{ fontSize: 13, color: colors.primary }}>
          {ev.request && ev.kind === 'request' ? `${ev.title} · ${ev.request.summary}` : ev.title}
        </span>
        {ev.upcoming && <span style={{ fontSize: 11.5, color: colors.muted }}>upcoming</span>}
        {ev.policy_flag && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#DC2626' }}>over monthly flag</span>}
        {ev.informed === true && <span style={{ fontSize: 11.5, color: '#059669' }}>informed</span>}
        {ev.informed === false && <span style={{ fontSize: 11.5, color: '#B45309' }}>uninformed</span>}
        {ev.excused && <span style={{ fontSize: 11.5, color: '#059669' }}>excused</span>}
        {ev.company_exception && <span style={{ fontSize: 11.5, color: '#2563EB' }}>company exception</span>}
      </div>
      <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 2 }}>
        Actual: {ev.actual.check_in ? istClockOf(ev.actual.check_in) : '—'} → {ev.actual.check_out ? istClockOf(ev.actual.check_out) : '—'}
        {ev.actual.source === 'corrected' ? ' (corrected)' : ev.actual.source === 'none' ? ' (no record)' : ''}
      </div>
      {ev.request && (
        <div style={{ fontSize: 12, color: colors.tertiary }}>
          Request: {ev.request.type_label} · {ev.request.reason_label}{ev.request.reason_note ? ` — ${ev.request.reason_note}` : ''}
          {' · '}{REQUEST_STATUS_LABEL[ev.request.status]} · submitted {formatIstDateTime(ev.request.submitted_at)}
          {ev.request.informed_before_shift ? ' (before shift)' : ' (after shift start)'}
        </div>
      )}
      {ev.excused && ev.excuse_reason && (
        <div style={{ fontSize: 12, color: colors.tertiary }}>Excused: {ev.excuse_reason}</div>
      )}
      <div style={{ fontSize: 12, color: colors.primary }}>
        {ev.payroll_state}{ev.credits_redeemed > 0 ? ` BOE Credits used: ${ev.credits_redeemed}.` : ''}
      </div>
      {ev.flags.map(f => <div key={f} style={{ fontSize: 12, color: '#B45309' }}>• {f}</div>)}
      {ev.decision && (
        <div style={{ fontSize: 12, color: ev.stale ? '#DC2626' : colors.tertiary }}>
          {ev.stale ? 'Attendance changed since this decision — review again. ' : ''}
          Decision: {ev.decision.pay_decision ? PAY_DECISION_LABEL[ev.decision.pay_decision] : 'none'}
          {ev.decision.decision_reason ? ` — ${ev.decision.decision_reason}` : ''}
          {' · '}{names[ev.decision.reviewed_by] ?? 'Admin'}, {formatIstDateTime(ev.decision.reviewed_at)}
        </div>
      )}
      {ev.decision_notes.map(n => <div key={n} style={{ fontSize: 12, color: '#2563EB' }}>ℹ {n}</div>)}
      {canDecide && (
        <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: 12.5, marginTop: 4 }}
          onClick={onDecide}>
          {ev.decision ? 'Change decision' : 'Decide'}
        </button>
      )}
    </li>
  )
}

function ReviewModal({ emp, ev, onClose, onSave }: {
  emp: ReconEmployeeResult
  ev: ReconEvent
  onClose: () => void
  onSave: (body: Record<string, unknown>) => Promise<string | null>
}) {
  const isLate = ev.event_key === 'late_arrival'
  const [decision, setDecision] = useState<PayDecision | ''>(ev.decision?.pay_decision ?? '')
  const [reason, setReason] = useState(ev.decision?.decision_reason ?? '')
  const [excused, setExcused] = useState(ev.excused)
  const [excuseReason, setExcuseReason] = useState(ev.excuse_reason ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invalid = (!decision && !excused) || (!!decision && !reason.trim()) || (excused && !excuseReason.trim())

  const submit = async () => {
    if (invalid || saving) return
    setSaving(true)
    const msg = await onSave({
      employee_id: emp.employee.id,
      attendance_date: ev.date,
      event_key: ev.event_key,
      excused,
      excuse_reason: excused ? excuseReason.trim() : null,
      pay_decision: decision || null,
      decision_reason: decision ? reason.trim() : null,
    })
    if (msg) { setError(msg); setSaving(false); return }
    onClose()
  }

  return (
    <PayrollModal title="Payroll review decision" subtitle={`${emp.employee.full_name ?? 'Employee'} · ${formatShortDate(ev.date)} · ${ev.title}`}
      onClose={onClose} width={480}>
      {error && <PayrollModalError message={error} />}
      <div style={{ fontSize: 12.5, color: colors.tertiary }}>{ev.payroll_state}</div>

      {isLate && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={excused} onChange={e => setExcused(e.target.checked)} />
            Excuse this late arrival (not counted toward the monthly flag)
          </label>
          {excused && (
            <PayrollField label="Excuse reason (required)">
              <input className="boe-input" style={{ padding: '9px 11px', fontSize: 14 }} value={excuseReason} maxLength={500}
                placeholder="e.g. Company vehicle delay; emergency reported by phone"
                onChange={e => setExcuseReason(e.target.value)} />
            </PayrollField>
          )}
        </div>
      )}

      <PayrollField label="Salary treatment">
        <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {PAY_DECISIONS.map(d => (
            <label key={d} style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="pay_decision" checked={decision === d} onChange={() => setDecision(d)} />
              {PAY_DECISION_LABEL[d]}
            </label>
          ))}
          {decision && (
            <button type="button" className="boe-btn boe-btn-ghost" style={{ alignSelf: 'flex-start', padding: '3px 10px', fontSize: 12 }}
              onClick={() => setDecision('')}>Clear</button>
          )}
        </div>
      </PayrollField>
      {decision && (
        <PayrollField label="Reason (required)">
          <input className="boe-input" style={{ padding: '9px 11px', fontSize: 14 }} value={reason} maxLength={500}
            placeholder={decision === 'paid_waived' ? 'e.g. Company vehicle; Review credit' : ''}
            onChange={e => setReason(e.target.value)} />
        </PayrollField>
      )}
      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
        Saving records the decision and who made it. It does not change pay: to waive a charge the draft
        still makes, apply a waiver through the attendance correction on the payslip.
      </div>
      <PayrollModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Save decision" disabled={invalid} />
    </PayrollModal>
  )
}
