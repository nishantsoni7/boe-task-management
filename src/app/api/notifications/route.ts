import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory } from '@/lib/notifications'

// Lists the authenticated user's notifications (newest first), or — with
// `?count=1` — returns only the unread count for the sidebar badge.
// `?category=task|finance|order` narrows either path to one module's own rows
// (see getNotificationCategoryFilter). An absent category defaults to `task`
// for backward compatibility; a present-but-unrecognized value is rejected
// with 400 rather than silently falling back (see resolveNotificationCategory).
// Reads go through the service-role key so the feature does not depend on
// client-side RLS; every query is explicitly scoped to the caller's user id.
export async function GET(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const categoryResult = resolveNotificationCategory(req.nextUrl.searchParams.get('category'))
  if (!categoryResult.ok) {
    return NextResponse.json({ error: categoryResult.error }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const activityFilter = getNotificationCategoryFilter(categoryResult.category)

  // Lightweight badge path: just the unread count.
  if (req.nextUrl.searchParams.get('count') === '1') {
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false)
      .or(activityFilter)
    if (error) {
      console.error('[notifications] count failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ unreadCount: count ?? 0 })
  }

  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, task_id, entity_id, type, title, body, is_read, is_push_sent, is_digest, created_at, read_at')
    .eq('user_id', user.id)
    .or(activityFilter)
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

// Deletes all of ONE module's notifications for the authenticated user —
// `?category=task|finance|order`, defaulting to `task` when absent (same rule
// as GET; a present-but-unrecognized value is rejected with 400). Always
// scoped to a single module's filter so "Delete all" on one module's page can
// never remove another module's rows.
// Also scoped strictly to user_id = caller — no other user's rows are touched.
export async function DELETE(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const categoryResult = resolveNotificationCategory(req.nextUrl.searchParams.get('category'))
  if (!categoryResult.ok) {
    return NextResponse.json({ error: categoryResult.error }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const activityFilter = getNotificationCategoryFilter(categoryResult.category)
  // `.select('id')` so the response can report how many of the caller's rows
  // were actually removed, matching the contract of /api/notifications/[id]
  // and /delete-selected. A category with nothing in it deletes 0 rows and is
  // still a success — that is an accurate idempotent result, not a failure.
  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', user.id)
    .or(activityFilter)
    .select('id')

  if (error) {
    // Message only — never the deleted rows, whose titles/bodies carry task
    // titles and client names.
    console.error('[notifications/delete-all] failed:', error.message)
    return NextResponse.json({ error: 'Could not delete notifications' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    category: categoryResult.category,
    deletedCount: data?.length ?? 0,
  })
}
