'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'

// ─── Types ────────────────────────────────────────────────────────────────────

type DeductionLine = {
  id: string
  line_date: string
  deduction_type: string
  hours_deducted: number | null
  amount_deducted: number | null
}

type MyDetail = {
  id: string
  payroll_month: number | null
  payroll_year: number | null
  period_status: 'draft' | 'generated' | 'locked' | null
  period_locked_at: string | null
  monthly_salary: number | null
  working_days_in_month: number | null
  days_present: number | null
  days_absent: number | null
  half_day_count: number | null
  paid_leave_used: number | null
  late_deduction_hours: number | null
  missing_punch_hours: number | null
  gross_salary: number | null
  total_deductions: number | null
  pending_adjustment_total: number | null
  net_salary: number | null
  status: 'draft' | 'locked'
  employee_reviewed_at: string | null
  generated_at: string | null
  deduction_lines: DeductionLine[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const DEDUCTION_LABELS: Record<string, string> = {
  late_arrival:      'Late Arrival',
  early_checkout:    'Early Checkout',
  missing_punch_in:  'Missing Punch-In',
  missing_punch_out: 'Missing Punch-Out',
  absent:            'Absent',
  half_day:          'Half Day',
  short_hours:       'Short Hours',
}

function fmt(n: number | null): string {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
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
      <span style={{
        fontSize: 13.5, fontWeight: highlight ? 700 : 500,
        color: highlight ? '#111318' : '#3D4455', fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyPayrollDetailPage() {
  const params   = useParams()
  const periodId = params.periodId as string

  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [result,      setResult]      = useState<MyDetail | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [reviewing,   setReviewing]   = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [token,       setToken]       = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)

      const { data: prof } = await supabase
        .from('users')
        .select('*')
        .eq('id', session.user.id)
        .single()

      if (!prof) { router.push('/login'); return }
      setProfile(prof)

      const res = await fetch(`/api/payroll/my-result?period_id=${periodId}`, {
        headers: { authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Failed to load payroll data')
      else setResult(json.result)

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  const handleMarkReviewed = async () => {
    if (reviewing || result?.employee_reviewed_at) return
    setReviewing(true)
    setReviewError(null)
    try {
      const res = await fetch('/api/payroll/my-result/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ period_id: periodId }),
      })
      const json = await res.json()
      if (!res.ok) {
        setReviewError(json.error ?? 'Failed to mark as reviewed')
      } else {
        setResult(prev => prev ? { ...prev, employee_reviewed_at: new Date().toISOString() } : prev)
      }
    } finally {
      setReviewing(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const card: React.CSSProperties = {
    background: '#fff', borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.08)',
    overflow: 'hidden', marginBottom: 20,
  }

  const monthLabel = result?.payroll_month
    ? `${MONTHS[result.payroll_month - 1]} ${result.payroll_year ?? ''}`
    : 'Payroll Summary'

  const isReviewed = !!result?.employee_reviewed_at
  const isLocked   = result?.period_status === 'locked'

  return (
    <AttendanceLayout
      profile={profile}
      title={monthLabel}
      subtitle="Your payroll summary"
      onSignOut={handleSignOut}
    >
      {/* Back */}
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={() => router.push('/my-payroll')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#6B7280', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, padding: 0,
          }}
        >
          ← Back to My Payroll
        </button>
      </div>

      {/* Locked notice */}
      {isLocked && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(232,160,48,0.10)', color: '#92400E',
          border: '1px solid rgba(232,160,48,0.35)', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>🔒</span>
          <span>
            This payroll has been locked by your admin
            {result?.period_locked_at ? ` on ${fmtDate(result.period_locked_at)}` : ''}.
            {' '}No further changes are possible.
          </span>
        </div>
      )}

      {error && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ maxWidth: 680 }}>

          {/* Attendance summary */}
          <div style={card}>
            <SectionHeader title="Attendance Summary" />
            <Row label="Salary Month"           value={monthLabel} />
            <Row label="Payable Days"           value={result.days_present != null ? String(result.days_present) : '—'} />
            <Row label="Absent Days"            value={result.days_absent  != null ? String(result.days_absent)  : '—'} />
            {result.half_day_count != null && result.half_day_count > 0 && (
              <Row label="Half Days"            value={String(result.half_day_count)} />
            )}
            {result.paid_leave_used != null && result.paid_leave_used > 0 && (
              <Row label="Paid Leave Used"      value={String(result.paid_leave_used)} />
            )}
          </div>

          {/* Deduction hours */}
          {((result.late_deduction_hours ?? 0) > 0 || (result.missing_punch_hours ?? 0) > 0) && (
            <div style={card}>
              <SectionHeader title="Hourly Deductions" />
              {(result.late_deduction_hours ?? 0) > 0 && (
                <Row label="Late / Early Departure Hours" value={`${result.late_deduction_hours}h`} />
              )}
              {(result.missing_punch_hours ?? 0) > 0 && (
                <Row label="Missing Punch Hours" value={`${result.missing_punch_hours}h`} />
              )}
            </div>
          )}

          {/* Salary breakdown */}
          <div style={card}>
            <SectionHeader title="Salary Breakdown" />
            <Row label="Monthly Salary (CTC)" value={fmt(result.monthly_salary)} />
            <Row label="Gross Salary"         value={fmt(result.gross_salary)} highlight />
            <Row label="Total Deductions"     value={fmt(result.total_deductions)} />
            {result.pending_adjustment_total != null && result.pending_adjustment_total !== 0 && (
              <Row
                label="Adjustments"
                value={`${(result.pending_adjustment_total ?? 0) >= 0 ? '+' : ''}${fmt(result.pending_adjustment_total)}`}
              />
            )}
          </div>

          {/* Deduction lines — detailed */}
          {result.deduction_lines.length > 0 && (
            <div style={card}>
              <SectionHeader title="Deduction Details" />
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)', background: 'rgba(0,0,0,0.015)' }}>
                      {['Date', 'Reason', 'Hours', 'Amount'].map(h => (
                        <th key={h} style={{
                          padding: '8px 16px', textAlign: 'left',
                          fontSize: 11, fontWeight: 700, color: '#8C94A6',
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.deduction_lines.map((l, i) => (
                      <tr key={l.id} style={{
                        borderBottom: i < result.deduction_lines.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                      }}>
                        <td style={{ padding: '9px 16px', fontSize: 13, color: '#3D4455' }}>{fmtDate(l.line_date)}</td>
                        <td style={{ padding: '9px 16px', fontSize: 13, color: '#3D4455' }}>
                          {DEDUCTION_LABELS[l.deduction_type] ?? l.deduction_type}
                        </td>
                        <td style={{ padding: '9px 16px', fontSize: 13, color: '#6B7280', fontVariantNumeric: 'tabular-nums' }}>
                          {l.hours_deducted != null ? `${l.hours_deducted}h` : '—'}
                        </td>
                        <td style={{ padding: '9px 16px', fontSize: 13, color: '#DC2626', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                          {fmt(l.amount_deducted)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Net salary */}
          <div style={{
            ...card,
            background: 'linear-gradient(135deg, #1E293B 0%, #334155 100%)',
            border: 'none',
          }}>
            <div style={{
              padding: '20px 24px', display: 'flex',
              justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
                  Net Payable
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

          {/* Review action */}
          <div style={{
            background: '#fff', borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.08)',
            padding: '20px 24px',
          }}>
            {isReviewed ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 20,
                  background: 'rgba(16,185,129,0.12)', color: '#059669',
                  fontSize: 13, fontWeight: 700,
                }}>
                  ✓ Reviewed
                </span>
                <span style={{ fontSize: 12, color: '#8C94A6' }}>
                  on {fmtDate(result.employee_reviewed_at!)}
                </span>
              </div>
            ) : isLocked ? (
              <div style={{ fontSize: 13, color: '#92400E' }}>
                🔒 The review window is closed — this payroll period has been locked by your admin.
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 12 }}>
                  Please review your payroll summary above and confirm it looks correct.
                </div>
                {reviewError && (
                  <div style={{
                    marginBottom: 10, padding: '7px 12px', borderRadius: 7,
                    background: 'rgba(239,68,68,0.08)', color: '#DC2626',
                    border: '1px solid rgba(239,68,68,0.2)', fontSize: 12.5,
                  }}>
                    {reviewError}
                  </div>
                )}
                <button
                  onClick={handleMarkReviewed}
                  disabled={reviewing}
                  style={{
                    padding: '9px 22px', borderRadius: 8, fontSize: 13.5, fontWeight: 700,
                    cursor: reviewing ? 'not-allowed' : 'pointer',
                    border: 'none',
                    background: reviewing ? 'rgba(0,0,0,0.08)' : '#1A2035',
                    color: reviewing ? '#8C94A6' : '#E8A030',
                  }}
                >
                  {reviewing ? 'Submitting…' : 'Mark as Reviewed'}
                </button>
              </div>
            )}
          </div>

        </div>
      )}
    </AttendanceLayout>
  )
}
