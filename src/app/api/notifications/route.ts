import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { canReadNotificationCategory, CATEGORY_FORBIDDEN } from '@/lib/notificationAccess'
import { NOTIFICATION_PAGE_SIZE, NOTIFICATION_MAX_ROWS } from '@/lib/notificationPaging'

/**
 * Clamp a caller-supplied `?limit=` into [1, NOTIFICATION_MAX_ROWS].
 *
 * Absent / non-numeric / out of range all resolve to a usable bound rather
 * than an error: the worst a bad value can do is show the first page.
 */
function clampNotificationLimit(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return NOTIFICATION_PAGE_SIZE
  return Math.min(Math.floor(n), NOTIFICATION_MAX_ROWS)
}

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

  // Some feeds are management information, not self-service (see
  // ADMIN_ONLY_CATEGORIES). Checked before the filter is even built, and on the
  // count path as well as the list path — an unread number is itself a fact
  // about how many colleagues have disputed their pay.
  if (!(await canReadNotificationCategory(supabase, user.id, categoryResult.category))) {
    return NextResponse.json({ error: CATEGORY_FORBIDDEN }, { status: 403 })
  }

  const activityFilter = getNotificationCategoryFilter(categoryResult.category)

  // Lightweight badge path: just the unread count.
  if (req.nextUrl.searchParams.get('count') === '1') {
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false)
      .or(activityFilter)
      .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
    if (error) {
      console.error('[notifications] count failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ unreadCount: count ?? 0 })
  }

  // BOUNDED, ALWAYS. `?limit=` lets the page ask for a further block when the
  // reader presses "Load older"; it is clamped to NOTIFICATION_MAX_ROWS, so no
  // request — crafted or accidental — can ever pull the full history down. A
  // missing or unparseable value falls back to the first page rather than 400ing:
  // this is a display bound, not a business input.
  const limit = clampNotificationLimit(req.nextUrl.searchParams.get('limit'))

  // One extra row than asked for, purely to answer "is there anything older?".
  // It is dropped before the response, so the client still receives exactly
  // `limit` rows and `hasMore` costs no second query.
  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, task_id, entity_id, type, title, body, is_read, is_push_sent, is_digest, created_at, read_at')
    .eq('user_id', user.id)
    .or(activityFilter)
    .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
    .order('created_at', { ascending: false })
    .limit(limit + 1)

  if (error) {
    console.error('[notifications] list failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data ?? []
  const hasMore = rows.length > limit
  const notifications = hasMore ? rows.slice(0, limit) : rows
  // Unread among the rows returned. NOT the category's total unread — that is
  // what `?count=1` is for, and the badge reads it from there. Kept in the
  // response because callers have always had it.
  const unreadCount = notifications.filter(n => !n.is_read).length
  return NextResponse.json({ notifications, unreadCount, hasMore, limit })
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

  // Same gate as GET: a category nobody may read is a category nobody may
  // empty. Without this, "Delete all" would be a write path into a feed the
  // read path refuses.
  if (!(await canReadNotificationCategory(supabase, user.id, categoryResult.category))) {
    return NextResponse.json({ error: CATEGORY_FORBIDDEN }, { status: 403 })
  }

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
    .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
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
