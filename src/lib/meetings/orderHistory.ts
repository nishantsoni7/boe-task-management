// One Order's discussion across meetings.
//
// A meeting is a dated record, and the same Order returns to later meetings as a
// NEW meeting_orders row under the same normalised order_number_key. Nothing is
// copied forward: an earlier meeting's rows stay exactly as they were recorded,
// and today's update becomes a new row in today's meeting. This file is the pure
// half of reading that back — which meetings count as "earlier", which history
// rows are discussion rather than bookkeeping, and how updates and evidence read
// together — so the rules can be asserted without a database.

import { hasUpdateText } from './history'
import type {
  MeetingHistoryEntry, MeetingOrderEvidence, MeetingStatus, MeetingType, OrderPosition,
} from './types'

type MeetingClock = { meeting_date: string; created_at: string }

/**
 * Whether meeting `a` was held before meeting `b`: by meeting date, then by when
 * it was raised, so two reviews on the same day still have an order.
 */
export function meetingIsBefore(a: MeetingClock, b: MeetingClock): boolean {
  if (a.meeting_date !== b.meeting_date) return a.meeting_date < b.meeting_date
  return a.created_at < b.created_at
}

/** The normalised Order key, as the generated column computes it. */
export function orderNumberKey(order: { order_number: string; order_number_key?: string | null }): string {
  return order.order_number_key ?? order.order_number.trim().toUpperCase()
}

export type EarlierMeetingOrder = {
  /** The meeting_orders row in that earlier meeting. */
  id: string
  meeting_id: string
  order_number: string
  position: OrderPosition
  latest_update: string | null
  next_review_date: string | null
  meeting: {
    id: string
    title: string
    meeting_date: string
    meeting_type: MeetingType
    status: MeetingStatus
    created_at: string
  } | null
}

/**
 * This Order's rows in meetings held BEFORE the current one, newest first.
 *
 * A later meeting is not "previous history" for an earlier one: opening last
 * month's completed review must show what was known then, not what happened
 * after it. A row whose meeting did not come back (the join was not readable)
 * is dropped rather than shown without a date.
 */
export function earlierMeetingOrders(
  rows: readonly EarlierMeetingOrder[],
  current: { id: string } & MeetingClock,
): EarlierMeetingOrder[] {
  return rows
    .filter(r => r.meeting && r.meeting_id !== current.id && meetingIsBefore(r.meeting, current))
    .sort((a, b) => (meetingIsBefore(a.meeting!, b.meeting!) ? 1 : -1))
}

/**
 * A history row a reader wants in a discussion, as opposed to bookkeeping.
 *
 *   order_added              never — being on the agenda is the group itself
 *   item_added               only if the line was added WITH an update
 *   import                   only if it carried an update or moved a follow-up
 *   order_update, item_update, task_linked — always
 */
export function isDiscussionEntry(entry: MeetingHistoryEntry): boolean {
  switch (entry.entry_type) {
    case 'order_added':
      return false
    case 'item_added':
      return hasUpdateText(entry)
    case 'import':
      return hasUpdateText(entry) || !!entry.new_follow_up_date || !!entry.previous_follow_up_date
    default:
      return true
  }
}

export type TimelineItem =
  | { kind: 'entry'; at: string; entry: MeetingHistoryEntry }
  | { kind: 'evidence'; at: string; items: MeetingOrderEvidence[] }

/**
 * Updates and evidence for ONE meeting's discussion of an Order, oldest first —
 * the order it happened in, so "raised with Operations" is followed by the
 * screenshot of that request. Images uploaded one after another collapse into
 * one strip.
 */
export function mergeDiscussionTimeline(
  entries: readonly MeetingHistoryEntry[],
  evidence: readonly MeetingOrderEvidence[],
): TimelineItem[] {
  const raw: TimelineItem[] = [
    ...entries.filter(isDiscussionEntry).map(entry => ({ kind: 'entry' as const, at: entry.created_at, entry })),
    ...evidence.map(item => ({ kind: 'evidence' as const, at: item.created_at, items: [item] })),
  ]
  // Stable on ties: an update saved in the same instant as an image reads first.
  raw.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === 'entry' ? -1 : 1))

  const out: TimelineItem[] = []
  for (const item of raw) {
    const last = out[out.length - 1]
    if (item.kind === 'evidence' && last?.kind === 'evidence') {
      last.items.push(...item.items)
      last.at = item.at
    } else {
      out.push(item.kind === 'evidence' ? { ...item, items: [...item.items] } : item)
    }
  }
  return out
}

export type EarlierMeetingGroup = {
  meetingOrder: EarlierMeetingOrder
  items: TimelineItem[]
  updateCount: number
  evidenceCount: number
  /** The last thing said about the Order in that meeting, for a collapsed row. */
  lastUpdate: string | null
}

/** One group per earlier meeting, in the order `earlierOrders` is given. */
export function groupEarlierDiscussions(
  earlierOrders: readonly EarlierMeetingOrder[],
  entries: readonly MeetingHistoryEntry[],
  evidence: readonly MeetingOrderEvidence[],
): EarlierMeetingGroup[] {
  const entriesByOrder = new Map<string, MeetingHistoryEntry[]>()
  for (const e of entries) {
    if (!e.meeting_order_id) continue
    const list = entriesByOrder.get(e.meeting_order_id) ?? []
    list.push(e)
    entriesByOrder.set(e.meeting_order_id, list)
  }
  const evidenceByOrder = new Map<string, MeetingOrderEvidence[]>()
  for (const ev of evidence) {
    const list = evidenceByOrder.get(ev.meeting_order_id) ?? []
    list.push(ev)
    evidenceByOrder.set(ev.meeting_order_id, list)
  }

  return earlierOrders.map(meetingOrder => {
    const orderEntries = entriesByOrder.get(meetingOrder.id) ?? []
    const orderEvidence = evidenceByOrder.get(meetingOrder.id) ?? []
    const items = mergeDiscussionTimeline(orderEntries, orderEvidence)
    const withText = items
      .filter((i): i is Extract<TimelineItem, { kind: 'entry' }> => i.kind === 'entry' && hasUpdateText(i.entry))
    return {
      meetingOrder,
      items,
      updateCount: items.filter(i => i.kind === 'entry').length,
      evidenceCount: orderEvidence.length,
      lastUpdate: withText.length > 0
        ? withText[withText.length - 1].entry.new_update
        : meetingOrder.latest_update,
    }
  })
}

export type EarlierPresence = { count: number; lastMeetingDate: string }

/**
 * For the board: per Order key, how many earlier meetings discussed it and when
 * the most recent of them was. Only meetings held before the current one count.
 */
export function earlierPresenceByKey(
  rows: readonly { order_number_key: string; meeting_id: string; meeting: MeetingClock | null }[],
  current: { id: string } & MeetingClock,
): Map<string, EarlierPresence> {
  const meetingsByKey = new Map<string, Map<string, string>>()
  for (const row of rows) {
    if (!row.meeting || row.meeting_id === current.id || !meetingIsBefore(row.meeting, current)) continue
    const meetings = meetingsByKey.get(row.order_number_key) ?? new Map<string, string>()
    meetings.set(row.meeting_id, row.meeting.meeting_date)
    meetingsByKey.set(row.order_number_key, meetings)
  }

  const out = new Map<string, EarlierPresence>()
  for (const [key, meetings] of meetingsByKey) {
    const dates = [...meetings.values()].sort()
    out.set(key, { count: meetings.size, lastMeetingDate: dates[dates.length - 1] })
  }
  return out
}

export type DiscussionState = { updates: number; evidence: number; lastAt: string | null }

/** For the board: what has been recorded against each Order in THIS meeting. */
export function discussionStateByOrder(
  history: readonly MeetingHistoryEntry[],
  evidence: readonly MeetingOrderEvidence[],
): Map<string, DiscussionState> {
  const out = new Map<string, DiscussionState>()
  const touch = (orderId: string) => {
    const state = out.get(orderId) ?? { updates: 0, evidence: 0, lastAt: null }
    out.set(orderId, state)
    return state
  }
  for (const entry of history) {
    if (!entry.meeting_order_id || !isDiscussionEntry(entry)) continue
    const state = touch(entry.meeting_order_id)
    state.updates += 1
    if (!state.lastAt || entry.created_at > state.lastAt) state.lastAt = entry.created_at
  }
  for (const item of evidence) {
    const state = touch(item.meeting_order_id)
    state.evidence += 1
    if (!state.lastAt || item.created_at > state.lastAt) state.lastAt = item.created_at
  }
  return out
}
