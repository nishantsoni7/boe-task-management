import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { NOTIFICATION_ACTIVITY_OR } from '@/lib/notifications'

// Lists the authenticated user's notifications (newest first), or — with
// `?count=1` — returns only the unread count for the sidebar badge.
// Reads go through the service-role key so the feature does not depend on
// client-side RLS; every query is explicitly scoped to the caller's user id.
export async function GET(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Lightweight badge path: just the unread count.
  if (req.nextUrl.searchParams.get('count') === '1') {
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false)
      .or(NOTIFICATION_ACTIVITY_OR)
    if (error) {
      console.error('[notifications] count failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ unreadCount: count ?? 0 })
  }

  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, task_id, type, title, body, is_read, is_push_sent, is_digest, created_at, read_at')
    .eq('user_id', user.id)
    .or(NOTIFICATION_ACTIVITY_OR)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('[notifications] list failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const notifications = data ?? []
  const unreadCount = notifications.filter(n => !n.is_read).length
  return NextResponse.json({ notifications, unreadCount })
}

// Deletes ALL notifications for the authenticated user.
// Scoped strictly to user_id = caller — no other user's rows are touched.
export async function DELETE(_req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', user.id)

  if (error) {
    console.error('[notifications/delete-all] failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
