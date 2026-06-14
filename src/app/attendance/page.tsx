'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

// ─── Module cards ─────────────────────────────────────────────────────────────

const ACTIVE_CARDS = [
  {
    title: 'Upload Monthly Attendance',
    description: 'Import monthly attendance data from fingerprint machine Excel export.',
    dotColor: '#8B5CF6',
    href: '/attendance/upload',
  },
  {
    title: 'Monthly Attendance Review',
    description: 'Per-employee attendance summary: present, half-day, absent, late, and missing punch counts.',
    dotColor: '#F59E0B',
    href: '/attendance/monthly-review',
  },
  {
    title: 'View Imported Records',
    description: 'Browse and verify attendance records imported from Excel.',
    dotColor: colors.blue,
    href: '/attendance/records',
  },
  {
    title: 'Employee Fingerprint Mapping',
    description: 'Map employee codes to fingerprint device IDs.',
    dotColor: colors.green,
    href: '/attendance/employees',
  },
]

const FUTURE_CARDS = [
  {
    title: 'Gate Pass / Outside Movement',
    description: 'Track employee movements and outside-office approvals.',
    dotColor: '#F59E0B',
  },
  {
    title: 'Payroll Linkage',
    description: 'Connect attendance records to monthly payroll calculation.',
    dotColor: '#EC4899',
  },
  {
    title: 'Leave / Adjustment Rules',
    description: 'Define leave types, half-day rules, and attendance adjustments.',
    dotColor: '#EF4444',
  },
]

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
        .eq('id', session.user.id)
        .single()

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
      title="Attendance"
      subtitle="Managed through monthly fingerprint Excel import"
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

        {/* ── Info banner ── */}
        <div style={{
          background: colors.raised,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: '14px 18px',
          marginBottom: 28,
          fontSize: 13,
          color: colors.secondary,
          lineHeight: 1.6,
        }}>
          Attendance is managed through monthly fingerprint Excel import. Upload the export from your fingerprint device software each month to record employee attendance.
        </div>

        {/* ── Active modules ── */}
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          Modules
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 28 }}>
          {ACTIVE_CARDS.map(card => (
            <Link key={card.title} href={card.href} style={{ textDecoration: 'none' }}>
              <div style={{
                background: colors.base,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: '18px 20px',
                cursor: 'pointer',
                height: '100%',
                boxSizing: 'border-box',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: card.dotColor, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>{card.title}</span>
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: colors.tertiary, lineHeight: 1.5 }}>{card.description}</p>
              </div>
            </Link>
          ))}
        </div>

        {/* ── Admin utilities ── */}
        {profile?.role === 'admin' && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
              Admin
            </div>
            <div style={{ marginBottom: 28 }}>
              <Link href="/attendance/holidays" style={{ textDecoration: 'none' }}>
                <div style={{
                  background: colors.base,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: '18px 20px',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  minWidth: 260,
                }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#6366F1', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.primary, marginBottom: 3 }}>Holiday Management</div>
                    <div style={{ fontSize: 12.5, color: colors.tertiary }}>Add or remove public holidays excluded from working days.</div>
                  </div>
                </div>
              </Link>
            </div>
          </>
        )}

        {/* ── Future modules ── */}
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          Coming Soon
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {FUTURE_CARDS.map(card => (
            <div key={card.title} style={{
              background: colors.base,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: '18px 20px',
              opacity: 0.45,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: card.dotColor, flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>{card.title}</span>
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: colors.tertiary, lineHeight: 1.5 }}>{card.description}</p>
            </div>
          ))}
        </div>

      </div>
    </AttendanceLayout>
  )
}
