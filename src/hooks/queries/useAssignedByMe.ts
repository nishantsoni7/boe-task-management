import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { perfStart } from '@/lib/perf'
import type { Task } from '@/lib/types'

/**
 * Columns the Assigned By Me list renders. Lives with the query rather than
 * with the page so the two cannot drift.
 */
const ASSIGNED_BY_ME_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

/** Prefix used for cache invalidation after a task this user delegated changes. */
export const ASSIGNED_BY_ME_KEY = ['tasks', 'assigned-by'] as const

export const assignedByMeKey = (userId: string | null | undefined) =>
  [...ASSIGNED_BY_ME_KEY, userId] as const

/**
 * The open work this user has handed to somebody else.
 *
 * WHY THIS IS A CACHED QUERY AND NOT A `useEffect`.
 *
 * This is the list a delegated task is opened from, and it used to re-read
 * itself from scratch on every arrival — behind a full-screen LoadingScreen, so
 * a Back press blanked the whole module shell until an auth hop and two round
 * trips had finished. The very same shape /tasks/quotation-requests was in
 * before #181, and /tasks/my before it.
 *
 * Three costs are gone. The mount-time `supabase.auth.getSession()` the page
 * awaited before it could name its own user: useSignedInUserId answers that
 * from the stored session with no request, on the FIRST render, so the read
 * starts immediately instead of second in a chain. The unfiltered `users`
 * read beside it: assignee names now come from useUserNames, cached for ten
 * minutes because names change very rarely. And the read itself, which now
 * shares the QueryClient's ordinary list settings — the same 30s/5min as
 * useMyTasks — so a return inside the stale window issues nothing at all and
 * the cached rows are on screen in the first frame.
 *
 * STALENESS IS HANDLED BY INVALIDATION, NOT BY A SHORT WINDOW. Task Detail's
 * `invalidateTaskCache` marks this key after any mutation, and /tasks/create
 * marks it after delegating a new one, so a return that follows a real change
 * paints the cached rows immediately and refetches behind them.
 *
 * THE FILTERS ARE THE PAGE'S OLD ONES, UNCHANGED: tasks this user created, that
 * are assigned to somebody who is not them, and that are neither completed nor
 * cancelled — completed and cancelled have their own archive pages. Quotation
 * requests are deliberately NOT excluded here, because they never were: a
 * quotation raised for somebody else is work this user is owed, and it is
 * listed as such. Ordering is by due date, nullsFirst false, as before.
 *
 * Timed under `task.list.load`, like useMyTasks and useQuotationRequests. Inert
 * unless NEXT_PUBLIC_BOE_PERF_DEBUG=true — see src/lib/perf.ts — and it records
 * only the action name and a duration, never a task title or an id.
 */
export function useAssignedByMe(userId: string | null | undefined) {
  return useQuery<Task[]>({
    queryKey: assignedByMeKey(userId),
    queryFn: async () => {
      const done = perfStart('task.list.load')
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('tasks')
          .select(ASSIGNED_BY_ME_COLUMNS)
          .eq('created_by', userId)
          .not('assigned_to', 'is', null)
          .neq('assigned_to', userId)
          .neq('status', 'completed')
          .neq('status', 'cancelled')
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
