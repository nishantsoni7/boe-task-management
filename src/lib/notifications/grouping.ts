// ONE function decides how the Notifications page is arranged. Nothing else.
//
// THE PROBLEM. A notification row is an EVENT, and a task produces many:
// acknowledged, a comment, submitted for approval, another comment. The page
// rendered each as its own top-level card, so one task filled the screen four
// or five times over and there was no way to see it as one thing. Grouping is
// therefore presentation, not storage — the events are still individual rows,
// still individually readable and deletable, and nothing about the table
// changes.
//
// THE TASK TITLE IS ALREADY IN THE ROW. Every task-notification write path —
// /api/notify-status-update, /cancel-task, /restore-task, /tasks/[id]/copy, the
// four client inserts, and transition_task_review() — stores the ACTOR SENTENCE
// in `title` ("Dhruv added a comment") and the TASK TITLE in `body`. So the
// group heading needs no join, no extra query and no schema change: it is the
// newest non-empty `body` in the group.
//
// DEDUPLICATION IS STRUCTURAL. The list query holds one flat newest-N array and
// "Load older" REPLACES it with a wider newest-N rather than appending, so the
// grouping is recomputed from scratch every time. A task cannot acquire a
// second top-level card, and an event cannot be lost or duplicated, because
// there is no merge step in which either could happen. `byId` below is belt and
// braces for an array that somehow arrived with a repeat.

import type { Notification } from '@/lib/types'

export type NotificationFilter = 'all' | 'unread'

/** Several events about one task, shown as one collapsible card. */
export type NotificationTaskGroup = {
  kind: 'task'
  /** React key and the stem of the accordion's aria ids. */
  key: string
  taskId: string
  /** The task's title, from the newest event that carries one. */
  title: string
  /** Newest first, or unread-first under the Unread filter — see orderGroupEvents. */
  notifications: Notification[]
  /** Unread events among those LOADED. */
  unreadCount: number
  /** Events LOADED for this task — never a claim about the server's total. */
  loadedCount: number
  /** The newest event; drives the summary line and the group's position. */
  latest: Notification
}

/** A notification with no task — shown on its own, exactly as before. */
export type NotificationSingle = {
  kind: 'single'
  key: string
  notification: Notification
  unreadCount: 0 | 1
}

export type NotificationDisplayItem = NotificationTaskGroup | NotificationSingle

/**
 * Newest first, then by id descending.
 *
 * The id tiebreak is not decoration: a batch insert writes several rows on one
 * transaction timestamp, and without a total order the same data could arrange
 * itself two different ways between renders, or a group could change position
 * without anything having happened.
 */
export function compareNewestFirst(a: Notification, b: Notification): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/** A task id worth grouping on: present, a string, and not blank. */
function groupableTaskId(n: Notification): string | null {
  const id = n.task_id
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}

/**
 * The heading for a group.
 *
 * `body` holds the task title on every task row, but it is nullable in the
 * schema and a legacy row may not have one, so the newest non-empty body wins
 * and a group with none at all still renders — with a neutral label rather
 * than an empty heading or a crash.
 */
export function resolveGroupTitle(ordered: readonly Notification[]): string {
  for (const n of ordered) {
    const body = typeof n.body === 'string' ? n.body.trim() : ''
    if (body) return body
  }
  return 'Task'
}

/**
 * THE canonical arrangement: task groups and standalone rows, newest first.
 *
 * Taskless notifications are never grouped with each other — a Finance
 * approval and a payroll issue have nothing in common but the absence of a
 * task id, and collapsing them together would hide unrelated things behind one
 * heading.
 */
export function groupNotificationsByTask(
  notifications: readonly Notification[],
): NotificationDisplayItem[] {
  // Defensive dedupe; last occurrence wins, so a refetched row beats a stale one.
  const byId = new Map<string, Notification>()
  for (const n of notifications) if (n && typeof n.id === 'string') byId.set(n.id, n)

  const buckets = new Map<string, Notification[]>()
  const singles: NotificationSingle[] = []

  for (const n of byId.values()) {
    const taskId = groupableTaskId(n)
    if (!taskId) {
      singles.push({ kind: 'single', key: n.id, notification: n, unreadCount: n.is_read ? 0 : 1 })
      continue
    }
    const bucket = buckets.get(taskId)
    if (bucket) bucket.push(n)
    else buckets.set(taskId, [n])
  }

  const groups: NotificationTaskGroup[] = []
  for (const [taskId, rows] of buckets) {
    const ordered = [...rows].sort(compareNewestFirst)
    groups.push({
      kind: 'task',
      key: `task:${taskId}`,
      taskId,
      title: resolveGroupTitle(ordered),
      notifications: ordered,
      unreadCount: ordered.reduce((acc, n) => (n.is_read ? acc : acc + 1), 0),
      loadedCount: ordered.length,
      latest: ordered[0],
    })
  }

  return [...groups, ...singles].sort((a, b) =>
    compareNewestFirst(latestOf(a), latestOf(b)))
}

function latestOf(item: NotificationDisplayItem): Notification {
  return item.kind === 'task' ? item.latest : item.notification
}

/** The newest event an item represents — what its position is decided by. */
export function itemLatest(item: NotificationDisplayItem): Notification {
  return latestOf(item)
}

/**
 * Events inside an expanded group, ordered for the active filter.
 *
 * Under `all` this is strictly newest first. Under `unread` the unread events
 * come first — that is what the reader opened the group for — with the read
 * ones kept below rather than hidden, because a comment only makes sense next
 * to the status change it answers. Both halves stay newest-first internally.
 */
export function orderGroupEvents(
  group: NotificationTaskGroup,
  filter: NotificationFilter,
): Notification[] {
  if (filter === 'all') return group.notifications
  const unread = group.notifications.filter(n => !n.is_read)
  const read   = group.notifications.filter(n => n.is_read)
  return [...unread, ...read]
}

/** Items to show under a filter. */
export function filterDisplayItems(
  items: readonly NotificationDisplayItem[],
  filter: NotificationFilter,
): NotificationDisplayItem[] {
  if (filter === 'all') return [...items]
  return items.filter(item => item.unreadCount > 0)
}

export type NotificationSummary = {
  /** Exact unread EVENT count among the loaded rows. */
  unreadEvents: number
  /** Task groups holding at least one unread event. */
  unreadTaskGroups: number
  /** Standalone unread rows — counted separately so the sentence can be honest. */
  unreadSingles: number
  /** Groups + standalone rows carrying unread events: what "across N" means. */
  unreadContainers: number
}

/**
 * The numbers behind "16 unread updates across 6 tasks".
 *
 * Both are computed from the SAME loaded rows the page is rendering, so the
 * sentence cannot describe a set the reader is not looking at. Neither is a
 * claim about the server's totals — the list is bounded, and the badge count
 * (which is exact and server-side) is a different number on purpose.
 */
export function summarizeDisplayItems(
  items: readonly NotificationDisplayItem[],
): NotificationSummary {
  let unreadEvents = 0
  let unreadTaskGroups = 0
  let unreadSingles = 0
  for (const item of items) {
    unreadEvents += item.unreadCount
    if (item.unreadCount === 0) continue
    if (item.kind === 'task') unreadTaskGroups += 1
    else unreadSingles += 1
  }
  return {
    unreadEvents,
    unreadTaskGroups,
    unreadSingles,
    unreadContainers: unreadTaskGroups + unreadSingles,
  }
}

/** Ids of every unread event in an item — the exact set a "mark read" would flip. */
export function unreadIdsOf(item: NotificationDisplayItem): string[] {
  if (item.kind === 'single') return item.notification.is_read ? [] : [item.notification.id]
  return item.notifications.filter(n => !n.is_read).map(n => n.id)
}

/** Every id an item holds — the exact set a "delete group" would remove. */
export function allIdsOf(item: NotificationDisplayItem): string[] {
  return item.kind === 'single' ? [item.notification.id] : item.notifications.map(n => n.id)
}
