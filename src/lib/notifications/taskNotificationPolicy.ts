// Task Management events that are deliberately NOT announced.
//
// Two business rules (September 2026, docs/BOE Master Context/05_Business_Rules.md
// → NOTIFICATION RULES):
//
//   QUOTATION REQUESTS ARE SILENT. A quotation request is a task whose
//   `task_type` is 'quotation_request' — the column, never its title. Nothing
//   that happens to one writes a notification: not its creation, a comment, its
//   completion, reopening or cancellation. The quotation's own screens (the
//   register, its sidebar count, its activity history) are how it is followed,
//   and all of those are untouched.
//
//   APPROVAL IS SILENT. When a creator approves submitted work the task is
//   simply complete; nobody is notified. Submitting for approval still notifies
//   the creator, and returning or reopening still notifies the assignee.
//
// ENFORCED TWICE, NEITHER A SUBSTITUTE FOR THE OTHER.
//
//   Where rows are CREATED. Every Task Management writer asks the predicates
//   below, and transition_task_review() stops inserting the approval row in
//   supabase/migrations/20261212000000_task_review_approval_stops_notifying.sql.
//
//   Where rows are READ. Rows written before either change stay in the table —
//   nothing is deleted — but never surface: the list, the unread count,
//   mark-all-read and delete-all all apply the same exclusion BEFORE paging or
//   counting, so a hidden row can neither fill a page with nothing nor hold a
//   badge up. It also keeps the approval rule true between this code deploying
//   and the migration being applied.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getNotificationCategoryFilter, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { TASK_REVIEW_NOTIFICATION_SUFFIXES } from '@/lib/tasks/reviewTransitions'

export const QUOTATION_TASK_TYPE = 'quotation_request'

type TaskFacts = {
  task_type?: string | null
  created_by?: string | null
  assigned_to?: string | null
}

/** A quotation request, by its stored `task_type`. */
export function isQuotationTask(task: Pick<TaskFacts, 'task_type'> | null | undefined): boolean {
  return task?.task_type === QUOTATION_TASK_TYPE
}

/**
 * May /api/notify-status-update announce this event?
 *
 * The route is generic — acknowledge, comment, any status — so it is where an
 * approval could come back by another road. A delegated ordinary task reaches
 * `completed` ONLY through creator approval: tasks_enforce_review_path
 * (20260834000000) refuses every other client write. A generic "completed"
 * event for such a task is therefore the approval again, and is not announced.
 * A self task completing has nobody else to tell and is skipped by the
 * self-notify rule already; a quotation is silent for the reason above.
 */
export function shouldNotifyTaskStatusEvent(task: TaskFacts, action: unknown): boolean {
  if (isQuotationTask(task)) return false
  const delegated = !!task.created_by && !!task.assigned_to && task.created_by !== task.assigned_to
  if (action === 'completed' && delegated) return false
  return true
}

// ─── Read side ────────────────────────────────────────────────────────────────

/**
 * Embedded through `notifications.task_id → tasks.id`. `!inner` makes the task
 * row a condition of the notification row, so a filter on it removes the
 * notification — in the list, and in a `head` count alike.
 */
export const TASK_FEED_TASK_EMBED = 'tasks!inner(task_type)'
export const TASK_FEED_TASK_TYPE_COLUMN = 'tasks.task_type'

/**
 * The approval row transition_task_review() wrote: `task_acknowledged`,
 * titled "<actor> approved and completed task".
 *
 * WHY THE TITLE HERE, WHEN QUOTATIONS USE A COLUMN. A quotation has a column
 * that says what it is. An approval row does not: submit, approve and return
 * all write the same type, and the activity link that could tell them apart
 * (20261016000000) is null on every row written before it. The suffix is the
 * only thing on the row that distinguishes an approval, it is composed by
 * exactly one writer, and it is pinned against that writer's SQL by
 * reviewTransitions.test.ts. No other writer produces a title containing
 * "approved".
 */
export const APPROVAL_NOTIFICATION_TITLE_PATTERN = `*${TASK_REVIEW_NOTIFICATION_SUFFIXES.approve}`

/** Drop the embed used for filtering before rows leave the server. */
export function stripTaskFeedEmbed<T>(rows: readonly T[]): T[] {
  return rows.map(row => {
    const copy = { ...(row as Record<string, unknown>) }
    delete copy.tasks
    return copy as T
  })
}

/** PostgREST pages at most this many rows per select. */
export const VISIBLE_ID_PAGE_SIZE = 1000
/** Ids per mutation, so a long IN list never exceeds a URL. */
export const MUTATION_ID_CHUNK_SIZE = 200

export function chunkIds(ids: readonly string[], size = MUTATION_ID_CHUNK_SIZE): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

/**
 * Every Task notification the reader can SEE, by id — the set a bulk mutation
 * may touch.
 *
 * WHY A SELECT FIRST. PostgREST does not accept a filter on an embedded table
 * in an UPDATE or a DELETE, and the quotation exclusion is exactly such a
 * filter. So mark-all-read and delete-all resolve the visible set with the
 * list's own predicate and then mutate those ids, which keeps a hidden row from
 * being deleted — or silently marked read — by a button that never showed it.
 *
 * Scoped to `userId` like every other notification query.
 */
export async function selectVisibleTaskNotificationIds(
  // No generated Database type in this project — matches the untyped-client
  // pattern the API routes already use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupabaseClient<any, any, any>,
  opts: { userId: string; unreadOnly?: boolean; taskId?: string | null; entityId?: string | null },
): Promise<{ ids: string[]; error: { message: string } | null }> {
  const ids: string[] = []
  for (let from = 0; ; from += VISIBLE_ID_PAGE_SIZE) {
    let query = client
      .from('notifications')
      .select(`id, ${TASK_FEED_TASK_EMBED}`)
      .eq('user_id', opts.userId)
      .or(getNotificationCategoryFilter('task'))
      .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
      .neq(TASK_FEED_TASK_TYPE_COLUMN, QUOTATION_TASK_TYPE)
      .not('title', 'like', APPROVAL_NOTIFICATION_TITLE_PATTERN)
    if (opts.unreadOnly) query = query.eq('is_read', false)
    if (opts.taskId) query = query.eq('task_id', opts.taskId)
    if (opts.entityId) query = query.eq('entity_id', opts.entityId)

    const { data, error } = await query
      .order('id', { ascending: true })
      .range(from, from + VISIBLE_ID_PAGE_SIZE - 1)
    if (error) return { ids: [], error }
    const page = (data ?? []) as { id: string }[]
    for (const row of page) ids.push(row.id)
    if (page.length < VISIBLE_ID_PAGE_SIZE) return { ids, error: null }
  }
}
