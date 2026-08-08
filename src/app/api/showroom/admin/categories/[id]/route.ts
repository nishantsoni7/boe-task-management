import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { resolveModuleAccess } from '@/lib/moduleAccess'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function requireShowroomAccess(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const client = serviceClient()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null

  const [{ data: profile }, { data: mod }] = await Promise.all([
    client.from('users').select('id, role, team').eq('id', user.id).single(),
    client.from('app_modules').select('visibility_type, allowed_department, allowed_user_ids').eq('module_key', 'showroom_qr').single(),
  ])
  if (!profile) return null

  const team = (profile.team as string | null)?.toLowerCase()
  const teamFallback = !!team && (team.includes('sales') || team.includes('showroom'))
  const allowed = profile.role === 'admin' ||
    resolveModuleAccess('showroom_qr', mod, profile, teamFallback)

  return allowed ? client : null
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
}

// PATCH /api/showroom/admin/categories/[id] — rename a category.
// Existing products carry the category as free text, so a rename also updates
// every showroom_products row that used the old name to the new one.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const body = await req.json()
  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) {
    return NextResponse.json({ error: 'Category name is required' }, { status: 400 })
  }

  const { data: current, error: findError } = await client
    .from('showroom_categories')
    .select('id, name')
    .eq('id', id)
    .single()

  if (findError || !current) {
    return NextResponse.json({ error: 'Category not found' }, { status: 404 })
  }

  const { data: dup } = await client
    .from('showroom_categories')
    .select('id')
    .ilike('name', name)
    .neq('id', id)
    .maybeSingle()

  if (dup) {
    return NextResponse.json({ error: 'This category already exists.' }, { status: 409 })
  }

  const slug = slugify(name)

  const { data, error } = await client
    .from('showroom_categories')
    .update({ name, slug })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This category already exists.' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Keep existing products' free-text category in sync with the rename.
  if (current.name !== name) {
    const { error: syncError } = await client
      .from('showroom_products')
      .update({ category: name })
      .eq('category', current.name)

    if (syncError) return NextResponse.json({ error: syncError.message }, { status: 500 })
  }

  return NextResponse.json({ category: data })
}

// DELETE /api/showroom/admin/categories/[id] — block deletion if any product still uses it.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params

  const { data: category, error: findError } = await client
    .from('showroom_categories')
    .select('id, name')
    .eq('id', id)
    .single()

  if (findError || !category) {
    return NextResponse.json({ error: 'Category not found' }, { status: 404 })
  }

  const { count, error: countError } = await client
    .from('showroom_products')
    .select('id', { count: 'exact', head: true })
    .eq('category', category.name)

  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 })

  if (count && count > 0) {
    return NextResponse.json(
      { error: 'This category is used by products. Move or update those products before deleting.' },
      { status: 409 }
    )
  }

  const { error: deleteError } = await client
    .from('showroom_categories')
    .delete()
    .eq('id', id)

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  return NextResponse.json({ deleted: true })
}
