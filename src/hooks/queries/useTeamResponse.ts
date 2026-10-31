import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'
import { fetchTaskPeople } from '@/lib/tasks/taskPeople'
import {
  buildTeamResponse,
  type ResponseEvent, type ResponseTask, type TeamResponse,
} from '@/lib/tasks/teamResponse'

const TASK_COLUMNS =
  'id, title, status, assigned_to, created_at, due_date, last_update_at, completed_at, cancelled_at'

const EVENT_COLUMNS = 'id, task_id, actor_id, action, from_status, to_status, created_at'

/** Closed tasks stay in view this long: the longest window the bar reads back over. */
const CLOSED_TASK_DAYS = 45

/** Task ids per history request, so the query string stays a safe length. */
const IDS_PER_REQUEST = 100

/** Prefix for cache invalidation after a task on the list is approved or cancelled. */
export const TEAM_RESPONSE_KEY = ['tasks', 'team-response'] as const

/**
 * The Team response bar's reading of the tasks this user assigned.
 *
 * Separate from useAssignedByMe on purpose: that list holds open work only and
 * must paint at once, while this also needs closed tasks and their history. It
 * loads beside the list and a failure here costs the bar, never the list.
 *
 * Everything is read with the viewer's own session, so RLS keeps it to tasks they
 * created and it shows them nothing they could not already open. The one server
 * read is the name list, see src/lib/tasks/taskPeople.ts.
 */
export function useTeamResponse(userId: string | null | undefined) {
  return useQuery<TeamResponse>({
    queryKey: [...TEAM_RESPONSE_KEY, userId],
    queryFn: async () => {
      const supabase = createClient()
      const since = new Date(Date.now() - CLOSED_TASK_DAYS * 86_400_000).toISOString()

      const tasks = unwrapPagedRows('team response tasks', await fetchAllRows<ResponseTask>((from, to) =>
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('created_by', userId as string)
          .not('assigned_to', 'is', null)
          .neq('assigned_to', userId as string)
          .or(`status.not.in.(completed,cancelled),last_update_at.gte.${since},completed_at.gte.${since},cancelled_at.gte.${since}`)
          .order('id')
          .range(from, to) as unknown as PromiseLike<{ data: ResponseTask[] | null; error: { message: string } | null }>))

      const batches: string[][] = []
      for (let i = 0; i < tasks.length; i += IDS_PER_REQUEST) {
        batches.push(tasks.slice(i, i + IDS_PER_REQUEST).map(t => t.id))
      }
      const eventPages = await Promise.all(batches.map(async ids =>
        unwrapPagedRows('team response history', await fetchAllRows<ResponseEvent>((from, to) =>
          supabase
            .from('task_activity_log')
            .select(EVENT_COLUMNS)
            .in('task_id', ids)
            .order('id')
            .range(from, to) as unknown as PromiseLike<{ data: ResponseEvent[] | null; error: { message: string } | null }>))))

      const people = await fetchTaskPeople()
      return buildTeamResponse({
        tasks, events: eventPages.flat(), people,
        viewerId: userId as string,
        now: new Date(),
      })
    },
    enabled: isValidUUID(userId),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}
