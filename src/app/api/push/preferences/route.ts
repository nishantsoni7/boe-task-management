// GET /api/push/preferences            -> { muted: string[] }
// PUT /api/push/preferences { muted }  -> replaces the caller's muted categories
//
// Scoped to the signed-in user. A View As preview reads nothing of the previewed
// employee's and writes nothing.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'
import { PUSH_CATEGORIES } from '@/lib/push/pushPolicy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await authClient
    .from('push_preferences').select('muted_categories').eq('user_id', user.id).maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not load settings.' }, { status: 500 })
  return NextResponse.json({ muted: (data?.muted_categories as string[] | undefined) ?? [] })
}

export async function PUT(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isPreviewRequest(req.headers)) {
    return NextResponse.json({ error: PREVIEW_WRITE_REFUSED }, { status: 403 })
  }

  const body = await req.json().catch(() => null) as { muted?: unknown } | null
  const known: readonly string[] = PUSH_CATEGORIES
  if (!Array.isArray(body?.muted) || !body.muted.every((c) => typeof c === 'string' && known.includes(c))) {
    return NextResponse.json({ error: 'muted must be a list of known categories' }, { status: 400 })
  }
  const muted = Array.from(new Set(body.muted as string[]))

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[push/preferences] database access is not configured:', admin.missing.join(', '))
    return NextResponse.json({ error: 'Phone alerts are not available.' }, { status: 503 })
  }
  const { error } = await admin.client.from('push_preferences').upsert(
    { user_id: user.id, muted_categories: muted, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  )
  if (error) {
    console.error('[push/preferences] save failed:', error.message)
    return NextResponse.json({ error: 'Could not save settings.' }, { status: 500 })
  }
  return NextResponse.json({ muted })
}
