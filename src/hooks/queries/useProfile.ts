import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'

const PROFILE_COLUMNS = 'id, full_name, email, phone, role, team, is_active, created_at'

/**
 * The cache entry for one user's profile row.
 *
 * Exported so usePermissionContext can publish into it: that hook reads the
 * same row with the same columns, and without a shared key the two would fetch
 * it twice on any screen that wanted both.
 */
export const profileKey = (userId: string | null | undefined) => ['profile', userId] as const

export function useProfile(userId: string | null | undefined) {
  return useQuery<UserProfile | null>({
    queryKey: profileKey(userId),
    queryFn: async () => {
      if (!userId) return null
      const supabase = createClient()
      const { data } = await supabase
        .from('users')
        .select(PROFILE_COLUMNS)
        .eq('id', userId)
        .single()
      return (data as UserProfile) ?? null
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000, // profile changes rarely
    gcTime: 10 * 60 * 1000,
  })
}
