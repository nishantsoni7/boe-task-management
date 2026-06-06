import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function getCallerProfile(token: string) {
  const sb = serviceClient()
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return null
  const { data: profile } = await sb.from('users').select('id, role').eq('id', user.id).single()
  return profile as { id: string; role: string } | null
}

// GET /api/daily-log?date=YYYY-MM-DD&userId=optional
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const date   = searchParams.get('date') ?? new Date().toISOString().slice(0, 10)
  const userId = searchParams.get('userId') ?? caller.id

  // Only admin/manager can query other users
  if (userId !== caller.id && !['admin', 'manager'].includes(caller.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sb = serviceClient()
  const { data, error } = await sb
    .from('daily_work_logs')
    .select('*')
    .eq('user_id', userId)
    .eq('log_date', date)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ log: data ?? null })
}

// POST /api/daily-log — upsert today's log
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { summary, highlights, blockers, self_score, log_date } = body

  if (!summary?.trim()) return NextResponse.json({ error: 'Summary is required' }, { status: 400 })

  const date = log_date ?? new Date().toISOString().slice(0, 10)

  const sb = serviceClient()
  const { data, error } = await sb
    .from('daily_work_logs')
    .upsert({
      user_id:   caller.id,
      log_date:  date,
      summary:   summary.trim(),
      highlights: highlights?.trim() || null,
      blockers:  blockers?.trim() || null,
      self_score: self_score ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,log_date' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ log: data })
}
