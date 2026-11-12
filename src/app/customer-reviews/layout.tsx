'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'

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
//
// 2026-11-12: read from the signed-in person's permission context (profile +
// resolve_effective_permissions_for_user, one RPC for every module) instead of
// a users read and up to two resolve_permission calls; useCustomerReviews then
// reuses the same answer. The rule below is unchanged.

export default function CustomerReviewsGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { ready, userId, profile, permissionsByModule } = usePermissionContext()

  // ONLY is_active IS READ from the profile, so entry cannot be decided by
  // anything else on it here or by a later edit to this file. A failed profile
  // read denies: an unidentified caller holding a stale permission row is
  // exactly the case that must not be admitted.
  const active = profile?.is_active === true

  // ENTRY IS `use` OR `verify`, RESOLVED — and nothing else. An administrator
  // with both permissions revoked is not let in. A permission question that
  // could not be answered is not a yes: a failed resolve is an empty map here.
  const reviews = permissionsByModule.get('customer_review_requests') ?? []
  const allowed = active && (
    reviews.some(p => p.actionKey === 'use' && p.allowed) ||
    reviews.some(p => p.actionKey === 'verify' && p.allowed)
  )

  useEffect(() => {
    if (!ready) return
    if (!userId) router.replace('/login')
    // The legacy test-card purge page exception is retired with the generated-review
    // frontend: /customer-reviews/<id> redirects to the landing page for everybody.
    else if (!allowed) router.replace('/coming-soon')
  }, [ready, userId, allowed, router])

  // `children` render in no state but allowed, so a child that fetches on
  // mount cannot start before the check finishes.
  if (!ready || !userId || !allowed) return <LoadingScreen />
  return <>{children}</>
}
