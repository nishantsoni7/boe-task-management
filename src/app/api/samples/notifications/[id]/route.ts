import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/ui'

function serviceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// PATCH /api/samples/notifications/[id] — mark single notification as read
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const supabase = serviceClient()

  const { error } = await supabase
    .from('sample_notifications')
    .update({ is_read: true })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// DELETE /api/samples/notifications/[id]
// Hard-deletes a single sample notification owned by the authenticated user.
// Mirrors /api/notifications/[id] exactly, including its response contract:
//
//   200 { success: true, deleted: true,  id }  — the caller's row was removed
//   200 { success: true, deleted: false, id }  — no row matched; nothing to do
//   400 / 401 / 500                            — real failures
//
// `deleted: false` is a deliberate idempotent success, not an error: a retried
// or double-fired DELETE must not fail the second time. It is also the ONLY
// thing reported for a row belonging to another user — the query is scoped to
// `user_id = caller`, so someone else's notification is indistinguishable from
// one that never existed, and nothing about it leaks.
//
// Only `sample_notifications` rows are touched. The sample request, its
// activity/audit trail, QR submissions, approvals, dispatch records and
// attachments all live in their own tables and are never referenced here.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  // Validated before it reaches Postgres: a malformed id would otherwise come
  // back as a 22P02 cast error surfaced as a 500, which reads as a server fault
  // rather than the bad request it is.
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: 'Invalid notification id' }, { status: 400 })
  }

  const supabase = serviceClient()

  const { data, error } = await supabase
    .from('sample_notifications')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id) // scope to caller — never delete another user's row
    .select('id')           // report what was actually removed

  if (error) {
    // Message only — a notification's title/body carries sample labels and
    // actor names, and none of that belongs in server logs.
    console.error('[samples/notifications/delete] failed:', error.message)
    return NextResponse.json({ error: 'Could not delete the notification' }, { status: 500 })
  }

  return NextResponse.json({ success: true, deleted: (data?.length ?? 0) > 0, id })
}
