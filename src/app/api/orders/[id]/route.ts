import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// DELETE /api/orders/[id] — admin-only permanent delete of an order request.
// order_activity_log rows cascade automatically (ON DELETE CASCADE).
// finance_payment_requests.order_id is set null automatically (ON DELETE
// SET NULL) — blocked below for approved_linked rows, since that status
// requires a non-null order_id (finance_payment_requests_approved_linked_requires_order_id).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const client = serviceClient()
  const { data: { user: caller }, error: callerError } = await client.auth.getUser(token)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await client
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can delete order requests' }, { status: 403 })
  }

  const { data: order } = await client
    .from('orders')
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (!order) {
    return NextResponse.json({ error: 'Order request not found' }, { status: 404 })
  }

  const { data: linkedReceived } = await client
    .from('finance_payment_requests')
    .select('id')
    .eq('order_id', id)
    .eq('status', 'approved_linked')
    .limit(1)

  if (linkedReceived && linkedReceived.length > 0) {
    return NextResponse.json({
      error: 'This order has payments marked as Received. Unlink them in Finance before deleting this order.',
    }, { status: 409 })
  }

  const { error: deleteError } = await client
    .from('orders')
    .delete()
    .eq('id', id)

  if (deleteError) {
    return NextResponse.json({
      error: 'Could not delete this order because related records are still attached. Please try again or contact support.',
    }, { status: 409 })
  }

  return NextResponse.json({ success: true })
}
