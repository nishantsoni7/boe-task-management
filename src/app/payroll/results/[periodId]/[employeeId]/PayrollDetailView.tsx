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
import { formatRupees } from '@/lib/payroll/money'
import { periodLabel, formatGeneratedAt } from '@/lib/payroll/months'
import { Avatar } from '@/components/ui/atoms'
import type { DayTreatment } from '@/lib/attendance/corrections'
import {
  PAYMENT_NOT_RECORDED_LABEL,
  SETTLEMENT_STATUS_NOT_RECORDED,
} from '@/lib/payroll/settlement'
import { COMPANY_PAID_NOTE } from '@/lib/payroll/deductionExplanation'
import { istClockOf } from '@/lib/istDate'
import {
  coveredLabel,
  redemptionOfferLabel,
  type RedeemableDate,
} from '@/lib/boeCredits/attendanceRedemption'

// ─── Types ────────────────────────────────────────────────────────────────────

type DeductionLine = {
  id: string
  line_date: string
  deduction_type: string
  hours_deducted: number | null
  amount_deducted: number | null
}

/**
 * One manual adjustment, with a SIGNED amount.
 *
 * The API converts through toSignedAdjustment before this reaches the UI, so a
 * deduction arrives negative. It did not always: the detail payload selected
 * `amount` without `adjustment_type`, and since storage keeps `amount` positive
 * with the direction in the type, every recovery rendered with a "+".
 */
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
  /** 'paid_leave' (the company paid) or 'boe_credits' (the employee's credits did). */
  waived_by?: string
  /** With waived_by 'boe_credits': the credits spent. */
  credits_redeemed?: number
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

/**
 * The settlement block, computed server-side in src/lib/payroll/settlement.ts.
 *
 * Every figure arrives finished. This file formats them and does no arithmetic
 * of its own — which is what stops a number on screen from drifting away from
 * the records it came from.
 */
export type SettlementPayload = {
  figures: {
    gross_salary: number
    attendance_deductions: number
    salary_after_attendance: number
    carry_forward: number
    other_adjustments: number
    net_adjustments: number
    salary_payable: number
    amount_paid: number | null
    /** Null when no payment has been recorded — there is no balance yet. */
    closing_balance: number | null
    payment_status: 'recorded' | 'not_recorded'
  }
  /** The closing balance in plain language, for the employee. */
  sentence: string
  /** False when the itemised adjustments do not sum to the engine's total. */
  adjustments_balance: boolean
  carry_forward: {
    proposed: number
    is_manual: boolean
    remark: string | null
    source_period_id: string | null
    set_at: string | null
  } | null
  payment: {
    payment_date: string | null
    remark: string | null
    recorded_at: string | null
  } | null
}

export type DetailPayload = {
  period: PeriodMeta
  can_edit: boolean
  edit_blocked: string | null
  result: DetailResult
  /** Absent only if migration 20260826000000 has not been applied. */
  settlement?: SettlementPayload
  deduction_days: DeductionDay[]
  considered_days: ConsideredDay[]
  corrections: CorrectionRow[]
  correctable_dates: string[]
  /**
   * BOE Credits (Phase 1C). `can_redeem` is true only for the employee's own
   * view of an unlocked month; `redeemable_dates` lists the dates whose
   * deduction credits could cover. Absent before migration 20261103000000.
   */
  can_redeem?: boolean
  redeemable_dates?: RedeemableDate[]
  stale: boolean
  day_view_error: string | null
}

export type TabKey = 'deductions' | 'considered'

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmt(n: number | null): string {
  if (n == null) return '—'
  // Whole rupees: every payroll figure is stored whole since the whole-rupee
  // rule, and a payslip that printed paise would not match what was paid.
  return formatRupees(n)
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

export function DayDateCell({ iso }: { iso: string }) {
  const { date, weekday } = dayDateParts(iso)
  return (
    <>
      <span style={{ color: '#111318', fontWeight: 600 }}>{date}</span>
      <span style={{ color: '#8C94A6', fontWeight: 400 }}>, {weekday}</span>
    </>
  )
}

export function fmtPunches(checkIn: string | null, checkOut: string | null): string {
  return `${checkIn ? istClockOf(checkIn) : '—'} → ${checkOut ? istClockOf(checkOut) : '—'}`
}

function fmtCount(n: number | null): string {
  return n != null ? String(n) : '—'
}

export function fmtHours(h: number): string {
  if (h <= 0) return '—'
  const total = Math.round(h * 60)
  const hrs = Math.floor(total / 60)
  const min = total % 60
  return min === 0 ? `${hrs}h` : `${hrs}h ${min}m`
}

export const DEDUCTION_LABELS: Record<string, string> = {
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

export function Pill({ tone, children }: { tone: { bg: string; color: string }; children: React.ReactNode }) {
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

/**
 * One label/value pair in the identity header's metadata group.
 *
 * The label above the value rather than beside it: three inline "Label: value"
 * pairs on one line read as a sentence and force the eye to re-parse where each
 * ends, and stacking keeps the group two lines tall — the same height as the
 * identity beside it, which is what lets the whole card stay on one row.
 *
 * The label styling is SectionHeader's, so the two agree about what a small
 * uppercase label looks like on this page.
 */
export function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.07em', color: '#8C94A6', lineHeight: 1.3,
        whiteSpace: 'nowrap',
      }}>
        {label}
      </div>
      <div style={{
        marginTop: 1, fontSize: 13, fontWeight: 600, color: '#111318',
        lineHeight: 1.3, display: 'flex', alignItems: 'center', minHeight: 17,
      }}>
        {children}
      </div>
    </div>
  )
}

export function SectionHeader({ title }: { title: string }) {
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

export function SummaryLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
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

export function SummaryGroup({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 3,
    }}>
      {title}
    </div>
  )
}

export function SummaryDivider() {
  return <div style={{ height: 1, background: 'rgba(0,0,0,0.07)', margin: '15px 0 12px' }} />
}

export const TH: React.CSSProperties = {
  padding: '10px 16px', textAlign: 'left',
  fontSize: 10.5, fontWeight: 700, color: '#8C94A6',
  textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
}

export const TD: React.CSSProperties = { padding: '10px 16px', fontSize: 13, color: '#3D4455', verticalAlign: 'top' }

// The header rule is deliberately heavier than the row rules, so the head reads
// as the table's edge and the body reads as one continuous ledger.
export const THEAD_ROW: React.CSSProperties = { borderBottom: '1px solid rgba(0,0,0,0.10)' }
export const ROW_DIVIDER = '1px solid rgba(0,0,0,0.045)'

/** First line of a stacked attendance cell — the punch pair. */
export const PUNCH_LINE: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: '#3D4455', fontVariantNumeric: 'tabular-nums',
}

// ── Aggregate (total) row ─────────────────────────────────────────────────────
// Lives inside the table, in <tfoot>, so it inherits the same <colgroup> as the
// rows above it and its figure lands in the very same column. Rendering it as a
// sibling <div> below the table — which is what it used to be — pushed it to the
// card's right edge, one column adrift from the numbers it totals.
export const TFOOT_CELL: React.CSSProperties = {
  padding: '13px 16px 14px',
  borderTop: '1px solid rgba(0,0,0,0.11)',
  background: 'rgba(0,0,0,0.012)',
}

export const TFOOT_LABEL: React.CSSProperties = {
  ...TFOOT_CELL, fontSize: 13, fontWeight: 600, color: '#3D4455', whiteSpace: 'nowrap',
}

export const TFOOT_VALUE: React.CSSProperties = {
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

/**
 * The employee's offer to cover a day with BOE Credits (Phase 1C).
 *
 * Present only on the employee's own view, only on an unlocked month, and only
 * on a date whose deduction the server listed as coverable — it opens a
 * confirmation, and the server decides again before anything is written. The
 * accent is the credits' own blue so it reads as a different kind of action
 * from Edit, which changes payroll on the admin's authority.
 */
function RedeemButton({ offer, onClick }: { offer: RedeemableDate; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`Cover this deduction with BOE Credits — ${redemptionOfferLabel(offer.deduction_type)}`}
      style={{
        fontSize: 12, fontWeight: 600, padding: '0 10px', borderRadius: 6,
        minHeight: 30, border: '1px solid rgba(79,111,208,0.35)', background: 'rgba(79,111,208,0.06)',
        color: '#3B63B8', cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(79,111,208,0.14)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(79,111,208,0.06)' }}
    >
      Use {offer.credits} {offer.credits === 1 ? 'credit' : 'credits'}
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

function PayrollSummaryCard({
  result, settlement,
}: {
  result: DetailResult
  settlement?: SettlementPayload
}) {
  const deductions = result.total_deductions ?? 0

  // ONE headline figure on the page, not two.
  //
  // The rail used to total to "Net Payable" (payroll_results.net_salary) and
  // itemise the adjustments itself. With settlement below it, that becomes two
  // different final answers on one screen — and they genuinely disagree, because
  // net_salary is clamped at ₹0 and carries no carry-forward. So the rail now
  // ends at Salary Payable, the same figure the settlement section reaches, and
  // the itemised adjustments live once, down there, with their reasons and their
  // correct signs.
  //
  // The Net Payable fallback remains for the case where the settlement tables
  // are not present yet (migration 20260826000000 unapplied), so the page keeps
  // working rather than losing its total.
  const headline = settlement
    ? { label: 'Salary Payable', value: settlement.figures.salary_payable }
    : { label: 'Net Payable',    value: result.net_salary ?? 0 }

  return (
    <div style={{
      background: '#fff', borderRadius: 12,
      border: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden',
    }}>
      <SectionHeader title="Payroll Summary" />

      <div style={{ padding: '16px 18px 18px' }}>
        {/* Reads as a calculation, top to bottom: what was earned, what came
            off, then the result under a rule. */}
        <SummaryLine label="Gross Salary" value={fmt(result.gross_salary)} />
        <SummaryLine
          label="Deductions"
          value={deductions > 0 ? `−${fmt(result.total_deductions)}` : fmt(result.total_deductions)}
          tone={deductions > 0 ? '#DC2626' : undefined}
        />
        {settlement && (
          <>
            <SummaryLine label="Salary After Attendance" value={fmt(settlement.figures.salary_after_attendance)} />
            <SummaryLine
              label="Net Adjustments"
              value={fmtSignedAmount(settlement.figures.net_adjustments)}
              tone={signTone(settlement.figures.net_adjustments)}
            />
          </>
        )}

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
            {headline.label}
          </span>
          {/* Body font, not the display face — this is an accounting figure. */}
          <span style={{
            fontSize: 27, fontWeight: 700, lineHeight: 1.05, color: '#111318',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {fmt(headline.value)}
          </span>
        </div>

        {/* What is still outstanding, in one line, for anyone who reads only the
            rail. The full ladder is in Adjustments & Settlement below.
            An unrecorded payment states itself rather than showing a balance
            that has not been established. */}
        {settlement && (
          <div style={{ marginTop: 10 }}>
            {settlement.figures.payment_status === 'recorded' ? (
              <>
                <SummaryLine label="Amount Paid" value={fmt(settlement.figures.amount_paid ?? 0)} />
                <SummaryLine
                  label="Balance Carried Forward"
                  value={fmtSignedAmount(settlement.figures.closing_balance ?? 0)}
                  tone={signTone(settlement.figures.closing_balance ?? 0)}
                />
              </>
            ) : (
              <>
                <SummaryLine label="Amount Paid" value={PAYMENT_NOT_RECORDED_LABEL} tone="#8C94A6" />
                <SummaryLine label="Settlement Status" value={SETTLEMENT_STATUS_NOT_RECORDED} tone="#8C94A6" />
              </>
            )}
          </div>
        )}

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

// ─── Adjustments & Settlement ─────────────────────────────────────────────────
//
// Three blocks, in the order the money is worked out: what the month earned,
// what was added or recovered, what was actually settled. Deliberately NOT
// folded into the deductions ledger — an advance recovery is not an attendance
// deduction, and putting them in one list is how the two get confused.
//
// Signs are explicit on every signed figure. Colour is a second signal only:
// read this in greyscale and the direction is still unambiguous.

export function SettlementRow({
  label, value, tone, remark, strong, muted,
}: {
  label: string
  value: string
  tone?: string
  remark?: string | null
  strong?: boolean
  muted?: boolean
}) {
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
      }}>
        <span style={{
          fontSize: strong ? 13 : 12.5,
          fontWeight: strong ? 600 : 400,
          color: muted ? '#8C94A6' : strong ? '#3D4455' : '#6B7280',
          minWidth: 0,
        }}>
          {label}
        </span>
        <span style={{
          fontSize: strong ? 14 : 13.5,
          fontWeight: strong ? 700 : 600,
          color: tone ?? (muted ? '#8C94A6' : '#3D4455'),
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>
          {value}
        </span>
      </div>
      {remark && (
        <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 2, lineHeight: 1.45, paddingRight: 60 }}>
          {remark}
        </div>
      )}
    </div>
  )
}

export function SettlementRule() {
  return <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '9px 0 7px' }} />
}

/** One card in the left column. Compact: these rows carry little text. */
function SettlementCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 12,
      border: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden',
      padding: '13px 16px 15px',
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 5,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

/** Tone for a signed figure. Never the only carrier of meaning — the sign is. */
export function signTone(amount: number): string | undefined {
  if (Math.abs(amount) < 0.005) return undefined
  return amount > 0 ? '#16A34A' : '#DC2626'
}

export function AdjustmentsAndSettlement({
  settlement, adjustments, canEdit, onEditCarryForward, onEditPayment,
}: {
  settlement: SettlementPayload
  adjustments: Adjustment[]
  canEdit: boolean
  /** Omitted entirely for the employee — there is no edit path to reach. */
  onEditCarryForward?: () => void
  onEditPayment?: () => void
}) {
  const f = settlement.figures
  const hasCarryForward = Math.abs(f.carry_forward) >= 0.005
  const isAdmin = !!onEditCarryForward || !!onEditPayment
  const recorded = f.payment_status === 'recorded'

  return (
    // No width of its own. The grid below is the SAME .payroll-detail-workspace
    // the ledger and summary rail use, so this section's columns, gap and both
    // outer edges are theirs by construction — the settlement card lines up with
    // the rail above it because it is in the same column, not because two
    // numbers happen to match.
    <section style={{ marginTop: 20 }} aria-labelledby="adjustments-settlement">
      {/* The heading sits on the page background rather than inside a card: the
          section is now three cards across two columns, and a header bar on one
          of them would read as belonging to that card alone. */}
      <div
        id="adjustments-settlement"
        style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em', color: '#8C94A6', marginBottom: 10,
        }}
      >
        Adjustments &amp; Settlement
      </div>

      {/* A breakdown that does not add up to its own total is not shown as if it
          does. This fires only on a real inconsistency between the itemised
          rows and the figure the engine applied. */}
      {!settlement.adjustments_balance && (
        <div style={{
          marginBottom: 10, padding: '10px 13px', borderRadius: 8,
          background: 'rgba(232,160,48,0.10)', border: '1px solid rgba(232,160,48,0.35)',
          fontSize: 12.5, color: '#92400E', lineHeight: 1.5,
        }}>
          The individual adjustments below do not add up to the total applied to this payroll.
          Regenerate the period to bring them back in line.
        </div>
      )}

      {/* The page's own workspace grid, reused verbatim. Below 1024 it stacks
          and the aside takes order:-1 — so the mobile order is Settlement,
          Calculation, Adjustments, matching the ledger's answer-before-evidence
          ordering without a second rule to maintain. */}
      <div className="payroll-detail-workspace">
        <div className="payroll-detail-main">
          <div className="payroll-settlement-pair">

          {/* ── What the month earned ────────────────────────────────── */}
          <SettlementCard title="Salary Calculation">
            <SettlementRow label="Gross Salary" value={fmt(f.gross_salary)} />
            <SettlementRow
              label="Attendance Deductions"
              value={f.attendance_deductions > 0 ? `−${fmt(f.attendance_deductions)}` : fmt(0)}
              tone={f.attendance_deductions > 0 ? '#DC2626' : undefined}
            />
            <SettlementRule />
            <SettlementRow label="Salary After Attendance" value={fmt(f.salary_after_attendance)} strong />
          </SettlementCard>

          {/* ── What was added or recovered ──────────────────────────── */}
          <SettlementCard title="Adjustments">
            {hasCarryForward || settlement.carry_forward ? (
              <SettlementRow
                label="Previous Balance"
                value={fmtSignedAmount(f.carry_forward)}
                tone={signTone(f.carry_forward)}
                remark={carryForwardNote(settlement)}
              />
            ) : (
              <SettlementRow label="Previous Balance" value={fmt(0)} muted remark="Nothing carried from the previous payroll period" />
            )}

            {/* One row per adjustment, each with its own reason. Unrelated
                amounts are never merged — an employee must never meet an
                unexplained +₹800 on their payslip. */}
            {adjustments.map(adj => (
              <SettlementRow
                key={adj.id}
                label={adj.description || 'Adjustment'}
                value={fmtSignedAmount(adj.amount ?? 0)}
                tone={signTone(adj.amount ?? 0)}
              />
            ))}

            {adjustments.length === 0 && (
              <SettlementRow label="Other Adjustments" value={fmt(0)} muted remark="None this month" />
            )}

            <SettlementRule />
            <SettlementRow
              label="Net Adjustments"
              value={fmtSignedAmount(f.net_adjustments)}
              tone={signTone(f.net_adjustments)}
              strong
            />

            {/* The action sits with the value it changes, not in a toolbar. */}
            {canEdit && onEditCarryForward && (
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={onEditCarryForward}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '4px 12px', fontSize: 12.5 }}
                >
                  Edit previous balance
                </button>
              </div>
            )}
          </SettlementCard>
          </div>
        </div>

        {/* ── The conclusion, in the page's summary rail ──────────────── */}
        <aside className="payroll-detail-aside">
          <div className="payroll-detail-aside-inner">
            <div style={{
              background: '#fff', borderRadius: 12,
              border: '1px solid rgba(79,111,208,0.28)', overflow: 'hidden',
            }}>
              <div style={{
                padding: '11px 16px 9px',
                borderBottom: '1px solid rgba(0,0,0,0.06)',
                background: 'rgba(79,111,208,0.04)',
                fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.09em', color: '#4F6FD0',
              }}>
                Salary Settlement
              </div>

              <div style={{ padding: '13px 16px 15px' }}>
                <SettlementRow label="Salary After Attendance" value={fmt(f.salary_after_attendance)} />
                <SettlementRow
                  label="Net Adjustments"
                  value={fmtSignedAmount(f.net_adjustments)}
                  tone={signTone(f.net_adjustments)}
                />

                {/* Salary Payable is the whole point of the section, so it is
                    the one figure given size, weight and a tint of its own. */}
                <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '10px 0 0' }} />
                <div style={{
                  margin: '10px -16px', padding: '11px 16px 12px',
                  background: 'rgba(79,111,208,0.06)',
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
                }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.08em', color: '#3B63B8',
                  }}>
                    Salary Payable
                  </span>
                  <span style={{
                    fontSize: 24, fontWeight: 700, lineHeight: 1.05, color: '#111318',
                    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                  }}>
                    {fmt(f.salary_payable)}
                  </span>
                </div>

                {/* Not recorded is a STATE, not a zero. Rendering "−₹0.00" here,
                    and a closing balance of the full payable underneath it, would
                    assert that BOE paid nothing and owes the lot — when in truth
                    nobody has said what was paid yet. */}
                <SettlementRow
                  label="Amount Paid"
                  value={recorded ? fmtAmountPaid(f.amount_paid ?? 0) : PAYMENT_NOT_RECORDED_LABEL}
                  muted={!recorded}
                  remark={paymentNote(settlement)}
                />
                <SettlementRule />
                {recorded ? (
                  <SettlementRow
                    label="Balance Carried Forward"
                    value={fmtSignedAmount(f.closing_balance ?? 0)}
                    tone={signTone(f.closing_balance ?? 0)}
                    strong
                  />
                ) : (
                  <SettlementRow
                    label="Settlement Status"
                    value={SETTLEMENT_STATUS_NOT_RECORDED}
                    muted
                    strong
                  />
                )}

                {/* Plain language, for both readers. An admin benefits from it
                    too — "+₹2,221.95" does not say who owes whom. */}
                <div style={{
                  marginTop: 10, padding: '9px 12px', borderRadius: 8,
                  background: 'rgba(0,0,0,0.028)', fontSize: 12.5, color: '#3D4455', lineHeight: 1.5,
                }}>
                  {settlement.sentence}
                </div>

                {/* The payment action, directly under the figures it sets. */}
                {canEdit && onEditPayment && (
                  <button
                    onClick={onEditPayment}
                    className="boe-btn boe-btn-primary"
                    style={{ marginTop: 11, padding: '7px 14px', fontSize: 12.5, width: '100%' }}
                  >
                    {recorded ? 'Edit amount paid' : 'Record amount paid'}
                  </button>
                )}

                {/* Why the controls are gone, said once, to the reader who would
                    otherwise have had them. */}
                {isAdmin && !canEdit && (
                  <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 10, lineHeight: 1.5 }}>
                    This period is locked. Unlock it to change the balance or the payment.
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  )
}

/** Signed money with an explicit + or −, so direction survives without colour. */
export function fmtSignedAmount(amount: number): string {
  if (Math.abs(amount) < 0.005) return fmt(0)
  return `${amount > 0 ? '+' : '−'}${fmt(Math.abs(amount))}`
}

/**
 * Amount Paid, shown as the subtraction it is — except at zero.
 *
 * "−₹0.00" is not a smaller number than "₹0.00"; it reads as a negative
 * quantity, which is meaningless for a payment and makes a deliberately recorded
 * ₹0 look like a data error. The minus is punctuation for the subtraction, so it
 * is dropped when there is nothing to subtract.
 *
 * Display only. The formula is unchanged: closing_balance is still
 * salary_payable − amount_paid, and a recorded ₹0 still leaves the whole payable
 * outstanding.
 */
function fmtAmountPaid(amount: number): string {
  if (Math.abs(amount) < 0.005) return fmt(0)
  return `−${fmt(amount)}`
}

function carryForwardNote(settlement: SettlementPayload): string | null {
  const cf = settlement.carry_forward
  if (!cf) return null
  if (cf.is_manual) {
    // A manual override always shows its reason. The employee is entitled to
    // know why their opening balance is not the figure the system worked out.
    return cf.remark ? `Adjusted manually — ${cf.remark}` : 'Adjusted manually'
  }
  return cf.source_period_id ? 'Carried from the previous payroll period' : null
}

function paymentNote(settlement: SettlementPayload): string | null {
  const p = settlement.payment
  if (!p) return null
  const parts: string[] = []
  if (p.payment_date) parts.push(`Paid ${fmtDayDate(p.payment_date)}`)
  if (p.remark) parts.push(p.remark)
  return parts.length > 0 ? parts.join(' · ') : null
}

// The guide link card that used to sit here has been removed, and nothing
// replaces it — no banner, no accordion, no inline explainer. Payroll Result
// Detail is this employee's salary and settlement; a module-wide explanation
// competed with the figures it was meant to explain. The guide is reachable from
// the Payroll sidebar, and for employees from the Attendance sidebar.

// ─── Tab 1: Deductions ────────────────────────────────────────────────────────

function DeductionsTab({
  days, totalDeductions, corrections, canEdit, editHint, onEdit, onExplain, redeemable, onRedeem,
}: {
  days: DeductionDay[]
  totalDeductions: number | null
  corrections: Map<string, CorrectionRow>
  canEdit: boolean
  editHint: string | null
  onEdit?: (date: string) => void
  onExplain: (date: string) => void
  /** Dates the reader may cover with BOE Credits. Empty for every reader but the employee. */
  redeemable: Map<string, RedeemableDate>
  onRedeem?: (date: string) => void
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
                        {l.waived_by == null && l.hours_deducted > 0 && (
                          <span style={{ color: '#8C94A6', fontVariantNumeric: 'tabular-nums' }}>
                            {' · '}{fmtHours(l.hours_deducted)}
                          </span>
                        )}
                        {l.waived_by === 'paid_leave' && (
                          <div style={{ fontSize: 11.5, color: '#047857', marginTop: 1 }}>
                            {COMPANY_PAID_NOTE}
                          </div>
                        )}
                        {/* The day keeps its name — Half Day, Absent — and the
                            note says who paid: the employee's BOE Credits. Both
                            readers see it; only the employee could act on it. */}
                        {l.waived_by === 'boe_credits' && (
                          <div style={{ fontSize: 11.5, color: '#047857', marginTop: 1, fontWeight: 600 }}>
                            {coveredLabel(l.credits_redeemed ?? 0)}
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
                    {/* Same statement for the employee's action: present only
                        where the server offered it. */}
                    {onRedeem && redeemable.has(day.date) && (
                      <RedeemButton offer={redeemable.get(day.date)!} onClick={() => onRedeem(day.date)} />
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
  canEdit, onEdit, onExplain, onEditCarryForward, onEditPayment, onRedeem, notices, issuePanel,
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
  /** Settlement editing. Absent for the employee, exactly like onEdit. */
  onEditCarryForward?: () => void
  onEditPayment?: () => void
  /**
   * Covering a day with BOE Credits. The employee's action, absent for the
   * admin exactly as onEdit is absent for the employee; shown only on the
   * dates the payload listed as redeemable.
   */
  onRedeem?: (date: string) => void
  /** Banners (save confirmations and the like). */
  notices?: React.ReactNode
  /** The raised-issue panel, which differs between the two readers. */
  issuePanel?: React.ReactNode
}) {
  const redeemable = new Map<string, RedeemableDate>(
    data.can_redeem ? (data.redeemable_dates ?? []).map(r => [r.date, r]) : [],
  )
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

  // The genuine stored instant, formatted in IST. Null when payroll has no
  // recorded generation time — the field is then omitted rather than guessed at.
  const generatedAt = formatGeneratedAt(result.generated_at)

  return (
    <div className="payroll-detail-page">

      {/* Who this payslip belongs to, and which run produced it. */}
      <div className="payroll-identity-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <Avatar name={result.employee_name} size={32} />
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 15, fontWeight: 700, color: '#111318',
              letterSpacing: '-0.01em', lineHeight: 1.25,
              // The name is the one value here with no bound on its length.
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {result.employee_name}
            </div>
            {result.employee_code && (
              <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.3 }}>
                {result.employee_code}
              </div>
            )}
          </div>
        </div>

        <div className="payroll-identity-meta">
          <MetaField label="Payroll Month">
            {periodLabel(data.period.payroll_month, data.period.payroll_year)}
          </MetaField>

          {/* The same semantic badge as before — draft and locked already carry
              their meaning, and this header is not the place to restate it. */}
          <MetaField label="Status">
            <StatusBadge status={result.status} />
          </MetaField>

          {generatedAt && <MetaField label="Generated">{generatedAt}</MetaField>}
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
                redeemable={redeemable}
                onRedeem={onRedeem}
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
            <PayrollSummaryCard result={result} settlement={data.settlement} />
          </div>
        </aside>
      </div>

      {/* Adjustments and settlement sit BELOW the attendance ledger and outside
          it: what was added, recovered, owed and paid is a different question
          from which day cost what, and merging the two is how an advance
          recovery gets mistaken for an attendance deduction. */}
      {data.settlement && (
        <AdjustmentsAndSettlement
          settlement={data.settlement}
          adjustments={result.adjustments}
          canEdit={canEdit}
          onEditCarryForward={onEditCarryForward}
          onEditPayment={onEditPayment}
        />
      )}

    </div>
  )
}
