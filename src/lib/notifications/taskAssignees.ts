// WHO THE TASK BELONGS TO — fetched once for a page, never once per card.
//
// The card header reads "test task    Assigned to: Nishant". Neither fact is in
// the notification row: `body` happens to hold the task title on every current
// write path, but that is a convention, not the source of truth, and the
// assignee is not there at all.
//
// ── WHY NOT THE LATEST ACTOR ────────────────────────────────────────────────
//
// The obvious shortcut is to reuse the name already parsed out of the newest
// notification's title. It is WRONG, and confidently so: "Dhruv added a
// comment" on a task assigned to Nishant would render "Assigned to: Dhruv".
// The actor of an event and the owner of a task are different facts and this
// module exists to keep them apart.
//
// ── WHY A BATCH, NOT A JOIN OR A PER-GROUP FETCH ────────────────────────────
//
// One request per group is what makes a list of twenty cards twenty round
// trips. A PostgREST embed from `notifications` would be one request, but it
// assumes a declared foreign key from notifications.task_id, and an embed that
// fails takes the whole notification list down with it — a display nicety
// breaking the feed.
//
// So: two `in(...)` filters, both bounded by the page. The notification list is
// already clamped to NOTIFICATION_MAX_ROWS, so the id sets are bounded by that
// and by the number of DISTINCT tasks within it, which is smaller. Two extra
// queries per page, whatever the number of cards.
//
// ── PERMISSIONS ─────────────────────────────────────────────────────────────
//
// The task ids are taken from the caller's OWN notification rows, which the
// route has already scoped to `user_id = caller`. So the lookup can only ever
// describe tasks this person is already being told about, and it selects one
// column about a person — their display name — which they already see on the
// task itself. No email, no phone, no role, no employment fields.

import type { Notification } from '@/lib/types'

/** What the header needs about one task. */
export type TaskHeaderInfo = {
  /** The task's real title, from `tasks`. */
  title: string
  /**
   * The assignee's display name, or null when there is no name to show —
   * unassigned, deleted, or a record the lookup could not read.
   */
  assigneeName: string | null
}

export type TaskHeaderMap = Record<string, TaskHeaderInfo>

/**
 * Shown wherever an assignee cannot be named.
 *
 * Covers every missing case with one honest phrase: a deleted employee, a
 * deactivated one, a task with nobody assigned, and a lookup that failed. The
 * card still renders and still says who the task is — it simply does not claim
 * to know the person.
 */
export const ASSIGNEE_UNAVAILABLE = 'Assignee unavailable'

/** The distinct task ids in a page of notifications. Bounded by the page. */
export function collectTaskIds(notifications: readonly Pick<Notification, 'task_id'>[]): string[] {
  const seen = new Set<string>()
  for (const n of notifications) {
    if (typeof n.task_id === 'string' && n.task_id) seen.add(n.task_id)
  }
  return [...seen]
}

/** The name to render, never null, never a guess. */
export function assigneeLabel(info: TaskHeaderInfo | undefined): string {
  const name = info?.assigneeName
  if (typeof name !== 'string' || !name.trim()) return ASSIGNEE_UNAVAILABLE
  return name.trim()
}

/**
 * The task title to render.
 *
 * Prefers the authoritative `tasks.title`; falls back to the title the group
 * already derived from the notification body, which is what every card showed
 * before this lookup existed. So a task row that could not be read degrades to
 * the previous behaviour rather than to an empty header.
 */
export function taskTitleFor(info: TaskHeaderInfo | undefined, fallback: string): string {
  const title = info?.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  return fallback
}

// ── The two queries ─────────────────────────────────────────────────────────

/**
 * Just the two calls this makes.
 *
 * `any` on the builder is deliberate and narrow: PostgREST's generated types
 * are deep enough that spelling this chain out structurally makes the compiler
 * give up with "Type instantiation is excessively deep" at the call site. The
 * results are re-validated field by field below — every value is checked with
 * `typeof` before it is used — so nothing is trusted on the strength of a type
 * that was never checked anyway.
 */
type RowClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: 'tasks' | 'users') => any
}

type LookupResult = {
  data: Record<string, unknown>[] | null
  error: { message: string } | null
}

/**
 * Resolve titles and assignee names for a page of notifications.
 *
 * NEVER THROWS AND NEVER FAILS THE FEED. Every error path returns whatever was
 * resolved so far — possibly nothing — and the cards render
 * `ASSIGNEE_UNAVAILABLE` with their existing titles. A notification list is
 * more useful without an assignee than it is absent.
 */
export async function fetchTaskHeaderInfo(
  client: RowClient,
  taskIds: readonly string[],
): Promise<TaskHeaderMap> {
  const out: TaskHeaderMap = {}
  if (taskIds.length === 0) return out

  const { data: tasks, error: taskErr }: LookupResult = await client
    .from('tasks')
    .select('id, title, assigned_to')
    .in('id', taskIds)
  if (taskErr || !tasks) {
    console.error('[notifications] task header lookup failed:', taskErr?.message)
    return out
  }

  const assigneeIds = new Set<string>()
  for (const t of tasks) {
    const id = typeof t.id === 'string' ? t.id : null
    if (!id) continue
    out[id] = {
      title: typeof t.title === 'string' ? t.title : '',
      assigneeName: null,
    }
    if (typeof t.assigned_to === 'string' && t.assigned_to) assigneeIds.add(t.assigned_to)
  }
  if (assigneeIds.size === 0) return out

  // ONE COLUMN ABOUT A PERSON. Their display name, which the caller already
  // sees on the task itself.
  const { data: users, error: userErr }: LookupResult = await client
    .from('users')
    .select('id, full_name')
    .in('id', [...assigneeIds])
  if (userErr || !users) {
    // Titles resolved, names did not. Every card says "Assignee unavailable",
    // which is true.
    console.error('[notifications] assignee name lookup failed:', userErr?.message)
    return out
  }

  const nameById = new Map<string, string>()
  for (const u of users) {
    if (typeof u.id === 'string' && typeof u.full_name === 'string') {
      nameById.set(u.id, u.full_name)
    }
  }
  for (const t of tasks) {
    const id = typeof t.id === 'string' ? t.id : null
    const assignee = typeof t.assigned_to === 'string' ? t.assigned_to : null
    if (!id || !assignee || !out[id]) continue
    // A missing entry here is a deleted or unreadable employee record: left
    // null, rendered as ASSIGNEE_UNAVAILABLE.
    out[id].assigneeName = nameById.get(assignee) ?? null
  }
  return out
}
