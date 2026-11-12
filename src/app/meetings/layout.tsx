'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'

// Server-side authorization is the boundary — every meeting table is behind RLS
// and every write behind a SECURITY DEFINER guard. This is the UI half: it
// stops someone without the module from landing on an empty screen and
// wondering what broke, and it is deliberately the WEAKEST check in the module
// (module entry only). What they can then see is decided by
// can_view_meeting(), which the browser cannot influence.
//
// Same shape as src/app/orders/layout.tsx: it reads the signed-in person's
// permission context (profile + resolve_effective_permissions_for_user, one RPC
// for every module) instead of reading the role and calling resolve_permission
// up to twice (2026-11-12); useMeetings then reuses that answer.
export default function MeetingsGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { ready, userId, profile, role, permissionsByModule } = usePermissionContext()

  // Admin always; otherwise the Meetings 'view' grant from Control Center →
  // Access Control. Any stronger grant implies entry, which is why
  // deriveMeetingsCapabilities also treats create/edit/manage as entry —
  // but 'view' is what everyone conducting or attending a review holds.
  // A failed read denies: no profile, or an empty permission map.
  const allowed = !!profile && (
    role === 'admin' ||
    (permissionsByModule.get('meetings') ?? []).some(p => p.actionKey === 'view' && p.allowed) ||
    (permissionsByModule.get('meetings') ?? []).some(p => p.actionKey === 'manage' && p.allowed)
  )

  useEffect(() => {
    if (!ready) return
    if (!userId) router.replace('/login')
    else if (!allowed) router.replace('/coming-soon')
  }, [ready, userId, allowed, router])

  if (!ready || !userId || !allowed) return <LoadingScreen />
  return <>{children}</>
}
