import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/ui'
import { perfTrack } from '@/lib/perf'

// Hard-deletes a single notification owned by the authenticated user.
//
// Response contract:
//   200 { success: true, deleted: true,  id }  — the caller's row was removed
//   200 { success: true, deleted: false, id }  — no row matched; nothing to do
//   400 / 401 / 500                            — real failures
//
// `deleted: false` is a deliberate idempotent success, not an error. A retried
// or double-fired DELETE must not fail the second time: the caller's intent
// ("this notification should not exist for me") is satisfied either way, so
// the client can keep the row hidden. It is also the ONLY thing reported for a
// row belonging to another user — the query is scoped to `user_id = caller`, so
// someone else's notification is indistinguishable from one that never
// existed, and nothing about it leaks.
//
// The previous version ran the delete without `.select()`, so a request that
// matched zero rows returned exactly the same `{ success: true }` as one that
// really deleted a row. The client had no way to tell a genuine deletion from a
// silent no-op.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const perf = perfTrack('notification.delete.single')
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

  perf.mark('auth')

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id) // scope to caller — never delete another user's row
    .select('id')           // report what was actually removed

  perf.mark('delete')

  if (error) {
    // Logged without the row's title/body — a notification's content can carry
    // task titles and client names, and none of that belongs in server logs.
    console.error('[notifications/delete] failed:', error.message)
    perf.end()
    return NextResponse.json({ error: 'Could not delete the notification' }, { status: 500 })
  }

  perf.end()
  return NextResponse.json({ success: true, deleted: (data?.length ?? 0) > 0, id })
}
