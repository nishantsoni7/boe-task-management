'use client'

// Team Today (Day Close, owner 2026-11-12), inside Task Management: everybody's plan, tasks done or carried
// over, punches, calls logged and strikes for a day. Administrators and the Day Close reviewer:
// /api/day-close/team refuses everybody else, and this page says so plainly.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { TeamTodayScreen } from '@/components/dayClose/TeamTodayScreen'

export default function TeamTodayPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login?redirect=%2Ftasks%2Fteam-today'); return }
      const { data: prof } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.replace('/login'); return }
      setProfile(prof as UserProfile)
    }
    void init()
  }, [supabase, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!profile) return <LoadingScreen />
  return (
    <DashboardLayout profile={profile} title="Team Today" subtitle="Who planned, who finished, who closed the day, and the strikes to review." onSignOut={handleSignOut}>
      <TeamTodayScreen />
    </DashboardLayout>
  )
}
