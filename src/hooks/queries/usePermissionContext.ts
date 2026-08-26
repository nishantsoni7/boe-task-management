'use client'

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { profileKey } from '@/hooks/queries/useProfile'
import { getEffectivePermissionsForUser } from '@/lib/permissions/resolver'
import type { UserProfile } from '@/lib/types'
import type { EffectivePermission } from '@/lib/permissions/types'

// ── ONE permission resolution per signed-in user, per session ────────────────
//
// WHAT THIS REPLACES. The same three facts — who is signed in, what their role
// is, and what the permission engine grants them — were resolved three separate
// times on a single Task Management page load:
//
//   ModuleGuard        getSession + users.role + resolve_effective_permissions
//   DashboardLayout    auth.getUser() (a NETWORK call) + users.role
//                      + resolve_effective_permissions   ← identical to the above
//   /modules           getSession + users(profile) + resolve_..._for_user
//
// None of them cached, so every /modules → /dashboard → /modules round trip
// paid for all of it again.
//
// HOW IT IS SHARED. Not through a React context provider — through the query
// cache. All three callers use this hook, so all three hit the identical
// uid-keyed query key; React Query deduplicates concurrent callers into one
// request and serves the rest from cache for the 30s stale window.
//
// That matters for more than tidiness: because the resolution lives here and
// not in the root provider, a route that never asks for a permission answer
// never issues the request, and the resolver/Supabase dependencies stay out of
// the bundle that every route loads. Hoisting this into Providers was measured
// and reverted — it recovered ~1.9 KB on guarded routes while adding ~4 KB to
// every route and firing permission requests on pages that had no use for them.
//
// WHAT IT DOES NOT CHANGE. It calls the same resolver as before and applies no
// rule of its own. resolve_effective_permissions_for_user (20260661) and
// resolve_effective_permissions (20260660) run the identical precedence merge —
// Employee Override > Department > Role > System Default — and both filter
// permission_modules.is_active, so a module that is inactive yields no rows from
// either. Reading every module in one round trip instead of one module per round
// trip is therefore a transport change, not an authorization change.
//
// CACHE INVALIDATION lives in src/components/layout/Providers.tsx, which owns
// the QueryClient and the single auth listener. It drops the whole cache on a
// genuine identity change or a sign-out, ignores repeated SIGNED_IN events for
// the same user, and invalidates the two query keys below — by name — when a
// USER_UPDATED arrives for the same user. Those key literals are duplicated
// there on purpose; see the comment at that call site.
//
// ── THE THREE CORRECTNESS RULES ─────────────────────────────────────────────
//
// 1. THE SIGNED-IN USER, ALWAYS. This resolves the real caller and nothing else.
//    View As is a preview of somebody else's screen; it must not lend that
//    person's authority nor take the administrator's away. Callers that want the
//    VIEWED user's data must ask for it separately — see the View As branch kept
//    in DashboardLayout.
//
// 2. FAIL CLOSED, AND INDEPENDENTLY. The profile read and the permission read
//    are separate awaits and each degrades on its own, exactly as the code they
//    replace did:
//      · profile read fails  → role null → canAccessManagementModule denies
//                              everyone, admins included.
//      · permission RPC fails → empty map → non-admins denied; an admin still
//                              passes on the role short-circuit alone.
//
// 3. `ready` IS NOT `allowed`. A caller must render neither protected content
//    nor a denial until `ready` is true. An unresolved context reports role null
//    and an empty permission map — which reads as "denied" — so treating
//    pending as an answer would flash the wrong screen in both directions.

const NO_PERMISSIONS: ReadonlyMap<string, readonly EffectivePermission[]> = new Map()

/** Same column list as useProfile, so the two never disagree about a field. */
const PROFILE_COLUMNS = 'id, full_name, email, phone, role, team, is_active, created_at'

export const PERMISSION_STALE_MS = 30_000
export const PERMISSION_GC_MS = 5 * 60 * 1000

export type PermissionContext = {
  /** False while either half is still resolving. Never render an access
   *  decision — grant OR denial — while this is false. */
  ready: boolean
  /** The SIGNED-IN user. Null once ready means no session: send them to /login. */
  userId: string | null
  /** The signed-in user's own profile row. Null if the read failed. */
  profile: UserProfile | null
  /** Convenience accessor for profile.role. Null fails closed. */
  role: string | null
  /** Effective permissions for every active module, keyed by module_key. */
  permissionsByModule: ReadonlyMap<string, readonly EffectivePermission[]>
}

/**
 * The signed-in user's id, read from the local session.
 *
 * getSession() reads the stored session rather than calling the auth server, so
 * this costs no round trip — the same call /modules, ModuleGuard and the
 * dashboard page each already made. It replaces DashboardLayout's auth.getUser(),
 * which did make a network call; the freshness that call was there to guarantee
 * is now provided by the auth listener in Providers, which drops the cache the
 * moment the signed-in identity changes.
 */
/**
 * EXPORTED because identity alone is a much smaller question than authority.
 *
 * A screen that only needs to know WHO is signed in — the Notifications page,
 * My Tasks — must not pull the permission resolution in behind it. On a route
 * whose shell already resolves permissions (anything under a ModuleGuard, or
 * inside DashboardLayout) that would be free; on the module notification pages
 * that have neither, it would be a `resolve_effective_permissions_for_user`
 * RPC on cold load that those pages never used to make. So they take this, and
 * read the profile through useProfile.
 */
export function useSignedInUserId() {
  return useQuery<string | null>({
    // Key mirrored in Providers.tsx for USER_UPDATED invalidation.
    queryKey: ['signed-in-user-id'],
    queryFn: async () => {
      const { data: { session } } = await createClient().auth.getSession()
      return session?.user?.id ?? null
    },
    staleTime: PERMISSION_STALE_MS,
    gcTime: PERMISSION_GC_MS,
  })
}

export function usePermissionContext(): PermissionContext {
  const { data: userId, isPending: idPending } = useSignedInUserId()
  const qc = useQueryClient()

  const { data, isPending: contextPending } = useQuery({
    // Scoped by user id: user B cannot address user A's entry even before the
    // listener in Providers has cleared it. Prefix mirrored in Providers.tsx.
    queryKey: ['permission-context', userId ?? null],
    // Waits for the id rather than firing with `undefined` and re-keying.
    enabled: !idPending,
    queryFn: async () => {
      // No session. Resolved, not pending, and denies everything — no round trip.
      if (!userId) {
        return { profile: null as UserProfile | null, permissionsByModule: NO_PERMISSIONS }
      }

      const supabase = createClient()

      // Independent failure, per rule 2.
      const [profileResult, permissionsByModule] = await Promise.all([
        supabase.from('users').select(PROFILE_COLUMNS).eq('id', userId).single(),
        // A permissions failure must NOT take an admin's access away: they pass
        // on the role short-circuit alone, exactly as before. So this half
        // degrades to an empty map rather than failing the whole query.
        getEffectivePermissionsForUser(supabase, userId).catch(
          () => new Map<string, EffectivePermission[]>(),
        ),
      ])

      // WHY THIS ONE REJECTS INSTEAD OF DEGRADING.
      //
      // A failed profile read means role null, and role null denies everyone —
      // which is the right answer the FIRST time we ask, and is what the code
      // this replaces did. But this query also refetches in the background
      // after 30s, and returning a fail-closed object there would overwrite a
      // good cached answer with a denial and bounce a signed-in admin to
      // /coming-soon because of one blipped request.
      //
      // Rejecting instead gets both: React Query keeps the last good data on a
      // refetch failure, so a blip changes nothing; and on a FIRST resolution
      // there is no previous data, so `data` is undefined, role reads null and
      // the caller still denies. Fail-closed when we have never known, stable
      // when we already do.
      if (profileResult.error) throw profileResult.error

      const profile = (profileResult.data as UserProfile | null) ?? null

      // ONE ROW, ONE CACHE ENTRY.
      //
      // This read and useProfile's are the same `users` row with the same
      // column list, under two different query keys — so a screen that asked
      // for the profile after a shell had already resolved it used to fetch it
      // again. Publishing the row here makes the second reader a cache hit for
      // useProfile's 5-minute stale window, and makes it impossible for the two
      // to show different names for the same person.
      //
      // Publish only, never subscribe: this cannot make useProfile fetch
      // anything, so a route that resolves permissions gains nothing to pay for
      // and a route that does not is completely unaffected.
      publishProfile(qc, userId, profile)

      return {
        profile,
        permissionsByModule: permissionsByModule as ReadonlyMap<string, readonly EffectivePermission[]>,
      }
    },
    staleTime: PERMISSION_STALE_MS,
    gcTime: PERMISSION_GC_MS,
  })

  const profile = data?.profile ?? null

  return {
    ready: !idPending && !contextPending,
    userId: userId ?? null,
    profile,
    role: profile?.role ?? null,
    permissionsByModule: data?.permissionsByModule ?? NO_PERMISSIONS,
  }
}

/**
 * Write a resolved profile into useProfile's cache entry.
 *
 * `setQueryData` also stamps `dataUpdatedAt`, which is what makes a subsequent
 * useProfile mount treat the row as fresh and skip its request. A null profile
 * is not published: "the read failed" and "this person has no row" are not the
 * same answer, and useProfile should be free to ask for itself.
 */
function publishProfile(qc: QueryClient, userId: string, profile: UserProfile | null): void {
  if (!profile) return
  qc.setQueryData(profileKey(userId), profile)
}
