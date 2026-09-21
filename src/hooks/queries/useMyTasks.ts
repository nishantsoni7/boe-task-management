import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { perfStart } from '@/lib/perf'
import type { Task } from '@/lib/types'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

/**
 * Tasks assigned to a given user, excluding cancelled. Ordered by due date.
 *
 * ONE request serves every My Tasks tab: the page splits this collection with
 * buildMyTaskBuckets (src/lib/tasks/myTaskTabs.ts) rather than querying per
 * tab, which is why switching between already-loaded tabs issues nothing.
 *
 * Timed under `task.list.load`. Inert unless NEXT_PUBLIC_BOE_PERF_DEBUG=true —
 * see src/lib/perf.ts — and it records only the action name and a duration,
 * never a task title or an id. The action was already declared in PerfAction
 * but nothing measured it, so the one query behind the My Tasks first paint had
 * no local number attached to it.
 */
export function useMyTasks(userId: string | null | undefined) {
  return useQuery<Task[]>({
    queryKey: ['tasks', 'assigned-to', userId],
    queryFn: async () => {
      if (!userId) return []
      const done = perfStart('task.list.load')
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', userId)
          .neq('status', 'cancelled')
          .neq('task_type', 'quotation_request')
          .order('due_date', { ascending: true, nullsFirst: false })
        return ((data ?? []) as unknown as Task[])
      } finally {
        done()
      }
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

/**
 * Every user's display name, active or not — a lookup table, not a directory.
 *
 * WHY IT IS NOT `useUserNames(ids)` OR `useActiveUsers()`. The task drawer
 * resolves four different people from one row — the assignee, the creator,
 * whoever the task is waiting on, and the actor on the latest activity entry —
 * and any of them may have since been deactivated. A map keyed on the ids
 * currently listed would answer "Team member" or "Someone" for the rest, and
 * the active-user directory would lose the leavers.
 *
 * So this is the same unfiltered read Assigned By Me used to issue on every
 * single arrival, kept exactly as it was and simply cached: ten minutes,
 * because names change very rarely, which is the same window `useUserNames`
 * already uses for the identical reason.
 */
export function useAllUserNames() {
  return useQuery<Record<string, string>>({
    queryKey: ['user-names', 'all'],
    queryFn: async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('users')
        .select('id, full_name')
      const map: Record<string, string> = {}
      for (const u of data ?? []) map[u.id] = u.full_name
      return map
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}

/**
 * All active users — the one directory every task screen draws from.
 *
 * `team` IS PART OF IT because the assignee dropdowns render "Name — Team".
 * Both of them (Assign Task, and Delegate on Assigned By Me) already read this
 * hook and already printed that dash, with nothing after it, because the column
 * was not selected. Selecting it is what lets /tasks/create stop re-reading the
 * directory for itself on every visit.
 *
 * Ordered by name, so every dropdown that shares this entry is in the same
 * order without sorting it again.
 */
export function useActiveUsers() {
  return useQuery<{ id: string; full_name: string; team: string | null }[]>({
    queryKey: ['users', 'active'],
    queryFn: async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('users')
        .select('id, full_name, team')
        .eq('is_active', true)
        .order('full_name')
      return data ?? []
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}
