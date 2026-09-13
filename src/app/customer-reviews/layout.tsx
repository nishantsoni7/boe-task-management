'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
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

// ONE CARD'S PAGE, and nothing else in the module: the only place an
// administrator without `use` or `verify` may be let in, to permanently delete
// an internal test record. See the exception below.
const PURGE_PAGE = /^\/customer-reviews\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/

export default function CustomerReviewsGuard({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  /** Admitted by the purge exception alone, so confined to one card's page. */
  const [purgeOnly, setPurgeOnly] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      // ONLY is_active IS READ. The role column is not selected, so entry
      // cannot be decided by it here or by a later edit to this file.
      const { data: profile } = await supabase
        .from('users')
        .select('is_active')
        .eq('id', session.user.id)
        .single()

      // A failed profile read denies. An unidentified caller holding a stale
      // permission row is exactly the case that must not be admitted.
      if (!profile || profile.is_active !== true) { router.replace('/coming-soon'); return }

      // ENTRY IS `use` OR `verify`, RESOLVED — and nothing else.
      //
      // `profile.role === 'admin' ||` used to lead this expression, and being
      // first it short-circuited: an administrator with both permissions
      // revoked was let into a module where every list is empty and every
      // action refused. The engine decides now, so revoking both genuinely
      // closes the door.
      //
      // Both catches deny rather than admit. A permission question that could
      // not be answered is not a yes.
      const allowed =
        (await hasPermission(supabase, session.user.id, 'customer_review_requests', 'use').catch(() => false)) ||
        (await hasPermission(supabase, session.user.id, 'customer_review_requests', 'verify').catch(() => false))

      if (!allowed) {
        // THE ONE EXCEPTION, AND IT IS ONE PAGE. The database says whether this
        // person may permanently delete internal test records; nothing here
        // decides it. If so, a single card's page opens — and that page shows
        // them the purge and nothing else. An unanswered question denies.
        const purgeAllowed = PURGE_PAGE.test(pathname ?? '')
          && (await supabase.rpc('can_purge_customer_review_test_cards').then(({ data }: { data: unknown }) => data === true, () => false))
        if (!purgeAllowed) {
          router.replace('/coming-soon')
          return
        }
        setPurgeOnly(true)
      }

      setAuthorized(true)
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Admitted for the purge alone, the person stays on that one card's page.
  const outsidePurgePage = purgeOnly && !PURGE_PAGE.test(pathname ?? '')
  useEffect(() => {
    if (outsidePurgePage) router.replace('/coming-soon')
  }, [outsidePurgePage, router])

  // `children` render in no state but `authorized`, so a child that fetches on
  // mount cannot start before the check finishes.
  if (!authorized) return <LoadingScreen />
  if (outsidePurgePage) return <LoadingScreen />
  return <>{children}</>
}
