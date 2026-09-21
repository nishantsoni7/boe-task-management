import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { perfStart } from '@/lib/perf'
import { fetchAllRows } from '@/lib/supabasePaging'
import type { Task } from '@/lib/types'

/**
 * Columns the Quotation Requests list renders. Lives with the query rather than
 * with the page so the two cannot drift.
 */
const QTN_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type', 'task_type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'customer_name', 'contact_number', 'company_name', 'city_project',
].join(', ')

/** Prefix used for cache invalidation after a quotation task is mutated. */
export const QUOTATION_REQUESTS_KEY = ['tasks', 'quotation-requests'] as const

export const quotationRequestsKey = (userId: string | null | undefined) =>
  [...QUOTATION_REQUESTS_KEY, userId] as const

/**
 * A complete read, or an explicit statement that it was not complete.
 *
 * `complete: false` carries the rows it did get so nothing crashes, but the page
 * must show its load error rather than present them as the whole workload — see
 * the tab counts note in the page.
 */
export type QuotationRequestsResult = { rows: Task[]; complete: boolean }

/**
 * Every quotation request the user raised or owns.
 *
 * WHY THIS IS A CACHED QUERY AND NOT A `useEffect`.
 *
 * This list is what the user comes back to from a quotation's detail page, and
 * it used to re-read itself from scratch on every arrival — behind a full-screen
 * LoadingScreen, so Back blanked the page until two sequential round trips had
 * finished. It now shares the QueryClient's ordinary list settings (the same
 * 30s/5min as useMyTasks), so a return inside the stale window paints from cache
 * with no request at all.
 *
 * STALENESS IS HANDLED BY INVALIDATION, NOT BY A SHORT WINDOW. Task Detail's
 * `invalidateTaskCache` marks this key stale after any mutation, so a return
 * that follows a real change paints the cached rows immediately and refetches
 * behind them — the row the user just changed corrects itself within one round
 * trip instead of holding the whole page blank for one.
 *
 * PAGED, because PostgREST truncates silently at 1000 rows — a cap, not an error
 * (src/lib/supabasePaging.ts). Quotation requests accumulate and this list is
 * ordered newest-first, so past a thousand the oldest would stop appearing with
 * nothing to show for it. The whole set is held in memory because the tabs,
 * counts and search on this page all work over it.
 *
 * The secondary sort on `id` is required for stable paging: range() maps to
 * LIMIT/OFFSET, which promises nothing about row order unless the ordering is
 * unique.
 *
 * Timed under `task.list.load`, like useMyTasks. Inert unless
 * NEXT_PUBLIC_BOE_PERF_DEBUG=true — see src/lib/perf.ts — and it records only
 * the action name and a duration, never a customer name or an id.
 *
 * `enabled` is the GATE, and it is load-bearing: the page passes
 * `canViewQuotations` here so a direct URL never fetches a row it may not show.
 * That ordering is the same one the previous inline version kept by awaiting the
 * permission resolve first.
 */
export function useQuotationRequests(
  userId: string | null | undefined,
  allowed: boolean,
) {
  return useQuery<QuotationRequestsResult>({
    queryKey: quotationRequestsKey(userId),
    queryFn: async () => {
      const done = perfStart('task.list.load')
      try {
        const supabase = createClient()
        const result = await fetchAllRows<Task>((from, to) => supabase
          .from('tasks')
          .select(QTN_COLUMNS)
          .eq('task_type', 'quotation_request')
          .or(`assigned_to.eq.${userId},created_by.eq.${userId}`)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to))

        // A FAILED READ IS NOT AN EMPTY WORKLOAD. The tab counts are computed
        // from these rows, so silently accepting a partial answer would
        // understate somebody's outstanding work rather than merely showing a
        // short list. Returned rather than thrown so a blip cannot replace a
        // good cached list with nothing.
        if (!result.ok) return { rows: [], complete: false }
        return { rows: result.rows as unknown as Task[], complete: !result.truncated }
      } finally {
        done()
      }
    },
    enabled: allowed && isValidUUID(userId),
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}
