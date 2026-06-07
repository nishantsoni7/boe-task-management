'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'

// ─── Types ────────────────────────────────────────────────────────────────────

type PayrollPeriodRow = {
  id: string
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  notes: string | null
  created_at: string
  generated_employees: number | null
  last_generated_at: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function StatusBadge({ status }: { status: PayrollPeriodRow['status'] }) {
  const map = {
    draft:     { bg: 'rgba(140,148,166,0.12)', color: '#6B7280', label: 'Draft' },
    generated: { bg: 'rgba(16,185,129,0.12)',  color: '#059669', label: 'Generated' },
    locked:    { bg: 'rgba(232,160,48,0.15)',  color: '#B45309', label: 'Locked' },
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

export default function PayrollPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [periods,  setPeriods]  = useState<PayrollPeriodRow[]>([])
  const [loading,  setLoading]  = useState(true)
  const [token,    setToken]    = useState('')
  const [busy,     setBusy]     = useState<Record<string, boolean>>({})
  const [error,    setError]    = useState<string | null>(null)

  const router  = useRouter()
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

      if (!prof || prof.role !== 'admin') {
        router.push('/dashboard')
        return
      }

      setProfile(prof)
      await loadPeriods(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadPeriods = async (accessToken: string) => {
    const res = await fetch('/api/payroll/periods', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) { setError('Failed to load payroll periods'); return }
    const json = await res.json()
    setPeriods(json.periods ?? [])
  }

  const handleGenerate = async (period: PayrollPeriodRow) => {
    if (busy[period.id]) return
    setBusy(b => ({ ...b, [period.id]: true }))
    setError(null)
    try {
      const res = await fetch('/api/payroll/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ payroll_period_id: period.id }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Generation failed'); return }
      await loadPeriods(token)
    } finally {
      setBusy(b => ({ ...b, [period.id]: false }))
    }
  }

  const handleLock = async (period: PayrollPeriodRow) => {
    if (busy[period.id]) return
    if (!confirm(`Lock payroll for ${MONTHS[period.payroll_month - 1]} ${period.payroll_year}? This cannot be undone.`)) return
    setBusy(b => ({ ...b, [period.id]: true }))
    setError(null)
    try {
      const res = await fetch('/api/payroll/lock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ payroll_period_id: period.id }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Lock failed'); return }
      await loadPeriods(token)
    } finally {
      setBusy(b => ({ ...b, [period.id]: false }))
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Payroll"
      subtitle="Manage payroll periods"
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

      {/* Table card */}
      <div style={{
        background: '#fff', borderRadius: 12,
        border: '1px solid rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}>
        {periods.length === 0 ? (
          <div style={{
            padding: '48px 24px', textAlign: 'center',
            color: '#8C94A6', fontSize: 14,
          }}>
            No payroll periods found.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  {['Month', 'Year', 'Status', 'Generated Employees', 'Last Generated', 'Actions'].map(h => (
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
                {periods.map((p, i) => (
                  <tr
                    key={p.id}
                    style={{
                      borderBottom: i < periods.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
                    }}
                  >
                    <td style={{ padding: '12px 16px', fontSize: 13.5, fontWeight: 500, color: '#111318' }}>
                      {MONTHS[p.payroll_month - 1]}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455' }}>
                      {p.payroll_year}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <StatusBadge status={p.status} />
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455' }}>
                      {p.generated_employees != null ? p.generated_employees : '—'}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12.5, color: '#6B7280', whiteSpace: 'nowrap' }}>
                      {formatDateTime(p.last_generated_at)}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <ActionButtons
                        period={p}
                        isBusy={!!busy[p.id]}
                        onGenerate={() => handleGenerate(p)}
                        onLock={() => handleLock(p)}
                        onViewResults={() => router.push(`/payroll/results/${p.id}`)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

// ─── ActionButtons ────────────────────────────────────────────────────────────

type ActionButtonsProps = {
  period: PayrollPeriodRow
  isBusy: boolean
  onGenerate: () => void
  onLock: () => void
  onViewResults: () => void
}

function ActionButtons({ period, isBusy, onGenerate, onLock, onViewResults }: ActionButtonsProps) {
  const isLocked     = period.status === 'locked'
  const canLock      = period.status === 'generated'
  const hasResults   = period.status === 'generated' || period.status === 'locked'

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {/* Generate */}
      <button
        onClick={onGenerate}
        disabled={isLocked || isBusy}
        style={{
          padding: '5px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600,
          cursor: isLocked || isBusy ? 'not-allowed' : 'pointer',
          border: '1px solid rgba(0,0,0,0.12)',
          background: isLocked || isBusy ? 'rgba(0,0,0,0.04)' : '#1A2035',
          color: isLocked || isBusy ? '#8C94A6' : '#E8A030',
          opacity: isLocked ? 0.5 : 1,
          whiteSpace: 'nowrap',
        }}
      >
        {isBusy ? 'Working…' : period.status === 'draft' ? 'Generate' : 'Re-generate'}
      </button>

      {/* Lock */}
      <button
        onClick={onLock}
        disabled={!canLock || isBusy}
        style={{
          padding: '5px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600,
          cursor: !canLock || isBusy ? 'not-allowed' : 'pointer',
          border: `1px solid ${canLock ? 'rgba(232,160,48,0.4)' : 'rgba(0,0,0,0.1)'}`,
          background: canLock ? 'rgba(232,160,48,0.1)' : 'rgba(0,0,0,0.03)',
          color: canLock ? '#B45309' : '#8C94A6',
          whiteSpace: 'nowrap',
        }}
      >
        {isLocked ? 'Locked' : 'Lock'}
      </button>

      {/* View Results */}
      <button
        onClick={onViewResults}
        disabled={!hasResults}
        title={hasResults ? undefined : 'Generate payroll first'}
        style={{
          padding: '5px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600,
          cursor: hasResults ? 'pointer' : 'not-allowed',
          border: `1px solid ${hasResults ? 'rgba(59,130,246,0.35)' : 'rgba(0,0,0,0.08)'}`,
          background: hasResults ? 'rgba(59,130,246,0.08)' : 'rgba(0,0,0,0.03)',
          color: hasResults ? '#1D4ED8' : '#8C94A6',
          whiteSpace: 'nowrap',
        }}
      >
        View Results
      </button>
    </div>
  )
}
