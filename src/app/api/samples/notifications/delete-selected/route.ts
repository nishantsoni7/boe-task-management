import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/ui'

// Deletes a specific set of sample notifications for the authenticated user.
// Body: { ids: string[] }
//
// A direct mirror of /api/notifications/delete-selected, against
// `sample_notifications` instead of `notifications`, so the client can handle
// both the same way:
//   200 { success: true, deletedIds: string[], deletedCount: n }
//   400 / 401 / 500 on real failures
//
// `deletedIds` is what the caller actually owned and removed; ids that matched
// nothing are simply absent, which is an idempotent success rather than an
// error. Every query is scoped to `user_id = caller`, so ids belonging to
// another user behave exactly like ids that do not exist — the response reveals
// nothing about them, and no row of theirs is deleted.
//
// Only `sample_notifications` is touched: sample requests, activity/audit
// records, QR submissions, approvals, dispatch records and attachments live in
// their own tables and are never referenced here.
const MAX_IDS = 200

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as { ids?: unknown } | null
  const ids = body?.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }
  // Bounded and shape-checked before hitting Postgres: an unbounded `.in()`
  // list is a trivially large query, and a single malformed id would fail the
  // whole statement as a 22P02 cast error surfaced as a 500.
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `Cannot delete more than ${MAX_IDS} notifications at once` }, { status: 400 })
  }
  if (!ids.every(isValidUUID)) {
    return NextResponse.json({ error: 'ids must all be valid notification ids' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data, error } = await supabase
    .from('sample_notifications')
    .delete()
    .eq('user_id', user.id)
    .in('id', ids)
    .select('id')

  if (error) {
    console.error('[samples/notifications/delete-selected] failed:', error.message)
    return NextResponse.json({ error: 'Could not delete the selected notifications' }, { status: 500 })
  }

  const deletedIds = (data ?? []).map(r => r.id)
  return NextResponse.json({ success: true, deletedIds, deletedCount: deletedIds.length })
}
