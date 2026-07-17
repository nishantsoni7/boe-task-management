import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const VALID_STATUSES           = ['new', 'in_discussion', 'quotation_sent', 'closed']

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/showroom/inquiry/[id]
// Supports ?viewAs=<userId> for admin callers.
// Uses three flat queries instead of one large nested join to avoid PostgREST
// schema-cache failures when showroom_products columns change.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // ── 1. Fetch the inquiry (flat, no joins) ───────────────────────────────────
  const { data: inquiry, error: inqErr } = await caller.client
    .from('showroom_inquiries')
    .select('*')
    .eq('id', id)
    .single()

  if (inqErr || !inquiry) {
    console.error('[inquiry GET] inquiry fetch failed:', inqErr?.message, 'id:', id)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // ── 2. Ownership / viewAs check ─────────────────────────────────────────────
  if (caller.role === 'admin') {
    const viewAs = req.nextUrl.searchParams.get('viewAs')
    if (viewAs && UUID_RE.test(viewAs) && inquiry.salesperson_id !== viewAs) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  } else if (inquiry.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── 3. Fetch inquiry items (flat) ───────────────────────────────────────────
  const { data: items, error: itemsErr } = await caller.client
    .from('showroom_inquiry_items')
    .select('id, inquiry_id, product_id, quantity, mrp_at_time, rate_override, customization_note, created_at')
    .eq('inquiry_id', id)
    .order('created_at')

  if (itemsErr) {
    console.error('[inquiry GET] items fetch failed:', itemsErr.message)
    return NextResponse.json({ error: 'Failed to load inquiry items' }, { status: 500 })
  }

  // ── 4. Fetch products for those items ───────────────────────────────────────
  // Use wildcard (*) so new columns (images, dimensions) are included if present,
  // without failing if the migration hasn't been applied yet.
  const productIds = [...new Set((items ?? []).map(i => i.product_id).filter(Boolean))]
  const productsById: Record<string, Record<string, unknown>> = {}

  if (productIds.length > 0) {
    const { data: products, error: prodErr } = await caller.client
      .from('showroom_products')
      .select('*')
      .in('id', productIds)

    if (prodErr) {
      console.error('[inquiry GET] products fetch failed:', prodErr.message)
      // Non-fatal: return items without product details rather than failing
    } else {
      for (const p of products ?? []) {
        productsById[p.id as string] = p
      }
    }
  }

  // ── 5. Merge items with product data ────────────────────────────────────────
  const mergedItems = (items ?? []).map(item => {
    const prod = productsById[item.product_id] ?? null
    return {
      id:                 item.id,
      quantity:           item.quantity,
      mrp_at_time:        item.mrp_at_time,
      rate_override:      item.rate_override      ?? null,
      customization_note: item.customization_note ?? null,
      created_at:         item.created_at,
      showroom_products: prod ? {
        id:           prod.id,
        product_code: prod.product_code,
        name:         prod.name,
        category:     prod.category,
        mrp:          prod.mrp,
        is_active:    prod.is_active,
        image_url:    prod.image_url   ?? null,
        images:       prod.images      ?? [],
        dimensions:   prod.dimensions  ?? null,
      } : null,
    }
  })

  return NextResponse.json({
    inquiry: {
      ...inquiry,
      showroom_inquiry_items: mergedItems,
    },
  })
}

// PATCH /api/showroom/inquiry/[id] — update status, discount_percent, notes
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Verify ownership before updating
  const { data: existing, error: fetchErr } = await caller.client
    .from('showroom_inquiries')
    .select('id, salesperson_id')
    .eq('id', id)
    .single()

  if (fetchErr || !existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (caller.role !== 'admin' && existing.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const updates: Record<string, unknown> = {}

  if ('status' in body) {
    if (!VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }
    updates.status = body.status
  }
  if ('discount_percent' in body) {
    const d = parseFloat(body.discount_percent)
    if (isNaN(d) || d < 0 || d > 100) {
      return NextResponse.json({ error: 'discount_percent must be 0–100' }, { status: 400 })
    }
    updates.discount_percent = d
  }
  if ('notes' in body) {
    updates.notes = body.notes?.trim() || null
  }
  if ('converted_at' in body) {
    updates.converted_at = body.converted_at ?? null
  }
  if ('lost_at' in body) {
    updates.lost_at = body.lost_at ?? null
  }
  if ('shared_at' in body) {
    updates.shared_at = body.shared_at ?? null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data, error } = await caller.client
    .from('showroom_inquiries')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ inquiry: data })
}
