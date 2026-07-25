import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { REQUEST_ID_RE, removeAllObjectsForRequest } from '@/lib/orderRequestAttachmentsServer'

// Admin-only PURGE of one Order Request's attachment storage objects. Unlike the
// full delete orchestration (/api/orders/requests/delete), this removes ONLY the
// storage objects and does NOT delete the request row — it is the storage half of
// a larger deletion the caller owns (Test Data Cleanup, whose bulk RPC deletes
// the DB rows). It is called BEFORE that DB deletion, so a storage failure leaves
// the row + metadata intact and the paths discoverable.
//
// Safety: the object paths are loaded FROM THE DATABASE for the given requestId
// (removeAllObjectsForRequest) — the browser never supplies the path list, so an
// admin cannot use this to remove objects that do not belong to the request.
// Partial failures are returned explicitly so the caller never proceeds to delete
// the DB rows when storage removal failed.

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { requestId } = await req.json() as { requestId?: string }
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    return NextResponse.json({ error: 'A valid requestId is required.' }, { status: 400 })
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Trusted admin authorization (server-side; never trust the client).
  const { data: me, error: roleErr } = await service
    .from('users').select('role').eq('id', user.id).maybeSingle()
  if (roleErr) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })
  if (!me || me.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin may clean up attachment storage.' }, { status: 403 })
  }

  try {
    const { removed, failed, count } = await removeAllObjectsForRequest(service, requestId)
    const status = failed.length > 0 ? 502 : 200
    return NextResponse.json({ removed, failed, count }, { status })
  } catch {
    return NextResponse.json({ error: 'Could not read attachment storage for cleanup.', failed: ['unknown'] }, { status: 500 })
  }
}
