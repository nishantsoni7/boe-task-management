'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { hasPermission } from '@/lib/permissions/resolver'

// Server-side authorization is the boundary — every meeting table is behind RLS
// and every write behind a SECURITY DEFINER guard. This is the UI half: it
// stops someone without the module from landing on an empty screen and
// wondering what broke, and it is deliberately the WEAKEST check in the module
// (module entry only). What they can then see is decided by
// can_view_meeting(), which the browser cannot influence.
//
// Same shape as src/app/orders/layout.tsx.
export default function MeetingsGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: profile } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .single()

      // Admin always; otherwise the Meetings 'view' grant from Control Center →
      // Access Control. Any stronger grant implies entry, which is why
      // deriveMeetingsCapabilities also treats create/edit/manage as entry —
      // but 'view' is what everyone conducting or attending a review holds.
      const allowed = !!profile && (
        profile.role === 'admin' ||
        (await hasPermission(supabase, session.user.id, 'meetings', 'view').catch(() => false)) ||
        (await hasPermission(supabase, session.user.id, 'meetings', 'manage').catch(() => false))
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
