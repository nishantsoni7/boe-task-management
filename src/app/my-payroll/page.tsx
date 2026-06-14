'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'

// ─── Types ────────────────────────────────────────────────────────────────────

type MyResultRow = {
  id: string
  period_id: string
  payroll_month: number | null
  payroll_year: number | null
  gross_salary: number | null
  total_deductions: number | null
  net_salary: number | null
  status: 'draft' | 'locked'
  employee_reviewed_at: string | null
  generated_at: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function fmt(n: number | null): string {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function ReviewBadge({ reviewedAt }: { reviewedAt: string | null }) {
  if (reviewedAt) {
    return (
      <span style={{
        display: 'inline-block', padding: '2px 10px', borderRadius: 20,
        fontSize: 11.5, fontWeight: 600,
        background: 'rgba(16,185,129,0.12)', color: '#059669',
      }}>
        Reviewed
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600,
      background: 'rgba(140,148,166,0.12)', color: '#6B7280',
    }}>
      Pending Review
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyPayrollPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [results, setResults] = useState<MyResultRow[]>([])
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

      if (!prof) { router.push('/login'); return }
      setProfile(prof)

      const res = await fetch('/api/payroll/my-result', {
        headers: { authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Failed to load payroll data')
      else setResults(json.results ?? [])

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <AttendanceLayout
      profile={profile}
      title="My Payroll"
      subtitle="View your salary summaries"
      onSignOut={handleSignOut}
    >
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
            No payroll results available yet. Check back after your admin generates payroll.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  {['Month', 'Gross Salary', 'Deductions', 'Net Payable', 'Review Status', ''].map(h => (
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
                    style={{ borderBottom: i < results.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111318' }}>
                        {r.payroll_month ? MONTHS[r.payroll_month - 1] : '—'}{' '}
                        {r.payroll_year ?? ''}
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.gross_salary)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: r.total_deductions ? '#DC2626' : '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.total_deductions)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, fontWeight: 600, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.net_salary)}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <ReviewBadge reviewedAt={r.employee_reviewed_at} />
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <button
                        onClick={() => router.push(`/my-payroll/${r.period_id}`)}
                        style={{
                          fontSize: 12.5, fontWeight: 600,
                          color: '#4F6FD0', cursor: 'pointer',
                          padding: '4px 10px', borderRadius: 6,
                          border: '1px solid rgba(79,111,208,0.3)',
                          background: 'none', whiteSpace: 'nowrap',
                        }}
                      >
                        View & Review
                      </button>
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
