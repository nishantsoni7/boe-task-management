'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

type DashboardCounts = {
  total: number
  present_today: number
  checked_in: number
  absent_today: number
}

// ─── Module cards ─────────────────────────────────────────────────────────────

const MODULE_CARDS = [
  { title: 'Employee Master',    description: 'View and manage employee records.',       dotColor: colors.blue,  href: '/attendance/employees' },
  { title: 'Attendance Upload',  description: 'Import attendance from fingerprint machine CSV export.', dotColor: '#8B5CF6', href: '/attendance/upload' },
  { title: 'Leave Requests',     description: 'Submit and track leave applications.',     dotColor: colors.green  },
  { title: 'Late Arrival',       description: 'Log and review late arrival records.',     dotColor: '#F59E0B'     },
  { title: 'Early Departure',    description: 'Log and review early departure records.',  dotColor: '#F97316'     },
  { title: 'Salary Calculation', description: 'Calculate monthly salary for employees.', dotColor: '#EC4899'     },
  { title: 'My Salary',          description: 'View your personal salary details.',       dotColor: colors.blue   },
  { title: 'Salary Concerns',    description: 'Raise and track payroll concerns.',        dotColor: '#EF4444'     },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayLabel() {
  return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{
      background: colors.base,
      border: `1px solid ${colors.border}`,
      borderRadius: 10,
      padding: '18px 20px',
      flex: 1,
      minWidth: 130,
    }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 6, fontWeight: 500 }}>{label}</div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [counts, setCounts]   = useState<DashboardCounts | null>(null)
  const [loading, setLoading] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  const fetchDashboard = useCallback(async (tok: string) => {
    const res  = await fetch('/api/attendance/dashboard', {
      headers: { 'Authorization': `Bearer ${tok}` },
    })
    const json = await res.json()
    if (res.ok) setCounts(json.counts)
  }, [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: me }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
          .eq('id', session.user.id)
          .single(),
        fetchDashboard(session.access_token),
      ])

      setProfile(me as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <AttendanceLayout
      profile={profile}
      title="Attendance Dashboard"
      subtitle={todayLabel()}
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 820, padding: '24px 0' }}>

        <Link
          href="/"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Home
        </Link>

        {/* ── Stat cards ── */}
        {counts ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <StatCard label="Total Employees" value={counts.total}         accent={colors.primary} />
            <StatCard label="Present Today"   value={counts.present_today} accent="#10B981" />
            <StatCard label="Checked In"      value={counts.checked_in}    accent="#3B82F6" />
            <StatCard label="Absent Today"    value={counts.absent_today}  accent="#EF4444" />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            {['Total Employees', 'Present Today', 'Checked In', 'Absent Today'].map(label => (
              <div key={label} style={{
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: 10, padding: '18px 20px', flex: 1, minWidth: 130,
              }}>
                <div style={{ height: 26, width: 40, borderRadius: 4, background: colors.raised, marginBottom: 10 }} />
                <div style={{ fontSize: 12, color: colors.tertiary }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Module cards ── */}
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          Modules
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {MODULE_CARDS.map(card => {
            const inner = (
              <div style={{
                background: colors.base,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: '18px 20px',
                cursor: card.href ? 'pointer' : 'default',
                height: '100%',
                boxSizing: 'border-box',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: card.dotColor, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>{card.title}</span>
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: colors.tertiary, lineHeight: 1.5 }}>{card.description}</p>
              </div>
            )
            return card.href
              ? <Link key={card.title} href={card.href} style={{ textDecoration: 'none' }}>{inner}</Link>
              : <div key={card.title}>{inner}</div>
          })}
        </div>

      </div>
    </AttendanceLayout>
  )
}
