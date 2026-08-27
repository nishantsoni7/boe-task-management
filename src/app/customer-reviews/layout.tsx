'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { hasPermission } from '@/lib/permissions/resolver'

// Server-side authorization is the boundary — every table in this module is
// behind RLS, every status change behind a SECURITY DEFINER guard, and every
// photograph behind a private bucket whose policies read the same predicate.
// This is the UI half: it stops someone without the module from landing on an
// empty screen and wondering what broke, and it is deliberately the WEAKEST
// check in the module (module entry only). What they can then SEE is decided by
// can_view_customer_review_request(), which the browser cannot influence.
//
// Same shape as src/app/meetings/layout.tsx, with one difference worth naming:
// this module has no `view` action, so it cannot use the shared ModuleGuard.
// Entry is `use` OR `verify` — a verifier who could not open the module could
// not verify anything, and a `use` holder who could not open it could not raise
// a request. See src/lib/permissions/customerReviewOutreach.ts.
export default function CustomerReviewsGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: profile } = await supabase
        .from('users')
        .select('role, is_active')
        .eq('id', session.user.id)
        .single()

      // A failed profile read denies. An unidentified caller holding a stale
      // permission row is exactly the case that must not be admitted.
      if (!profile || profile.is_active !== true) { router.replace('/coming-soon'); return }

      const allowed =
        profile.role === 'admin' ||
        (await hasPermission(supabase, session.user.id, 'customer_review_requests', 'use').catch(() => false)) ||
        (await hasPermission(supabase, session.user.id, 'customer_review_requests', 'verify').catch(() => false))

      if (!allowed) {
        router.replace('/coming-soon')
        return
      }

      setAuthorized(true)
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `children` render in no state but `authorized`, so a child that fetches on
  // mount cannot start before the check finishes.
  if (!authorized) return <LoadingScreen />
  return <>{children}</>
}
