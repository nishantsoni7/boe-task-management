import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { resolveModuleAccess } from '@/lib/moduleAccess'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Any user allowed to see the Showroom QR module (per Control Center visibility)
// may manage categories — same source of truth as the module launcher and the
// showroom-admin route guards.
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

// GET /api/showroom/admin/categories — active categories by default, sorted alphabetically.
// Pass ?all=1 to also include inactive categories (used by the management page).
export async function GET(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const includeInactive = req.nextUrl.searchParams.get('all') === '1'

  let query = client.from('showroom_categories').select('*').order('name', { ascending: true })
  if (!includeInactive) query = query.eq('is_active', true)

  const { data, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ categories: data ?? [] })
}

// POST /api/showroom/admin/categories — create category
export async function POST(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) {
    return NextResponse.json({ error: 'Category name is required' }, { status: 400 })
  }

  const slug = slugify(name)

  const { data: existing } = await client
    .from('showroom_categories')
    .select('id')
    .ilike('name', name)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ error: 'This category already exists.' }, { status: 409 })
  }

  const { data, error } = await client
    .from('showroom_categories')
    .insert({ name, slug })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This category already exists.' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ category: data }, { status: 201 })
}
