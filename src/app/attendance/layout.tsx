'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { resolveModuleAccess } from '@/lib/moduleAccess'

export default function AttendanceGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const [{ data: profile }, { data: mod }] = await Promise.all([
        supabase.from('users').select('id, role, team').eq('id', session.user.id).single(),
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'attendance')
          .single(),
      ])

      // One decision, shared with /modules and with the attendance API routes —
      // see src/lib/moduleAccess.ts. Every screen under /attendance reads other
      // people's punches, so `attendance` is an explicit-grant module there:
      // `live` and `department_only` cannot open it, `hidden` closes it, and a
      // non-admin gets in only by being named in Control Center → Module
      // Visibility → Custom. Row access is still enforced by RLS and by the API
      // routes regardless of what this guard decides — see
      // supabase/migrations/20260812000000_attendance_payroll_isolation.sql.
      const allowed = !!profile && resolveModuleAccess('attendance', mod, profile, false)

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
