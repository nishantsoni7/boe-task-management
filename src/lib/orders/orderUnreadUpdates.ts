// THE "NEW UPDATE" STATE ON THE CONFIRMED ORDERS LIST — per reader, per Order.
//
// WHERE THE STATE LIVES
// ---------------------
// In `notifications`, and nowhere else. Each Order update is already ONE ROW
// PER RECIPIENT with its own `is_read`, and each row's `entity_id` is the Order
// it is about. So "does this reader have unread updates on this Order?" is a
// question the notification system can already answer, exactly, for that one
// person — and one reader marking theirs read cannot touch anybody else's,
// because those are different rows.
//
// THE ALTERNATIVE THAT WAS NOT BUILT. A boolean on `orders` — order_has_update
// — would have been one column and completely wrong: the first person to open
// the Order would clear it for the whole company, and nobody else would ever
// learn that it had moved. There is no per-user answer to be had from a
// per-Order column, and adding a second per-user table beside the one that
// already does this would leave two unread states to disagree with each other.
//
// This module holds the shaping only: it reads nothing and writes nothing.

import { ORDER_UPDATE_NOTIFICATION_TYPES } from './orderUpdateNotifications'

/** The types the list counts. Exported so the query and the tests share one list. */
export const ORDER_UNREAD_TYPES: readonly string[] = ORDER_UPDATE_NOTIFICATION_TYPES

/** One unread notification row, as the list reads it. */
export type UnreadUpdateRow = {
  entity_id: string | null
  created_at?: string | null
}

/**
 * How many unread updates this reader has, per Order.
 *
 * Rows with no `entity_id` are skipped rather than counted under a placeholder
 * key: a notification that does not name an Order cannot highlight one.
 */
export function unreadUpdateCounts(rows: readonly UnreadUpdateRow[] | null | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows ?? []) {
    const id = row.entity_id
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/**
 * What the badge says.
 *
 * "NEW UPDATE" for one, "2 NEW UPDATES" for more — the count only appears when
 * it tells the reader something. Null when there is nothing to say, so the
 * caller renders no badge rather than an empty one.
 */
export function unreadUpdateLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null
  return count === 1 ? 'NEW UPDATE' : `${count} NEW UPDATES`
}

/**
 * The oldest unread update's timestamp for one Order, or null.
 *
 * This is the line the Order page draws "New since your last visit" above:
 * everything the reader has not been told about happened at or after the
 * EARLIEST unread notification. Taking the latest instead would hide every
 * earlier unseen entry behind the divider.
 *
 * Unparseable and missing timestamps are ignored rather than treated as zero,
 * which would drag the line back to the beginning of the trail.
 */
export function oldestUnreadAt(rows: readonly UnreadUpdateRow[] | null | undefined): string | null {
  let oldest: string | null = null
  let oldestMs = Number.POSITIVE_INFINITY
  for (const row of rows ?? []) {
    const iso = row.created_at
    if (!iso) continue
    const ms = new Date(iso).getTime()
    if (!Number.isFinite(ms)) continue
    if (ms < oldestMs) { oldestMs = ms; oldest = iso }
  }
  return oldest
}
