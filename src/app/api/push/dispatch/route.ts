// POST /api/push/dispatch  { notification_id }
//
// Called by the database (trigger notifications_push_dispatch, via pg_net) right
// after a notification row is inserted, to send that row's phone alert. Not a
// browser route: it authenticates with a shared secret, `PUSH_DISPATCH_SECRET`,
// and answers 503 doing nothing when the push keys are not configured.
//
// Always answers 200 for a well-formed call, even when no alert was sent: the
// caller is a database trigger that cannot do anything with a failure, and a
// notification must never be undone by its alert.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import webpush from 'web-push'
import { adminClient } from '@/lib/supabase/admin'
import { isValidUUID } from '@/lib/ui'
import { dispatchPush, type PushDevice } from '@/lib/push/dispatch'
import type { PushSourceRow } from '@/lib/push/pushPolicy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const expected = process.env.PUSH_DISPATCH_SECRET
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!expected || !publicKey || !privateKey || !subject) {
    console.error('[push/dispatch] push is not configured - refusing to run')
    return NextResponse.json({ error: 'Phone alerts are not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null) as { notification_id?: unknown } | null
  const notificationId = body?.notification_id
  if (typeof notificationId !== 'string' || !isValidUUID(notificationId)) {
    return NextResponse.json({ error: 'notification_id is required' }, { status: 400 })
  }

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[push/dispatch] database access is not configured:', admin.missing.join(', '))
    return NextResponse.json({ error: 'Phone alerts are not configured.' }, { status: 503 })
  }
  const db = admin.client
  webpush.setVapidDetails(subject, publicKey, privateKey)

  try {
    const result = await dispatchPush(notificationId, {
      loadNotification: async (id) => {
        const { data } = await db
          .from('notifications')
          .select('id, user_id, task_id, entity_id, type, title, body, is_digest')
          .eq('id', id)
          .maybeSingle()
        return (data as PushSourceRow | null) ?? null
      },
      loadMutedCategories: async (userId) => {
        const { data } = await db
          .from('push_preferences').select('muted_categories').eq('user_id', userId).maybeSingle()
        return (data?.muted_categories as string[] | undefined) ?? []
      },
      loadDevices: async (userId) => {
        const { data } = await db
          .from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId)
        return (data as PushDevice[] | null) ?? []
      },
      send: async (device, payload) => {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 24, urgency: 'high' },
        )
      },
      removeDevice: async (deviceId) => {
        await db.from('push_subscriptions').delete().eq('id', deviceId)
      },
      log: (message) => console.error('[push/dispatch]', message),
    })
    return NextResponse.json(result)
  } catch (error) {
    console.error('[push/dispatch] failed:', (error as Error)?.message)
    return NextResponse.json({ outcome: 'error' })
  }
}
