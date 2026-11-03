// GET /api/sales/alerts/morning and /api/sales/alerts/evening
//
// The slot is part of the path, not a query string: Vercel's cron documentation shows literal paths and says nothing
// about keeping a query string, and a dropped one would have failed every run with "Unknown slot".
//
// The two daily Sales alerts: each person's follow-ups in the morning with first calls missed yesterday going up to
// manager level, and new leads not called yet in the evening. Driven by Vercel Cron (see `crons` in vercel.json), which
// calls with GET and `Authorization: Bearer $CRON_SECRET`. All of the logic is in the database function
// sales_lead_send_alerts (20270526000100), executable by the service role only; this route merely authenticates the
// scheduler and calls it. If it never runs, nothing is lost but the nudge: My day shows the same leads.
//
// With CRON_SECRET unset the route answers 503 and does nothing.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(req: Request, { params }: { params: Promise<{ slot: string }> }) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[sales/alerts] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'Alerts are not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { slot } = await params
  if (slot !== 'morning' && slot !== 'evening') {
    return NextResponse.json({ error: 'Unknown slot.' }, { status: 400 })
  }

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data, error } = await svc.rpc('sales_lead_send_alerts', { p_slot: slot })
  if (error) {
    console.error('[sales/alerts] sweep failed:', error.message)
    return NextResponse.json({ error: 'Alerts could not be sent.' }, { status: 500 })
  }

  return NextResponse.json({ sent: typeof data === 'number' ? data : 0 })
}
