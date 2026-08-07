'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { resolveModuleAccess } from '@/lib/moduleAccess'

export default function PayrollGuard({ children }: { children: React.ReactNode }) {
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
          .eq('module_key', 'payroll')
          .single(),
      ])

      // One decision, shared with /modules and with the payroll API routes —
      // see src/lib/moduleAccess.ts. /payroll is salary administration for the
      // whole company, so `payroll` is an explicit-grant module there: flipping
      // the module to `live` or to a department cannot hand an employee the
      // payroll ledger, and a non-admin gets in only by being named in Control
      // Center → Module Visibility → Custom. Employees still reach their own
      // payslip at /my-payroll without any of this.
      //
      // Opening the module is not the same as running it: generation, locking,
      // unlocking, adjustments and attendance corrections stay admin-only in
      // their API routes and in canCorrectAttendance().
      const allowed = !!profile && resolveModuleAccess('payroll', mod, profile, false)

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
