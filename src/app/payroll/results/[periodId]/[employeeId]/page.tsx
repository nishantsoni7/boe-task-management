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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number | null): string {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
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

function StatusBadge({ status }: { status: DetailResult['status'] }) {
  const map = {
    draft:  { bg: 'rgba(140,148,166,0.12)', color: '#6B7280', label: 'Draft' },
    locked: { bg: 'rgba(232,160,48,0.15)',  color: '#B45309', label: 'Locked' },
  }
  const s = map[status]
  return (
    <span style={{
      display: 'inline-block', padding: '3px 12px', borderRadius: 20,
      fontSize: 12, fontWeight: 600, background: s.bg, color: s.color,
    }}>
      {s.label}
    </span>
  )
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollResultDetailPage() {
  const params     = useParams()
  const periodId   = params.periodId as string
  const employeeId = params.employeeId as string

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [result,  setResult]  = useState<DetailResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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

      const res = await fetch(
        `/api/payroll/results/detail?period_id=${periodId}&employee_id=${employeeId}`,
        { headers: { authorization: `Bearer ${session.access_token}` } },
      )
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Failed to load result')
      else setResult(json.result)

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, employeeId])

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

  // Group deduction lines by type for summary
  const deductionsByType = result
    ? result.deduction_lines.reduce<Record<string, { count: number; total: number }>>((acc, l) => {
        const key = l.deduction_type
        if (!acc[key]) acc[key] = { count: 0, total: 0 }
        acc[key].count++
        acc[key].total += l.amount_deducted ?? 0
        return acc
      }, {})
    : {}

  return (
    <AttendanceLayout
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

      {result && (
        <div style={{ maxWidth: 720 }}>

          {/* Employee summary */}
          <div style={card}>
            <SectionHeader title="Employee" />
            <div style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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

          {/* Deductions */}
          <div style={card}>
            <SectionHeader title="Deduction Lines" />
            {result.deduction_lines.length === 0 ? (
              <div style={{ padding: '20px', fontSize: 13, color: '#8C94A6' }}>No deductions applied.</div>
            ) : (
              <>
                {/* Summary by type */}
                <div style={{ padding: '12px 20px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.entries(deductionsByType).map(([type, { count, total }]) => (
                    <div key={type} style={{
                      padding: '6px 12px', borderRadius: 8,
                      background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
                      fontSize: 12,
                    }}>
                      <span style={{ color: '#DC2626', fontWeight: 600 }}>
                        {DEDUCTION_LABELS[type] ?? type}
                      </span>
                      <span style={{ color: '#6B7280', marginLeft: 6 }}>
                        ×{count} · {fmt(total)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Full line-by-line table */}
                <div style={{ overflowX: 'auto', marginTop: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)', background: 'rgba(0,0,0,0.015)' }}>
                        {['Date', 'Type', 'Hours Deducted', 'Amount'].map(h => (
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
                          <td style={{ padding: '9px 16px', fontSize: 13, color: '#3D4455' }}>
                            {fmtDate(l.line_date)}
                          </td>
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

                <div style={{
                  padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.06)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#3D4455' }}>Total Deductions</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(result.total_deductions)}
                  </span>
                </div>
              </>
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
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
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
              padding: '20px 24px', display: 'flex',
              justifyContent: 'space-between', alignItems: 'center',
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
    </AttendanceLayout>
  )
}
