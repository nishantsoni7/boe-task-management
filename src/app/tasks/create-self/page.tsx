'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'

export default function CreateSelfTaskPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase.from('users').select('*').eq('id', session.user.id).single()
      if (data) setProfile(data as UserProfile)
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="New Task for Self"
      subtitle="Create a task assigned to yourself"
      onSignOut={handleLogout}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '80px 24px', gap: '10px',
        background: colors.base,
        border: `1.5px dashed ${colors.border}`,
        borderRadius: '10px',
      }}>
        <div style={{
          width: '40px', height: '40px', borderRadius: '50%',
          background: colors.raised,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '18px', marginBottom: '6px',
        }}>
          ✎
        </div>
        <div style={{ fontSize: '15px', fontWeight: 600, color: colors.primary }}>
          Self-task creation coming soon
        </div>
        <div style={{ fontSize: '12px', color: colors.muted, textAlign: 'center', maxWidth: '320px', lineHeight: 1.6 }}>
          This flow will let you quickly assign a task to yourself without going through the team task form.
        </div>
        <button
          onClick={() => router.push('/tasks/create')}
          style={{
            marginTop: '16px',
            padding: '8px 20px',
            background: colors.base,
            border: `1.5px solid ${colors.borderSoft}`,
            borderRadius: '7px', cursor: 'pointer',
            fontSize: '12px', fontWeight: 600, color: colors.secondary,
          }}
        >
          Use New Task for Team instead
        </button>
      </div>
    </DashboardLayout>
  )
}
