'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { callerProfile } from '@/hooks/queries/usePermissionContext'
import { useQueryClient } from '@tanstack/react-query'
import { LoadingScreen } from '@/components/ui/atoms'
import { resolveManagementAccess } from '@/lib/moduleAccess'

export default function AttendanceGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const qc = useQueryClient()

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const [{ data: profile }, { data: mod }] = await Promise.all([
        // The shared profile row (it carries id, role and team): the pages below reuse it instead of reading
        // the row again (callerProfile, 2026-11-15). Under 30 s old it is reused, otherwise read.
        callerProfile(qc, session.user.id).then(data => ({ data })),
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'attendance')
          .single(),
      ])

      // Every screen under /attendance reads other people's punches, so this is
      // the MANAGEMENT surface and it is admins only — no Control Center
      // visibility mode can widen it. See SELF_SERVICE_MODULE_KEYS in
      // src/lib/moduleAccess.ts. An employee granted the Attendance module goes
      // to /my-attendance instead, which the launcher already sends them to.
      //
      // Row access is still enforced by RLS and by the API routes regardless of
      // what this guard decides — see
      // supabase/migrations/20260812000000_attendance_payroll_isolation.sql.
      const allowed = !!profile && resolveManagementAccess('attendance', mod, profile, false)

      if (!allowed) {
        router.replace(profile ? '/my-attendance' : '/coming-soon')
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
