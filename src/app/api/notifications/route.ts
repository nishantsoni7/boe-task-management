import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { canReadNotificationCategory, CATEGORY_FORBIDDEN } from '@/lib/notificationAccess'
import { isValidUUID } from '@/lib/ui'
import { NOTIFICATION_PAGE_SIZE, NOTIFICATION_MAX_ROWS } from '@/lib/notificationPaging'
import { collectTaskIds, fetchTaskHeaderInfo } from '@/lib/notifications/taskAssignees'

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
    // DETERMINISTIC TIEBREAK. `created_at` is not unique — a batch insert
    // (every admin notified of one objection, the warranty sweep) writes many
    // rows on the same transaction timestamp. Ordering by it alone leaves ties
    // in whatever order the plan happens to produce, so two requests for
    // overlapping windows can disagree about which side of the LIMIT a tied row
    // falls on, and "Load older" could come back missing a row it had already
    // shown. `id` is the primary key, so this makes the sort total.
    .order('id', { ascending: false })
    .limit(limit + 1)

  if (error) {
    console.error('[notifications] list failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data ?? []
  const hasMore = rows.length > limit
  const notifications = hasMore ? rows.slice(0, limit) : rows

  // ── Task header facts: title and assignee, for the whole page at once ──
  //
  // TWO QUERIES, NOT ONE PER CARD. The ids come from `notifications`, which is
  // already clamped to NOTIFICATION_MAX_ROWS and already scoped to this caller,
  // so both lookups are bounded by the page and can only describe tasks this
  // person is being notified about. A failure returns an empty map and the
  // cards say "Assignee unavailable" — a notification list is more useful
  // without an assignee than absent. See src/lib/notifications/taskAssignees.ts
  // for why the newest event's ACTOR is not an acceptable substitute.
  const taskHeaders = categoryResult.category === 'task'
    ? await fetchTaskHeaderInfo(supabase, collectTaskIds(notifications))
    : {}
  // Unread among the rows returned. NOT the category's total unread — that is
  // what `?count=1` is for, and the badge reads it from there. Kept in the
  // response because callers have always had it.
  const unreadCount = notifications.filter(n => !n.is_read).length
  return NextResponse.json({ notifications, unreadCount, hasMore, limit, taskHeaders })
}

// Deletes ONE module's notifications for the authenticated user —
// `?category=task|finance|order`, defaulting to `task` when absent (same rule
// as GET; a present-but-unrecognized value is rejected with 400). Always
// scoped to a single module's filter so "Delete all" on one module's page can
// never remove another module's rows.
// Also scoped strictly to user_id = caller — no other user's rows are touched.
//
// `?taskId=<uuid>` narrows the same operation to ONE task: "Delete all
// notifications for this task". It belongs here rather than on
// /delete-selected because this route ALREADY carries the category filter and
// the system-type exclusion that a group action needs, and /delete-selected is
// deliberately id-only (it takes ids the caller already holds, so it needs no
// category — see attendancePayrollNotifications.test.ts).
//
// WHY NOT DRIVE IT FROM LOADED IDS. The page is bounded to the newest N. A
// group delete built from loaded ids leaves older rows for that task on the
// server, so the group reappears the moment somebody presses "Load older" and
// the unread badge stays wrong in the meantime. The task id lets the DATABASE
// decide the set.
//
// IT DELETES NOTIFICATION ROWS AND NOTHING ELSE. No task, no activity record,
// no comment, no attachment: this statement names one table.
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

  // Optional narrowing to one task. Validated before Postgres sees it: a
  // malformed value would otherwise surface as a 22P02 cast error dressed up as
  // a 500 rather than the 400 it is.
  const taskId = req.nextUrl.searchParams.get('taskId')
  if (taskId !== null && !isValidUUID(taskId)) {
    return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })
  }

  const activityFilter = getNotificationCategoryFilter(categoryResult.category)
  // `.select('id, is_read')` so the response reports BOTH how many of the
  // caller's rows were removed and how many of those were unread — the exact
  // number the badge must drop by. Both come from the DELETE itself, so there
  // is no count-then-delete window in which the two could disagree.
  //
  // A category (or task) with nothing in it deletes 0 rows and is still a
  // success — an accurate idempotent result, not a failure.
  let deleteQuery = supabase
    .from('notifications')
    .delete()
    .eq('user_id', user.id)
    .or(activityFilter)
    .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
  // An EXTRA condition on top of the caller, category and system filters —
  // never a replacement for any of them.
  if (taskId !== null) deleteQuery = deleteQuery.eq('task_id', taskId)

  const { data, error } = await deleteQuery.select('id, is_read')

  if (error) {
    // Message only — never the deleted rows, whose titles/bodies carry task
    // titles and client names.
    console.error('[notifications/delete-all] failed:', error.message)
    return NextResponse.json({ error: 'Could not delete notifications' }, { status: 500 })
  }

  const deleted = data ?? []
  return NextResponse.json({
    success: true,
    category: categoryResult.category,
    taskId: taskId ?? undefined,
    deletedCount: deleted.length,
    // Exact, from the same statement. The client subtracts this rather than
    // counting the unread rows it happened to have loaded, which for a bounded
    // page is only ever a lower bound.
    unreadAffected: deleted.reduce((acc, r) => (r.is_read ? acc : acc + 1), 0),
  })
}
