// POST   /api/push/subscription  { endpoint, keys: { p256dh, auth } }  turn alerts on for this device
// DELETE /api/push/subscription  { endpoint }                          turn them off
//
// Every write is scoped to the signed-in user. A device is one row, keyed by its
// push endpoint: signing in as someone else on the same phone re-points the row
// to them, so the previous person stops receiving alerts there. A View As
// preview may never write (it would register the administrator's own phone
// under the previewed employee's name).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FIELD = 1024

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD ? value : null
}

async function caller(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  if (isPreviewRequest(req.headers)) {
    return { error: NextResponse.json({ error: PREVIEW_WRITE_REFUSED }, { status: 403 }) } as const
  }
  const admin = adminClient()
  if (!admin.ok) {
    console.error('[push/subscription] database access is not configured:', admin.missing.join(', '))
    return { error: NextResponse.json({ error: 'Phone alerts are not available.' }, { status: 503 }) } as const
  }
  return { user, db: admin.client } as const
}

export async function POST(req: NextRequest) {
  const who = await caller(req)
  if ('error' in who) return who.error

  const body = await req.json().catch(() => null) as
    { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
  const endpoint = text(body?.endpoint)
  const p256dh = text(body?.keys?.p256dh)
  const auth = text(body?.keys?.auth)
  if (!endpoint || !endpoint.startsWith('https://') || !p256dh || !auth) {
    return NextResponse.json({ error: 'A valid push subscription is required' }, { status: 400 })
  }

  const { error } = await who.db.from('push_subscriptions').upsert(
    {
      user_id: who.user.id,
      endpoint,
      p256dh,
      auth,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' },
  )
  if (error) {
    console.error('[push/subscription] save failed:', error.message)
    return NextResponse.json({ error: 'Could not turn on phone alerts.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const who = await caller(req)
  if ('error' in who) return who.error

  const body = await req.json().catch(() => null) as { endpoint?: unknown } | null
  const endpoint = text(body?.endpoint)
  if (!endpoint) return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })

  const { error } = await who.db
    .from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', who.user.id)
  if (error) {
    console.error('[push/subscription] delete failed:', error.message)
    return NextResponse.json({ error: 'Could not turn off phone alerts.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
