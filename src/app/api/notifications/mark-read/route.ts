import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { canReadNotificationCategory, CATEGORY_FORBIDDEN } from '@/lib/notificationAccess'
import { isValidUUID } from '@/lib/ui'

// Marks notifications as read. Body: { id } for a single notification, or
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
  const { id, all, category } = (body ?? {}) as { id?: unknown; all?: unknown; category?: unknown }
  if (!all && !id) {
    return NextResponse.json({ error: 'id or all is required' }, { status: 400 })
  }
  // Validated before Postgres sees it — a malformed id would otherwise return a
  // 22P02 cast error as a 500 rather than the 400 it is.
  if (!all && !isValidUUID(id as string)) {
    return NextResponse.json({ error: 'Invalid notification id' }, { status: 400 })
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
