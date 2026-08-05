// Prefilling a task from a meeting discussion.
//
// Task Management owns tasks; Meetings only proposes the wording. What matters
// here is that the assignee opening the task in three days can act on it
// without the meeting in front of them — so the order reference, the SKU, the
// meeting it came from and the discussion context all travel with it.
//
// What is deliberately NOT prefilled: assignee, due date and priority. Those
// are decisions, and a task that arrives pre-assigned to a default person with
// a default date is a task nobody owns.

import { formatMeetingDate, type Meeting, type MeetingOrder, type MeetingOrderItem } from './types'

/** Title length that stays readable in the task list without being truncated. */
const TITLE_MAX = 90

export type MeetingTaskDraft = {
  title: string
  description: string
}

function clamp(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/**
 * The task title: order, SKU, then the actionable part of the discussion.
 *
 * The issue is preferred over the latest update as the tail, because a task is
 * created to deal with a problem far more often than to note progress. With
 * neither, the product name is the honest fallback — better than an invented
 * verb.
 */
export function meetingTaskTitle(order: MeetingOrder, item: MeetingOrderItem): string {
  const lead = `${order.order_number} · ${item.sku}`
  const tail = item.issue?.trim() || item.latest_update?.trim() || item.product_name
  return clamp(`${lead} — ${tail}`, TITLE_MAX)
}

/**
 * The task description: every reference needed to find the source record, then
 * the discussion as it stood when the task was raised.
 *
 * This is a snapshot, on purpose. It is context for the assignee, not a live
 * mirror of the SKU line — the meeting keeps its own history, and duplicating a
 * changing value into a task body would produce two versions of the truth.
 */
export function meetingTaskDescription(
  meeting: Meeting,
  order: MeetingOrder,
  item: MeetingOrderItem,
): string {
  const lines: string[] = [
    `Order: ${order.order_number}`,
    `SKU: ${item.sku} — ${item.product_name}`,
  ]

  if (item.quantity != null)   lines.push(`Quantity: ${item.quantity}`)
  if (order.customer_name)     lines.push(`Customer: ${order.customer_name}`)
  if (item.current_stage)      lines.push(`Current stage: ${item.current_stage}`)
  if (item.responsible_department) lines.push(`Department: ${item.responsible_department}`)
  if (order.expected_dispatch_date) {
    lines.push(`Expected dispatch: ${formatMeetingDate(order.expected_dispatch_date)}`)
  }

  lines.push('', `From meeting: ${meeting.title} (${formatMeetingDate(meeting.meeting_date)})`)

  if (item.issue)         lines.push('', `Issue: ${item.issue}`)
  if (item.latest_update) lines.push('', `Latest update: ${item.latest_update}`)

  return lines.join('\n')
}

export function buildMeetingTaskDraft(
  meeting: Meeting,
  order: MeetingOrder,
  item: MeetingOrderItem,
): MeetingTaskDraft {
  return {
    title: meetingTaskTitle(order, item),
    description: meetingTaskDescription(meeting, order, item),
  }
}

/**
 * Which team the task is filed under.
 *
 * The SKU line's responsible department when it has one — a polishing delay is
 * Operations' task even when Sales raised it — falling back to the creator's
 * own team, which is what /tasks/create does.
 */
export function meetingTaskTeam(item: MeetingOrderItem, creatorTeam: string): string {
  return item.responsible_department?.trim() || creatorTeam
}
