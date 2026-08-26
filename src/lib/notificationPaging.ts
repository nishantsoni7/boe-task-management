// How much notification history the Notifications page is allowed to hold.
//
// Shared by the API route and the client hook so the two cannot disagree about
// the bound — the server clamps to it, the client stops offering "Load older"
// at it.
//
// The page never downloads the full history. It opens on the newest
// NOTIFICATION_PAGE_SIZE rows, and each "Load older" press raises the ceiling by
// one more page up to NOTIFICATION_MAX_ROWS. Everything older than that stays on
// the server; "Mark all read" and "Delete all" are server-side operations over
// the whole category, so nothing depends on having loaded it.

/** The first page — what the Notifications page opens with. */
export const NOTIFICATION_PAGE_SIZE = 50

/** The hard ceiling. A request asking for more is clamped down to this. */
export const NOTIFICATION_MAX_ROWS = 200

/** The next page ceiling after `current`, clamped. Equal to `current` when exhausted. */
export function nextNotificationLimit(current: number): number {
  return Math.min(current + NOTIFICATION_PAGE_SIZE, NOTIFICATION_MAX_ROWS)
}
