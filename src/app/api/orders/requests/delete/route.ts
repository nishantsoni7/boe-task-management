import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { REQUEST_ID_RE, removeAllObjectsForRequest } from '@/lib/orderRequestAttachmentsServer'

// Single authenticated server-side orchestration for deleting an Order Request
// together with its attachment storage objects. This is the ONLY safe order,
// because Supabase Storage and Postgres cannot share a transaction:
//
//   1. authenticate the caller;
//   2. confirm the caller is an admin;
//   3. validate requestId;
//   4. load the request + its attachment metadata FROM THE DATABASE (never trust
//      browser-supplied paths as the source of truth);
//   5. confirm the request is unconverted and deletable (converted history is
//      protected — the DB RPC refuses it too, this is defence-in-depth);
//   6. pre-check linked payments so we do not remove storage and then fail;
//   7. remove the storage objects with the service role;
//   8. ONLY after storage removal fully succeeds, run the approved deletion RPC
//      (admin_delete_order_request — same rules + audit + notification cleanup);
//   9. return a structured result.
//
// Failure semantics (why this is recoverable): if step 7 fails, step 8 does NOT
// run, so the request row and its attachment metadata SURVIVE — the object paths
// stay discoverable in the database and the whole call can simply be retried
// (object removal is idempotent). Nothing is ever left as an undiscoverable
// orphaned commercial file.

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { requestId, unlinkPayments } = await req.json() as {
    requestId?: string
    unlinkPayments?: boolean
  }
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    return NextResponse.json({ error: 'A valid requestId is required.' }, { status: 400 })
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Trusted authorization, resolved server-side from the bearer token's user —
  // never from anything the client sent. Admin, or an explicit orders.delete
  // grant, which is the same rule admin_delete_order_request() enforces after
  // 20260901000000_finance_orders_permission_enforcement.sql. This check is
  // the early, friendly one; the RPC below remains the real boundary.
  //
  // Fails closed on every uncertainty: a failed profile read, a failed resolve,
  // and a missing row all deny.
  const { data: me, error: roleErr } = await service
    .from('users').select('role').eq('id', user.id).maybeSingle()
  if (roleErr) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })
  if (!me) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })

  let mayDelete = me.role === 'admin'
  if (!mayDelete) {
    // resolve_permission is SECURITY DEFINER and takes the user id explicitly,
    // so it is called with the service client for the AUTHENTICATED user's id.
    const { data: allowed, error: permErr } = await service.rpc('resolve_permission', {
      p_user_id: user.id,
      p_module_key: 'orders',
      p_action_key: 'delete',
    })
    if (permErr) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })
    mayDelete = allowed === true
  }

  if (!mayDelete) {
    return NextResponse.json(
      { error: 'You do not have permission to delete an Order Request.' },
      { status: 403 },
    )
  }

  // Load the request from the database (authoritative).
  const { data: reqRow, error: reqErr } = await service
    .from('order_requests')
    .select('id, status, converted_order_id')
    .eq('id', requestId)
    .maybeSingle()
  if (reqErr) return NextResponse.json({ error: 'Could not load the Order Request.' }, { status: 500 })
  if (!reqRow) return NextResponse.json({ error: 'This Order Request no longer exists.' }, { status: 404 })

  // Converted requests are permanent source history — never deletable.
  if (reqRow.status === 'converted' || reqRow.converted_order_id) {
    return NextResponse.json({
      error: 'This Order Request created a Confirmed Order and is retained as permanent source history. It cannot be deleted.',
    }, { status: 409 })
  }

  // Pre-check linked payments so we never remove storage and then have the RPC
  // refuse. The RPC re-checks under a row lock, so a race is still caught there.
  const { count: paymentCount, error: payErr } = await service
    .from('finance_payment_requests')
    .select('id', { count: 'exact', head: true })
    .eq('order_request_id', requestId)
  if (payErr) return NextResponse.json({ error: 'Could not check linked payments.' }, { status: 500 })
  if ((paymentCount ?? 0) > 0 && !unlinkPayments) {
    return NextResponse.json({
      error: `ORDER_REQUEST_HAS_PAYMENTS: ${paymentCount} payment(s) are still linked to this request.`,
      linkedPayments: paymentCount ?? 0,
    }, { status: 409 })
  }

  // STORAGE FIRST. If anything fails to remove, do NOT delete the DB row — the
  // metadata (and therefore the discoverable paths) must survive for a retry.
  let removal
  try {
    removal = await removeAllObjectsForRequest(service, requestId)
  } catch {
    return NextResponse.json({
      error: 'Could not read attachment storage for cleanup. The request was NOT deleted; please retry.',
    }, { status: 500 })
  }
  if (removal.failed.length > 0) {
    return NextResponse.json({
      error: 'Some attachment files could not be removed from storage. The request was NOT deleted so its files remain recorded; please retry.',
      removed: removal.removed,
      failed:  removal.failed,
    }, { status: 502 })
  }

  // Objects are gone — now run the approved DB deletion (admin auth, converted
  // guard, payment unlink, notification cleanup, and it cascades the now-empty
  // attachment metadata). Run as the admin USER so the RPC's own admin check and
  // auth.uid()-scoped rules apply.
  const { data: delData, error: delErr } = await authClient.rpc('admin_delete_order_request', {
    p_order_request_id: requestId,
    p_unlink_payments:  (paymentCount ?? 0) > 0,
  })
  if (delErr) {
    // Rare: a race changed eligibility after our pre-checks. The objects are
    // already removed, but the row survives (retry converges: re-reading finds no
    // metadata, removal is a no-op, and the RPC runs once the race is resolved).
    return NextResponse.json({ error: delErr.message ?? 'Deletion failed after storage cleanup.' }, { status: 409 })
  }

  const result = delData as { unlinked_count?: number } | null
  return NextResponse.json({
    success:        true,
    unlinked_count: result?.unlinked_count ?? 0,
    removed_count:  removal.removed.length,
  })
}
