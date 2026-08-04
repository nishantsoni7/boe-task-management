'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { canAccessModule } from '@/lib/moduleAccess'

export default function PayrollGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const [{ data: profile }, { data: mod }] = await Promise.all([
        supabase.from('users').select('role, team').eq('id', session.user.id).single(),
        supabase.from('app_modules').select('visibility_type, allowed_department').eq('module_key', 'payroll').single(),
      ])

      // /payroll is salary administration for the whole company, so it is
      // admin-only. Control Center's visibility setting can still HIDE it, but
      // flipping it to `live` or a department must never be able to grant an
      // employee payroll access — that is a navigation control, not an
      // authorization one. Employees reach their own payslip at /my-payroll.
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
