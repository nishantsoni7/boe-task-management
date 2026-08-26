import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { canReadNotificationCategory, CATEGORY_FORBIDDEN } from '@/lib/notificationAccess'
import { isValidUUID } from '@/lib/ui'

/** Ceiling on an explicit id list, matching /api/notifications/delete-selected. */
const MAX_IDS = 200

// Marks notifications as read. Exactly ONE of:
//   { id }            one notification, by id
//   { ids: [...] }    an explicit set the caller already holds
//   { taskId }        EVERY notification for that task in this category —
//                     including ones the browser has never loaded
//   { all: true }     every unread one for the caller in this category
//
// `taskId` exists because the page is bounded. "Mark all updates for this task
// as read" driven by loaded ids would silently skip whatever sits outside the
// newest-N window, leaving older unread rows behind and the badge wrong. The
// task id is resolved against the SAME category filter and system-type
// exclusion the list route uses, so it can only reach rows the reader can
// actually see, and the affected rows are returned BY the update itself — one
// statement, so there is no count-then-mutate race — narrowed to one
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
  const { id, ids, taskId, all, category } =
    (body ?? {}) as { id?: unknown; ids?: unknown; taskId?: unknown; all?: unknown; category?: unknown }

  // `ids` is the same operation as `id`, for a known set. It exists so that
  // marking one task's group read is ONE request rather than one per event —
  // which would be N optimistic updates, N failure modes and N chances for the
  // unread count to end up wrong. Every row is still scoped to
  // `user_id = caller` below, exactly as the single-id path is.
  const idList: string[] | null = Array.isArray(ids) ? (ids as unknown[]).map(String) : null

  // Exactly one selector. Two would be ambiguous about which wins, and an
  // ambiguous destructive-ish request is one nobody can reason about later.
  const selectors = [id != null, idList != null, taskId != null, all === true].filter(Boolean).length
  if (selectors === 0) {
    return NextResponse.json({ error: 'id, ids, taskId or all is required' }, { status: 400 })
  }
  if (selectors > 1) {
    return NextResponse.json(
      { error: 'Provide exactly one of id, ids, taskId or all' }, { status: 400 })
  }
  if (taskId != null && !isValidUUID(taskId as string)) {
    return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })
  }
  // Validated before Postgres sees it — a malformed id would otherwise return a
  // 22P02 cast error as a 500 rather than the 400 it is.
  if (id != null && !isValidUUID(id as string)) {
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
  if (all || taskId != null) {
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
    // …and a task-group mark-read is that same set, narrowed to one task. The
    // narrowing is an EXTRA condition on top of the category and system
    // filters, never a replacement for them, so it cannot reach a row the feed
    // does not show.
    if (taskId != null) query = query.eq('task_id', taskId as string)
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

  // `data` is the rows the UPDATE actually changed. Because the query filtered
  // on `is_read = false`, every returned row was unread a moment ago — so this
  // count IS the exact number the unread badge must drop by, and it comes from
  // the mutation rather than from a separate count that could race it.
  const updatedCount = data?.length ?? 0
  return NextResponse.json({
    success: true,
    updatedCount,
    // Named separately from updatedCount so a future change to the filter
    // cannot silently redefine what the client subtracts.
    unreadAffected: (all || taskId != null) ? updatedCount : undefined,
  })
}
