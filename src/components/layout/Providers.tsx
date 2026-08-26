'use client'

import { ViewAsProvider } from '@/contexts/ViewAsContext'
import { RefreshProvider } from '@/contexts/RefreshContext'
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { clearPersistedUnreadCounts } from '@/lib/notificationCountCache'

export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per browser session — created once, never recreated on re-render
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is considered fresh for 30 seconds — no refetch on window focus within this window
            staleTime: 30 * 1000,
            // Keep unused cache for 5 minutes so back-navigation feels instant
            gcTime: 5 * 60 * 1000,
            // Retry once on failure (network blip), not 3 times (default)
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      {/* Owns the single auth listener for THIS QueryClient, and must sit
          inside the provider so useQueryClient() resolves to that instance. */}
      <AuthIdentityBoundary>
        <RefreshProvider>
          <ViewAsProvider>{children}</ViewAsProvider>
        </RefreshProvider>
      </AuthIdentityBoundary>
    </QueryClientProvider>
  )
}

// ── AuthIdentityBoundary ─────────────────────────────────────────────────────
//
// Exactly one auth listener, tied to the lifetime of this provider and to the
// QueryClient it actually owns.
//
// SCOPE. This watches identity and invalidates the cache. It deliberately does
// NOT resolve permissions: that lives in usePermissionContext and runs only for
// the screens that ask for it (/modules, ModuleGuard, DashboardLayout), so a
// route that needs no permission answer issues no permission request and the
// resolution's dependencies stay out of the root bundle every route loads.
//
// WHY NOT A MODULE-LEVEL LATCH. A `let attached = false` guard looks like it
// guarantees one subscription, but Fast Refresh re-evaluates the module and
// resets the flag, so the old subscription survives un-unsubscribed and a new
// one is added on top. It also captures whichever QueryClient happened to be
// first, which need not be the mounted one. Subscribing in an effect and
// returning Supabase's own unsubscribe fixes both.
//
// WHY NOT CLEAR ON EVERY `SIGNED_IN`. auth-js 2.106.1 emits SIGNED_IN from
// eleven call sites, including _recoverAndRefresh — ordinary recovery of an
// existing session out of storage, which happens on normal page loads and
// refreshes, not just at a real login. Clearing there would empty the cache in
// the exact situations this cache exists to serve, and every mounted query
// would refetch: a self-inflicted request storm.
//
// So the trigger is an IDENTITY CHANGE, not an event name. The last resolved
// user id is remembered and compared; only a genuine change — or a sign-out —
// drops anything.
function AuthIdentityBoundary({ children }: { children: ReactNode }) {
  // The client owned by the QueryClientProvider above, not a captured global.
  const queryClient = useQueryClient()

  // `undefined` = we have not established an identity yet; `null` = signed out.
  // The distinction matters: see the first-event branch below.
  const lastUserId = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    const supabase = createClient()
    let cancelled = false

    // Seed from the stored session (getSession is a LOCAL read — no request) so
    // that if the very first event we receive is somebody else signing in, we
    // recognise it as a change rather than adopting it silently and leaving the
    // previous user's data cached.
    void supabase.auth
      .getSession()
      .then((result: { data: { session: Session | null } }) => {
        if (!cancelled && lastUserId.current === undefined) {
          lastUserId.current = result.data.session?.user?.id ?? null
        }
      })

    // Not destructured: the browser client is created without generics, so this
    // call's return type widens to `any` and destructuring it would be an
    // implicit-any binding. Naming the shape we rely on keeps the cleanup typed.
    const listener: { data: { subscription: { unsubscribe: () => void } } } =
      supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      // Same person, new access token. Nothing user-sensitive changed.
      if (event === 'TOKEN_REFRESHED') return

      // Always drop everything: whatever is cached belongs to whoever just left.
      if (event === 'SIGNED_OUT') {
        lastUserId.current = null
        queryClient.clear()
        // The persisted badge counts outlive the tab, so clearing the in-memory
        // cache alone would leave the last person's numbers on disk. Their keys
        // carry a user id and so could never be READ for somebody else, but on
        // a shared device there is no reason to keep them at all.
        clearPersistedUnreadCounts()
        return
      }

      if (event !== 'SIGNED_IN' && event !== 'USER_UPDATED') return

      const nextUserId = session?.user?.id ?? null

      // First event of the tab's life and the seed has not landed yet. Adopt
      // the identity; there is no earlier user whose data could be lingering.
      if (lastUserId.current === undefined) {
        lastUserId.current = nextUserId
        return
      }

      if (nextUserId === lastUserId.current) {
        // Same identity. A SIGNED_IN here is session recovery — ignore it
        // entirely.
        //
        // A USER_UPDATED means the account record changed, so refresh the
        // identity-derived answer WITHOUT emptying the application cache: this
        // invalidates by key prefix, so ['permission-context', uid] and
        // ['signed-in-user-id'] refetch in the background while every consumer
        // keeps showing its last good answer. Tasks, notifications and every
        // other family are left alone — the same person's work has not changed.
        //
        // These two literals are the query keys defined in
        // src/hooks/queries/usePermissionContext.ts; they are written out here
        // rather than imported so that this root provider — which every route
        // loads — does not pull the resolution module's dependencies into the
        // bundle of routes that never ask for a permission answer.
        if (event === 'USER_UPDATED') {
          void queryClient.invalidateQueries({ queryKey: ['permission-context'] })
          void queryClient.invalidateQueries({ queryKey: ['signed-in-user-id'] })
        }
        return
      }

      // A DIFFERENT USER in the same tab.
      //
      // clear() is deliberately indiscriminate. Every cached entry — profile,
      // permissions, app_modules, nav counts, notification counts, tasks,
      // quotation capabilities, top tasks — was fetched as the previous user,
      // and enumerating those families by hand would silently miss any query
      // family added later. Dropping the lot cannot miss one, and it is what
      // returns the protected UI to its unresolved, fail-closed state at once:
      // with no cached data the permission context reports ready=false, so
      // ModuleGuard shows its loading screen rather than the old user's module.
      lastUserId.current = nextUserId
      queryClient.clear()
      clearPersistedUnreadCounts()
    })

    return () => {
      cancelled = true
      listener.data.subscription.unsubscribe()
    }
  }, [queryClient])

  return <>{children}</>
}
