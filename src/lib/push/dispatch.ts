// Send the phone alert for one notification row.
//
// The route supplies the database and the push library as `deps`, so the
// decisions here (filter, mute, expire dead devices, never throw) are testable
// without either.

import { buildPushPayload, shouldPushNotification, type PushPayload, type PushSourceRow } from '@/lib/push/pushPolicy'

export type PushDevice = { id: string; endpoint: string; p256dh: string; auth: string }

export type DispatchDeps = {
  loadNotification: (id: string) => Promise<PushSourceRow | null>
  loadMutedCategories: (userId: string) => Promise<string[]>
  loadDevices: (userId: string) => Promise<PushDevice[]>
  /** Resolves on delivery to the push service; rejects with `statusCode` on failure. */
  send: (device: PushDevice, payload: PushPayload) => Promise<void>
  removeDevice: (deviceId: string) => Promise<void>
  log?: (message: string) => void
}

export type DispatchResult =
  | { outcome: 'skipped'; reason: 'not_found' | 'not_pushable' | 'no_devices' }
  | { outcome: 'sent'; sent: number; failed: number; removed: number }

/** A device the push service says is gone for good. */
function isGone(error: unknown): boolean {
  const code = (error as { statusCode?: number } | null)?.statusCode
  return code === 404 || code === 410
}

export async function dispatchPush(notificationId: string, deps: DispatchDeps): Promise<DispatchResult> {
  const row = await deps.loadNotification(notificationId)
  if (!row) return { outcome: 'skipped', reason: 'not_found' }

  const muted = await deps.loadMutedCategories(row.user_id)
  if (!shouldPushNotification(row, muted)) return { outcome: 'skipped', reason: 'not_pushable' }

  const devices = await deps.loadDevices(row.user_id)
  if (devices.length === 0) return { outcome: 'skipped', reason: 'no_devices' }

  const payload = buildPushPayload(row)
  let sent = 0
  let failed = 0
  let removed = 0
  // One device failing must not stop the others.
  await Promise.all(devices.map(async (device) => {
    try {
      await deps.send(device, payload)
      sent += 1
    } catch (error) {
      if (isGone(error)) {
        removed += 1
        await deps.removeDevice(device.id).catch(() => undefined)
      } else {
        failed += 1
        deps.log?.(`push to device ${device.id} failed: ${(error as Error)?.message ?? 'unknown'}`)
      }
    }
  }))
  return { outcome: 'sent', sent, failed, removed }
}
