import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

async function adminClient(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user } } = await svc.auth.getUser(token)
  if (!user) return null

  const { data: p } = await svc.from('users').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return null

  return svc
}

export async function GET(req: NextRequest) {
  const svc = await adminClient(req)
  if (!svc) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await svc
    .from('app_modules')
    .select('id, module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order')
    .order('sort_order')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ modules: data ?? [] })
}
