'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
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
//   2. The check reads the DISPLAY SUBJECT — the signed-in user normally, the
//      viewed employee while View As is active. View As exists to show an
//      administrator what somebody else sees, so a module that employee does
//      not hold must not be reachable inside the preview. This lends the admin
//      nothing and takes nothing from them: authority is decided on the server
//      from their own session, and Exit View Mode returns their screen.
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

  // WHOSE MODULE LIST DECIDES? The DISPLAY SUBJECT's — which outside View As is
  // the signed-in user, so nothing changes for an ordinary session.
  //
  // While previewing, this answers the employee's question ("would Dhruv have
  // this module?") rather than the admin's, so a module the employee does not
  // hold is not silently reachable just because the person previewing them is an
  // administrator. The admin's own authority is not lost either: they are one
  // click of Exit View Mode away from their own screen, and the SERVER never
  // consulted this component in the first place.
  //
  // This is the UI half of the boundary and it stays the UI half. RLS and each
  // route's own server checks refuse the DATA, and they read the real caller —
  // so narrowing a preview here cannot weaken anything, and widening it could
  // not have granted anything.
  const { ready, actorUserId: userId, subjectRole: role, subjectPermissionsByModule: permissionsByModule }
    = useDisplaySubject()

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
