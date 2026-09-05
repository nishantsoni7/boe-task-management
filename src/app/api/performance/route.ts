import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { istToday } from '@/lib/istDate'
import { resolvePerformanceAccess } from '@/lib/permissions/performance'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * The caller's own daily performance log. Self-scoped in both directions — the
 * row is always keyed on the token's user — so the only question is whether this
 * person has Personal Performance at all.
 *
 * That question is asked here, and not only in the navigation: a caller whose
 * Personal Performance has been switched off in Control Center must not reach
 * this endpoint by typing the URL. See src/lib/permissions/performance.ts.
 */
async function personalAccess(token: string) {
  const access = await resolvePerformanceAccess(serviceClient(), token)
  if (!access || !access.capabilities.canAccessPersonalPerformance) return null
  return access.caller
}

// GET /api/performance?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await personalAccess(token)
  if (!caller) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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

  const caller = await personalAccess(token)
  if (!caller) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
