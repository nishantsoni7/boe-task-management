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

/**
 * The one query-defaults object every route's QueryClient is built from.
 *
 * EXPORTED SO IT IS A TESTABLE FACT, not a claim in a comment. Requirement 5
 * ("Stop Finance from refreshing when returning from another browser tab")
 * depends on `refetchOnWindowFocus: false` holding globally — there is no
 * per-query override anywhere in the app (asserted by grep in
 * financeRefreshPolicy.test.ts) — so this object is the single place that
 * property can regress, and the single place a test can catch it doing so.
 */
export const DEFAULT_QUERY_OPTIONS = {
  // Data is considered fresh for 30 seconds — no refetch on window focus within this window
  staleTime: 30 * 1000,
  // Keep unused cache for 5 minutes so back-navigation feels instant
  gcTime: 5 * 60 * 1000,
  // Retry once on failure (network blip), not 3 times (default)
  retry: 1,
  // THE LOAD-BEARING LINE. React Query's own focus-refetch mechanism is
  // exactly the kind of automatic Finance refresh Requirement 5 forbids —
  // disabled globally, with no local override anywhere in the app.
  refetchOnWindowFocus: false,
} as const

export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per browser session — created once, never recreated on re-render
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: DEFAULT_QUERY_OPTIONS,
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
//
// THE DECISION IS A PURE FUNCTION (resolveAuthIdentityAction, below),
// EXPORTED, SO IT IS TESTABLE WITHOUT A DOM. This repo has no jsdom / testing
// library (src/lib/ui/modalDismissal.test.ts states why), so a live
// `visibilitychange` → GoTrueClient's internal auto-refresh → SIGNED_IN event
// sequence cannot be dispatched and observed directly. What can be proven is
// the thing that actually protects Finance from it: for a SIGNED_IN event
// naming the SAME user id already established (exactly what auth-js's
// `_recoverAndRefresh()` fires on every tab-return once a session exists and
// is not near expiry — see GoTrueClient.js `_onVisibilityChanged` /
// `_recoverAndRefresh`), this function returns `{ kind: 'ignore' }` — no
// cache clear, no invalidation, nothing. financeRefreshPolicy.test.ts asserts
// exactly that, for TOKEN_REFRESHED and for a same-identity SIGNED_IN alike.
export type AuthIdentityAction =
  | { kind: 'ignore' }
  | { kind: 'sign_out' }
  | { kind: 'adopt'; userId: string | null }
  | { kind: 'invalidate_identity' }
  | { kind: 'identity_changed'; userId: string | null }

export function resolveAuthIdentityAction(
  event: AuthChangeEvent,
  nextUserId: string | null,
  prev: { established: boolean; userId: string | null },
): AuthIdentityAction {
  // Same person, new access token. Nothing user-sensitive changed.
  if (event === 'TOKEN_REFRESHED') return { kind: 'ignore' }

  // Always drop everything: whatever is cached belongs to whoever just left.
  if (event === 'SIGNED_OUT') return { kind: 'sign_out' }

  if (event !== 'SIGNED_IN' && event !== 'USER_UPDATED') return { kind: 'ignore' }

  // First event of the tab's life and the seed has not landed yet. Adopt the
  // identity; there is no earlier user whose data could be lingering.
  if (!prev.established) return { kind: 'adopt', userId: nextUserId }

  if (nextUserId === prev.userId) {
    // Same identity. A SIGNED_IN here is session recovery — including the one
    // GoTrueClient fires on every tab-focus-return via _recoverAndRefresh —
    // and is ignored entirely: no cache clear, no invalidation, no refetch.
    //
    // A USER_UPDATED means the account record changed, so refresh the
    // identity-derived answer WITHOUT emptying the application cache — see
    // the caller for which two query keys that means.
    return event === 'USER_UPDATED' ? { kind: 'invalidate_identity' } : { kind: 'ignore' }
  }

  // A DIFFERENT USER in the same tab.
  return { kind: 'identity_changed', userId: nextUserId }
}

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
      const action = resolveAuthIdentityAction(event, session?.user?.id ?? null, {
        established: lastUserId.current !== undefined,
        userId: lastUserId.current ?? null,
      })

      switch (action.kind) {
        case 'ignore':
          return

        case 'sign_out':
          lastUserId.current = null
          queryClient.clear()
          return

        case 'adopt':
          lastUserId.current = action.userId
          return

        case 'invalidate_identity':
          // These two literals are the query keys defined in
          // src/hooks/queries/usePermissionContext.ts; they are written out
          // here rather than imported so that this root provider — which
          // every route loads — does not pull the resolution module's
          // dependencies into the bundle of routes that never ask for a
          // permission answer.
          void queryClient.invalidateQueries({ queryKey: ['permission-context'] })
          void queryClient.invalidateQueries({ queryKey: ['signed-in-user-id'] })
          return

        case 'identity_changed':
          // clear() is deliberately indiscriminate. Every cached entry —
          // profile, permissions, app_modules, nav counts, notification
          // counts, tasks, quotation capabilities, top tasks — was fetched as
          // the previous user, and enumerating those families by hand would
          // silently miss any query family added later. Dropping the lot
          // cannot miss one, and it is what returns the protected UI to its
          // unresolved, fail-closed state at once: with no cached data the
          // permission context reports ready=false, so ModuleGuard shows its
          // loading screen rather than the old user's module.
          lastUserId.current = action.userId
          queryClient.clear()
          return
      }
    })

    return () => {
      cancelled = true
      listener.data.subscription.unsubscribe()
    }
  }, [queryClient])

  return <>{children}</>
}
