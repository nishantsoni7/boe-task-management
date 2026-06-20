import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function requireAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const client = serviceClient()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await client
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  return profile?.role === 'admin' ? client : null
}

// PATCH /api/showroom/admin/products/[product_code] — edit product or toggle is_active
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ product_code: string }> }
) {
  const client = await requireAdmin(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { product_code } = await params
  const body = await req.json()

  const allowed = ['name', 'category', 'description', 'specifications', 'image_url', 'mrp', 'is_active', 'product_code']
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
