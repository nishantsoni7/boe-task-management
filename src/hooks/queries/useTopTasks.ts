import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import type { Task } from '@/lib/types'

const TOP_TASK_SELECT = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'task_type', 'customer_name', 'contact_number', 'company_name', 'city_project',
].join(', ')

export type TopTasksData = {
  /** All stored pin IDs — normally active because status transitions clean stale pins */
  pinnedIds: Set<string>
  /** Actionable pinned tasks in display_order */
  tasks: Task[]
}

export function useTopTasks(userId: string | null | undefined) {
  return useQuery<TopTasksData>({
    queryKey: ['top-tasks', userId],
    queryFn: async () => {
      if (!userId) return { pinnedIds: new Set<string>(), tasks: [] }
      const supabase = createClient()

      // Step 1: pinned task IDs in display order
      const { data: pins } = await supabase
        .from('user_top_tasks')
        .select('task_id, display_order')
        .eq('user_id', userId)
        .order('display_order', { ascending: true })

      if (!pins || pins.length === 0) return { pinnedIds: new Set<string>(), tasks: [] }

      const orderedIds = (pins as { task_id: string }[]).map(p => p.task_id)
      const pinnedIds  = new Set(orderedIds)

      // Step 2: fetch tasks that still require action from this user. A task
      // submitted for approval belongs with its approver, not in the assignee's
      // Top 3 Focus. The database trigger removes that pin transactionally;
      // this filter also keeps the dashboard correct during cache/deploy skew.
      const { data: taskData } = await supabase
        .from('tasks')
        .select(TOP_TASK_SELECT)
        .in('id', orderedIds)
        .not('status', 'eq', 'completed')
        .neq('status', 'cancelled')
        .neq('status', 'pending_approval')

      // Maintain display_order from pins
      const taskMap = new Map(
        ((taskData ?? []) as unknown as Task[]).map(t => [t.id, t])
      )
      const tasks = orderedIds
        .map(id => taskMap.get(id))
        .filter((t): t is Task => !!t)

      return { pinnedIds, tasks }
    },
    enabled: isValidUUID(userId),
    staleTime: 15 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}
