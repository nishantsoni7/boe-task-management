'use client'

// Monthly attendance review for payroll — per employee, every salary-relevant
// attendance event, the request behind it (if any), the reviewer's decision,
// and whether the payroll DRAFT reflects it.
//
// Saving Paid / waived or Unpaid actual time on a late arrival, early departure
// or missing punch applies it through the existing attendance correction in the
// same action (versioned correction + recalculation). Every other event says
// "Action required in payroll" and links to the payslip, and stays unresolved
// until the draft matches the decision. Nothing here calculates money.
//
// One request for the whole month; decisions re-read it.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { colors } from '@/lib/tokens'
import { istClockOf } from '@/lib/istDate'
import {
  PAY_DECISION_LABEL,
  LATE_POLICY_ALLOWANCE,
  type ReconEmployeeResult,
  type ReconEvent,
  type ReconResult,
  type PayDecision,
  type SalaryStatus,
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
  viewer_id: string
}

const STATUS_CHIP: Record<SalaryStatus, { label: string; fg: string; bg: string }> = {
  upcoming:         { label: 'Upcoming',                    fg: '#4B5563', bg: 'rgba(107,114,128,0.12)' },
  needs_decision:   { label: 'Needs decision',              fg: '#B45309', bg: 'rgba(232,160,48,0.15)' },
  stale:            { label: 'Review again',                fg: '#DC2626', bg: 'rgba(239,68,68,0.10)' },
  needs_correction: { label: 'Needs correction',            fg: '#B45309', bg: 'rgba(232,160,48,0.15)' },
  no_draft:         { label: 'Waiting for draft',           fg: '#4B5563', bg: 'rgba(107,114,128,0.12)' },
  action_required:  { label: 'Action required in payroll',  fg: '#DC2626', bg: 'rgba(239,68,68,0.10)' },
  resolved:         { label: 'Matches payroll',             fg: '#059669', bg: 'rgba(16,185,129,0.12)' },
}

export function PayrollAttendanceReview({ getToken }: { getToken: () => Promise<string | null> }) {
  const now = istCurrentYearMonth()
  const [year, setYear] = useState(now.year)
  const [month, setMonth] = useState(now.month)
  const [data, setData] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
    const applied = json.applied as { before?: { deduction_amount: number }; after?: { deduction_amount: number } } | null
    setNotice(applied?.before && applied.after
      ? `Saved and applied: the day's deduction moved from ₹${Math.round(applied.before.deduction_amount)} to ₹${Math.round(applied.after.deduction_amount)} in the draft.`
      : json.action_required
        ? `Decision saved. Action required in payroll: ${json.action_required}`
        : 'Decision saved. The draft already matched it.')
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
      {notice && (
        <div role="status" style={{ fontSize: 12.5, color: colors.primary, background: 'rgba(37,99,235,0.08)', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
          {notice}
        </div>
      )}
      {loading && <div style={{ fontSize: 13, color: colors.muted }}>Loading…</div>}

      {data && !loading && (
        <>
          <div style={{
            display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: colors.primary,
            padding: '10px 12px', border: `1px solid ${colors.border}`, borderRadius: 10, marginBottom: 12, background: colors.base,
          }}>
            <span><strong>{data.result.totals.unresolved}</strong> unresolved salary items</span>
            <span style={{ color: data.result.totals.conflicts ? '#DC2626' : undefined }}>
              <strong>{data.result.totals.conflicts}</strong> disagree with the draft
            </span>
            <span><strong>{data.result.totals.policy_flagged_employees}</strong> over the late-arrival flag</span>
            <span style={{ color: colors.muted }}>
              {data.period ? `Payroll draft: ${data.period.status}` : 'No payroll draft for this month yet'}
              {data.coverage_through ? ` · attendance through ${formatShortDate(data.coverage_through)}` : ' · no attendance imported'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.55, marginBottom: 12 }}>
            Paid / waived and Unpaid actual time on a late arrival, early departure or missing punch are applied
            to the draft through the attendance correction when you save. Other events are settled on the
            payslip and stay open until the draft matches. Payroll&apos;s automatic paid-leave rule is unchanged: it
            absorbs the month&apos;s earliest eligible item by itself. The late-arrival flag marks the
            {' '}{LATE_POLICY_ALLOWANCE + 1}th and later uninformed, unexcused late arrival for review — it deducts nothing.
            {locked && ' This month is locked: nothing can be changed here; use the existing unlock or adjustment path.'}
          </div>

          {employees.length === 0 && (
            <div style={{ fontSize: 13, color: colors.muted, padding: '16px 0' }}>Nothing needs review.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {employees.map(emp => {
              const payslip = data.period ? `/payroll/results/${data.period.id}/${emp.employee.id}` : null
              const self = emp.employee.id === data.viewer_id
              return (
                <details key={emp.employee.id} open={(emp.conflict_count > 0 || emp.unresolved_count > 0) && employees.length <= 6}
                  style={{ border: `1px solid ${emp.conflict_count ? '#FCA5A5' : colors.border}`, borderRadius: 10, background: colors.base }}>
                  <summary style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 14, color: colors.primary }}>{emp.employee.full_name ?? 'Employee'}</strong>
                    {emp.employee.employee_code && <span style={{ fontSize: 12, color: colors.muted }}>{emp.employee.employee_code}</span>}
                    {!emp.employee.is_active && <span style={{ fontSize: 12, color: '#DC2626' }}>inactive</span>}
                    <span style={{ fontSize: 12, color: emp.unresolved_count ? '#B45309' : '#059669' }}>
                      {emp.unresolved_count ? `${emp.unresolved_count} unresolved` : 'all match payroll'}
                    </span>
                    {emp.conflict_count > 0 && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#DC2626' }}>{emp.conflict_count} disagree with draft</span>
                    )}
                    <span style={{ fontSize: 12, color: colors.tertiary }}>{emp.uninformed_late_count} uninformed late</span>
                    {emp.policy_flag_dates.length > 0 && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#DC2626' }}>
                        Review flag: {emp.policy_flag_dates.map(formatShortDate).join(', ')}
                      </span>
                    )}
                    {payslip && <Link href={payslip} style={{ fontSize: 12, marginLeft: 'auto' }}>Open payslip</Link>}
                  </summary>
                  {self && (
                    <div style={{ fontSize: 12, color: '#B45309', padding: '0 12px 6px' }}>
                      This is your own attendance: another admin must record these decisions.
                    </div>
                  )}
                  <ul style={{ listStyle: 'none', margin: 0, padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {emp.events.map(ev => (
                      <EventRow key={`${ev.date}|${ev.event_key}`} ev={ev} names={data.reviewer_names} payslip={payslip}
                        canDecide={!locked && !ev.upcoming && !self} onDecide={() => setDeciding({ emp, ev })} />
                    ))}
                  </ul>
                </details>
              )
            })}
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

function EventRow({ ev, names, payslip, canDecide, onDecide }: {
  ev: ReconEvent
  names: Record<string, string>
  payslip: string | null
  canDecide: boolean
  onDecide: () => void
}) {
  const chip = STATUS_CHIP[ev.salary_status]
  const border = ev.salary_status === 'action_required' || ev.salary_status === 'stale' ? '#DC2626'
    : ev.policy_flag ? '#DC2626' : ev.resolved ? colors.border : '#E8A030'
  return (
    <li style={{ borderLeft: `3px solid ${border}`, padding: '6px 0 6px 10px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 13, color: colors.primary }}>{formatShortDate(ev.date)}</strong>
        <span style={{ fontSize: 13, color: colors.primary }}>{ev.title}</span>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999, color: chip.fg, background: chip.bg }}>
          {chip.label}
        </span>
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
      {ev.charge && (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.primary }}>{ev.charge.text}</div>
      )}
      {ev.request && (
        <div style={{ fontSize: 12, color: colors.tertiary }}>
          Request: {ev.request.summary} · {ev.request.reason_label}{ev.request.reason_note ? ` — ${ev.request.reason_note}` : ''}
          {' · '}{REQUEST_STATUS_LABEL[ev.request.status]} · submitted {formatIstDateTime(ev.request.submitted_at)}
          {ev.request.informed_before_shift ? ' (before shift)' : ' (after shift start)'}
        </div>
      )}
      {ev.excused && ev.excuse_reason && (
        <div style={{ fontSize: 12, color: colors.tertiary }}>Excused: {ev.excuse_reason}</div>
      )}
      <div style={{ fontSize: 12, color: colors.primary }}>{ev.payroll_state}</div>
      {ev.flags.map(f => <div key={f} style={{ fontSize: 12, color: '#B45309' }}>• {f}</div>)}
      {ev.decision && (
        <div style={{ fontSize: 12, color: colors.tertiary }}>
          Decision: {ev.decision.pay_decision ? PAY_DECISION_LABEL[ev.decision.pay_decision] : 'excuse only'}
          {ev.decision.decision_reason ? ` — ${ev.decision.decision_reason}` : ''}
          {' · '}{names[ev.decision.reviewed_by] ?? 'Admin'}, {formatIstDateTime(ev.decision.reviewed_at)}
          {ev.decision.applied_correction_id ? ' · applied by attendance correction' : ''}
        </div>
      )}
      {ev.action_note && (
        <div style={{ fontSize: 12, fontWeight: 600, color: '#DC2626' }}>
          {ev.action_note}
          {ev.salary_status === 'action_required' && !ev.applies_in_one_step && payslip && (
            <> <Link href={payslip}>Open payslip to correct {formatShortDate(ev.date)}</Link></>
          )}
        </div>
      )}
      {canDecide && (
        <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: 12.5, marginTop: 4 }}
          onClick={onDecide}>
          {ev.decision ? (ev.salary_status === 'action_required' && ev.applies_in_one_step ? 'Apply decision' : 'Change decision') : 'Decide'}
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

  const effect = !decision || decision === 'needs_correction'
    ? 'Recorded only; the event stays open.'
    : ev.applies_in_one_step
      ? `Saving applies this to the payroll draft through the attendance correction (${decision === 'paid_waived' ? 'waiver on' : 'waiver off'}), then recalculates ${emp.employee.full_name ?? 'this employee'}.`
      : `Cannot be applied from here: ${ev.one_step_blocker} The event stays "Action required in payroll" until the payslip matches.`

  return (
    <PayrollModal title="Payroll review decision" subtitle={`${emp.employee.full_name ?? 'Employee'} · ${formatShortDate(ev.date)} · ${ev.title}`}
      onClose={onClose} width={480}>
      {error && <PayrollModalError message={error} />}
      {ev.charge && (
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.primary }}>{ev.charge.text}</div>
      )}
      <div style={{ fontSize: 12.5, color: colors.tertiary }}>{ev.payroll_state}</div>
      {ev.charge && (
        <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>{ev.charge.rule_text}</div>
      )}

      {isLate && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={excused} onChange={e => setExcused(e.target.checked)} />
            Excuse this late arrival (not counted toward the monthly flag)
          </label>
          {excused && (
            <PayrollField label="Excuse reason (required)">
              <input className="boe-input" style={{ padding: '9px 11px', fontSize: 16 }} value={excuseReason} maxLength={500}
                placeholder="e.g. Company vehicle delay; emergency reported by phone"
                onChange={e => setExcuseReason(e.target.value)} />
            </PayrollField>
          )}
          <div style={{ fontSize: 11.5, color: colors.muted }}>
            Excusing affects only the monthly review flag. Whether the minutes are paid is the salary treatment below.
          </div>
        </div>
      )}

      <PayrollField label="Salary treatment">
        <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ev.allowed_decisions.map(d => (
            <label key={d} style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="pay_decision" checked={decision === d} onChange={() => setDecision(d)} />
              {d === 'paid_waived' && ev.request?.type === 'time_out' ? 'No deduction for time away' : PAY_DECISION_LABEL[d]}
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
          <input className="boe-input" style={{ padding: '9px 11px', fontSize: 16 }} value={reason} maxLength={500}
            placeholder={decision === 'paid_waived' ? 'e.g. Company vehicle; Review credit' : ''}
            onChange={e => setReason(e.target.value)} />
        </PayrollField>
      )}
      <div style={{ fontSize: 12, color: colors.primary, lineHeight: 1.5 }}>{effect}</div>
      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
        There is no &quot;use paid leave&quot; choice: payroll applies earned paid leave automatically to the
        earliest eligible item of the month and cannot be told which day to use it on.
      </div>
      <PayrollModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Save decision" disabled={invalid} />
    </PayrollModal>
  )
}
