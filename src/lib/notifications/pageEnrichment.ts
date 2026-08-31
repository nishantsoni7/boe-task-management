// EVERYTHING THE FEED NEEDS BEYOND THE NOTIFICATION ROWS, IN FOUR QUERIES.
//
// A page of notifications answers "what happened", but the card also shows the
// task's title and owner, and each event shows its detail and its actor. None
// of that is in `notifications`. This fetches all of it for the whole page:
//
//   1. tasks             id, title, assigned_to      — one in()
//   2. task_activity_log id, actor_id, action, note,
//                        from_status, to_status      — one in()
//   3. task_attachments  activity_log_id, file_name,
//                        file_type                   — one in(), so an update
//                                                      that carried a file can
//                                                      say so
//   4. users             id, full_name               — ONE in(), covering
//                                                      assignees AND actors
//
// Five queries per page including the notification list itself, whatever the
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
import type { ActivityAttachmentInfo } from '@/lib/tasks/activityHeadings'

/**
 * What the header needs about one task.
 *
 * BOTH SIDES OF THE TASK, not just the assignee. The header names the person
 * the reader is dealing with, and that is only the assignee when the reader is
 * NOT the assignee. A quotation request assigned to the reader used to render
 * the reader's own name, which tells them nothing they did not already know —
 * see `headerCounterpart`.
 *
 * The ids travel with the names because the rule is an identity comparison,
 * never a string comparison: two people can share a display name, and a name
 * parsed out of a title is not an authority on who anybody is.
 */
export type TaskHeaderInfo = {
  title: string
  assigneeName: string | null
  assigneeId?: string | null
  creatorName?: string | null
  creatorId?: string | null
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
  /**
   * The files this update carried, if any.
   *
   * WHY THE CARD NEEDS THEM. "Send Update" writes ONE `note_added` row whether
   * the person typed a sentence, attached a PDF, or both — so a row with no
   * text is not an empty comment, it is usually an ATTACHMENT. Without this the
   * card fell back to the bare "Comment added" for exactly the updates that had
   * something in them.
   *
   * TYPE AND NAME ONLY, never a URL or a storage path: this list decides one
   * word in a sentence, and a link to a file whose permissions the card has not
   * checked has no business travelling to the browser. See safeCommentPreview,
   * which strips storage URLs out of comment text for the same reason.
   *
   * OPTIONAL, because a detail can predate this field: a payload cached by an
   * older build carries none, and absent must mean "not known" rather than
   * "none attached" — the card then says exactly what it said before.
   */
  attachments?: ActivityAttachmentInfo[]
}
export type ActivityDetailMap = Record<string, ActivityDetail>

export type NotificationPageEnrichment = {
  taskHeaders: TaskHeaderMap
  activityDetails: ActivityDetailMap
}

export const ASSIGNEE_UNAVAILABLE = 'Assignee unavailable'

/**
 * WHO THE HEADER NAMES.
 *
 * `assignee`  — the reader is not the assignee, so the assignee is the
 *                counterpart. Unchanged behaviour for every ordinary task a
 *                creator is watching.
 * `creator`   — the reader IS the assignee, so the useful name is the person
 *                who assigned or created the work. This is the quotation case.
 * `self`      — the reader is both sides. There is no counterpart, and their
 *                own name is not one, so the header names nobody.
 * `unknown`   — nothing resolved: a deleted user, a task the enrichment could
 *                not read, or a row written before this field existed.
 */
export type HeaderCounterpartRelation = 'assignee' | 'creator' | 'self' | 'unknown'

export type HeaderCounterpart = {
  name: string | null
  relation: HeaderCounterpartRelation
}

/**
 * The person to name beside the task title, derived from the task's own
 * assigned_to / created_by — never from notification title or body text.
 *
 * A viewer id of null (identity not resolved yet) falls back to the previous
 * behaviour: name the assignee. That is the safe direction — it can only show
 * what the page showed before, and it never invents a name.
 */
export function headerCounterpart(
  info: TaskHeaderInfo | undefined,
  viewerId: string | null | undefined,
): HeaderCounterpart {
  const clean = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null

  const assigneeName = clean(info?.assigneeName)
  const creatorName  = clean(info?.creatorName)
  const assigneeId   = clean(info?.assigneeId)
  const creatorId    = clean(info?.creatorId)
  const viewer       = clean(viewerId)

  const viewerIsAssignee = !!viewer && !!assigneeId && assigneeId === viewer
  const viewerIsCreator  = !!viewer && !!creatorId  && creatorId  === viewer

  // Both sides are the reader: a self task. Naming them is noise.
  if (viewerIsAssignee && viewerIsCreator) return { name: null, relation: 'self' }

  if (viewerIsAssignee) {
    if (creatorName) return { name: creatorName, relation: 'creator' }
    // The reader is the assignee and the other side did not resolve. Falling
    // back to the assignee would print the reader's own name, which is the
    // defect this exists to remove.
    return { name: null, relation: 'unknown' }
  }

  if (assigneeName) return { name: assigneeName, relation: 'assignee' }
  // No assignee to name — an unassigned task still has an author worth showing,
  // unless that author is the reader.
  if (creatorName && !viewerIsCreator) return { name: creatorName, relation: 'creator' }
  return { name: null, relation: 'unknown' }
}

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
  from: (table: 'tasks' | 'users' | 'task_activity_log' | 'task_attachments') => any
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
  const [taskRes, actRes, attRes]: [Res, Res, Res] = await Promise.all([
    taskIds.length
      ? client.from('tasks').select('id, title, assigned_to, created_by').in('id', taskIds)
      : Promise.resolve({ data: [], error: null }),
    activityIds.length
      ? client.from('task_activity_log')
          .select('id, actor_id, action, note, from_status, to_status')
          .in('id', activityIds)
      : Promise.resolve({ data: [], error: null }),
    // Scoped by the SAME activity ids as the query above, which came from the
    // caller's own notification rows — so this can only describe files attached
    // to an update this person was already being notified about. Two columns,
    // neither of which locates the object in storage.
    activityIds.length
      ? client.from('task_attachments')
          .select('activity_log_id, file_name, file_type')
          .in('activity_log_id', activityIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (taskRes.error) console.error('[notifications] task lookup failed:', taskRes.error.message)
  if (actRes.error) console.error('[notifications] activity lookup failed:', actRes.error.message)
  // Independently optional like the rest: no attachment list means the card
  // says "Comment added" exactly as it did before, never that it failed.
  if (attRes.error) console.error('[notifications] attachment lookup failed:', attRes.error.message)

  const taskHeaders: TaskHeaderMap = {}
  const assigneeOf = new Map<string, string>()
  const creatorOf = new Map<string, string>()
  // ONE set of people to resolve, from both sources.
  const peopleIds = new Set<string>()

  for (const t of taskRes.data ?? []) {
    const id = str(t.id)
    if (!id) continue
    taskHeaders[id] = {
      title: typeof t.title === 'string' ? t.title : '',
      assigneeName: null,
      assigneeId: str(t.assigned_to),
      creatorName: null,
      creatorId: str(t.created_by),
    }
    const assignee = str(t.assigned_to)
    if (assignee) { assigneeOf.set(id, assignee); peopleIds.add(assignee) }
    // The creator joins the SAME people query — no extra round trip.
    const creator = str(t.created_by)
    if (creator) { creatorOf.set(id, creator); peopleIds.add(creator) }
  }

  // Grouped before the details are built so each one is handed a complete list
  // rather than being mutated afterwards.
  const filesOf = new Map<string, ActivityAttachmentInfo[]>()
  for (const f of attRes.data ?? []) {
    const activityId = str(f.activity_log_id)
    if (!activityId) continue
    const list = filesOf.get(activityId) ?? []
    list.push({ fileType: str(f.file_type), name: str(f.file_name) })
    filesOf.set(activityId, list)
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
      attachments: filesOf.get(id) ?? [],
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
  for (const [taskId, userId] of creatorOf) {
    if (taskHeaders[taskId]) taskHeaders[taskId].creatorName = nameById.get(userId) ?? null
  }
  for (const [activityId, userId] of actorOf) {
    if (activityDetails[activityId]) activityDetails[activityId].actorName = nameById.get(userId) ?? null
  }

  return { taskHeaders, activityDetails }
}

// ── ATTACHING THE ENRICHMENT TO THE ROWS IT DESCRIBES ────────────────────────
//
// WHY THIS EXISTS, AND WHAT WENT WRONG WITHOUT IT.
//
// The maps above were returned to the client BESIDE the rows, and the client
// held them in component state while the rows lived in the React Query cache.
// Those two stores have different lifetimes, and that is not a theoretical
// problem — it is the defect that made a correctly linked comment render as a
// bare "Comment added":
//
//   * the list query has `staleTime: 30s`. Open Notifications, open the task,
//     post a comment, come back inside the window — TanStack serves the CACHED
//     rows and never runs the query function, so the state that would have
//     carried the maps is never assigned and stays `{}`. Every card falls back.
//   * every mutation (mark read, delete one, delete all) writes rows straight
//     into the cache with `setQueryData`. The rows update; a separate map does
//     not travel with them.
//   * two observers of the same query key share ONE fetch, so only the
//     component whose query function ran ever receives the maps.
//
// The fix is structural rather than defensive: the detail is attached to the
// row itself, so it is the same object the cache holds. A row can no longer be
// present without its context, because there is nowhere else for the context to
// be. Nothing needs to stay in sync, so nothing can fall out of sync.
//
// STILL EXACTLY THE SAME QUERIES. This is composition over data already
// fetched — no additional read, per row or otherwise.

/**
 * Everything one card needs about one notification, carried on the row.
 *
 * `activity` is null for every historical row and for any row whose activity
 * has since been deleted (ON DELETE SET NULL clears the link, the notification
 * survives) — both render the honest fallback.
 */
export type NotificationRowContext = {
  taskTitle: string | null
  assigneeName: string | null
  /** Both ids and the creator's name, so the header rule never parses text. */
  assigneeId?: string | null
  creatorName?: string | null
  creatorId?: string | null
  activity: ActivityDetail | null
}

/** The enrichment for one row, or null when the page resolved nothing for it. */
export function rowContext(
  row: { task_id?: string | null; activity_log_id?: string | null },
  { taskHeaders, activityDetails }: NotificationPageEnrichment,
): NotificationRowContext | null {
  const header = typeof row.task_id === 'string' && row.task_id
    ? taskHeaders[row.task_id]
    : undefined
  const activity = typeof row.activity_log_id === 'string' && row.activity_log_id
    ? activityDetails[row.activity_log_id] ?? null
    : null
  if (!header && !activity) return null
  return {
    taskTitle: header?.title?.trim() ? header.title.trim() : null,
    assigneeName: header?.assigneeName ?? null,
    assigneeId: header?.assigneeId ?? null,
    creatorName: header?.creatorName ?? null,
    creatorId: header?.creatorId ?? null,
    activity,
  }
}

/**
 * Copy each row with its own context attached. Order and identity preserved.
 *
 * A row the page resolved nothing for is returned unchanged rather than given
 * an empty context, so "no context" and "context that resolved to nothing" stay
 * distinguishable at the point where that difference matters.
 */
export function attachRowContext<T extends { task_id?: string | null; activity_log_id?: string | null }>(
  rows: readonly T[],
  enrichment: NotificationPageEnrichment,
): Array<T & { context?: NotificationRowContext }> {
  return rows.map(row => {
    const context = rowContext(row, enrichment)
    return context ? { ...row, context } : row
  })
}
