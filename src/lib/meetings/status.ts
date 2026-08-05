// Meeting status transitions, and the summary shown when one is completed.
//
// The transition table is the browser-side mirror of set_meeting_status()
// (migration 20260814000000 §8g). The database is the enforcement boundary;
// this file exists so the UI never offers a button whose RPC would refuse, and
// so the rules can be asserted without a database.

import type { MeetingStatus, MeetingOrder, MeetingOrderItem } from './types'

/**
 * Where a meeting may go from where it is.
 *
 *   draft       → in_progress (start it) or straight to completed
 *   in_progress → completed, or back to draft if it was started by mistake
 *   completed   → in_progress only, which is what "reopen for a correction"
 *                 means. A completed meeting never jumps back to draft: the
 *                 record of having been held is not erasable.
 */
export const MEETING_TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  draft:       ['in_progress', 'completed'],
  in_progress: ['completed', 'draft'],
  completed:   ['in_progress'],
}

export function canTransitionMeeting(from: MeetingStatus, to: MeetingStatus): boolean {
  if (from === to) return false
  return MEETING_TRANSITIONS[from].includes(to)
}

/** A completed meeting is read-only. Everything else in the module asks this. */
export function isMeetingEditable(status: MeetingStatus): boolean {
  return status !== 'completed'
}

// ─── Completion summary ───────────────────────────────────────────────────────

export type MeetingCompletionSummary = {
  ordersReviewed: number
  itemsReviewed: number
  /** Lines still Open or Waiting — the reason the warning appears. */
  unresolvedIssues: number
  /** Lines carrying a next follow-up date. */
  followUpsScheduled: number
  tasksCreated: number
  /**
   * Lines nobody said anything about. Not a blocker — plenty of SKUs need no
   * comment — but the one number a lead wants before closing the meeting.
   */
  itemsWithoutUpdates: number
}

/**
 * What the confirm-completion panel shows.
 *
 * "Reviewed" counts what was in the meeting, not what was touched: an order
 * that was brought in and turned out to need nothing was still reviewed, and
 * reporting it as unreviewed would push people to type a filler update.
 */
export function summarizeMeetingForCompletion(
  orders: readonly MeetingOrder[],
  items: readonly MeetingOrderItem[],
): MeetingCompletionSummary {
  return {
    ordersReviewed: orders.length,
    itemsReviewed: items.length,
    unresolvedIssues: items.filter(i => i.status !== 'resolved').length,
    followUpsScheduled: items.filter(i => !!i.next_follow_up_date).length,
    tasksCreated: items.filter(i => !!i.linked_task_id).length,
    itemsWithoutUpdates: items.filter(i => !i.latest_update || i.latest_update.trim() === '').length,
  }
}

/**
 * Completion is never blocked — a meeting ends when the meeting ends, and
 * refusing to close it until every line is resolved would just teach people to
 * mark things resolved. The warning is informational, and `null` means there is
 * nothing worth saying.
 */
export function completionWarning(summary: MeetingCompletionSummary): string | null {
  const parts: string[] = []
  if (summary.unresolvedIssues > 0) {
    parts.push(`${summary.unresolvedIssues} ${summary.unresolvedIssues === 1 ? 'item is' : 'items are'} still open`)
  }
  if (summary.itemsWithoutUpdates > 0) {
    parts.push(`${summary.itemsWithoutUpdates} ${summary.itemsWithoutUpdates === 1 ? 'item has' : 'items have'} no update recorded`)
  }
  if (parts.length === 0) return null
  return `${parts.join(' and ')}. They stay on the follow-up lists after this meeting is completed.`
}
