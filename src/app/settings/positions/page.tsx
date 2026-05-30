'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'

export default function PositionsPage() {
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
      title="Positions"
      subtitle="Settings · Positions"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 560, padding: '24px 0' }}>
        <div style={{
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: '32px 24px',
          textAlign: 'center',
          color: colors.muted,
        }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.secondary, marginBottom: 8 }}>
            No positions yet
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Positions will appear here once added.<br />
            Full position management coming soon.
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
