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
    .from('users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!profile) return null
  return { client, id: profile.id as string, role: profile.role as string }
}

// GET /api/showroom/inquiry — list own (salesperson) or all (admin)
export async function GET(req: NextRequest) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let query = caller.client
    .from('showroom_inquiries')
    .select('*, showroom_inquiry_items(quantity, mrp_at_time)')
    .order('created_at', { ascending: false })

  if (caller.role !== 'admin') {
    query = query.eq('salesperson_id', caller.id)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Compute item_count and mrp_total for each inquiry
  const inquiries = (data ?? []).map(({ showroom_inquiry_items: items, ...inq }) => ({
    ...inq,
    item_count: (items as { quantity: number; mrp_at_time: number }[]).length,
    mrp_total:  (items as { quantity: number; mrp_at_time: number }[])
      .reduce((s, i) => s + i.quantity * i.mrp_at_time, 0),
  }))

  return NextResponse.json({ inquiries })
}

type CartItem = {
  product_id: string
  product_code: string
  name: string
  mrp: number
  quantity: number
}

type CustomerDetails = {
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
}

// POST /api/showroom/inquiry
// Public — no caller auth. Uses service role server-side.
// Creates showroom_inquiries + showroom_inquiry_items atomically (cleanup fallback).
export async function POST(req: NextRequest) {
  let body: {
    salesperson_id?: string
    customer?: CustomerDetails
    cart?: CartItem[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { salesperson_id, customer, cart } = body

  // ── Input validation ───────────────────────────────────────────────────────

  if (!salesperson_id) {
    return NextResponse.json({ error: 'salesperson_id is required' }, { status: 400 })
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(salesperson_id)) {
    return NextResponse.json({ error: 'Invalid salesperson' }, { status: 400 })
  }
  if (!customer?.customer_name?.trim()) {
    return NextResponse.json({ error: 'customer_name is required' }, { status: 400 })
  }
  if (!customer?.customer_mobile?.trim()) {
    return NextResponse.json({ error: 'customer_mobile is required' }, { status: 400 })
  }
  if (!Array.isArray(cart) || cart.length === 0) {
    return NextResponse.json({ error: 'Cart must have at least one item' }, { status: 400 })
  }

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Validate salesperson exists and is active ──────────────────────────────

  const { data: sp, error: spErr } = await svc
    .from('users')
    .select('id, is_active, is_deleted')
    .eq('id', salesperson_id)
    .single()

  if (spErr || !sp || !sp.is_active || sp.is_deleted) {
    return NextResponse.json({ error: 'Invalid salesperson' }, { status: 400 })
  }

  // ── Validate each product and fetch current MRP from DB ───────────────────
  // Ignores client-sent MRP entirely — source of truth is the DB.

  const productIds = cart.map(item => item.product_id)
  const { data: products, error: prodErr } = await svc
    .from('showroom_products')
    .select('id, mrp, is_active')
    .in('id', productIds)

  if (prodErr) {
    return NextResponse.json({ error: 'Failed to validate products' }, { status: 500 })
  }

  const productMap = new Map((products ?? []).map(p => [p.id, p]))

  for (const item of cart) {
    const p = productMap.get(item.product_id)
    if (!p || !p.is_active) {
      return NextResponse.json(
        { error: `Product not available: ${item.product_code}` },
        { status: 400 }
      )
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return NextResponse.json(
        { error: `Invalid quantity for product: ${item.product_code}` },
        { status: 400 }
      )
    }
  }

  // ── Create inquiry row ─────────────────────────────────────────────────────

  const { data: inquiry, error: inquiryErr } = await svc
    .from('showroom_inquiries')
    .insert({
      salesperson_id,
      customer_name:   customer.customer_name.trim(),
      customer_mobile: customer.customer_mobile.trim(),
      company:         customer.company?.trim() || null,
      city:            customer.city?.trim() || null,
      project_name:    customer.project_name?.trim() || null,
      lead_source:     'Showroom QR',
      status:          'new',
      discount_percent: 0,
    })
    .select('id')
    .single()

  if (inquiryErr || !inquiry) {
    return NextResponse.json({ error: 'Failed to create inquiry' }, { status: 500 })
  }

  // ── Insert items — cleanup inquiry if this fails ──────────────────────────
  // Supabase JS v2 does not expose a transaction API in the client library.
  // Pattern: insert items, on failure delete the inquiry row to avoid orphans.

  const itemRows = cart.map(item => ({
    inquiry_id:  inquiry.id,
    product_id:  item.product_id,
    quantity:    item.quantity,
    // Use DB MRP, not client-sent value
    mrp_at_time: Number(productMap.get(item.product_id)!.mrp),
  }))

  const { error: itemsErr } = await svc
    .from('showroom_inquiry_items')
    .insert(itemRows)

  if (itemsErr) {
    // Cleanup: remove the inquiry so no orphaned record is left
    await svc.from('showroom_inquiries').delete().eq('id', inquiry.id)
    return NextResponse.json({ error: 'Failed to save product list. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ inquiry_id: inquiry.id }, { status: 201 })
}
