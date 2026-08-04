'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { canAccessModule } from '@/lib/moduleAccess'

export default function AttendanceGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const [{ data: profile }, { data: mod }] = await Promise.all([
        supabase.from('users').select('role, team').eq('id', session.user.id).single(),
        supabase.from('app_modules').select('visibility_type, allowed_department').eq('module_key', 'attendance').single(),
      ])

      // Every screen under /attendance reads other people's punches, so the
      // module is admin-only. Control Center's visibility setting can still
      // HIDE it (`hidden`), but it can no longer open it: a toggle meant for
      // navigation must not be able to hand an employee the company's
      // attendance. Row access is enforced by RLS and by the API routes
      // regardless of what this guard decides — see
      // supabase/migrations/20260812000000_attendance_payroll_isolation.sql.
      const allowed = !!profile
        && profile.role === 'admin'
        && canAccessModule(mod?.visibility_type, mod?.allowed_department, profile, true)

      if (!allowed) {
        router.replace('/coming-soon')
        return
      }

      setAuthorized(true)
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!authorized) return <LoadingScreen />
  return <>{children}</>
}
