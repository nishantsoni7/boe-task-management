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

/** One pin and, embedded, its task. `tasks` is null when the task is filtered out of Top 3. */
export type TopTaskPinRow = { task_id: string; display_order: number; tasks: Task | null }

/**
 * The pins as they came back (already in display_order) into the hook's shape.
 *
 * `pinnedIds` is EVERY stored pin, whether or not its task still qualifies;
 * `tasks` is only the pins whose task survived the status filter, in the same
 * order. That is exactly what the two separate reads gave before.
 */
export function shapeTopTasks(rows: readonly TopTaskPinRow[]): TopTasksData {
  return {
    pinnedIds: new Set(rows.map(r => r.task_id)),
    tasks: rows.flatMap(r => (r.tasks ? [r.tasks] : [])),
  }
}

export function useTopTasks(userId: string | null | undefined) {
  return useQuery<TopTasksData>({
    queryKey: ['top-tasks', userId],
    queryFn: async () => {
      if (!userId) return { pinnedIds: new Set<string>(), tasks: [] }
      const supabase = createClient()

      // ONE request: the pins in display order, each with its task embedded
      // (user_top_tasks.task_id -> tasks.id). It used to be two requests, one
      // after the other, so Top 3 landed a whole round trip after the list.
      //
      // Only tasks that still require action from this user. A task submitted
      // for approval belongs with its approver, not in the assignee's Top 3
      // Focus. The database trigger removes that pin transactionally; this
      // filter also keeps the dashboard correct during cache/deploy skew. The
      // filters sit on the EMBEDDED task (no `!inner`), so a pin whose task no
      // longer qualifies still comes back, with `tasks: null`, and still counts
      // in `pinnedIds`. Row access is the same as before: the caller's own
      // JWT, user_top_tasks_select then the tasks policy.
      const { data, error } = await supabase
        .from('user_top_tasks')
        .select(`task_id, display_order, tasks!task_id(${TOP_TASK_SELECT})`)
        .eq('user_id', userId)
        .not('tasks.status', 'eq', 'completed')
        .neq('tasks.status', 'cancelled')
        .neq('tasks.status', 'pending_approval')
        .order('display_order', { ascending: true })

      // A failed read rejects: it must not be cached as "nothing is pinned".
      if (error) throw error

      return shapeTopTasks((data ?? []) as unknown as TopTaskPinRow[])
    },
    enabled: isValidUUID(userId),
    staleTime: 15 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}
