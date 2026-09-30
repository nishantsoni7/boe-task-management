'use client'

// Attendance Requests — the admin list of what employees have asked for:
// approve or reject each one.
//
// The month-by-month salary decisions that used to be a second tab here
// ("Payroll review") now live in ONE place, Attendance → Monthly Review →
// Salary decisions, beside the month's attendance summary they are made from.
// /attendance/requests?tab=review still resolves — next.config.ts redirects it —
// so old links and bookmarks land there.
//
// Admins only: AttendanceGuard (./../layout.tsx) sends everyone else to
// /my-attendance, and every API behind this page checks requireAdmin itself.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { RequestQueue } from '@/components/attendanceRequests/RequestQueue'

// useSearchParams needs a Suspense boundary; same shape as /payroll.
export default function AttendanceRequestsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AttendanceRequestsScreen />
    </Suspense>
  )
}

function AttendanceRequestsScreen() {
  const params = useSearchParams()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const router = useRouter()
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

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!profile) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Attendance requests"
      subtitle="Late arrivals, early departures, time out, half days and leave employees have asked for."
      onSignOut={handleSignOut}
      actions={
        // Salary treatment of an approved request is decided against the month's
        // attendance, not here — one contextual link rather than a second copy.
        <Link
          href="/attendance/monthly-review?view=decisions"
          className="boe-btn boe-btn-ghost"
          style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
        >
          Salary decisions
        </Link>
      }
    >
      {/* ?request=<id> is what a notification or the salary review links to. */}
      <RequestQueue getToken={getToken} focusId={params.get('request')} />
    </AttendancePayrollLayout>
  )
}
