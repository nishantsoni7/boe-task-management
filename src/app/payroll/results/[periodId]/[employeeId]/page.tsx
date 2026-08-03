'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { TrendingDown, CalendarCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { StatusTabs, accentFromBadge, type StatusTab } from '@/components/ui/StatusTabs'
import { istClockOf } from '@/lib/istDate'
import { resolveMachineRecord } from '@/lib/payroll/correctionContext'
import type { DayTreatment } from '@/lib/attendance/corrections'
import {
  AttendanceCorrectionModal,
  type CorrectionDayContext,
  type CorrectionPayload,
} from './AttendanceCorrectionModal'

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

/** Date-only values are formatted from their parts — parsing them as UTC shifts the day in IST. */
function fmtDayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
}

function fmtPunches(checkIn: string | null, checkOut: string | null): string {
  return `${checkIn ? istClockOf(checkIn) : '—'} → ${checkOut ? istClockOf(checkOut) : '—'}`
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

// Green for a fully paid, fully present day; muted for the paid-but-not-worked
// ones; amber where the day is only partly counted.
function classificationTone(classification: string): { bg: string; color: string; border: string } {
  switch (classification) {
    case 'full_present':
      return { bg: 'rgba(5,150,105,0.10)',  color: '#059669', border: 'rgba(5,150,105,0.28)' }
    case 'present_with_shortfall':
    case 'short_present':
    case 'missing_punch':
      return { bg: 'rgba(217,119,6,0.10)',  color: '#B45309', border: 'rgba(217,119,6,0.28)' }
    case 'half_day':
      return { bg: 'rgba(124,58,237,0.10)', color: '#7C3AED', border: 'rgba(124,58,237,0.28)' }
    case 'full_absent':
      return { bg: 'rgba(220,38,38,0.09)',  color: '#DC2626', border: 'rgba(220,38,38,0.26)' }
    default:
      return { bg: 'rgba(140,148,166,0.12)', color: '#6B7280', border: 'rgba(140,148,166,0.3)' }
  }
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

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 20px', borderBottom: '1px solid rgba(0,0,0,0.04)',
    }}>
      <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: highlight ? 700 : 500, color: highlight ? '#111318' : '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

const TH: React.CSSProperties = {
  padding: '8px 14px', textAlign: 'left',
  fontSize: 11, fontWeight: 700, color: '#8C94A6',
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

const TD: React.CSSProperties = { padding: '9px 14px', fontSize: 13, color: '#3D4455', verticalAlign: 'top' }

function EditButton({ onClick, disabled, title }: { onClick: () => void; disabled: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
        border: '1px solid rgba(79,111,208,0.3)', background: 'transparent',
        color: disabled ? '#A9AFBD' : '#4F6FD0',
        cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
      }}
    >
      Edit
    </button>
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
        .select('*')
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

  const tabs: StatusTab<TabKey>[] = [
    {
      key: 'deductions',
      label: 'Deductions',
      Icon: TrendingDown,
      accent: accentFromBadge({ bg: 'rgba(220,38,38,0.08)', color: '#DC2626', border: 'rgba(220,38,38,0.18)' }),
      count: data?.deduction_days.length ?? 0,
    },
    {
      key: 'considered',
      label: 'Days Considered',
      Icon: CalendarCheck,
      accent: accentFromBadge({ bg: 'rgba(5,150,105,0.09)', color: '#059669', border: 'rgba(5,150,105,0.2)' }),
      count: data?.considered_days.length ?? 0,
    },
  ]

  return (
    <PayrollLayout
      profile={profile}
      title="Payroll Result Detail"
      subtitle={result ? `${result.employee_name} — ${result.employee_code ?? ''}` : 'Loading…'}
      onSignOut={handleSignOut}
    >
      {/* Back link */}
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={() => router.push(`/payroll/results/${periodId}`)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#6B7280', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4,
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
        <div style={{ maxWidth: 760 }}>

          {/* Employee summary */}
          <div style={card}>
            <SectionHeader title="Employee" />
            <div style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318' }}>{result.employee_name}</div>
                {result.employee_code && (
                  <div style={{ fontSize: 12.5, color: '#8C94A6', marginTop: 2 }}>{result.employee_code}</div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StatusBadge status={result.status} />
                {result.generated_at && (
                  <span style={{ fontSize: 11.5, color: '#8C94A6' }}>
                    Generated {fmtDate(result.generated_at)}
                  </span>
                )}
              </div>
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
              Attendance has changed since this payroll was generated. The day breakdown below
              reflects the current attendance; the totals do not. Regenerate payroll for this period.
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

          {/* Salary breakdown */}
          <div style={card}>
            <SectionHeader title="Salary Breakdown" />
            <Row label="Monthly Salary (CTC)"  value={fmt(result.monthly_salary)} />
            <Row label="Working Days in Month" value={result.working_days_in_month != null ? String(result.working_days_in_month) : '—'} />
            <Row label="Days Present"          value={result.days_present != null ? String(result.days_present) : '—'} />
            <Row label="Days Absent"           value={result.days_absent  != null ? String(result.days_absent)  : '—'} />
            {result.half_day_count != null && result.half_day_count > 0 && (
              <Row label="Half Days"           value={String(result.half_day_count)} />
            )}
            <Row label="Gross Salary"          value={fmt(result.gross_salary)} highlight />
          </div>

          {/* ── The two result tabs ─────────────────────────────────────────── */}
          <div style={card}>
            <StatusTabs
              tabs={tabs}
              active={tab}
              onSelect={setTab}
              summary={tab === 'deductions' ? 'Dates that reduced salary' : 'Dates counted as paid'}
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

          {/* Adjustments */}
          <div style={card}>
            <SectionHeader title="Adjustments" />
            {result.adjustments.length === 0 ? (
              <div style={{ padding: '20px', fontSize: 13, color: '#8C94A6' }}>No adjustments applied.</div>
            ) : (
              <>
                {result.adjustments.map((adj, i) => (
                  <div key={adj.id} style={{
                    padding: '10px 20px',
                    borderBottom: i < result.adjustments.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                  }}>
                    <span style={{ fontSize: 13, color: '#3D4455' }}>{adj.description}</span>
                    <span style={{
                      fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                      color: (adj.amount ?? 0) >= 0 ? '#16A34A' : '#DC2626',
                    }}>
                      {(adj.amount ?? 0) >= 0 ? '+' : ''}{fmt(adj.amount)}
                    </span>
                  </div>
                ))}
                <div style={{
                  padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.06)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#3D4455' }}>Total Adjustments</span>
                  <span style={{
                    fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                    color: (result.pending_adjustment_total ?? 0) >= 0 ? '#16A34A' : '#DC2626',
                  }}>
                    {(result.pending_adjustment_total ?? 0) >= 0 ? '+' : ''}{fmt(result.pending_adjustment_total)}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Net salary */}
          <div style={{
            ...card,
            background: 'linear-gradient(135deg, #1E293B 0%, #334155 100%)',
            border: 'none',
          }}>
            <div style={{
              padding: '20px 24px', display: 'flex', gap: 14,
              justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap',
            }}>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
                  Net Salary
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                  Gross − Deductions + Adjustments
                </div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(result.net_salary)}
              </div>
            </div>
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
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)', background: 'rgba(0,0,0,0.015)' }}>
              <th style={TH}>Date</th>
              <th style={TH}>Reason</th>
              <th style={TH}>Considered</th>
              <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
              <th style={TH} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => {
              const correction = corrections.get(day.date)
              // One row per DATE. The reasons stack inside it, so a date with
              // two deductions carries one Edit action, not two.
              return (
                <tr key={day.date} style={{ borderBottom: i < days.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    {fmtDayDate(day.date)}
                    {day.is_corrected && <CorrectedBadge remark={correction?.remark} />}
                  </td>
                  <td style={TD}>
                    {day.lines.map((l, j) => (
                      <div key={j} style={{ marginTop: j > 0 ? 3 : 0 }}>
                        <span style={{ color: '#DC2626', fontWeight: 500 }}>
                          {DEDUCTION_LABELS[l.deduction_type] ?? l.deduction_type}
                        </span>
                        <span style={{ color: '#8C94A6', marginLeft: 6, fontVariantNumeric: 'tabular-nums' }}>
                          {fmtHours(l.hours_deducted)}
                        </span>
                      </div>
                    ))}
                    {correction && (
                      <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 5, fontStyle: 'italic' }}>
                        {correction.remark}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: '#6B7280' }}>
                    {fmtPunches(day.check_in_at, day.check_out_at)}
                    <div style={{ marginTop: 3 }}>
                      <Pill tone={classificationTone(day.classification)}>
                        {CLASSIFICATION_LABELS[day.classification] ?? day.classification}
                      </Pill>
                    </div>
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
        </table>
      </div>

      <div style={{
        padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#3D4455' }}>Total Deductions</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(totalDeductions)}
        </span>
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
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)', background: 'rgba(0,0,0,0.015)' }}>
              <th style={TH}>Date</th>
              <th style={TH}>Status</th>
              <th style={TH}>Punches</th>
              <th style={{ ...TH, textAlign: 'right' }}>Payable</th>
              <th style={TH} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => {
              const correction = corrections.get(day.date)
              const editable = canEdit && correctableDates.has(day.date)
              return (
                <tr key={day.date} style={{ borderBottom: i < days.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    {fmtDayDate(day.date)}
                    {day.is_corrected && <CorrectedBadge remark={correction?.remark} />}
                  </td>
                  <td style={TD}>
                    <Pill tone={classificationTone(day.classification)}>
                      {CLASSIFICATION_LABELS[day.classification] ?? day.classification}
                    </Pill>
                    {correction && (
                      <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 5, fontStyle: 'italic' }}>
                        {correction.remark}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: '#6B7280' }}>
                    {fmtPunches(day.check_in_at, day.check_out_at)}
                    {day.effective_hours_worked > 0 && (
                      <div style={{ fontSize: 11.5, marginTop: 2 }}>{fmtHours(day.effective_hours_worked)} worked</div>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: day.payable_day_value > 0 ? '#059669' : '#8C94A6' }}>
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
        </table>
      </div>

      <div style={{
        padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#3D4455' }}>Payable Days Counted</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>
          {payableTotal}
        </span>
      </div>
    </>
  )
}
