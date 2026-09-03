'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'
import { PositionsManager } from '@/components/positions/PositionsManager'

// Settings › Positions. The editor moved to src/components/positions/
// PositionsManager.tsx so the Control Center can offer the same control under
// People › Positions; this page keeps its shell and its admin check exactly as
// they were and renders that one component.
export default function PositionsPage() {
  const { viewAsUserId, exitViewMode } = useViewAs()
  const [profile, setProfile]       = useState<UserProfile | null>(null)
  const [loading, setLoading]       = useState(true)
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
      title="Positions"
      subtitle="Settings · Positions"
      onSignOut={handleSignOut}
    >
      <div style={{ padding: '24px 0' }}>
        <PositionsManager />
      </div>
    </DashboardLayout>
  )
}
