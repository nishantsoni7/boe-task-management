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
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'finance')
          .single(),
      ])

      // Admin always has access; otherwise defer to Control Center's setting.
      // Fallback (no app_modules row) is open, matching Finance's current default access.
      //
      // The resolver is the shared one /modules uses, so a Custom member list
      // grants the route as well as the card. The `role === 'admin'` clause in
      // front of it is deliberate and is Finance's own rule, not a leftover: it
      // is what keeps an admin able to open Finance while the module is
      // `hidden`. Nothing else about Finance's authorization changes here — the
      // permission engine and RLS still decide what anyone can do inside.
      const allowed = !!profile && (
        profile.role === 'admin' ||
        resolveModuleAccess('finance', mod, profile, true)
      )

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
