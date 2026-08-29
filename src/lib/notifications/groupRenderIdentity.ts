// WHEN ONE NOTIFICATION CARD ACTUALLY HAS TO RE-RENDER.
//
// THE DEFECT THIS EXISTS TO FIX. Marking ONE task group read repainted EVERY
// card on the page. Measured on a 20-card page before this file existed:
// 250 DOM mutations and 434ms of render for a single group's "Mark all read",
// and 239 mutations / 600ms for the page-level one. Roughly twelve mutations
// per card, for cards whose content had not changed at all. On a longer page
// that is the ~800-1400ms interaction the profiler was reporting.
//
// It happened for two compounding reasons, neither of them the click handler:
//
//   1. `groupNotificationsByTask` rebuilds the whole arrangement from the flat
//      row list on every change. That is deliberate and worth keeping — it is
//      what makes "Load older" incapable of producing a duplicate group — but
//      it means every group OBJECT is new whenever any single row changes.
//   2. The card was not memoized, so a new object was a guaranteed re-render.
//
// Referential memoization cannot help here: the props are honestly new. What
// is NOT new is their CONTENT, and content is what the card draws. So this
// compares the facts a card actually renders, and lets React skip the rest.
//
// The comparison is O(events in this group) — a handful of string compares
// against a render that touches a dozen DOM nodes. It is not close.

import type { NotificationTaskGroup } from './grouping'

/**
 * The per-event facts a card draws. Anything the card can display must be
 * listed here, or a change to it would not repaint.
 */
function sameEvent(a: NotificationTaskGroup['notifications'][number],
                   b: NotificationTaskGroup['notifications'][number]): boolean {
  if (a === b) return true
  return (
    a.id === b.id &&
    a.is_read === b.is_read &&
    a.title === b.title &&
    a.body === b.body &&
    a.created_at === b.created_at &&
    a.activity_log_id === b.activity_log_id &&
    // The enrichment attached to the row: title, both people, and the linked
    // activity. Compared by reference first — attachRowContext copies the row
    // but reuses the same context object — then field by field.
    sameContext(a.context, b.context)
  )
}

function sameContext(
  a: NotificationTaskGroup['notifications'][number]['context'],
  b: NotificationTaskGroup['notifications'][number]['context'],
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.taskTitle === b.taskTitle &&
    a.assigneeName === b.assigneeName &&
    a.assigneeId === b.assigneeId &&
    a.creatorName === b.creatorName &&
    a.creatorId === b.creatorId &&
    a.activity === b.activity
  )
}

/** True when two groups would draw identically. */
export function sameGroupContent(
  a: NotificationTaskGroup,
  b: NotificationTaskGroup,
): boolean {
  if (a === b) return true
  if (
    a.key !== b.key ||
    a.taskId !== b.taskId ||
    a.title !== b.title ||
    a.unreadCount !== b.unreadCount ||
    a.loadedCount !== b.loadedCount ||
    a.notifications.length !== b.notifications.length
  ) return false
  for (let i = 0; i < a.notifications.length; i++) {
    if (!sameEvent(a.notifications[i], b.notifications[i])) return false
  }
  return true
}

/**
 * Whether this group's own membership of a page-wide set changed.
 *
 * `selected` and `pendingDeletes` are single Sets shared by every card, so
 * their identity changes whenever ANY row is selected or any delete starts.
 * Only the ids in THIS group can change what THIS card draws.
 */
export function sameSetMembership(
  group: NotificationTaskGroup,
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): boolean {
  if (prev === next) return true
  for (const n of group.notifications) {
    if (prev.has(n.id) !== next.has(n.id)) return false
  }
  return true
}
