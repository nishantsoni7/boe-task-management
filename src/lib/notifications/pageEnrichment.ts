// EVERYTHING THE FEED NEEDS BEYOND THE NOTIFICATION ROWS, IN THREE QUERIES.
//
// A page of notifications answers "what happened", but the card also shows the
// task's title and owner, and each event shows its detail and its actor. None
// of that is in `notifications`. This fetches all of it for the whole page:
//
//   1. tasks             id, title, assigned_to      — one in()
//   2. task_activity_log id, actor_id, action, note,
//                        from_status, to_status      — one in()
//   3. users             id, full_name               — ONE in(), covering
//                                                      assignees AND actors
//
// Four queries per page including the notification list itself, whatever the
// number of cards. Never one per card, and never one per event.
//
// ── WHY THE USER QUERY IS SHARED ────────────────────────────────────────────
//
// Assignees and actors are the same kind of thing — people — read from the same
// table for the same column. Two queries would fetch the same rows twice on any
// page where somebody acts on their own task, which is most of them. The id
// sets are unioned before the query and the resulting map serves both.
//
// ── WHY THIS CANNOT REACH SOMEBODY ELSE'S DATA ──────────────────────────────
//
// Every id it looks up is taken from the CALLER'S OWN notification rows, which
// the route has already scoped to `user_id = caller`. A task id can only be one
// this person is being notified about; an activity id can only be one a
// notification addressed to them points at. There is no parameter a caller can
// supply and no id that enters from outside that set — so the batch cannot
// return an activity row, a task or a name the caller was not already being
// shown. A test proves an unrelated activity id is never fetched.
//
// ── AND IT NEVER TAKES THE FEED DOWN ────────────────────────────────────────
//
// Every query is independently optional. A failure returns whatever resolved
// and the cards render their fallbacks — "Assignee unavailable", "Comment
// added", "Status updated". A notification list is more useful without its
// enrichment than absent.

import type { Notification } from '@/lib/types'

/** What the header needs about one task. */
export type TaskHeaderInfo = {
  title: string
  assigneeName: string | null
}
export type TaskHeaderMap = Record<string, TaskHeaderInfo>

/** What one event's line needs, read from the exact linked activity row. */
export type ActivityDetail = {
  action: string | null
  /** The comment text, raw. Sanitised and truncated at render time. */
  note: string | null
  fromStatus: string | null
  toStatus: string | null
  /** Resolved display name, or null when there is no readable actor. */
  actorName: string | null
}
export type ActivityDetailMap = Record<string, ActivityDetail>

export type NotificationPageEnrichment = {
  taskHeaders: TaskHeaderMap
  activityDetails: ActivityDetailMap
}

export const ASSIGNEE_UNAVAILABLE = 'Assignee unavailable'

/** The distinct task ids in a page. Bounded by the page. */
export function collectTaskIds(rows: readonly Pick<Notification, 'task_id'>[]): string[] {
  const seen = new Set<string>()
  for (const n of rows) if (typeof n.task_id === 'string' && n.task_id) seen.add(n.task_id)
  return [...seen]
}

/** The distinct linked activity ids in a page. Null for every historical row. */
export function collectActivityIds(
  rows: readonly { activity_log_id?: string | null }[],
): string[] {
  const seen = new Set<string>()
  for (const n of rows) {
    if (typeof n.activity_log_id === 'string' && n.activity_log_id) seen.add(n.activity_log_id)
  }
  return [...seen]
}

/** The name to render, never null, never a guess. */
export function assigneeLabel(info: TaskHeaderInfo | undefined): string {
  const name = info?.assigneeName
  return typeof name === 'string' && name.trim() ? name.trim() : ASSIGNEE_UNAVAILABLE
}

/** Prefers the authoritative task title; falls back to what the group derived. */
export function taskTitleFor(info: TaskHeaderInfo | undefined, fallback: string): string {
  const title = info?.title
  return typeof title === 'string' && title.trim() ? title.trim() : fallback
}

/** Just the reads this makes. `any` on the builder — see the note in the route. */
type PageClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: 'tasks' | 'users' | 'task_activity_log') => any
}
type Res = { data: Record<string, unknown>[] | null; error: { message: string } | null }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export async function enrichNotificationPage(
  client: PageClient,
  rows: readonly (Pick<Notification, 'task_id'> & { activity_log_id?: string | null })[],
): Promise<NotificationPageEnrichment> {
  const taskIds = collectTaskIds(rows)
  const activityIds = collectActivityIds(rows)
  const empty: NotificationPageEnrichment = { taskHeaders: {}, activityDetails: {} }
  if (taskIds.length === 0 && activityIds.length === 0) return empty

  // The two independent lookups run together: neither needs the other's result,
  // so waiting for them in sequence would double the latency for nothing.
  const [taskRes, actRes]: [Res, Res] = await Promise.all([
    taskIds.length
      ? client.from('tasks').select('id, title, assigned_to').in('id', taskIds)
      : Promise.resolve({ data: [], error: null }),
    activityIds.length
      ? client.from('task_activity_log')
          .select('id, actor_id, action, note, from_status, to_status')
          .in('id', activityIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (taskRes.error) console.error('[notifications] task lookup failed:', taskRes.error.message)
  if (actRes.error) console.error('[notifications] activity lookup failed:', actRes.error.message)

  const taskHeaders: TaskHeaderMap = {}
  const assigneeOf = new Map<string, string>()
  // ONE set of people to resolve, from both sources.
  const peopleIds = new Set<string>()

  for (const t of taskRes.data ?? []) {
    const id = str(t.id)
    if (!id) continue
    taskHeaders[id] = { title: typeof t.title === 'string' ? t.title : '', assigneeName: null }
    const assignee = str(t.assigned_to)
    if (assignee) { assigneeOf.set(id, assignee); peopleIds.add(assignee) }
  }

  const activityDetails: ActivityDetailMap = {}
  const actorOf = new Map<string, string>()
  for (const a of actRes.data ?? []) {
    const id = str(a.id)
    if (!id) continue
    activityDetails[id] = {
      action: str(a.action),
      note: typeof a.note === 'string' ? a.note : null,
      fromStatus: str(a.from_status),
      toStatus: str(a.to_status),
      actorName: null,
    }
    const actor = str(a.actor_id)
    if (actor) { actorOf.set(id, actor); peopleIds.add(actor) }
  }

  if (peopleIds.size === 0) return { taskHeaders, activityDetails }

  // ONE COLUMN ABOUT A PERSON: their display name, which the caller already
  // sees on the task itself. No email, no phone, no role, no employment fields.
  const { data: users, error: userErr }: Res = await client
    .from('users')
    .select('id, full_name')
    .in('id', [...peopleIds])
  if (userErr || !users) {
    // Names did not resolve. Assignees read "Assignee unavailable" and actors
    // fall back to the name parsed from the notification title — both true.
    console.error('[notifications] name lookup failed:', userErr?.message)
    return { taskHeaders, activityDetails }
  }

  const nameById = new Map<string, string>()
  for (const u of users) {
    const id = str(u.id)
    const name = str(u.full_name)
    if (id && name) nameById.set(id, name)
  }
  // A missing entry is a deleted or unreadable employee: left null, rendered as
  // ASSIGNEE_UNAVAILABLE for a task and as the parsed fallback for an actor.
  for (const [taskId, userId] of assigneeOf) {
    if (taskHeaders[taskId]) taskHeaders[taskId].assigneeName = nameById.get(userId) ?? null
  }
  for (const [activityId, userId] of actorOf) {
    if (activityDetails[activityId]) activityDetails[activityId].actorName = nameById.get(userId) ?? null
  }

  return { taskHeaders, activityDetails }
}
