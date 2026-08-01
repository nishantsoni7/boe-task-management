import type { AssetNotifyEvent } from './assetNotifications'

// Fire-and-forget notification dispatch from the browser.
//
// Called AFTER the custody RPC has returned successfully, never before and
// never inside it. Two consequences, both deliberate:
//
//   * a failed notification cannot undo a movement that physically happened.
//     The asset really did change hands; losing that because a mailbox insert
//     failed would be the wrong trade.
//   * the caller does not await it and does not surface its errors. A user who
//     has just successfully transferred an asset must not be shown a red banner
//     about a notification. The failure goes to the console, where it can be
//     found, and /api/assets/notify's own duplicate suppression means a retry
//     from a later action is harmless.

export type AssetNotifyPayload = {
  event: AssetNotifyEvent
  /**
   * The record the notification is about — an ASSET id for `asset_*`, an
   * ACCESS RECORD id for `access_*`. Becomes entity_id.
   */
  assetId: string
  assetName: string
  assetCode?: string | null
  toEmployeeId?: string | null
  fromEmployeeId?: string | null
  assignerId?: string | null
  requesterId?: string | null
  /** The employee an access record belongs to. */
  accessHolderId?: string | null
  toName?: string | null
  fromName?: string | null
  toLocation?: string | null
  vendor?: string | null
  daysToExpiry?: number | null
  requestType?: string | null
  note?: string | null
  documentKind?: string | null
  accessLabel?: string | null
  actorName?: string | null
}

export function notifyAssetEvent(payload: AssetNotifyPayload): void {
  void fetch('/api/assets/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(err => {
    console.error('[assets:notify] dispatch failed', { event: payload.event, err })
  })
}

/**
 * Ask the server to check for warranties inside the notice window.
 *
 * "Expiring soon" is the one required notification no user action produces — a
 * warranty crosses the line by itself, at midnight. BOE has no scheduler for
 * application code, so the sweep runs when someone who can act on the result
 * opens the inventory. Seven-day duplicate suppression on the server side is
 * what keeps that from being noise (see /api/assets/warranty-sweep).
 */
export function sweepWarrantyExpiries(): void {
  void fetch('/api/assets/warranty-sweep', { method: 'POST' }).catch(() => {
    // Silent by design: a reminder sweep that could not run is not something to
    // interrupt someone's inventory session over. The next visit tries again.
  })
}
