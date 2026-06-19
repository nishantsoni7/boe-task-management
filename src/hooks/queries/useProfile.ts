import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'

const PROFILE_COLUMNS = 'id, full_name, email, phone, role, team, is_active, created_at'

export function useProfile(userId: string | null | undefined) {
  return useQuery<UserProfile | null>({
    queryKey: ['profile', userId],
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
