import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory } from '@/lib/notifications'

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

  const { id, all, category } = await req.json()
  if (!all && !id) {
    return NextResponse.json({ error: 'id or all is required' }, { status: 400 })
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
    // "Mark all" only affects visible task-activity rows, never hidden summary/digest ones.
    query = query.eq('is_read', false).or(getNotificationCategoryFilter(categoryResult.category))
  } else {
    query = query.eq('id', id)
  }

  const { error } = await query
  if (error) {
    console.error('[notifications/mark-read] update failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
