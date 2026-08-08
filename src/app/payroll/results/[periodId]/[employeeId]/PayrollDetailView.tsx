'use client'

// The approved Payroll Result Detail presentation, shared by the two people who
// look at it.
//
// WHY THIS IS A MODULE AND NOT TWO PAGES
// --------------------------------------
// An admin reviewing a payslip and the employee whose payslip it is are reading
// the same document. They were reading two different renderings of it: the
// admin got this workspace, the employee got an older, thinner layout that had
// drifted out of step and showed less than the person it belonged to should
// see. Duplicating the workspace to fix that would only guarantee the same
// drift again, in the other direction.
//
// So the presentation lives here once, and the difference between the two
// readers is expressed as `canEdit` — one boolean, in one place, rather than a
// second page that has to be remembered.
//
// WHAT canEdit DOES NOT DO
// ------------------------
// It hides controls. It is not the security boundary and must never be treated
// as one: attendance corrections, adjustments, generation, locking and
// unlocking all keep their own admin checks in their own API routes, and the
// employee's own view is served by an endpoint hard-scoped to their id. If this
// flag were the only thing standing between an employee and an admin action,
// that would be a bug in the route, not here.
//
// Nothing in this file computes money. Every figure is rendered as the payroll
// engine settled it — see src/lib/payroll/engine.ts.

import React from 'react'
import { periodLabel } from '@/lib/payroll/months'
import type { DayTreatment } from '@/lib/attendance/corrections'
import { CalculationRulesSection } from './CalculationRulesSection'
import { COMPANY_PAID_NOTE } from '@/lib/payroll/deductionExplanation'
import { istClockOf } from '@/lib/istDate'

// ─── Types ────────────────────────────────────────────────────────────────────

type DeductionLine = {
  id: string
  line_date: string
  deduction_type: string
  hours_deducted: number | null
  amount_deducted: number | null
}

type Adjustment = {
  id: string
  description: string
  amount: number | null
  status: string
}

export type DetailResult = {
  id: string
  employee_id: string
  employee_name: string
  employee_code: string | null
  monthly_salary: number | null
  working_days_in_month: number | null
  days_present: number | null
  days_absent: number | null
  half_day_count: number | null
  gross_salary: number | null
  total_deductions: number | null
  pending_adjustment_total: number | null
  net_salary: number | null
  status: 'draft' | 'locked'
  generated_at: string | null
  /** Set when the employee has acknowledged their own payslip. */
  employee_reviewed_at: string | null
  deduction_lines: DeductionLine[]
  adjustments: Adjustment[]
}

export type PeriodMeta = {
  id: string
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  locked_at: string | null
}

// `waived_by` and `explain` are engine metadata, carried through the detail API
// so a row can say WHY it costs nothing and the popup can show the workings
// without recalculating them. See src/lib/payroll/types.ts.
export type DeductionLineView = {
  deduction_type: string
  hours_deducted: number
  amount_deducted: number
  waived_by?: string
  explain?: {
    gross_amount: number
    units: number
    unit: 'hours' | 'days'
    rate: number
    rate_basis: 'per_hour' | 'per_day' | 'half_day'
    scheduled_minutes?: number
    grace_end_minutes?: number
    actual_minutes?: number
    minutes_beyond?: number
  }
}

export type DeductionDay = {
  date: string
  classification: string
  lines: DeductionLineView[]
  total_amount: number
  is_corrected: boolean
  check_in_at: string | null
  check_out_at: string | null
}

export type ConsideredDay = {
  date: string
  classification: string
  effective_hours_worked: number
  payable_day_value: number
  is_corrected: boolean
  check_in_at: string | null
  check_out_at: string | null
}

export type CorrectionRow = {
  attendance_date: string
  remark: string
  day_treatment: DayTreatment
  corrected_at: string
  corrected_check_in_at: string | null
  corrected_check_out_at: string | null
  waive_late_arrival: boolean
  waive_early_checkout: boolean
  waive_missing_punch: boolean
  raw_check_in_at: string | null
  raw_check_out_at: string | null
}

export type DetailPayload = {
  period: PeriodMeta
  can_edit: boolean
  edit_blocked: string | null
  result: DetailResult
  deduction_days: DeductionDay[]
  considered_days: ConsideredDay[]
  corrections: CorrectionRow[]
  correctable_dates: string[]
  stale: boolean
  day_view_error: string | null
}

export type TabKey = 'deductions' | 'considered'

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmt(n: number | null): string {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/**
 * Date-only values are formatted from their parts — parsing them as UTC shifts
 * the day in IST. Split so a row can emphasise the date and mute the weekday
 * while the two stay on one line; the joined form is used in prose.
 *
 * "01 July, Wed" — day first, full month, weekday last. No year: the payroll
 * month is stated once in the page header.
 */
function dayDateParts(iso: string): { date: string; weekday: string } {
  const [y, m, d] = iso.split('-').map(Number)
  const local = new Date(y, m - 1, d)
  return {
    date:    local.toLocaleDateString('en-IN', { day: '2-digit', month: 'long' }),
    weekday: local.toLocaleDateString('en-IN', { weekday: 'short' }),
  }
}

export function fmtDayDate(iso: string): string {
  const { date, weekday } = dayDateParts(iso)
  return `${date}, ${weekday}`
}

function DayDateCell({ iso }: { iso: string }) {
  const { date, weekday } = dayDateParts(iso)
  return (
    <>
      <span style={{ color: '#111318', fontWeight: 600 }}>{date}</span>
      <span style={{ color: '#8C94A6', fontWeight: 400 }}>, {weekday}</span>
    </>
  )
}

function fmtPunches(checkIn: string | null, checkOut: string | null): string {
  return `${checkIn ? istClockOf(checkIn) : '—'} → ${checkOut ? istClockOf(checkOut) : '—'}`
}

function fmtCount(n: number | null): string {
  return n != null ? String(n) : '—'
}

function fmtHours(h: number): string {
  if (h <= 0) return '—'
  const total = Math.round(h * 60)
  const hrs = Math.floor(total / 60)
  const min = total % 60
  return min === 0 ? `${hrs}h` : `${hrs}h ${min}m`
}

const DEDUCTION_LABELS: Record<string, string> = {
  late_arrival:        'Late Arrival',
  early_checkout:      'Early Checkout',
  missing_punch_in:    'Missing Punch-In',
  missing_punch_out:   'Missing Punch-Out',
  absent:              'Absent',
  half_day:            'Half Day',
  short_hours:         'Short Hours',
}

export const CLASSIFICATION_LABELS: Record<string, string> = {
  full_present:           'Full Present',
  present_with_shortfall: 'Present (short hours)',
  short_present:          'Short Present',
  half_day:               'Half Day',
  full_absent:            'Absent',
  missing_punch:          'Missing Punch',
  weekly_off:             'Weekly Off',
  holiday:                'Paid Holiday',
  pre_joining:            'Before Joining',
}

// Day classification is written as plain secondary text, not a badge — a table
// where every row carries a coloured pill reads as noise rather than as signal.
// Three tones only: green for a fully paid, fully worked day, amber for any
// exception, muted for the paid-but-not-worked ones. Red is reserved for the
// money column so the deduction amounts stay the fastest thing to scan.
function classificationTone(classification: string): string {
  switch (classification) {
    case 'full_present':
      return '#059669'
    case 'present_with_shortfall':
    case 'short_present':
    case 'missing_punch':
    case 'full_absent':
      return '#B45309'
    // Half day keeps the module's own purple, muted to text weight.
    case 'half_day':
      return '#7C5CD6'
    default:
      return '#8C94A6'
  }
}

function DayStatus({ classification }: { classification: string }) {
  return (
    <div style={{
      fontSize: 11.5, fontWeight: 500, marginTop: 3,
      color: classificationTone(classification),
    }}>
      {CLASSIFICATION_LABELS[classification] ?? classification}
    </div>
  )
}

function Pill({ tone, children }: { tone: { bg: string; color: string }; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
      background: tone.bg, color: tone.color,
    }}>
      {children}
    </span>
  )
}

function CorrectedBadge({ remark }: { remark?: string }) {
  return (
    <span
      title={remark ? `Manual override — ${remark}` : 'Manual override'}
      style={{
        display: 'inline-block', marginLeft: 6, padding: '1px 7px', borderRadius: 20,
        fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
        background: 'rgba(85,133,232,0.12)', color: '#3B63B8', cursor: 'help',
      }}
    >
      Corrected
    </span>
  )
}

function StatusBadge({ status }: { status: DetailResult['status'] }) {
  const map = {
    draft:  { bg: 'rgba(140,148,166,0.12)', color: '#6B7280', label: 'Draft' },
    locked: { bg: 'rgba(232,160,48,0.15)',  color: '#B45309', label: 'Locked' },
  }
  const s = map[status]
  return <Pill tone={s}>{s.label}</Pill>
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: '#8C94A6',
      padding: '14px 20px 8px', borderBottom: '1px solid rgba(0,0,0,0.06)',
    }}>
      {title}
    </div>
  )
}

// ── Summary rail primitives ───────────────────────────────────────────────────

function SummaryLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 12, padding: '5px 0',
    }}>
      <span style={{ fontSize: 12.5, color: '#6B7280' }}>{label}</span>
      <span style={{
        fontSize: 13.5, fontWeight: 600, color: tone ?? '#3D4455',
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  )
}

function SummaryGroup({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 3,
    }}>
      {title}
    </div>
  )
}

function SummaryDivider() {
  return <div style={{ height: 1, background: 'rgba(0,0,0,0.07)', margin: '15px 0 12px' }} />
}

const TH: React.CSSProperties = {
  padding: '10px 16px', textAlign: 'left',
  fontSize: 10.5, fontWeight: 700, color: '#8C94A6',
  textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
}

const TD: React.CSSProperties = { padding: '10px 16px', fontSize: 13, color: '#3D4455', verticalAlign: 'top' }

// The header rule is deliberately heavier than the row rules, so the head reads
// as the table's edge and the body reads as one continuous ledger.
const THEAD_ROW: React.CSSProperties = { borderBottom: '1px solid rgba(0,0,0,0.10)' }
const ROW_DIVIDER = '1px solid rgba(0,0,0,0.045)'

/** First line of a stacked attendance cell — the punch pair. */
const PUNCH_LINE: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: '#3D4455', fontVariantNumeric: 'tabular-nums',
}

// ── Aggregate (total) row ─────────────────────────────────────────────────────
// Lives inside the table, in <tfoot>, so it inherits the same <colgroup> as the
// rows above it and its figure lands in the very same column. Rendering it as a
// sibling <div> below the table — which is what it used to be — pushed it to the
// card's right edge, one column adrift from the numbers it totals.
const TFOOT_CELL: React.CSSProperties = {
  padding: '13px 16px 14px',
  borderTop: '1px solid rgba(0,0,0,0.11)',
  background: 'rgba(0,0,0,0.012)',
}

const TFOOT_LABEL: React.CSSProperties = {
  ...TFOOT_CELL, fontSize: 13, fontWeight: 600, color: '#3D4455', whiteSpace: 'nowrap',
}

const TFOOT_VALUE: React.CSSProperties = {
  ...TFOOT_CELL, fontSize: 14, fontWeight: 700, textAlign: 'right',
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

// ── Result tabs ───────────────────────────────────────────────────────────────
// Local to this page rather than the shared StatusTabs. That component is the
// list-navigation strip for Payment Requests, Received Payments, Order Requests
// and Confirmed Orders; restyling it to suit one payroll screen would restyle
// four unrelated modules. The switching contract here is identical — same keys,
// same onSelect — so behaviour is unchanged.
//
// Text tabs, not buttons or pills: quiet inactive state, a 2px indicator and a
// weight change on the active one, and a count badge that is tinted only while
// its tab is active so the inactive one never reads as an alert.

type ResultTab = { key: TabKey; label: string; count: number; accent: string; tint: string }

function ResultTabs({
  tabs, active, onSelect,
}: {
  tabs: ResultTab[]
  active: TabKey
  onSelect: (key: TabKey) => void
}) {
  return (
    <div style={{
      display: 'flex', gap: 4, padding: '0 10px',
      borderBottom: '1px solid rgba(0,0,0,0.09)',
    }}>
      {tabs.map(({ key, label, count, accent, tint }) => {
        const isActive = active === key
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            aria-pressed={isActive}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              height: 42, padding: '0 12px', flexShrink: 0,
              border: 'none', background: 'transparent',
              borderBottom: `2px solid ${isActive ? accent : 'transparent'}`,
              marginBottom: -1,
              fontSize: 13, fontWeight: isActive ? 700 : 500,
              color: isActive ? '#111318' : '#6B7384',
              cursor: 'pointer', whiteSpace: 'nowrap',
              transition: 'color 0.12s',
            }}
            onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = '#3D4455' }}
            onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = '#6B7384' }}
          >
            {label}
            <span style={{
              minWidth: 19, height: 19, padding: '0 6px', borderRadius: 999,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: isActive ? tint : 'rgba(0,0,0,0.05)',
              color: isActive ? accent : '#6B7384',
              fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
            }}>
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The explanation affordance.
 *
 * A separate control from Edit, and visually different from it — a circled "?"
 * against Edit's word — because the two do different things and one of them
 * changes payroll. The whole row is clickable as well, for anyone who reaches
 * for the figure rather than the icon; the row handler and this button open the
 * same dialog, so they cannot disagree.
 *
 * Never disabled. A locked period still has to be explainable.
 */
function WhyButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title="How was this calculated?"
      style={{
        fontSize: 13, fontWeight: 700, borderRadius: 999,
        width: 26, height: 26, marginRight: 2, padding: 0,
        border: '1px solid rgba(0,0,0,0.12)', background: 'transparent',
        color: '#8C94A6', cursor: 'pointer', lineHeight: 1,
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
        verticalAlign: 'middle',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(79,111,208,0.08)'
        e.currentTarget.style.color = '#4F6FD0'
        e.currentTarget.style.borderColor = 'rgba(79,111,208,0.35)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = '#8C94A6'
        e.currentTarget.style.borderColor = 'rgba(0,0,0,0.12)'
      }}
    >
      ?
    </button>
  )
}

// Deliberately quiet: on an audit table the amounts and the day statuses are
// what should catch the eye, not the action that sits on every single row.
function EditButton({ onClick, disabled, title }: { onClick: () => void; disabled: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 12, fontWeight: 600, padding: '0 10px', borderRadius: 6,
        minHeight: 30, minWidth: 44, border: 'none', background: 'transparent',
        color: disabled ? '#A9AFBD' : '#6B7280',
        cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={e => {
        if (disabled) return
        e.currentTarget.style.background = 'rgba(79,111,208,0.08)'
        e.currentTarget.style.color = '#4F6FD0'
      }}
      onMouseLeave={e => {
        if (disabled) return
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = '#6B7280'
      }}
    >
      Edit
    </button>
  )
}

// ── Payroll summary rail ──────────────────────────────────────────────────────
// Two blocks only: the money, then the attendance behind it. Identity and record
// state live in the page header, and the day counts the tabs already carry are
// not repeated here.
//
// One gross figure, not two. computeGrossSalary() in lib/payroll/engine.ts returns
// employee.monthly_salary unchanged, so gross_salary and monthly_salary are equal
// by definition rather than by coincidence in one result; the row is labelled
// "Gross Salary" to match the results list and the rest of the payroll module.

function PayrollSummaryCard({ result }: { result: DetailResult }) {
  const deductions  = result.total_deductions ?? 0
  const adjustments = result.pending_adjustment_total ?? 0

  return (
    <div style={{
      background: '#fff', borderRadius: 12,
      border: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden',
    }}>
      <SectionHeader title="Payroll Summary" />

      <div style={{ padding: '16px 18px 18px' }}>
        {/* Reads as a calculation, top to bottom: what was earned, what came
            off, then the result under a rule. Net Payable is the strongest
            figure on the page and shares the right edge with the lines above
            it, so all four amounts sit on one column. */}
        <SummaryLine label="Gross Salary" value={fmt(result.gross_salary)} />
        <SummaryLine
          label="Deductions"
          value={deductions > 0 ? `−${fmt(result.total_deductions)}` : fmt(result.total_deductions)}
          tone={deductions > 0 ? '#DC2626' : undefined}
        />
        <SummaryLine
          label="Adjustments"
          value={`${adjustments > 0 ? '+' : ''}${fmt(result.pending_adjustment_total)}`}
          tone={adjustments === 0 ? undefined : adjustments > 0 ? '#16A34A' : '#DC2626'}
        />
        {/* Detail only when there is something to detail — a zero-adjustment
            state says nothing the line above has not already said. */}
        {result.adjustments.map(adj => (
          <div key={adj.id} style={{
            display: 'flex', justifyContent: 'space-between', gap: 10,
            fontSize: 11.5, color: '#8C94A6', padding: '1px 0 3px 10px',
          }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {adj.description}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {(adj.amount ?? 0) > 0 ? '+' : ''}{fmt(adj.amount)}
            </span>
          </div>
        ))}

        {/* The rule reads as the line you draw under a column before totalling
            it, so it sits tight above the result rather than centred in space. */}
        <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '11px 0 9px' }} />
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'baseline', gap: 10,
        }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.09em', color: '#6B7384',
          }}>
            Net Payable
          </span>
          {/* Body font, not the display face — this is an accounting figure. */}
          <span style={{
            fontSize: 27, fontWeight: 700, lineHeight: 1.05, color: '#111318',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {fmt(result.net_salary)}
          </span>
        </div>

        <SummaryDivider />
        <SummaryGroup title="Attendance" />
        <SummaryLine label="Working Days" value={fmtCount(result.working_days_in_month)} />
        <SummaryLine label="Present"      value={fmtCount(result.days_present)} />
        <SummaryLine label="Absent"       value={fmtCount(result.days_absent)} />
        {result.half_day_count != null && result.half_day_count > 0 && (
          <SummaryLine label="Half Days"  value={String(result.half_day_count)} />
        )}
      </div>
    </div>
  )
}

// ─── Tab 1: Deductions ────────────────────────────────────────────────────────

function DeductionsTab({
  days, totalDeductions, corrections, canEdit, editHint, onEdit, onExplain,
}: {
  days: DeductionDay[]
  totalDeductions: number | null
  corrections: Map<string, CorrectionRow>
  canEdit: boolean
  editHint: string | null
  onEdit?: (date: string) => void
  onExplain: (date: string) => void
}) {
  if (days.length === 0) {
    return <div style={{ padding: '28px 20px', fontSize: 13, color: '#8C94A6' }}>No deductions applied.</div>
  }

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="payroll-ledger" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
          {/* Fixed proportions so the amount and action columns never shift as
              the reason text changes length from row to row. */}
          <colgroup>
            <col style={{ width: '17%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '27%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '9%'  }} />
          </colgroup>
          <thead>
            <tr style={THEAD_ROW}>
              <th style={TH}>Date</th>
              <th style={TH}>Attendance Issue</th>
              <th style={TH}>Attendance</th>
              <th style={{ ...TH, textAlign: 'right' }}>Deduction</th>
              <th style={{ ...TH, textAlign: 'right' }} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => {
              const correction = corrections.get(day.date)
              // One row per DATE. The reasons stack inside it, so a date with
              // two deductions carries one Edit action, not two — and one
              // explanation covering all of them.
              return (
                <tr
                  key={day.date}
                  className="payroll-ledger-row--explainable"
                  onClick={() => onExplain(day.date)}
                  style={{ borderBottom: i < days.length - 1 ? ROW_DIVIDER : 'none', cursor: 'pointer' }}
                >
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    <DayDateCell iso={day.date} />
                    {day.is_corrected && <CorrectedBadge remark={correction?.remark} />}
                  </td>
                  <td style={TD}>
                    {day.lines.map((l, j) => (
                      <div key={j} style={{ marginTop: j > 0 ? 3 : 0 }}>
                        {/* Neutral: red is reserved for the money column, so the
                            amounts stay the fastest thing to find on the row. */}
                        <span style={{ color: '#3D4455', fontWeight: 500 }}>
                          {l.waived_by === 'paid_leave'
                            ? 'Paid Leave · Company Paid'
                            : DEDUCTION_LABELS[l.deduction_type] ?? l.deduction_type}
                        </span>
                        {l.waived_by !== 'paid_leave' && l.hours_deducted > 0 && (
                          <span style={{ color: '#8C94A6', fontVariantNumeric: 'tabular-nums' }}>
                            {' · '}{fmtHours(l.hours_deducted)}
                          </span>
                        )}
                        {l.waived_by === 'paid_leave' && (
                          <div style={{ fontSize: 11.5, color: '#047857', marginTop: 1 }}>
                            {COMPANY_PAID_NOTE}
                          </div>
                        )}
                      </div>
                    ))}
                    {correction && (
                      <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 5, fontStyle: 'italic' }}>
                        {correction.remark}
                      </div>
                    )}
                  </td>
                  {/* Punches over status, stacked — one compact cell, no badge. */}
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    <div style={PUNCH_LINE}>{fmtPunches(day.check_in_at, day.check_out_at)}</div>
                    <DayStatus classification={day.classification} />
                  </td>
                  {/* A company-paid date is green and unsigned: it is not a
                      cut, and printing "−₹0.00" would read as one. */}
                  <td style={{
                    ...TD, textAlign: 'right', fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                    color: day.total_amount > 0 ? '#DC2626' : '#047857',
                  }}>
                    {day.total_amount > 0 ? `−${fmt(day.total_amount)}` : fmt(0)}
                  </td>
                  {/* Both actions live here, and the row click behind them is
                      stopped so neither can be triggered by accident. */}
                  <td
                    style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <WhyButton
                      onClick={() => onExplain(day.date)}
                      label={`How ${fmtDayDate(day.date)} was calculated`}
                    />
                    {/* No callback means no edit path exists for this reader —
                        the control is absent rather than disabled. */}
                    {onEdit && (
                      <EditButton
                        onClick={() => onEdit(day.date)}
                        disabled={!canEdit}
                        title={canEdit ? 'Correct this date' : editHint ?? undefined}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={TFOOT_LABEL} colSpan={3}>Total Deductions</td>
              {/* Same sign convention as the rows, so the column reads as one
                  continuous run of figures down to the total. Company-paid rows
                  carry ₹0 and therefore change nothing here. */}
              <td style={{ ...TFOOT_VALUE, color: '#DC2626' }}>
                −{fmt(totalDeductions)}
              </td>
              <td style={TFOOT_CELL} />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

// ─── Tab 2: Days Considered ───────────────────────────────────────────────────

function ConsideredTab({
  days, corrections, correctableDates, canEdit, editHint, onEdit,
}: {
  days: ConsideredDay[]
  corrections: Map<string, CorrectionRow>
  correctableDates: Set<string>
  canEdit: boolean
  editHint: string | null
  onEdit?: (date: string) => void
}) {
  if (days.length === 0) {
    return <div style={{ padding: '28px 20px', fontSize: 13, color: '#8C94A6' }}>No paid days in this period.</div>
  }

  const payableTotal = days.reduce((sum, d) => sum + d.payable_day_value, 0)

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="payroll-ledger" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
          {/* Date and Action match the Deductions tab exactly, so switching tabs
              does not move those columns. */}
          <colgroup>
            <col style={{ width: '17%' }} />
            <col style={{ width: '35%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '9%'  }} />
          </colgroup>
          <thead>
            <tr style={THEAD_ROW}>
              <th style={TH}>Date</th>
              <th style={TH}>Attendance</th>
              <th style={TH}>Worked</th>
              <th style={{ ...TH, textAlign: 'right' }}>Payable</th>
              <th style={{ ...TH, textAlign: 'right' }} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => {
              const correction = corrections.get(day.date)
              const editable = canEdit && correctableDates.has(day.date)
              return (
                <tr key={day.date} style={{ borderBottom: i < days.length - 1 ? ROW_DIVIDER : 'none' }}>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    <DayDateCell iso={day.date} />
                    {day.is_corrected && <CorrectedBadge remark={correction?.remark} />}
                  </td>
                  {/* Same compact stacked cell as the Deductions tab. */}
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    <div style={PUNCH_LINE}>{fmtPunches(day.check_in_at, day.check_out_at)}</div>
                    <DayStatus classification={day.classification} />
                    {correction && (
                      <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 4, fontStyle: 'italic', whiteSpace: 'normal' }}>
                        {correction.remark}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: '#6B7280' }}>
                    {day.effective_hours_worked > 0 ? fmtHours(day.effective_hours_worked) : '—'}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: day.payable_day_value > 0 ? '#3D4455' : '#8C94A6' }}>
                    {day.payable_day_value > 0 ? `${day.payable_day_value}d` : '—'}
                  </td>
                  <td style={{ ...TD, textAlign: 'right' }}>
                    {onEdit && correctableDates.has(day.date) && (
                      <EditButton
                        onClick={() => onEdit(day.date)}
                        disabled={!editable}
                        title={editable ? 'Correct this date' : editHint ?? undefined}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={TFOOT_LABEL} colSpan={3}>Payable Days Counted</td>
              <td style={{ ...TFOOT_VALUE, color: '#111318' }}>{payableTotal}d</td>
              <td style={TFOOT_CELL} />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}


// ─── The shared workspace ─────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#fff', borderRadius: 12,
  border: '1px solid rgba(0,0,0,0.08)',
  overflow: 'hidden', marginBottom: 20,
}

/**
 * Everything below the page header: the employee's name and month, the state
 * banners, the two result tabs, the salary rail, and the calculation guide.
 *
 * `onEdit` is optional on purpose. An employee view simply does not pass one,
 * which is a stronger statement than passing a callback that refuses: there is
 * no edit path to reach.
 */
export function PayrollDetailWorkspace({
  result, data, tab, onSelectTab, corrections, correctableDates,
  canEdit, onEdit, onExplain, notices, issuePanel,
}: {
  result: DetailResult
  data: DetailPayload
  tab: TabKey
  onSelectTab: (t: TabKey) => void
  corrections: Map<string, CorrectionRow>
  correctableDates: Set<string>
  canEdit: boolean
  onEdit?: (date: string) => void
  onExplain: (date: string) => void
  /** Admin-only banners (save confirmations and the like). */
  notices?: React.ReactNode
  /** The raised-issue panel, which differs between the two readers. */
  issuePanel?: React.ReactNode
}) {
  const tabs: ResultTab[] = [
    {
      key: 'deductions',
      label: 'Deductions',
      count: data.deduction_days.length,
      accent: '#DC2626',
      tint:   'rgba(220,38,38,0.10)',
    },
    {
      key: 'considered',
      label: 'Days Considered',
      count: data.considered_days.length,
      accent: '#059669',
      tint:   'rgba(5,150,105,0.11)',
    },
  ]

  return (
    <div className="payroll-detail-page">

      {/* The one place the employee is named. Sits directly on the page
          background — identity does not need a card around it. */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#111318', letterSpacing: '-0.015em' }}>
          {result.employee_name}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
          marginTop: 6, fontSize: 13, color: '#8C94A6',
        }}>
          {result.employee_code && <span>{result.employee_code}</span>}
          {result.employee_code && <span aria-hidden>·</span>}
          <span style={{ color: '#111318', fontWeight: 600, fontSize: 13.5 }}>
            {periodLabel(data.period.payroll_month, data.period.payroll_year)}
          </span>
          <StatusBadge status={result.status} />
          {result.generated_at && (
            <span style={{ fontSize: 12.5 }}>Generated {fmtDate(result.generated_at)}</span>
          )}
        </div>
      </div>

      {issuePanel}

      {/* Why editing is unavailable — stated once, above the tabs, and only to
          someone who would otherwise have had an edit control. */}
      {canEdit === false && data.edit_blocked && onEdit && (
        <div style={{
          marginBottom: 16, padding: '11px 16px', borderRadius: 9,
          background: 'rgba(232,160,48,0.10)', color: '#92400E',
          border: '1px solid rgba(232,160,48,0.35)', fontSize: 13,
          display: 'flex', gap: 9, alignItems: 'center',
        }}>
          <span style={{ fontSize: 15 }}>🔒</span>
          <span>{data.edit_blocked}</span>
        </div>
      )}

      {data.stale && (
        <div style={{
          marginBottom: 16, padding: '11px 16px', borderRadius: 9,
          background: 'rgba(85,133,232,0.09)', color: '#3B63B8',
          border: '1px solid rgba(85,133,232,0.3)', fontSize: 13,
        }}>
          {onEdit
            ? 'Attendance for this month changed after this payroll was generated. The day rows below are up to date; the salary figures are not. Regenerate payroll for this period to bring them back in line.'
            : 'Attendance for this month changed after this payroll was generated. The day rows below are up to date; the salary figures have not been recalculated yet.'}
        </div>
      )}

      {data.day_view_error && (
        <div style={{
          marginBottom: 16, padding: '11px 16px', borderRadius: 9,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          The day-level breakdown could not be built: {data.day_view_error}
        </div>
      )}

      {notices}

      {/* Ledger (left) + payroll summary rail (right).
          Below 1024 this stacks and the rail moves above the table. */}
      <div className="payroll-detail-workspace">
        <div className="payroll-detail-main">
          <div style={{ ...card, marginBottom: 0 }}>
            <ResultTabs tabs={tabs} active={tab} onSelect={onSelectTab} />

            {tab === 'deductions' ? (
              <DeductionsTab
                days={data.deduction_days}
                totalDeductions={result.total_deductions}
                corrections={corrections}
                canEdit={canEdit}
                editHint={data.edit_blocked}
                onEdit={onEdit}
                onExplain={onExplain}
              />
            ) : (
              <ConsideredTab
                days={data.considered_days}
                corrections={corrections}
                correctableDates={correctableDates}
                canEdit={canEdit}
                editHint={data.edit_blocked}
                onEdit={onEdit}
              />
            )}
          </div>
        </div>

        <aside className="payroll-detail-aside">
          <div className="payroll-detail-aside-inner">
            <PayrollSummaryCard result={result} />
          </div>
        </aside>
      </div>

      {/* The system behind the figures — collapsed, full page width, and below
          the workspace so it never competes with the ledger. */}
      <CalculationRulesSection />
    </div>
  )
}
