import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import type { Task } from '@/lib/types'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

/** Tasks assigned to a given user, excluding cancelled. Ordered by due date. */
export function useMyTasks(userId: string | null | undefined) {
  return useQuery<Task[]>({
    queryKey: ['tasks', 'assigned-to', userId],
    queryFn: async () => {
      if (!userId) return []
      const supabase = createClient()
      const { data } = await supabase
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('assigned_to', userId)
        .neq('status', 'cancelled')
        .order('due_date', { ascending: true, nullsFirst: false })
      return ((data ?? []) as unknown as Task[])
    },
    enabled: isValidUUID(userId),
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}

/** Creator names for a list of user IDs. */
export function useUserNames(userIds: string[]) {
  const sortedIds = [...userIds].sort().join(',')
  return useQuery<Record<string, string>>({
    queryKey: ['user-names', sortedIds],
    queryFn: async () => {
      if (!userIds.length) return {}
      const supabase = createClient()
      const { data } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', userIds)
      const map: Record<string, string> = {}
      for (const u of data ?? []) map[u.id] = u.full_name
      return map
    },
    enabled: userIds.length > 0,
    staleTime: 10 * 60 * 1000, // names change very rarely
    gcTime: 30 * 60 * 1000,
  })
}

/** All active users (for admin/manager views). */
export function useActiveUsers() {
  return useQuery<{ id: string; full_name: string }[]>({
    queryKey: ['users', 'active'],
    queryFn: async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('users')
        .select('id, full_name')
        .eq('is_active', true)
      return data ?? []
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}
