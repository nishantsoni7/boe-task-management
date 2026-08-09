'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { resolveManagementAccess } from '@/lib/moduleAccess'
import { PAYROLL_GUIDE_PATH } from '@/lib/payroll/guidePath'

/**
 * What the signed-in user may reach under /payroll.
 *
 * Resolved ONCE, then applied per path. Re-running the whole check on every
 * navigation would flash the loading screen between payroll pages; keeping a
 * single boolean and ignoring the path would let the guide's exception leak
 * authorisation to the guarded pages. This is the shape that does neither.
 */
type PayrollAccess = 'unknown' | 'manager' | 'guide_only' | 'denied'

export default function PayrollGuard({ children }: { children: React.ReactNode }) {
  const [access, setAccess] = useState<PayrollAccess>('unknown')
  const router   = useRouter()
  const pathname = usePathname()
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

      // /payroll is salary administration for the whole company, so this is the
      // MANAGEMENT surface and it is admins only — no Control Center visibility
      // mode can widen it. See SELF_SERVICE_MODULE_KEYS in
      // src/lib/moduleAccess.ts. Employees reach their own payslip at
      // /my-payroll, which is not gated by this module row at all.
      const allowed = !!profile && resolveManagementAccess('payroll', mod, profile, false)

      if (allowed) { setAccess('manager'); return }

      // Everyone else still gets the calculation guide, and only the guide.
      //
      // This is not a second access model — it is the same guard with a stated
      // exception for the one page under /payroll that holds NO employee data:
      // every figure on it comes from src/lib/payroll/rules.ts constants, and it
      // reads no payroll record for anybody. An employee following the link from
      // their own payslip must not be bounced back to the payslip they came from.
      setAccess(profile ? 'guide_only' : 'denied')
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isGuide = pathname === PAYROLL_GUIDE_PATH

  useEffect(() => {
    if (access === 'unknown') return
    if (access === 'manager') return
    if (access === 'guide_only' && isGuide) return
    router.replace(access === 'denied' ? '/coming-soon' : '/my-payroll')
  }, [access, isGuide, router])

  if (access === 'manager') return <>{children}</>
  if (access === 'guide_only' && isGuide) return <>{children}</>
  return <LoadingScreen />
}
