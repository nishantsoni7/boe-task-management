import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function requireAdmin(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null

  const db = svc()
  const { data: { user }, error } = await db.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await db.from('users').select('role').eq('id', user.id).single()
  if (!profile || profile.role !== 'admin') return null

  return { db, user }
}

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = svc()
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await db.from('users').select('role').eq('id', user.id).single()
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await db
    .from('payroll_holidays')
    .select('id, holiday_date, holiday_name:description, holiday_type, half_session, created_at')
    .order('holiday_date', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ holidays: data })
}

const HOLIDAY_TYPES = ['full_day', 'half_day'] as const
const HALF_SESSIONS  = ['first_half', 'second_half'] as const

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (!auth) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { holiday_date, holiday_name, half_session } = body ?? {}
  // Default 'full_day' so any existing caller that never sends holiday_type
  // keeps behaving exactly as before this field existed.
  const holiday_type = body?.holiday_type ?? 'full_day'

  if (!holiday_date || !holiday_name?.trim()) {
    return NextResponse.json({ error: 'holiday_date and holiday_name are required' }, { status: 400 })
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday_date)) {
    return NextResponse.json({ error: 'holiday_date must be YYYY-MM-DD' }, { status: 400 })
  }

  if (!HOLIDAY_TYPES.includes(holiday_type)) {
    return NextResponse.json({ error: 'holiday_type must be full_day or half_day' }, { status: 400 })
  }

  if (holiday_type === 'half_day') {
    if (!HALF_SESSIONS.includes(half_session)) {
      return NextResponse.json({ error: 'A half-day holiday needs First Half or Second Half' }, { status: 400 })
    }
  } else if (half_session != null) {
    return NextResponse.json({ error: 'Full-day holiday cannot have a half-day session' }, { status: 400 })
  }

  const { data, error } = await auth.db
    .from('payroll_holidays')
    .insert({
      holiday_date,
      description: holiday_name.trim(),
      holiday_type,
      half_session: holiday_type === 'half_day' ? half_session : null,
    })
    .select('id, holiday_date, holiday_name:description, holiday_type, half_session, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ holiday: data }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (!auth) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await auth.db.from('payroll_holidays').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
