import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { allUserNamesQueryOptions } from '@/hooks/queries/useMyTasks'
import { fetchAllRows } from '@/lib/supabasePaging'
import type { Task } from '@/lib/types'
import {
  applyTaskFilters, completedListFilters, completedPageRange, completedScopeFilters, counterpartColumn,
  type CompletedListFilters, type CompletedScope,
} from '@/lib/tasks/taskReporting'

const COMPLETED_TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'completed_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

export type CompletedTaskPage = {
  tasks: Task[]
  /** Every task matching the filters, counted by the database — not this page's length. */
  total: number
}

/**
 * One page of Completed history and its exact total, in a single request.
 *
 * ORDER. Newest completion first, then `id` — range() is LIMIT/OFFSET, which
 * promises nothing between two requests unless the ordering is unique, so two
 * tasks completed in the same instant could otherwise swap across a page
 * boundary. A task completed before completed_at was recorded sorts last.
 *
 * PLACEHOLDER. While the next page loads, the previous page stays on screen —
 * but only for the same person and list. Switching identity (View As) must never
 * show one employee's rows while another's are fetched.
 */
export function useCompletedTaskPage(
  scope: CompletedScope,
  userId: string,
  filters: CompletedListFilters,
  page: number,
) {
  const q = filters.q.trim()
  return useQuery<CompletedTaskPage>({
    queryKey: ['tasks', 'completed', scope, userId, filters.counterpart, filters.priority, q, filters.completedOn, page],
    enabled: isValidUUID(userId),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === scope && previousQuery?.queryKey[3] === userId ? previous : undefined,
    queryFn: async () => {
      const { from, to } = completedPageRange(page)
      const { data, count, error } = await applyTaskFilters(
        createClient().from('tasks').select(COMPLETED_TASK_COLUMNS, { count: 'exact' }),
        completedListFilters(scope, userId, { ...filters, q }),
      )
        .order('completed_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(from, to)

      // A failed read rejects: it must never be cached as an empty archive.
      if (error) throw error
      return { tasks: (data ?? []) as unknown as Task[], total: count ?? 0 }
    },
    // Completing or reopening a task elsewhere must show here on the next visit.
    staleTime: 0,
    gcTime: 5 * 60_000,
  })
}

/**
 * Everyone on the other side of this archive — assigners on My Tasks, assignees
 * on Assigned By Me — for the filter dropdown. One uuid column, read in pages
 * through the shared helper so PostgREST's 1000-row cap cannot drop anybody.
 */
export function useCompletedCounterparts(scope: CompletedScope, userId: string) {
  const column = counterpartColumn(scope)
  return useQuery<string[]>({
    queryKey: ['task-report', 'completed-counterparts', scope, userId],
    enabled: isValidUUID(userId),
    queryFn: async () => {
      const supabase = createClient()
      const result = await fetchAllRows<Record<string, string | null>>((from, to) =>
        applyTaskFilters(supabase.from('tasks').select(column), completedScopeFilters(scope, userId))
          .order('id', { ascending: false })
          .range(from, to))
      if (!result.ok) throw new Error(result.error)
      return [...new Set(result.rows.map(row => row[column]).filter((id): id is string => !!id))]
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })
}

/** Every user's display name, deactivated people included. See allUserNamesQueryOptions. */
export function useUserNames() {
  return useQuery<Record<string, string>>(allUserNamesQueryOptions())
}
