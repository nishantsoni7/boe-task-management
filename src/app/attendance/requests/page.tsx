'use client'

// Attendance Requests — the admin's two jobs over employee requests:
//
//   Queue           approve or reject what employees submitted
//   Payroll review  per employee, every salary-relevant attendance event of a
//                   month, matched with requests, with a recorded decision
//
// Admins only: AttendanceGuard (./../layout.tsx) sends everyone else to
// /my-attendance, and every API behind this page checks requireAdmin itself.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { RequestQueue } from '@/components/attendanceRequests/RequestQueue'
import { PayrollAttendanceReview } from '@/components/attendanceRequests/PayrollAttendanceReview'

type Tab = 'queue' | 'review'

// useSearchParams needs a Suspense boundary; same shape as /payroll.
export default function AttendanceRequestsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AttendanceRequestsScreen />
    </Suspense>
  )
}

function AttendanceRequestsScreen() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const router = useRouter()
  const params = useSearchParams()
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'review' ? 'review' : 'queue')
  const supabase = useMemo(() => createClient(), [])

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: prof } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.push('/login'); return }
      setProfile(prof)
    }
    void init()
  }, [supabase, router])

  const switchTab = (t: Tab) => {
    setTab(t)
    router.replace(t === 'review' ? '/attendance/requests?tab=review' : '/attendance/requests')
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!profile) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Attendance Requests"
      subtitle="Approve employee requests, then review each month's attendance before payroll"
      onSignOut={handleSignOut}
    >
      <div role="tablist" aria-label="Attendance requests" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button role="tab" type="button" aria-selected={tab === 'queue'}
          className={tab === 'queue' ? 'boe-btn boe-btn-primary' : 'boe-btn boe-btn-ghost'}
          style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => switchTab('queue')}>Requests</button>
        <button role="tab" type="button" aria-selected={tab === 'review'}
          className={tab === 'review' ? 'boe-btn boe-btn-primary' : 'boe-btn boe-btn-ghost'}
          style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => switchTab('review')}>Payroll review</button>
      </div>
      {tab === 'queue' ? <RequestQueue getToken={getToken} /> : <PayrollAttendanceReview getToken={getToken} />}
    </AttendancePayrollLayout>
  )
}
