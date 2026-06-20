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

// POST /api/showroom/inquiry-items — add a product to an existing inquiry
export async function POST(req: NextRequest) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { inquiry_id, product_id, quantity = 1 } = body

  if (!inquiry_id || !product_id) {
    return NextResponse.json({ error: 'inquiry_id and product_id are required' }, { status: 400 })
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 })
  }

  // Verify inquiry ownership
  const { data: inquiry, error: inqErr } = await caller.client
    .from('showroom_inquiries')
    .select('id, salesperson_id')
    .eq('id', inquiry_id)
    .single()

  if (inqErr || !inquiry) return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 })
  if (caller.role !== 'admin' && inquiry.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch current product MRP from DB — never use client-supplied price
  const { data: product, error: prodErr } = await caller.client
    .from('showroom_products')
    .select('id, mrp, is_active')
    .eq('id', product_id)
    .single()

  if (prodErr || !product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  if (!product.is_active) return NextResponse.json({ error: 'Product is not active' }, { status: 400 })

  const { data, error } = await caller.client
    .from('showroom_inquiry_items')
    .insert({ inquiry_id, product_id, quantity, mrp_at_time: Number(product.mrp) })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data }, { status: 201 })
}
