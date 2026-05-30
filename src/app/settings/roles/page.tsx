'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'

const ROLES = [
  {
    name: 'Admin',
    value: 'admin',
    description: 'Full access. Can manage members, settings, and all tasks.',
    dotColor: colors.blue,
  },
  {
    name: 'Manager',
    value: 'manager',
    description: 'Can view team tasks, assign work, and access the manager view.',
    dotColor: colors.amber,
  },
  {
    name: 'Member',
    value: 'member',
    description: 'Standard employee. Can create and manage their own tasks.',
    dotColor: colors.green,
  },
]

export default function RolesPage() {
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
      setProfile(data as UserProfile)
      setLoading(false)
    }
    init()
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Roles"
      subtitle="Settings · Roles"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 560, padding: '24px 0' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ROLES.map(role => (
            <div
              key={role.value}
              style={{
                background: colors.base,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
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
                    marginLeft: 8, fontSize: 11, fontWeight: 500,
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

        <p style={{ marginTop: 24, fontSize: 12, color: colors.muted }}>
          Roles are assigned per member in the Members page. Full permissions management coming soon.
        </p>
      </div>
    </DashboardLayout>
  )
}
