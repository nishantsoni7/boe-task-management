import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { istToday } from '@/lib/istDate'

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
  const { data: profile } = await sb
    .from('users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  return profile as { id: string; role: string } | null
}

// GET /api/performance?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date') ?? istToday()

  const sb = serviceClient()
  const { data, error } = await sb
    .from('daily_performance_logs')
    .select('*')
    .eq('user_id', caller.id)
    .eq('log_date', date)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ log: data ?? null })
}

// POST /api/performance — upsert today's log
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { completed_today, in_progress, blockers, tomorrow_focus } = body

  // The log belongs to the IST business day. Using the UTC date filed anything
  // saved before 5:30am IST against the previous day.
  const today = istToday()

  const sb = serviceClient()
  const { data, error } = await sb
    .from('daily_performance_logs')
    .upsert(
      {
        user_id:         caller.id,
        log_date:        today,
        completed_today: completed_today?.trim() || null,
        in_progress:     in_progress?.trim()     || null,
        blockers:        blockers?.trim()         || null,
        tomorrow_focus:  tomorrow_focus?.trim()   || null,
        updated_at:      new Date().toISOString(),
      },
      { onConflict: 'user_id,log_date' }
    )
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ log: data })
}
