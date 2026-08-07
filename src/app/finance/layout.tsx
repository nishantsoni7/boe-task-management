'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { resolveModuleAccess } from '@/lib/moduleAccess'

export default function FinanceGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const [{ data: profile }, { data: mod }] = await Promise.all([
        supabase.from('users').select('id, role, team').eq('id', session.user.id).single(),
        supabase.from('app_modules').select('visibility_type, allowed_department, allowed_user_ids').eq('module_key', 'finance').single(),
      ])

      // Admin always has access; otherwise defer to Control Center's setting,
      // through the SAME resolver /modules uses — so a Custom member list grants
      // the route as well as the card. Fallback (no app_modules row) is open,
      // matching Finance's current default access.
      const allowed = !!profile && resolveModuleAccess('finance', mod, profile, true)

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
