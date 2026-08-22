'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { hasPermission } from '@/lib/permissions/resolver'

export default function OrdersGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      // ── THE TWO QUESTIONS ARE ASKED TOGETHER ──
      //
      // THIS GUARD IS ON THE CRITICAL PATH OF EVERY ORDER SCREEN. It renders a
      // loading state instead of its children, so nothing below it — not one
      // query on any Order page — begins until it answers. Every round trip it
      // spends is spent by all nine routes.
      //
      // It used to spend two in series: read the role, and only then, for a
      // non-admin, resolve orders.view. Neither needs the other's answer; both
      // need only the session's user id. The short-circuit saved an admin one
      // RPC and cost every non-admin a full round trip, and non-admins are who
      // this gate is for.
      //
      // THE RULE IS UNCHANGED, and is still the database's: an admin passes on
      // the role, anybody else passes on resolve_permission's answer, and a
      // failed read of either denies. Only the waiting changed.
      const [{ data: profile }, viewAllowed] = await Promise.all([
        supabase
          .from('users')
          .select('role')
          .eq('id', session.user.id)
          .single(),
        hasPermission(supabase, session.user.id, 'orders', 'view').catch(() => false),
      ])

      // Admin always has access; otherwise defer to Control Center's
      // Order Management access level (view = can open this module at all).
      const allowed = !!profile && (profile.role === 'admin' || viewAllowed)

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
