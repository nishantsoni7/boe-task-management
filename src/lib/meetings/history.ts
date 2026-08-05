// Rendering the append-only update history.
//
// The history table stores before/after pairs; a reader wants sentences. This
// file is the translation, kept out of the JSX so "what a history row says" can
// be asserted directly — including the case that matters most, where a previous
// commitment existed and must still be visible next to the new one.

import { formatMeetingDate, type MeetingHistoryEntry, type MeetingHistoryEntryType } from './types'

export const HISTORY_ENTRY_LABEL: Record<MeetingHistoryEntryType, string> = {
  order_added:  'Order added',
  order_update: 'Order update',
  item_added:   'Product added',
  item_update:  'Update',
  task_linked:  'Task created',
  import:       'Spreadsheet import',
}

const STATUS_WORD: Record<string, string> = {
  open: 'Open', waiting: 'Waiting', resolved: 'Resolved',
  on_track: 'On Track', attention: 'Attention', at_risk: 'At Risk', closed: 'Closed',
}

const word = (raw: string | null): string =>
  raw ? (STATUS_WORD[raw] ?? raw) : '—'

/**
 * The supporting lines under a history entry's headline — the status move, the
 * follow-up move, and whatever `detail` the RPC recorded. Each is included only
 * when the save actually changed it, which is what keeps a drawer of twelve
 * updates readable.
 */
export function historyChangeLines(entry: MeetingHistoryEntry): string[] {
  const lines: string[] = []

  if (entry.previous_status || entry.new_status) {
    lines.push(`Status: ${word(entry.previous_status)} → ${word(entry.new_status)}`)
  }

  if (entry.previous_follow_up_date || entry.new_follow_up_date) {
    const from = entry.previous_follow_up_date ? formatMeetingDate(entry.previous_follow_up_date) : 'none'
    const to   = entry.new_follow_up_date      ? formatMeetingDate(entry.new_follow_up_date)      : 'cleared'
    lines.push(`Follow-up: ${from} → ${to}`)
  }

  if (entry.detail) lines.push(entry.detail)

  return lines
}

/**
 * True when this entry carries an update the reader should see as a quotation
 * rather than as a change line.
 */
export function hasUpdateText(entry: MeetingHistoryEntry): boolean {
  return !!entry.new_update && entry.new_update.trim() !== ''
}

/**
 * The previous commitment, shown alongside the new one.
 *
 * This is the single most valuable thing on the working screen — "what did we
 * say last time?" is the first question asked about every SKU — so it is
 * surfaced explicitly rather than left for the reader to scroll and infer.
 * Returns null when there was nothing before, which reads as "first update"
 * rather than as an empty quotation.
 */
export function previousCommitment(entry: MeetingHistoryEntry): string | null {
  const prev = entry.previous_update?.trim()
  return prev ? prev : null
}

/** Newest first — the order the drawer reads in. */
export function sortHistory(entries: readonly MeetingHistoryEntry[]): MeetingHistoryEntry[] {
  return [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * History for one SKU line.
 *
 * Matched on the item id, and NOT on the sku/order snapshots: two lines can
 * legitimately share a SKU string across different orders, and the snapshots
 * exist to keep an orphaned row readable, not to identify it.
 */
export function historyForItem(
  entries: readonly MeetingHistoryEntry[],
  itemId: string,
): MeetingHistoryEntry[] {
  return sortHistory(entries.filter(e => e.meeting_order_item_id === itemId))
}

/**
 * The update this SKU's current one replaced — the "what did we say last time?"
 * line shown beside every row and at the top of the update dialog.
 *
 * Taken from the `previous_update` of the newest entry that actually carried an
 * update, rather than from the second-newest entry's `new_update`. The two are
 * the same in the simple case and differ in the one that matters: a save that
 * only changed a status writes an entry with no update text, and reading the
 * second-newest entry would then report a stale value as the previous
 * commitment.
 */
export function previousUpdateForItem(
  entries: readonly MeetingHistoryEntry[],
  itemId: string,
): string | null {
  const latest = historyForItem(entries, itemId).find(hasUpdateText)
  return latest ? previousCommitment(latest) : null
}

/**
 * `previousUpdateForItem` for every item at once, in ONE pass.
 *
 * The per-item function filters and sorts the whole history array on each call.
 * Called from a table row it is O(rows × history) on every render — a 40-SKU
 * order with 600 history entries re-scanned 24,000 entries per keystroke
 * elsewhere on the screen. This computes the same answers once.
 *
 * Identical semantics to `previousUpdateForItem`, including the rule that an
 * entry carrying no update text is skipped.
 */
export function previousUpdateByItem(
  entries: readonly MeetingHistoryEntry[],
): Map<string, string | null> {
  const newest = new Map<string, MeetingHistoryEntry>()
  for (const entry of entries) {
    const itemId = entry.meeting_order_item_id
    if (!itemId || !hasUpdateText(entry)) continue
    const current = newest.get(itemId)
    if (!current || entry.created_at > current.created_at) newest.set(itemId, entry)
  }

  const out = new Map<string, string | null>()
  for (const [itemId, entry] of newest) out.set(itemId, previousCommitment(entry))
  return out
}

/** History for an order, including every SKU line beneath it. */
export function historyForOrder(
  entries: readonly MeetingHistoryEntry[],
  orderId: string,
): MeetingHistoryEntry[] {
  return sortHistory(entries.filter(e => e.meeting_order_id === orderId))
}
