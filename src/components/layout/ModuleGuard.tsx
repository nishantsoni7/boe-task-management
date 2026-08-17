'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'

// THE PARENT GATE, as a route guard.
//
// One component for every engine-gated module, so that "may this person open
// this module" is answered by the same function the launcher card asks —
// canAccessManagementModule — and the two can never drift. It is the generalised
// form of the guard src/app/orders/layout.tsx and src/app/meetings/layout.tsx
// already carried; those two keep their own files because each adds a
// module-specific clause (Meetings also accepts `manage`).
//
// WHAT IT IS AND IS NOT
//
// This is the UI half of the boundary, not the boundary itself. RLS is what
// actually refuses the data. What this adds is the guarantee the defect
// report asked for: the protected screen never mounts, so its queries never
// fire, for somebody whose module access is switched off.
//
// THREE THINGS THAT MATTER FOR CORRECTNESS
//
//   1. `children` is not rendered in any state except `allowed`. Returning
//      <LoadingScreen /> for both `checking` and `denied` is what prevents the
//      two flashes — protected content appearing for a frame before the
//      redirect lands, and the redirect target appearing before the check
//      finishes. A child that fetches on mount cannot start early because it
//      has not mounted.
//   2. The check reads the SIGNED-IN user, never the View As target. View As
//      shows an administrator what somebody else sees; it must not lend that
//      person's authority, and it must not take the administrator's away.
//   3. A failed profile read denies. An unidentified caller holding a stale
//      permission row is exactly the case that must not be admitted, which is
//      also why canAccessManagementModule fails closed on a null role.
export default function ModuleGuard({
  moduleKey,
  children,
  deniedRoute = '/coming-soon',
}: {
  moduleKey: string
  children: React.ReactNode
  /** Where an unauthorized employee lands. Every module uses the shared
   *  "not available" page, matching the Orders and Meetings guards. */
  deniedRoute?: string
}) {
  const router = useRouter()

  // The two reads this used to make itself — users.role, then
  // resolve_effective_permissions for one module — are now resolved once per
  // session for every module at a time and shared with /modules and
  // DashboardLayout. The decision below is unchanged: same inputs, same
  // function, same fail-closed defaults. What changed is that returning to this
  // route inside the cache window costs no round trip at all.
  const { ready, userId, role, permissionsByModule } = usePermissionContext()

  // An inactive or unregistered module makes the resolver return no rows at
  // all, so `permissions` is empty and the `view` test inside fails. That is
  // the correct answer, which is why `isModuleActive` is passed as true rather
  // than fetched separately: the engine has already applied it.
  const allowed =
    ready &&
    userId !== null &&
    canAccessManagementModule({
      role,
      moduleKey,
      isModuleActive: true,
      permissions: permissionsByModule.get(moduleKey) ?? [],
    })

  useEffect(() => {
    // Nothing is decided until the context has resolved. `ready` false reports
    // a null role and an empty permission map, which is indistinguishable from
    // a genuine denial — redirecting on it would bounce authorized people.
    if (!ready) return
    if (userId === null) { router.replace('/login'); return }
    if (!allowed) router.replace(deniedRoute)
  }, [ready, userId, allowed, router, deniedRoute])

  // Unchanged, and load-bearing: `children` render in no state but `allowed`.
  // A child that fetches on mount cannot start early because it has not
  // mounted, and the protected screen never appears for a frame before the
  // redirect lands.
  if (!allowed) return <LoadingScreen />
  return <>{children}</>
}
