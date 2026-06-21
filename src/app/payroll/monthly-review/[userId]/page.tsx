'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

type DeductionLine = {
  line_date:       string
  deduction_type:  string
  hours_deducted:  number
  amount_deducted: number
  check_in_at:     string | null
  check_out_at:    string | null
}

type AdjustmentRow = {
  id:              string
  adjustment_type: 'addition' | 'deduction'
  amount:          number
  description:     string
}

type Summary = {
  monthly_salary:            number
  gross_salary:              number
  working_days_in_month:     number
  days_present:              number
  days_absent:               number
  half_day_count:            number
  paid_leave_available:      number
  paid_leave_used:           number
  leave_absorbed_deductions: boolean
  late_deduction_hours:      number
  short_hours_deduction:     number
  missing_punch_hours:       number
  total_deductions:          number
  adjustment_total:          number
  net_salary:                number
}

type EmployeeInfo = {
  id:             string
  full_name:      string
  employee_code:  string | null
  monthly_salary: number
}

type DetailData = {
  employee:        EmployeeInfo
  skipped:         false
  summary:         Summary
  deduction_lines: DeductionLine[]
  adjustments:     AdjustmentRow[]
} | {
  employee:    EmployeeInfo
  skipped:     true
  skip_reason: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function fmt(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtHours(h: number): string {
  if (h <= 0) return '—'
  const total = Math.round(h * 60)
  const hrs = Math.floor(total / 60)
  const min = total % 60
  if (min === 0) return `${hrs}h`
  return `${hrs}h ${min}m`
}

function fmtISTTime(ts: string | null): string {
  if (!ts) return 'Missing'
  const istMs = new Date(ts).getTime() + 330 * 60 * 1000
  const d = new Date(istMs)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function fmtAttendance(checkIn: string | null, checkOut: string | null): string {
  return `IN ${fmtISTTime(checkIn)} • OUT ${fmtISTTime(checkOut)}`
}

function fmtDate(s: string): string {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

function fmtDateTime(s: string): string {
  return new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const DEDUCTION_LABELS: Record<string, string> = {
  late_arrival:       'Late Arrival',
  early_checkout:     'Early Checkout',
  missing_punch_in:   'Missing Punch-In',
  missing_punch_out:  'Missing Punch-Out',
  absent:             'Absent',
  half_day:           'Half Day',
  short_hours:        'Short Hours',
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: colors.tertiary,
      padding: '14px 20px 8px', borderBottom: `1px solid ${colors.border}`,
      background: colors.raised,
    }}>
      {title}
    </div>
  )
}

function Row({ label, value, highlight, valueColor }: { label: string; value: string; highlight?: boolean; valueColor?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 20px', borderBottom: `1px solid ${colors.border}`,
    }}>
      <span style={{ fontSize: 13, color: colors.tertiary }}>{label}</span>
      <span style={{
        fontSize: 13.5, fontWeight: highlight ? 700 : 500,
        color: valueColor ?? (highlight ? colors.primary : colors.secondary),
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  )
}

const SKIP_LABELS: Record<string, string> = {
  period_locked:         'Period is locked',
  employee_inactive:     'Employee is not payroll-active',
  no_salary_configured:  'No monthly salary configured',
}

// ─── Adjustment panel ─────────────────────────────────────────────────────────

function AdjustmentsPanel({
  adjustments,
  onAdd,
  onDelete,
  saving,
}: {
  adjustments: AdjustmentRow[]
  onAdd: (type: 'addition' | 'deduction', amount: number, note: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  saving: boolean
}) {
  const [adjType,   setAdjType]   = useState<'addition' | 'deduction'>('addition')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote,   setAdjNote]   = useState('')
  const [formErr,   setFormErr]   = useState('')
  const [deleting,  setDeleting]  = useState<string | null>(null)

  const handleSubmit = async () => {
    setFormErr('')
    const amt = parseFloat(adjAmount)
    if (!adjAmount || isNaN(amt) || amt <= 0) {
      setFormErr('Enter a valid positive amount.')
      return
    }
    if (!adjNote.trim()) {
      setFormErr('Note is required.')
      return
    }
    await onAdd(adjType, amt, adjNote.trim())
    setAdjAmount('')
    setAdjNote('')
  }

  const handleDelete = async (id: string) => {
    setDeleting(id)
    await onDelete(id)
    setDeleting(null)
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 12px', boxSizing: 'border-box',
  }

  const netAdj = adjustments.reduce((s, a) => s + (a.adjustment_type === 'addition' ? a.amount : -a.amount), 0)

  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: 10, overflow: 'hidden', marginBottom: 16,
    }}>
      <SectionHeader title="Manual Adjustments" />

      {/* Add form */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: colors.tertiary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Add Adjustment
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: colors.tertiary, marginBottom: 4 }}>Type</label>
            <select
              value={adjType}
              onChange={e => setAdjType(e.target.value as 'addition' | 'deduction')}
              style={{ ...inputStyle, width: 140 }}
            >
              <option value="addition">Addition</option>
              <option value="deduction">Deduction</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: colors.tertiary, marginBottom: 4 }}>Amount (₹)</label>
            <input
              type="number"
              min="1"
              step="0.01"
              placeholder="0.00"
              value={adjAmount}
              onChange={e => setAdjAmount(e.target.value)}
              style={{ ...inputStyle, width: 130 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={{ display: 'block', fontSize: 11, color: colors.tertiary, marginBottom: 4 }}>Note (required)</label>
            <input
              type="text"
              placeholder="Reason for adjustment…"
              value={adjNote}
              onChange={e => setAdjNote(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={saving}
            style={{
              padding: '8px 20px', fontSize: 13, fontWeight: 600, borderRadius: 7,
              border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
              background: adjType === 'addition' ? '#059669' : '#DC2626',
              color: '#fff', opacity: saving ? 0.6 : 1, flexShrink: 0,
            }}
          >
            {saving ? 'Saving…' : adjType === 'addition' ? '+ Add' : '− Deduct'}
          </button>
        </div>
        {formErr && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#DC2626' }}>{formErr}</div>
        )}
      </div>

      {/* History */}
      {adjustments.length === 0 ? (
        <div style={{ padding: '24px 20px', textAlign: 'center', fontSize: 13, color: colors.muted }}>
          No adjustments for this employee this month.
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                  {['Type', 'Amount', 'Note', ''].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: 11, fontWeight: 600, color: colors.tertiary,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a, i) => (
                  <tr key={a.id} style={{ borderBottom: i < adjustments.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                    <td style={{ padding: '9px 16px' }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 9px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                        background: a.adjustment_type === 'addition' ? 'rgba(5,150,105,0.1)' : 'rgba(220,38,38,0.08)',
                        color: a.adjustment_type === 'addition' ? '#059669' : '#DC2626',
                      }}>
                        {a.adjustment_type === 'addition' ? 'Addition' : 'Deduction'}
                      </span>
                    </td>
                    <td style={{
                      padding: '9px 16px', fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                      color: a.adjustment_type === 'addition' ? '#059669' : '#DC2626',
                    }}>
                      {a.adjustment_type === 'addition' ? '+' : '−'}{fmt(a.amount)}
                    </td>
                    <td style={{ padding: '9px 16px', color: colors.secondary }}>{a.description}</td>
                    <td style={{ padding: '9px 16px' }}>
                      <button
                        onClick={() => handleDelete(a.id)}
                        disabled={deleting === a.id}
                        style={{
                          fontSize: 12, color: '#DC2626', background: 'none', border: 'none',
                          cursor: deleting === a.id ? 'not-allowed' : 'pointer', opacity: deleting === a.id ? 0.5 : 1,
                          padding: '3px 8px', borderRadius: 5,
                        }}
                      >
                        {deleting === a.id ? '…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{
            padding: '12px 20px', borderTop: `1px solid ${colors.border}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.secondary }}>Net Adjustment</span>
            <span style={{
              fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: netAdj >= 0 ? '#059669' : '#DC2626',
            }}>
              {netAdj >= 0 ? '+' : '−'}{fmt(Math.abs(netAdj))}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollMonthlyReviewDetailPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [data,     setData]     = useState<DetailData | null>(null)
  const [error,    setError]    = useState('')
  const [token,    setToken]    = useState('')
  const [saving,   setSaving]   = useState(false)

  const params       = useParams()
  const searchParams = useSearchParams()
  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])

  const userId = params.userId as string
  const year   = parseInt(searchParams.get('year')  ?? '0', 10)
  const month  = parseInt(searchParams.get('month') ?? '0', 10)

  const loadDetail = async (tok: string) => {
    setFetching(true)
    const res  = await fetch(
      `/api/payroll/monthly-review/detail?year=${year}&month=${month}&employee_id=${userId}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    )
    const json = await res.json()
    if (res.ok) setData(json as DetailData)
    else setError(json.error ?? 'Failed to load detail')
    setFetching(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
        .eq('id', session.user.id)
        .single()

      if (!prof || prof.role !== 'admin') { router.push('/dashboard'); return }
      setProfile(prof as UserProfile)
      setToken(session.access_token)

      if (userId && year && month) await loadDetail(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, year, month])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleAddAdjustment = async (adjType: 'addition' | 'deduction', amount: number, note: string) => {
    setSaving(true)
    const res = await fetch('/api/payroll/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ employee_id: userId, year, month, adjustment_type: adjType, amount, note }),
    })
    if (res.ok) await loadDetail(token)
    else {
      const json = await res.json()
      setError(json.error ?? 'Failed to save adjustment')
    }
    setSaving(false)
  }

  const handleDeleteAdjustment = async (id: string) => {
    const res = await fetch(`/api/payroll/adjustments/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) await loadDetail(token)
    else {
      const json = await res.json()
      setError(json.error ?? 'Failed to delete adjustment')
    }
  }

  if (loading) return <LoadingScreen />

  const monthLabel = year && month ? `${MONTH_NAMES[month - 1]} ${year}` : ''
  const backHref   = year && month
    ? `/payroll/monthly-review?year=${year}&month=${month}`
    : '/payroll/monthly-review'

  const card: React.CSSProperties = {
    background: colors.base, border: `1px solid ${colors.border}`,
    borderRadius: 10, overflow: 'hidden', marginBottom: 16,
  }

  return (
    <PayrollLayout
      profile={profile}
      title={data && !data.skipped ? `${data.employee.full_name} — ${monthLabel}` : 'Payroll Preview Detail'}
      subtitle="Engine-computed payroll breakdown"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 720, padding: '24px 0' }}>

        <Link
          href={backHref}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Monthly Preview
        </Link>

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#DC2626',
          }}>
            {error}
          </div>
        )}

        {fetching && (
          <div style={{
            ...card, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            Computing payroll…
          </div>
        )}

        {!fetching && data && (
          <>
            {/* Employee header */}
            <div style={card}>
              <SectionHeader title="Employee" />
              <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>{data.employee.full_name}</div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                    {data.employee.employee_code && (
                      <span style={{ fontSize: 12, color: colors.tertiary }}>{data.employee.employee_code}</span>
                    )}
                    <span style={{ fontSize: 12, color: colors.tertiary }}>
                      ₹{data.employee.monthly_salary?.toLocaleString('en-IN')}/mo
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: colors.secondary }}>
                  {monthLabel}
                  <span style={{
                    display: 'inline-block', marginLeft: 10, padding: '2px 10px', borderRadius: 20,
                    fontSize: 11.5, fontWeight: 600,
                    background: 'rgba(232,160,48,0.12)', color: '#B45309',
                  }}>
                    Preview
                  </span>
                </div>
              </div>
            </div>

            {data.skipped ? (
              <div style={{
                ...card, padding: '32px 20px', textAlign: 'center',
                color: colors.tertiary, fontSize: 13,
              }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#D97706', marginBottom: 8 }}>Skipped</div>
                {SKIP_LABELS[data.skip_reason] ?? data.skip_reason}
              </div>
            ) : (
              <>
                {/* Attendance summary */}
                <div style={card}>
                  <SectionHeader title="Attendance Summary" />
                  <Row label="Working Days in Month" value={String(data.summary.working_days_in_month)} />
                  <Row label="Days Present"          value={String(data.summary.days_present)} valueColor="#059669" />
                  <Row label="Days Absent"           value={String(data.summary.days_absent)}  valueColor={data.summary.days_absent > 0 ? '#DC2626' : colors.tertiary} />
                  {data.summary.half_day_count > 0 && (
                    <Row label="Half Days"           value={String(data.summary.half_day_count)} valueColor="#D97706" />
                  )}
                  <Row label="Paid Leave Available"  value={`${data.summary.paid_leave_available}d`} />
                  <Row label="Paid Leave Used"       value={data.summary.paid_leave_used > 0 ? `${data.summary.paid_leave_used}d` : '—'} valueColor={data.summary.paid_leave_used > 0 ? '#7C3AED' : undefined} />
                  {data.summary.leave_absorbed_deductions && (
                    <div style={{
                      padding: '10px 20px',
                      background: 'rgba(124,58,237,0.06)',
                      borderTop: `1px solid ${colors.border}`,
                      fontSize: 12.5, color: '#7C3AED', fontWeight: 500,
                    }}>
                      ✓ Paid leave absorbed all hourly deductions this month
                    </div>
                  )}
                </div>

                {/* Deduction hours */}
                {(data.summary.late_deduction_hours > 0 || data.summary.missing_punch_hours > 0 || data.summary.short_hours_deduction > 0) && (
                  <div style={card}>
                    <SectionHeader title="Deduction Hours (Pre-Absorption)" />
                    {data.summary.late_deduction_hours > 0 && (
                      <Row label="Late / Early Checkout" value={fmtHours(data.summary.late_deduction_hours)} valueColor="#EA580C" />
                    )}
                    {data.summary.missing_punch_hours > 0 && (
                      <Row label="Missing Punch"         value={fmtHours(data.summary.missing_punch_hours)}  valueColor="#7C3AED" />
                    )}
                    {data.summary.short_hours_deduction > 0 && (
                      <Row label="Short Hours"           value={fmtHours(data.summary.short_hours_deduction)} valueColor="#D97706" />
                    )}
                  </div>
                )}

                {/* Salary breakdown */}
                <div style={card}>
                  <SectionHeader title="Salary Breakdown" />
                  <Row label="Gross Salary (CTC)"  value={fmt(data.summary.gross_salary)} highlight />
                  <Row
                    label="Total Deductions"
                    value={data.summary.total_deductions > 0 ? `−${fmt(data.summary.total_deductions)}` : '—'}
                    valueColor={data.summary.total_deductions > 0 ? '#DC2626' : colors.tertiary}
                  />
                  <Row
                    label="Adjustments"
                    value={
                      data.summary.adjustment_total !== 0
                        ? `${data.summary.adjustment_total >= 0 ? '+' : '−'}${fmt(Math.abs(data.summary.adjustment_total))}`
                        : '—'
                    }
                    valueColor={
                      data.summary.adjustment_total > 0 ? '#059669'
                      : data.summary.adjustment_total < 0 ? '#DC2626'
                      : colors.tertiary
                    }
                  />
                </div>

                {/* Deduction lines */}
                {data.deduction_lines.length > 0 && (
                  <div style={card}>
                    <SectionHeader title="Deduction Lines" />

                    <div style={{ padding: '12px 20px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {Object.entries(
                        data.deduction_lines.reduce<Record<string, { count: number; total: number }>>((acc, l) => {
                          if (!acc[l.deduction_type]) acc[l.deduction_type] = { count: 0, total: 0 }
                          acc[l.deduction_type].count++
                          acc[l.deduction_type].total += l.amount_deducted
                          return acc
                        }, {})
                      ).map(([type, { count, total }]) => (
                        <div key={type} style={{
                          padding: '5px 11px', borderRadius: 8,
                          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
                          fontSize: 12,
                        }}>
                          <span style={{ color: '#DC2626', fontWeight: 600 }}>
                            {DEDUCTION_LABELS[type] ?? type}
                          </span>
                          <span style={{ color: colors.tertiary, marginLeft: 6 }}>
                            ×{count} · {fmt(total)}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div style={{ overflowX: 'auto', marginTop: 12 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                            {['Date', 'Attendance', 'Type', 'Hours', 'Amount'].map(h => (
                              <th key={h} style={{
                                padding: '8px 16px', textAlign: 'left',
                                fontSize: 11, fontWeight: 600, color: colors.tertiary,
                                textTransform: 'uppercase', letterSpacing: '0.05em',
                              }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.deduction_lines.map((l, i) => (
                            <tr key={i} style={{ borderBottom: i < data.deduction_lines.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                              <td style={{ padding: '9px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                                {fmtDate(l.line_date)}
                              </td>
                              <td style={{ padding: '9px 16px', whiteSpace: 'nowrap' }}>
                                <span style={{ fontSize: 12, color: colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>
                                  {fmtAttendance(l.check_in_at, l.check_out_at)}
                                </span>
                              </td>
                              <td style={{ padding: '9px 16px', color: colors.secondary }}>
                                {DEDUCTION_LABELS[l.deduction_type] ?? l.deduction_type}
                              </td>
                              <td style={{ padding: '9px 16px', color: colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>
                                {fmtHours(l.hours_deducted)}
                              </td>
                              <td style={{
                                padding: '9px 16px', fontVariantNumeric: 'tabular-nums', fontWeight: 500,
                                color: l.amount_deducted > 0 ? '#DC2626' : colors.tertiary,
                              }}>
                                {l.amount_deducted > 0 ? `−${fmt(l.amount_deducted)}` : <span style={{ color: colors.tertiary }}>₹0 (absorbed)</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={{
                      padding: '12px 20px', borderTop: `1px solid ${colors.border}`,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: colors.secondary }}>Total Deductions</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(data.summary.total_deductions)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Adjustments panel */}
                <AdjustmentsPanel
                  adjustments={data.adjustments}
                  onAdd={handleAddAdjustment}
                  onDelete={handleDeleteAdjustment}
                  saving={saving}
                />

                {/* Net salary */}
                <div style={{
                  background: 'linear-gradient(135deg, #1A2035 0%, #2D3A55 100%)',
                  borderRadius: 10, overflow: 'hidden', marginBottom: 16,
                }}>
                  <div style={{
                    padding: '22px 26px', display: 'flex',
                    justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)', marginBottom: 4 }}>
                        Estimated Net Salary
                      </div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                        Gross − Deductions
                        {data.summary.adjustment_total !== 0 && (
                          <> {data.summary.adjustment_total > 0 ? '+' : '−'} Adjustments</>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: '#E8A030', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(data.summary.net_salary)}
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: colors.tertiary, lineHeight: 1.7 }}>
                  <strong style={{ color: colors.secondary }}>Preview only</strong> — adjustments are included in net salary above but payroll has not been locked yet.
                </div>
              </>
            )}
          </>
        )}

      </div>
    </PayrollLayout>
  )
}
