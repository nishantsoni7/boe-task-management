// GET /api/finance/handovers/remind
//
// The daily sweep that reminds people about cash handovers nobody has resolved.
// Driven by Vercel Cron (see `crons` in vercel.json), which calls with GET and
// `Authorization: Bearer $CRON_SECRET`.
//
// THE BANNER IS THE PRIMARY "CANNOT BE MISSED" SURFACE (HandoverBanner, drawn on
// every Finance page and the home screen until the handover is resolved). This
// route is the backup: a notification to the recipient and to the giver, once a
// day while a handover stays pending or disputed. All of the logic is in the
// database function finance_handover_send_reminders (20270410000100), which is
// executable by the service role only; this route merely authenticates the
// scheduler and calls it. If it never runs, nothing is lost but the nudge.
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

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[finance/handovers/remind] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'Reminders are not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data, error } = await svc.rpc('finance_handover_send_reminders')
  if (error) {
    console.error('[finance/handovers/remind] sweep failed:', error.message)
    return NextResponse.json({ error: 'Reminders could not be sent.' }, { status: 500 })
  }

  return NextResponse.json({ reminded: typeof data === 'number' ? data : 0 })
}
