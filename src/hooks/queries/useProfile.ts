import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'

const PROFILE_COLUMNS = 'id, full_name, email, phone, role, team, is_active, created_at'
// usePermissionContext's key prefix, written out rather than imported: that file imports this one.
const PERMISSION_CONTEXT = 'permission-context'

async function readProfileRow(userId: string): Promise<UserProfile | null> {
  const { data } = await createClient()
    .from('users')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .single()
  return (data as UserProfile) ?? null
}

/**
 * One person's profile row. A module shell's usePermissionContext reads the same row and publishes
 * it into this cache entry, but on a full page load both start in the same render, so the row was
 * fetched twice. If that read is already on its way, wait for it instead of asking again.
 */
export async function loadProfile(
  qc: QueryClient,
  userId: string,
  read: (userId: string) => Promise<UserProfile | null> = readProfileRow,
): Promise<UserProfile | null> {
  const contextKey = [PERMISSION_CONTEXT, userId]
  if (qc.getQueryState(contextKey)?.fetchStatus === 'fetching') {
    // Checked and joined in the same tick, so this joins the running read and never starts one.
    const context = await qc
      .fetchQuery<{ profile: UserProfile | null }>({ queryKey: contextKey, staleTime: Infinity })
      .catch(() => null)
    if (context?.profile) return context.profile
  }
  return read(userId)
}

/** For a screen that loads its data in an effect: the cached row, or one read shared with useProfile. */
export function profileQueryOptions(qc: QueryClient, userId: string) {
  return {
    queryKey: profileKey(userId),
    queryFn: () => loadProfile(qc, userId),
    staleTime: 5 * 60 * 1000,
  }
}

/**
 * The cache entry for one user's profile row.
 *
 * Exported so usePermissionContext can publish into it: that hook reads the
 * same row with the same columns, and without a shared key the two would fetch
 * it twice on any screen that wanted both.
 */
export const profileKey = (userId: string | null | undefined) => ['profile', userId] as const

export function useProfile(userId: string | null | undefined) {
  const qc = useQueryClient()
  return useQuery<UserProfile | null>({
    queryKey: profileKey(userId),
    queryFn: () => (userId ? loadProfile(qc, userId) : Promise.resolve(null)),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000, // profile changes rarely
    gcTime: 10 * 60 * 1000,
  })
}
