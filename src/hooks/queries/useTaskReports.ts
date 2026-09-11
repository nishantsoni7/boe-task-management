import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import {
  applyTaskFilters, completedScopeFilters, createdTaskFilters, onOrAfter,
  rollingSince, withinRange, yesterdayRange,
  type CompletedScope, type CompletionSummary, type CreationReport, type TaskFilter,
} from '@/lib/tasks/taskReporting'

/**
 * One number from the database, and no rows. `head: true` makes PostgREST send
 * only the count, so a person with thousands of tasks costs the same as one
 * with none.
 *
 * A failed count REJECTS instead of resolving 0 — "you created nothing" is a
 * statement about somebody's work, and must never stand in for a failed request.
 */
async function countTasks(filters: readonly TaskFilter[]): Promise<number> {
  const { count, error } = await applyTaskFilters(
    createClient().from('tasks').select('id', { count: 'exact', head: true }),
    filters,
  )
  if (error) throw error
  return count ?? 0
}

/**
 * Dashboard: self and delegated tasks the EFFECTIVE user created in the last 7
 * and 30 days. Its own cache entry, never part of the Dashboard's loading gate.
 */
export function useTaskCreationReport(userId: string) {
  return useQuery<CreationReport>({
    queryKey: ['task-report', 'created', userId],
    enabled: isValidUUID(userId),
    queryFn: async () => {
      const now = new Date()
      const since7 = rollingSince(now, 7)
      const since30 = rollingSince(now, 30)
      const [self7, self30, delegated7, delegated30] = await Promise.all([
        countTasks(createdTaskFilters('self', userId, since7)),
        countTasks(createdTaskFilters('self', userId, since30)),
        countTasks(createdTaskFilters('delegated', userId, since7)),
        countTasks(createdTaskFilters('delegated', userId, since30)),
      ])
      return { self7, self30, delegated7, delegated30 }
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })
}

/** Completed yesterday (local calendar day), in the last 7 days and in the last 30. */
export function useCompletionSummary(scope: CompletedScope, userId: string) {
  return useQuery<CompletionSummary>({
    queryKey: ['task-report', 'completed', scope, userId],
    enabled: isValidUUID(userId),
    queryFn: async () => {
      const now = new Date()
      const base = completedScopeFilters(scope, userId)
      const [yesterday, last7, last30] = await Promise.all([
        countTasks([...base, ...withinRange('completed_at', yesterdayRange(now))]),
        countTasks([...base, ...onOrAfter('completed_at', rollingSince(now, 7))]),
        countTasks([...base, ...onOrAfter('completed_at', rollingSince(now, 30))]),
      ])
      return { yesterday, last7, last30 }
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  })
}
