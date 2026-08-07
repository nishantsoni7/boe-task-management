'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { istClockOf } from '@/lib/istDate'
import { periodLabel } from '@/lib/payroll/months'
import { resolveMachineRecord } from '@/lib/payroll/correctionContext'
import type { DayTreatment } from '@/lib/attendance/corrections'
import {
  AttendanceCorrectionModal,
  type CorrectionDayContext,
  type CorrectionPayload,
} from './AttendanceCorrectionModal'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

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

type DetailResult = {
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
  deduction_lines: DeductionLine[]
  adjustments: Adjustment[]
}

type PeriodMeta = {
  id: string
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  locked_at: string | null
}

type DeductionDay = {
  date: string
  classification: string
  lines: { deduction_type: string; hours_deducted: number; amount_deducted: number }[]
  total_amount: number
  is_corrected: boolean
  check_in_at: string | null
  check_out_at: string | null
}

type ConsideredDay = {
  date: string
  classification: string
  effective_hours_worked: number
  payable_day_value: number
  is_corrected: boolean
  check_in_at: string | null
  check_out_at: string | null
}

type CorrectionRow = {
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

type DetailPayload = {
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

type TabKey = 'deductions' | 'considered'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number | null): string {
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

function fmtDayDate(iso: string): string {
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

const CLASSIFICATION_LABELS: Record<string, string> = {
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollResultDetailPage() {
  const params     = useParams()
  const periodId   = params.periodId as string
  const employeeId = params.employeeId as string

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [data,    setData]    = useState<DetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [token,   setToken]   = useState('')

  const [tab, setTab] = useState<TabKey>('deductions')
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const load = async (accessToken: string) => {
    const res = await fetch(
      `/api/payroll/results/detail?period_id=${periodId}&employee_id=${employeeId}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? 'Failed to load result'); return }
    setError(null)
    setData(json as DetailPayload)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      if (!prof || prof.role !== 'admin') { router.push('/dashboard'); return }
      setProfile(prof)
      setToken(session.access_token)

      await load(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, employeeId])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const result = data?.result ?? null

  const correctionsByDate = useMemo(
    () => new Map((data?.corrections ?? []).map(c => [c.attendance_date, c])),
    [data?.corrections],
  )
  const correctableDates = useMemo(
    () => new Set(data?.correctable_dates ?? []),
    [data?.correctable_dates],
  )

  // The modal always works from the date-level picture, whichever tab opened it.
  const editingContext: CorrectionDayContext | null = useMemo(() => {
    if (!editingDate || !data) return null
    const deductionDay  = data.deduction_days.find(d => d.date === editingDate)
    const consideredDay = data.considered_days.find(d => d.date === editingDate)
    const correction    = correctionsByDate.get(editingDate)
    const source        = deductionDay ?? consideredDay
    if (!source) return null

    const machine = resolveMachineRecord(correction, source)

    return {
      date: editingDate,
      classification: source.classification,
      raw_check_in_at:  machine.check_in_at,
      raw_check_out_at: machine.check_out_at,
      effective_check_in_at:  source.check_in_at,
      effective_check_out_at: source.check_out_at,
      lines: deductionDay?.lines ?? [],
      total_amount: deductionDay?.total_amount ?? 0,
      existing: correction
        ? {
            remark: correction.remark,
            day_treatment: correction.day_treatment,
            waive_late_arrival:   correction.waive_late_arrival,
            waive_early_checkout: correction.waive_early_checkout,
            waive_missing_punch:  correction.waive_missing_punch,
            corrected_at: correction.corrected_at,
          }
        : null,
    }
  }, [editingDate, data, correctionsByDate])

  const handleSaveCorrection = async (payload: CorrectionPayload) => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/payroll/attendance-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...payload, payroll_period_id: periodId, employee_id: employeeId }),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Failed to save the correction'); return }

      // Success closes the modal; a failure above leaves it open with the
      // entered values intact.
      setEditingDate(null)
      await load(token)
      setSavedNotice(
        `${fmtDayDate(payload.attendance_date)} corrected — payroll recalculated. Net salary ${fmt(json.net_salary)}.`,
      )
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingScreen />

  const card: React.CSSProperties = {
    background: '#fff', borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.08)',
    overflow: 'hidden', marginBottom: 20,
  }

  const canEdit = data?.can_edit ?? false

  const tabs: ResultTab[] = [
    {
      key: 'deductions',
      label: 'Deductions',
      count: data?.deduction_days.length ?? 0,
      accent: '#DC2626',
      tint:   'rgba(220,38,38,0.10)',
    },
    {
      key: 'considered',
      label: 'Days Considered',
      count: data?.considered_days.length ?? 0,
      accent: '#059669',
      tint:   'rgba(5,150,105,0.11)',
    },
  ]

  return (
    <PayrollLayout
      profile={profile}
      title="Payroll Result Detail"
      onSignOut={handleSignOut}
    >
      {/* Back link — secondary, and kept to a single tight line. */}
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => router.push(`/payroll/results/${periodId}`)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#8C94A6', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 4,
            padding: 0,
          }}
        >
          ← Back to Results
        </button>
      </div>

      {error && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {result && data && (
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
              {/* The month the salary is for — more use here than any other date,
                  so it outranks both the code beside it and the generated date. */}
              <span style={{ color: '#111318', fontWeight: 600, fontSize: 13.5 }}>
                {periodLabel(data.period.payroll_month, data.period.payroll_year)}
              </span>
              <StatusBadge status={result.status} />
              {result.generated_at && (
                <span style={{ fontSize: 12.5 }}>Generated {fmtDate(result.generated_at)}</span>
              )}
            </div>
          </div>

          {/* Why editing is unavailable — stated once, above the tabs. */}
          {!canEdit && data.edit_blocked && (
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
              Attendance for this month changed after this payroll was generated. The day rows
              below are up to date; the salary figures are not. Regenerate payroll for this period
              to bring them back in line.
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

          {savedNotice && (
            <div style={{
              marginBottom: 16, padding: '11px 16px', borderRadius: 9,
              background: 'rgba(5,150,105,0.09)', color: '#047857',
              border: '1px solid rgba(5,150,105,0.28)', fontSize: 13,
              display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center',
            }}>
              <span>{savedNotice}</span>
              <button
                onClick={() => setSavedNotice(null)}
                aria-label="Dismiss"
                style={{ background: 'none', border: 'none', color: '#047857', cursor: 'pointer', fontSize: 14 }}
              >✕</button>
            </div>
          )}

          {/* Audit workspace (left) + payroll summary rail (right).
              Below 1024 this stacks and the rail moves above the table. */}
          <div className="payroll-detail-workspace">

            <div className="payroll-detail-main">

              {/* ── The two result tabs ───────────────────────────────────── */}
              {/* No caption sentence: the tab labels already say what each list
                  is, and the sentence competed with them for attention. */}
              <div style={{ ...card, marginBottom: 0 }}>
                <ResultTabs
                  tabs={tabs}
                  active={tab}
                  onSelect={setTab}
                />

                {tab === 'deductions' ? (
                  <DeductionsTab
                    days={data.deduction_days}
                    totalDeductions={result.total_deductions}
                    corrections={correctionsByDate}
                    canEdit={canEdit}
                    editHint={data.edit_blocked}
                    onEdit={setEditingDate}
                  />
                ) : (
                  <ConsideredTab
                    days={data.considered_days}
                    corrections={correctionsByDate}
                    correctableDates={correctableDates}
                    canEdit={canEdit}
                    editHint={data.edit_blocked}
                    onEdit={setEditingDate}
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

        </div>
      )}

      {editingContext && result && (
        <AttendanceCorrectionModal
          employeeName={result.employee_name}
          day={editingContext}
          saving={saving}
          error={saveError}
          onCancel={() => { setEditingDate(null); setSaveError(null) }}
          onSave={handleSaveCorrection}
        />
      )}
    </PayrollLayout>
  )
}

// ─── Tab 1: Deductions ────────────────────────────────────────────────────────

function DeductionsTab({
  days, totalDeductions, corrections, canEdit, editHint, onEdit,
}: {
  days: DeductionDay[]
  totalDeductions: number | null
  corrections: Map<string, CorrectionRow>
  canEdit: boolean
  editHint: string | null
  onEdit: (date: string) => void
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
              // two deductions carries one Edit action, not two.
              return (
                <tr key={day.date} style={{ borderBottom: i < days.length - 1 ? ROW_DIVIDER : 'none' }}>
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
                          {DEDUCTION_LABELS[l.deduction_type] ?? l.deduction_type}
                        </span>
                        {l.hours_deducted > 0 && (
                          <span style={{ color: '#8C94A6', fontVariantNumeric: 'tabular-nums' }}>
                            {' · '}{fmtHours(l.hours_deducted)}
                          </span>
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
                  <td style={{ ...TD, textAlign: 'right', color: '#DC2626', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    −{fmt(day.total_amount)}
                  </td>
                  <td style={{ ...TD, textAlign: 'right' }}>
                    <EditButton
                      onClick={() => onEdit(day.date)}
                      disabled={!canEdit}
                      title={canEdit ? 'Correct this date' : editHint ?? undefined}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={TFOOT_LABEL} colSpan={3}>Total Deductions</td>
              {/* Same sign convention as the rows, so the column reads as one
                  continuous run of figures down to the total. */}
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
  onEdit: (date: string) => void
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
                    {correctableDates.has(day.date) && (
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
