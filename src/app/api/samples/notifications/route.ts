import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

function serviceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// GET /api/samples/notifications          — list for current user (newest first)
// GET /api/samples/notifications?count=1  — unread count only
export async function GET(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = serviceClient()

  if (req.nextUrl.searchParams.get('count') === '1') {
    const { count, error } = await supabase
      .from('sample_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ unreadCount: count ?? 0 })
  }

  const { data, error } = await supabase
    .from('sample_notifications')
    .select('id, user_id, event, title, body, is_read, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const notifications = data ?? []
  return NextResponse.json({
    notifications,
    unreadCount: notifications.filter(n => !n.is_read).length,
  })
}

// PATCH /api/samples/notifications — mark all read for current user
export async function PATCH(_req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = serviceClient()
  const { error } = await supabase
    .from('sample_notifications')
    .update({ is_read: true })
    .eq('user_id', user.id)
    .eq('is_read', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// DELETE /api/samples/notifications — delete ALL of the caller's sample
// notifications. Mirrors the DELETE on /api/notifications, minus the category
// parameter: `sample_notifications` holds nothing but Sample Tracking rows, so
// the table itself is the scope and there is no other module's feed to protect.
//
// Scoped strictly to `user_id = caller`, so no other user's rows are ever
// touched, and confined to `sample_notifications` — sample requests, their
// activity/audit history, QR submissions, approvals, dispatch records and
// attachments live in separate tables and are not referenced here.
//
// Deleting 0 rows is a success, not a failure — that is an accurate idempotent
// result for an already-empty inbox.
export async function DELETE(_req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = serviceClient()
  const { data, error } = await supabase
    .from('sample_notifications')
    .delete()
    .eq('user_id', user.id)
    .select('id')

  if (error) {
    // Message only — never the deleted rows, whose titles/bodies carry sample
    // labels and actor names.
    console.error('[samples/notifications/delete-all] failed:', error.message)
    return NextResponse.json({ error: 'Could not delete notifications' }, { status: 500 })
  }

  return NextResponse.json({ success: true, deletedCount: data?.length ?? 0 })
}
