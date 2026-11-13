'use client'

// The Scoreboard's Monthly Review (owner, 2026-11-12), inside Task Management: final standings, the awards
// (confirm, freeze and announce) and the private reviews. The owner alone: /api/scoreboard/review refuses
// everybody else, and the screen says so plainly.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { MonthlyReviewScreen } from '@/components/scoreboard/MonthlyReviewScreen'

export default function MonthlyReviewPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login?redirect=%2Ftasks%2Fmonthly-review'); return }
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
    <DashboardLayout profile={profile} title="Monthly Review" subtitle="Final standings, the month’s awards, and private reviews." onSignOut={handleSignOut}>
      <MonthlyReviewScreen />
    </DashboardLayout>
  )
}
