import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const VALID_STATUSES = ['new', 'in_discussion', 'quotation_sent', 'closed']

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
// Supports ?viewAs=<userId> for admin callers: enforces ownership check against viewAs user.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Try with new columns added in migration 20260647 (images, dimensions).
  // If migration hasn't been applied yet, fall back to the pre-migration column set
  // so the inquiry page keeps working while the DB is being updated.
  let { data: inquiry, error } = await caller.client
    .from('showroom_inquiries')
    .select(`
      *,
      showroom_inquiry_items (
        id, quantity, mrp_at_time, created_at,
        showroom_products ( id, product_code, name, category, mrp, is_active, image_url, images, dimensions )
      )
    `)
    .eq('id', id)
    .single()

  if (error) {
    const msg = error.message ?? ''
    const isColumnMissing = msg.includes('images') || msg.includes('dimensions') || error.code === 'PGRST204'
    if (isColumnMissing) {
      // Migration not yet applied — fall back to legacy columns
      const fallback = await caller.client
        .from('showroom_inquiries')
        .select(`
          *,
          showroom_inquiry_items (
            id, quantity, mrp_at_time, created_at,
            showroom_products ( id, product_code, name, category, mrp, is_active, image_url )
          )
        `)
        .eq('id', id)
        .single()
      inquiry = fallback.data
      error   = fallback.error
    }
  }

  if (error || !inquiry) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (caller.role === 'admin') {
    const viewAs = req.nextUrl.searchParams.get('viewAs')
    if (viewAs && UUID_RE.test(viewAs) && inquiry.salesperson_id !== viewAs) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  } else if (inquiry.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({ inquiry })
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
