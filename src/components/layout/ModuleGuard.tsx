'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
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
  const [state, setState] = useState<'checking' | 'allowed' | 'denied'>('checking')
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    let active = true

    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: profile } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .single()

      // An inactive or unregistered module makes the resolver return no rows at
      // all, so `permissions` is empty and the `view` test below fails. That is
      // the correct answer, which is why `isModuleActive` is passed as true
      // rather than fetched separately: the engine has already applied it.
      const permissions = await getEffectivePermissions(
        supabase,
        session.user.id,
        moduleKey,
      ).catch(() => [])

      const allowed = canAccessManagementModule({
        role: profile?.role ?? null,
        moduleKey,
        isModuleActive: true,
        permissions,
      })

      if (!active) return

      if (!allowed) {
        setState('denied')
        router.replace(deniedRoute)
        return
      }

      setState('allowed')
    }

    check()

    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey])

  if (state !== 'allowed') return <LoadingScreen />
  return <>{children}</>
}
