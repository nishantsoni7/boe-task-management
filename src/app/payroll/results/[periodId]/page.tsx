'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'

// ─── Types ────────────────────────────────────────────────────────────────────

type ResultRow = {
  id: string
  employee_id: string
  employee_name: string
  employee_code: string | null
  working_days_in_month: number | null
  gross_salary: number | null
  total_deductions: number | null
  pending_adjustment_total: number | null
  net_salary: number | null
  status: 'draft' | 'locked'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number | null): string {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function StatusBadge({ status }: { status: ResultRow['status'] }) {
  const map = {
    draft:  { bg: 'rgba(140,148,166,0.12)', color: '#6B7280', label: 'Draft' },
    locked: { bg: 'rgba(232,160,48,0.15)',  color: '#B45309', label: 'Locked' },
  }
  const s = map[status]
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.color,
    }}>
      {s.label}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollResultsPage() {
  const params   = useParams()
  const periodId = params.periodId as string

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [results, setResults] = useState<ResultRow[]>([])
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

      if (!prof || prof.role !== 'admin') {
        router.push('/dashboard')
        return
      }

      setProfile(prof)

      const res = await fetch(`/api/payroll/results?period_id=${periodId}`, {
        headers: { authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Failed to load results') }
      else { setResults(json.results ?? []) }

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <AttendanceLayout
      profile={profile}
      title="Payroll Results"
      subtitle="Results for this payroll period"
      onSignOut={handleSignOut}
    >
      {/* Back link */}
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => router.push('/payroll')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#6B7280', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4,
            padding: 0,
          }}
        >
          ← Back to Payroll Periods
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

      <div style={{
        background: '#fff', borderRadius: 12,
        border: '1px solid rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}>
        {results.length === 0 ? (
          <div style={{
            padding: '48px 24px', textAlign: 'center',
            color: '#8C94A6', fontSize: 14,
          }}>
            No payroll results generated for this period yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  {['Employee', 'Working Days', 'Gross Salary', 'Deductions', 'Adjustments', 'Net Salary', 'Status', ''].map(h => (
                    <th key={h} style={{
                      padding: '11px 16px', textAlign: 'left',
                      fontSize: 11.5, fontWeight: 700,
                      color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr
                    key={r.id}
                    style={{
                      borderBottom: i < results.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
                    }}
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: '#111318' }}>
                        {r.employee_name}
                      </div>
                      {r.employee_code && (
                        <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 1 }}>
                          {r.employee_code}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455' }}>
                      {r.working_days_in_month ?? '—'}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.gross_salary)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: r.total_deductions ? '#DC2626' : '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.total_deductions)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.pending_adjustment_total)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, fontWeight: 600, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.net_salary)}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <StatusBadge status={r.status} />
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <Link
                        href={`/payroll/results/${periodId}/${r.employee_id}`}
                        style={{
                          fontSize: 12.5, fontWeight: 600,
                          color: '#4F6FD0', textDecoration: 'none',
                          padding: '4px 10px', borderRadius: 6,
                          border: '1px solid rgba(79,111,208,0.3)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AttendanceLayout>
  )
}
