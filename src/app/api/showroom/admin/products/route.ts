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

// GET /api/showroom/admin/products — all products including inactive
export async function GET(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data, error } = await client
    .from('showroom_products')
    .select('*')
    .order('category')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ products: data ?? [] })
}

// POST /api/showroom/admin/products — create product
export async function POST(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { product_code, name, category, description, specifications, image_url, images, dimensions, mrp } = body

  if (!product_code?.trim() || !name?.trim() || !category?.trim() || mrp == null) {
    return NextResponse.json({ error: 'product_code, name, category and mrp are required' }, { status: 400 })
  }

  // Parse specifications: accept string (JSON) or object
  let specs = null
  if (specifications) {
    if (typeof specifications === 'string' && specifications.trim()) {
      try { specs = JSON.parse(specifications) } catch {
        return NextResponse.json({ error: 'specifications must be valid JSON' }, { status: 400 })
      }
    } else if (typeof specifications === 'object') {
      specs = specifications
    }
  }

  // Normalise images: filter empty strings, dedupe
  const imagesArr: string[] = Array.isArray(images)
    ? images.map((u: string) => u.trim()).filter(Boolean)
    : image_url?.trim() ? [image_url.trim()] : []

  // Primary image_url stays in sync with first image for backward compat
  const primaryUrl = imagesArr[0] ?? image_url?.trim() ?? null

  const { data, error } = await client
    .from('showroom_products')
    .insert({
      product_code: product_code.trim().toUpperCase(),
      name: name.trim(),
      category: category.trim(),
      description: description?.trim() || null,
      specifications: specs,
      image_url: primaryUrl,
      images: imagesArr,
      dimensions: dimensions ?? null,
      mrp: parseFloat(mrp),
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Product code already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ product: data }, { status: 201 })
}
