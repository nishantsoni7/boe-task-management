import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Any user allowed to see the Showroom QR module (per Control Center visibility)
// may manage products — same source of truth as the module launcher and the
// showroom-admin route guards.
async function requireShowroomAccess(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const client = serviceClient()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null

  const [{ data: profile }, { data: mod }] = await Promise.all([
    client.from('users').select('role, team').eq('id', user.id).single(),
    client.from('app_modules').select('visibility_type, allowed_department').eq('module_key', 'showroom_qr').single(),
  ])
  if (!profile) return null

  const team = (profile.team as string | null)?.toLowerCase()
  const teamFallback = !!team && (team.includes('sales') || team.includes('showroom'))
  const allowed = profile.role === 'admin' ||
    canAccessModule(mod?.visibility_type as ModuleVisibilityType | undefined, mod?.allowed_department, profile, teamFallback)

  return allowed ? client : null
}

// PATCH /api/showroom/admin/products/[product_code] — edit product or toggle is_active
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ product_code: string }> }
) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { product_code } = await params
  const body = await req.json()

  const allowed = ['name', 'category', 'description', 'specifications', 'image_url', 'images', 'dimensions', 'mrp', 'is_active', 'product_code']
  const updates: Record<string, unknown> = {}

  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  // Parse specifications if provided as string
  if (typeof updates.specifications === 'string') {
    const s = (updates.specifications as string).trim()
    if (!s) {
      updates.specifications = null
    } else {
      try { updates.specifications = JSON.parse(s) } catch {
        return NextResponse.json({ error: 'specifications must be valid JSON' }, { status: 400 })
      }
    }
  }

  // Normalise product_code if being changed
  if (typeof updates.product_code === 'string') {
    const trimmed = updates.product_code.trim().toUpperCase()
    if (!trimmed) {
      return NextResponse.json({ error: 'Product code cannot be empty' }, { status: 400 })
    }
    updates.product_code = trimmed
  }

  // Normalise images: filter empty strings, keep primary image_url in sync
  if (Array.isArray(updates.images)) {
    const imgs = (updates.images as string[]).map(u => u.trim()).filter(Boolean)
    updates.images    = imgs
    updates.image_url = imgs[0] ?? null
  }

  if (typeof updates.mrp !== 'undefined') {
    updates.mrp = parseFloat(updates.mrp as string)
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data, error } = await client
    .from('showroom_products')
    .update(updates)
    .eq('product_code', product_code.toUpperCase())
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This product code already exists. Please use a different code.' }, { status: 409 })
    }
    if (error.code === 'PGRST116') {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ product: data })
}

// DELETE /api/showroom/admin/products/[product_code] — hard delete if never used in an
// inquiry, otherwise deactivate to avoid breaking historical inquiries/quotations.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ product_code: string }> }
) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { product_code } = await params

  const { data: product, error: findError } = await client
    .from('showroom_products')
    .select('id')
    .eq('product_code', product_code.toUpperCase())
    .single()

  if (findError || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  const { count, error: countError } = await client
    .from('showroom_inquiry_items')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', product.id)

  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 })

  if (count && count > 0) {
    const { error: deactivateError } = await client
      .from('showroom_products')
      .update({ is_active: false })
      .eq('id', product.id)

    if (deactivateError) return NextResponse.json({ error: deactivateError.message }, { status: 500 })

    return NextResponse.json({
      deactivated: true,
      message: 'This product is already used in inquiry history, so it has been deactivated instead of permanently deleted.',
    })
  }

  const { error: deleteError } = await client
    .from('showroom_products')
    .delete()
    .eq('id', product.id)

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  return NextResponse.json({ deleted: true })
}
