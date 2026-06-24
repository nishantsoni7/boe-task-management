'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'

// ─── Types ────────────────────────────────────────────────────────────────────

type PeriodMeta = {
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  locked_at: string | null
}

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
  employee_reviewed_at: string | null
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

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  }) + ' ' + new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
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
      Pending
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollResultsPage() {
  const params   = useParams()
  const periodId = params.periodId as string

  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [period,      setPeriod]      = useState<PeriodMeta | null>(null)
  const [results,     setResults]     = useState<ResultRow[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [token,       setToken]       = useState('')
  const [locking,     setLocking]     = useState(false)
  const [lockError,   setLockError]   = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const loadData = async (accessToken: string) => {
    const res  = await fetch(`/api/payroll/results?period_id=${periodId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? 'Failed to load results'); return }
    setPeriod(json.period ?? null)
    setResults(json.results ?? [])
  }

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

      if (!prof || prof.role !== 'admin') { router.push('/dashboard'); return }
      setProfile(prof)

      await loadData(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  const handleLock = async () => {
    if (locking) return
    const label = period
      ? `${MONTHS[period.payroll_month - 1]} ${period.payroll_year}`
      : 'this period'
    if (!confirm(`Lock payroll for ${label}? This cannot be undone.\n\nEmployees who have not yet reviewed will no longer be able to do so.`)) return

    setLocking(true)
    setLockError(null)
    try {
      const res  = await fetch('/api/payroll/lock', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body:    JSON.stringify({ payroll_period_id: periodId }),
      })
      const json = await res.json()
      if (!res.ok) { setLockError(json.error ?? 'Lock failed') }
      else { await loadData(token) }
    } finally {
      setLocking(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const isLocked    = period?.status === 'locked'
  const canLock     = period?.status === 'generated'
  const periodLabel = period
    ? `${MONTHS[period.payroll_month - 1]} ${period.payroll_year}`
    : ''

  const reviewedCount = results.filter(r => r.employee_reviewed_at).length
  const totalCount    = results.length

  const totals = results.length > 0 ? {
    gross:       results.reduce((s, r) => s + (r.gross_salary             ?? 0), 0),
    deductions:  results.reduce((s, r) => s + (r.total_deductions         ?? 0), 0),
    adjustments: results.reduce((s, r) => s + (r.pending_adjustment_total ?? 0), 0),
    net:         results.reduce((s, r) => s + (r.net_salary               ?? 0), 0),
  } : null

  return (
    <PayrollLayout
      profile={profile}
      title="Payroll Results"
      subtitle={periodLabel ? `Results — ${periodLabel}` : 'Results for this payroll period'}
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

      {/* Locked banner */}
      {isLocked && (
        <div style={{
          marginBottom: 16, padding: '12px 18px', borderRadius: 10,
          background: 'rgba(232,160,48,0.10)', color: '#92400E',
          border: '1px solid rgba(232,160,48,0.35)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
        }}>
          <span style={{ fontSize: 16 }}>🔒</span>
          <span>
            <strong>Payroll locked</strong>
            {period?.locked_at ? ` · ${fmtDateTime(period.locked_at)}` : ''}
            {' — Regeneration and employee review are disabled.'}
          </span>
        </div>
      )}

      {/* Lock action bar — shown only when period is generated */}
      {canLock && (
        <div style={{
          marginBottom: 16, padding: '12px 18px', borderRadius: 10,
          background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ fontSize: 13, color: '#6B7280' }}>
            Lock this payroll period to finalise it. Generation and employee review will be disabled.
            {totalCount > 0 && (
              <div style={{ marginTop: 4, fontSize: 12.5, color: reviewedCount === totalCount ? '#059669' : '#D97706' }}>
                {reviewedCount} of {totalCount} employee{totalCount !== 1 ? 's' : ''} have reviewed their payslip.
              </div>
            )}
          </div>
          <button
            onClick={handleLock}
            disabled={locking}
            style={{
              padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 700,
              cursor: locking ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(232,160,48,0.5)',
              background: locking ? 'rgba(0,0,0,0.04)' : 'rgba(232,160,48,0.12)',
              color: locking ? '#8C94A6' : '#92400E',
              whiteSpace: 'nowrap',
            }}
          >
            {locking ? 'Locking…' : '🔒 Lock Payroll'}
          </button>
        </div>
      )}

      {lockError && (
        <div style={{
          marginBottom: 14, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {lockError}
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
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  {['Employee', 'Working Days', 'Gross Salary', 'Deductions', 'Adjustments', 'Net Salary', 'Employee Review', ''].map(h => (
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
                      <ReviewBadge reviewedAt={r.employee_reviewed_at} />
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
                {totals && (
                  <tr style={{ borderTop: '2px solid rgba(0,0,0,0.10)', background: 'rgba(0,0,0,0.025)' }}>
                    <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#111318' }}>
                      Total ({totalCount})
                    </td>
                    <td style={{ padding: '12px 16px' }} />
                    <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(totals.gross)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: totals.deductions > 0 ? '#DC2626' : '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(totals.deductions)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(totals.adjustments)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(totals.net)}
                    </td>
                    <td style={{ padding: '12px 16px' }} />
                    <td style={{ padding: '12px 16px' }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PayrollLayout>
  )
}
