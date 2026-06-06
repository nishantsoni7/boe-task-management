'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'

const SETTING_CARDS = [
  {
    title: 'Roles',
    description: 'View and manage member roles.',
    href: '/settings/roles',
    dotColor: colors.blue,
  },
  {
    title: 'Positions',
    description: 'View and manage job positions.',
    href: '/settings/positions',
    dotColor: colors.green,
  },
]

export default function SettingsPage() {
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
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Settings"
      subtitle="App configuration"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 600, padding: '24px 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {SETTING_CARDS.map(card => (
            <button
              key={card.href}
              onClick={() => router.push(card.href)}
              style={{
                background: colors.base,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: '20px 20px',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'box-shadow 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: card.dotColor, flexShrink: 0,
                }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: colors.primary }}>
                  {card.title}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
                {card.description}
              </p>
            </button>
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
