'use client'

// The shell both Day Close pages share: the signed-in profile for the Attendance & Payroll layout, and
// sign-out. The content decides nothing about access: its API routes do.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

export function DayClosePage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace(`/login?redirect=${encodeURIComponent(window.location.pathname)}`); return }
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
    <AttendancePayrollLayout profile={profile} title={title} subtitle={subtitle} onSignOut={handleSignOut}>
      {children}
    </AttendancePayrollLayout>
  )
}
