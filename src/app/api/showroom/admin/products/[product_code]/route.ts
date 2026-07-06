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
    updates.product_code = updates.product_code.trim().toUpperCase()
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
      return NextResponse.json({ error: 'Product code already exists' }, { status: 409 })
    }
    if (error.code === 'PGRST116') {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ product: data })
}
