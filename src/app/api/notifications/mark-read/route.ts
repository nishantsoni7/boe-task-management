import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { canReadNotificationCategory, CATEGORY_FORBIDDEN } from '@/lib/notificationAccess'
import { isValidUUID } from '@/lib/ui'

/** Ceiling on an explicit id list, matching /api/notifications/delete-selected. */
const MAX_IDS = 200

// Marks notifications as read. Body: { id } for a single notification,
// { ids: [...] } for an explicit set — used by "mark this task's updates read",
// where the ids are the loaded events of one task group — or
// { all: true } to clear every unread one for the caller — narrowed to one
// module via { all: true, category: 'task'|'finance'|'order' }, so "Mark all
// read" on one module's page only touches that module's rows. An absent
// category defaults to `task` for backward compatibility; a present-but-
// unrecognized value is rejected with 400 (see resolveNotificationCategory).
// Category is only meaningful for { all: true } — a single { id } request is
// already scoped to that exact row and ignores it.
// Uses the service-role key but every write is scoped to `user_id = caller`,
// so a user can never mark another user's notifications as read.
export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const { id, ids, all, category } =
    (body ?? {}) as { id?: unknown; ids?: unknown; all?: unknown; category?: unknown }

  // `ids` is the same operation as `id`, for a known set. It exists so that
  // marking one task's group read is ONE request rather than one per event —
  // which would be N optimistic updates, N failure modes and N chances for the
  // unread count to end up wrong. Every row is still scoped to
  // `user_id = caller` below, exactly as the single-id path is.
  const idList: string[] | null = Array.isArray(ids) ? (ids as unknown[]).map(String) : null

  if (!all && !id && !idList) {
    return NextResponse.json({ error: 'id, ids or all is required' }, { status: 400 })
  }
  // Validated before Postgres sees it — a malformed id would otherwise return a
  // 22P02 cast error as a 500 rather than the 400 it is.
  if (!all && !idList && !isValidUUID(id as string)) {
    return NextResponse.json({ error: 'Invalid notification id' }, { status: 400 })
  }
  if (idList) {
    if (idList.length === 0) {
      return NextResponse.json({ error: 'ids must not be empty' }, { status: 400 })
    }
    // Same ceiling as /delete-selected: a bounded page holds far fewer than
    // this, and an unbounded IN list is a query nobody sized.
    if (idList.length > MAX_IDS) {
      return NextResponse.json({ error: `Cannot mark more than ${MAX_IDS} notifications at once` }, { status: 400 })
    }
    if (!idList.every(isValidUUID)) {
      return NextResponse.json({ error: 'ids must all be valid notification ids' }, { status: 400 })
    }
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const update = { is_read: true, read_at: new Date().toISOString() }
  let query = supabase.from('notifications').update(update).eq('user_id', user.id)
  if (all) {
    const categoryResult = resolveNotificationCategory(category)
    if (!categoryResult.ok) {
      return NextResponse.json({ error: categoryResult.error }, { status: 400 })
    }
    // Same gate the list and count paths apply. Only reached for { all: true }:
    // a single { id } request is already scoped to one row the caller owns and
    // names no category at all.
    if (!(await canReadNotificationCategory(supabase, user.id, categoryResult.category))) {
      return NextResponse.json({ error: CATEGORY_FORBIDDEN }, { status: 403 })
    }
    // "Mark all" only affects visible task-activity rows, never hidden summary/digest ones.
    query = query.eq('is_read', false).or(getNotificationCategoryFilter(categoryResult.category)).not('type', 'in', SYSTEM_TYPE_EXCLUSION)
  } else if (idList) {
    // Scoped to the caller by the `.eq('user_id', …)` above, so an id belonging
    // to somebody else simply matches nothing.
    query = query.in('id', idList)
  } else {
    query = query.eq('id', id)
  }

  // `.select('id')` lets the response report how many of the caller's rows were
  // actually flipped, so the client can patch its unread badge without a
  // follow-up count request. Zero updated rows is an idempotent success — the
  // row was already read, or was never the caller's.
  const { data, error } = await query.select('id')
  if (error) {
    // Message only — notification titles/bodies stay out of the logs.
    console.error('[notifications/mark-read] update failed:', error.message)
    return NextResponse.json({ error: 'Could not update the notification' }, { status: 500 })
  }

  return NextResponse.json({ success: true, updatedCount: data?.length ?? 0 })
}
