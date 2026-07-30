'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { isTaskManagementRoute } from '@/lib/performanceAdoption'

/**
 * Once per browser session, tell the server the user has opened Task Management.
 *
 * Kept intentionally boring. This is not analytics: one POST per page-load
 * session, no navigation tracking, no timers, no payload beyond the path.
 *
 * The three guards, in order:
 *
 *   1. `reported` is module-level, so a route change inside the app does not fire
 *      it again. Client-side navigation keeps the module alive, which is exactly
 *      the lifetime we want — one report per time someone actually opens the app.
 *   2. The route must be a Task Management page. A Performance page does not
 *      count; checking the adoption metric must not satisfy it.
 *   3. The database's unique constraint on (user_id, business_date) is the real
 *      guarantee. A hard refresh, a second tab or a second device resets the
 *      module flag, and the constraint absorbs all of them — only the first open
 *      of the day survives.
 *
 * The server decides both the user (from the bearer token, so View As records the
 * admin rather than the viewed employee) and the IST business date. Nothing here
 * reads the device clock.
 *
 * Failure is silent by design. This must never delay a render or surface an
 * error: adoption is a supplementary metric, and a page that breaks because it
 * could not be recorded would be a strictly worse outcome than a missing metric.
 */
let reported = false

/** Test seam — lets a test reset the once-per-session latch. */
export function resetAppOpenReporting() {
  reported = false
}

export function useRecordAppOpen(enabled: boolean) {
  const pathname = usePathname()

  useEffect(() => {
    if (!enabled) return
    if (reported) return
    if (!pathname || !isTaskManagementRoute(pathname)) return

    // Latch before the await: two effects firing in the same tick must not both
    // issue a request.
    reported = true

    void (async () => {
      try {
        const { data } = await createClient().auth.getSession()
        const token = data.session?.access_token
        if (!token) { reported = false; return }   // not signed in yet — try again later

        await fetch('/api/performance/app-open', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ route: pathname }),
          keepalive: true,
        })
      } catch {
        // Swallowed on purpose. Nothing on the page depends on this succeeding.
      }
    })()
  }, [enabled, pathname])
}
