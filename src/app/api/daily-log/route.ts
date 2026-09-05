/**
 * The EOD log — reading one, and writing your own.
 *
 * AUTHORIZATION IS THE PERFORMANCE MODULE'S, not `users.role`. Writing an EOD is
 * part of Personal Performance (`performance.view`); reading somebody else's is
 * part of Team Performance (`performance.view_team`), narrowed to the caller's
 * own department unless they also hold `view_all`. See
 * src/lib/permissions/performance.ts, which is where those three capabilities
 * are defined and which every Performance route resolves through, so a URL typed
 * by hand gets the same answer as the screen.
 *
 * Until 20261109000000 this file asked `['admin','manager'].includes(role)`,
 * which is the rule that made Personal Performance something a Manager lost by
 * being promoted.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { istToday } from '@/lib/istDate'
import {
  resolvePerformanceAccess, canReadPerformanceOf,
} from '@/lib/permissions/performance'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// GET /api/daily-log?date=YYYY-MM-DD&userId=optional
// GET /api/daily-log?from=YYYY-MM-DD&to=YYYY-MM-DD  → returns { logs: [...] }
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = serviceClient()

  const access = await resolvePerformanceAccess(sb, token)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { caller, capabilities } = access

  const { searchParams } = new URL(req.url)
  const userId = searchParams.get('userId') ?? caller.id

  // Own log → Personal Performance. Somebody else's → Team Performance, and
  // within scope. The target's department is read from the database, never from
  // the request, so a hand-typed `?userId=` cannot widen the scope.
  let target: { id: string; team: string | null } = { id: userId, team: caller.team }
  if (userId !== caller.id) {
    const { data: targetScope } = await sb
      .from('users').select('id, team').eq('id', userId).maybeSingle()
    if (!targetScope) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    target = targetScope as { id: string; team: string | null }
  }
  if (!canReadPerformanceOf(caller, capabilities, target)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const from = searchParams.get('from')
  const to   = searchParams.get('to')

  // Range query — return array of logs
  if (from && to) {
    const { data, error } = await sb
      .from('daily_work_logs')
      .select('log_date, summary, self_score')
      .eq('user_id', userId)
      .gte('log_date', from)
      .lte('log_date', to)
      .order('log_date', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ logs: data ?? [] })
  }

  // IST business date — the UTC date is still yesterday until 5:30am here.
  const date = searchParams.get('date') ?? istToday()
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

  const sb = serviceClient()

  const access = await resolvePerformanceAccess(sb, token)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { caller, capabilities } = access

  // Submitting an EOD is Personal Performance. An employee whose Personal
  // Performance has been switched off cannot file one by calling this route
  // directly — hidden navigation was never the authorization.
  if (!capabilities.canSubmitOwnEod) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { summary, highlights, blockers, self_score, log_date } = body

  if (!summary?.trim()) return NextResponse.json({ error: 'Summary is required' }, { status: 400 })

  // The EOD belongs to the IST business day it was written for. Using the UTC
  // date filed anything submitted before 5:30am IST against the previous day,
  // which then showed as a missed EOD for the day it actually covered.
  const date = log_date ?? istToday()

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
