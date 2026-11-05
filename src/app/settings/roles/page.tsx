'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'

// THE THREE SYSTEM ROLES — an authorization fact, not a job description.
//
// These are the values of `users.role`, which is what every RLS policy tests
// and what the permission engine keys its role level on. They are NOT the
// employee hierarchy: that is the Designation Level (Super Admin,
// Administrator, Manager, Executive, Assistant, Trainee), it is recorded
// separately, and it grants nothing. See src/lib/users/designationLevels.ts.
const ROLES = [
  {
    name: 'Administrator',
    value: 'admin',
    description: 'Full system authority: every module, the Control Center, and employee administration.',
    dotColor: colors.blue,
  },
  {
    name: 'Manager',
    value: 'manager',
    description: 'Standard access plus team performance reporting. Module access is still granted individually.',
    dotColor: colors.amber,
  },
  {
    name: 'Member',
    value: 'member',
    description: 'Standard access. Every module they can open is granted individually in Access Control.',
    dotColor: colors.green,
  },
]

export default function RolesPage() {
  const { viewAsUserId, exitViewMode } = useViewAs()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      if (data?.role !== 'admin') { router.push('/dashboard'); return }
      if (viewAsUserId) { exitViewMode(); router.push('/dashboard'); return }
      setProfile(data as UserProfile)
      setLoading(false)
    }
    init()
  }, [viewAsUserId, exitViewMode, router, supabase])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="System Roles"
      subtitle="Settings · System Roles"
      onSignOut={handleSignOut}
    >
      <div className="boe-p3-settings" style={{ maxWidth: 560, padding: '24px 0' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ROLES.map(role => (
            <div
              key={role.value}
              style={{
                background: colors.base,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
              }}
            >
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: role.dotColor, flexShrink: 0, marginTop: 4,
              }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: colors.primary, marginBottom: 4 }}>
                  {role.name}
                  <span style={{
                    marginLeft: 8, fontSize: 12, fontWeight: 500,
                    color: colors.muted, fontFamily: 'monospace',
                  }}>
                    {role.value}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
                  {role.description}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* The two Control Center places are links (they read as plain text on
            a desktop, as before; a phone underlines them as 44px targets). */}
        <p className="boe-p4-roles-note" style={{ marginTop: 24, fontSize: 12, color: colors.muted }}>
          A system role is set on the employee record in{' '}
          <Link href="/admin/control-center/people" className="boe-p4-roles-link" style={{ color: 'inherit', textDecoration: 'none' }}>
            Control Center › People › Employees
          </Link>,
          under Access. What each person can open, module by module, is decided in{' '}
          <Link href="/admin/control-center/permissions" className="boe-p4-roles-link" style={{ color: 'inherit', textDecoration: 'none' }}>
            Control Center › Access
          </Link>. The employee&apos;s Designation Level — Super Admin,
          Administrator, Manager, Executive, Assistant or Trainee — is a separate,
          organisational fact and grants no access on its own.
        </p>
      </div>
    </DashboardLayout>
  )
}
