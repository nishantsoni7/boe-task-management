import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function requireAuth(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null
  const client = svc()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null
  const { data: profile } = await client
    .from('users').select('id, role').eq('id', user.id).single()
  if (!profile) return null
  return { client, id: profile.id as string, role: profile.role as string }
}

async function resolveItem(
  client: ReturnType<typeof svc>,
  itemId: string,
  callerId: string,
  callerRole: string
) {
  const { data: item, error } = await client
    .from('showroom_inquiry_items')
    .select('id, inquiry_id, showroom_inquiries(id, salesperson_id)')
    .eq('id', itemId)
    .single()

  if (error || !item) return { item: null, forbidden: false, notFound: true }

  const inq = (item.showroom_inquiries as unknown) as { id: string; salesperson_id: string } | null
  if (!inq) return { item: null, forbidden: false, notFound: true }
  if (callerRole !== 'admin' && inq.salesperson_id !== callerId) {
    return { item, forbidden: true, notFound: false }
  }
  return { item, forbidden: false, notFound: false }
}

// PATCH /api/showroom/inquiry-items/[itemId] — update quantity, rate_override, customization_note
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { itemId } = await params
  const { item, forbidden, notFound } = await resolveItem(
    caller.client, itemId, caller.id, caller.role
  )
  if (notFound) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  if (forbidden) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const updates: Record<string, unknown> = {}

  if ('quantity' in body) {
    const quantity = parseInt(body.quantity, 10)
    if (!Number.isInteger(quantity) || quantity < 1) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 })
    }
    updates.quantity = quantity
  }

  if ('rate_override' in body) {
    if (body.rate_override === null || body.rate_override === undefined) {
      updates.rate_override = null
    } else {
      const r = parseFloat(body.rate_override)
      if (isNaN(r) || r <= 0) {
        return NextResponse.json({ error: 'rate_override must be a positive number' }, { status: 400 })
      }
      updates.rate_override = r
    }
  }

  if ('customization_note' in body) {
    updates.customization_note = body.customization_note?.toString().trim() || null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data, error } = await caller.client
    .from('showroom_inquiry_items')
    .update(updates)
    .eq('id', item!.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}

// DELETE /api/showroom/inquiry-items/[itemId] — remove item from inquiry
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { itemId } = await params
  const { item, forbidden, notFound } = await resolveItem(
    caller.client, itemId, caller.id, caller.role
  )
  if (notFound) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  if (forbidden) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { error } = await caller.client
    .from('showroom_inquiry_items')
    .delete()
    .eq('id', item!.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
