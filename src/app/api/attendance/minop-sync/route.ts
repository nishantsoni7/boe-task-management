// GET /api/attendance/minop-sync
//
// The nightly repair for machine attendance. Driven by Vercel Cron (see `crons`
// in vercel.json), which calls with GET and `Authorization: Bearer $CRON_SECRET`.
//
// The webhook works out attendance as messages arrive, but that step is
// best-effort so that it can never change what Minop is told. This run copies any
// punch the webhook missed and works out every day of this month and last month
// again, which also picks up a Machine ID linked after the person punched. Only
// rows that actually change are written. See src/lib/minop/machineAttendance.ts.
//
// With CRON_SECRET unset the route answers 503 and does nothing.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { istToday } from '@/lib/attendance/monthAvailability'
import { syncMachineAttendance } from '@/lib/minop/machineAttendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[attendance/minop-sync] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The sync is not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  try {
    return NextResponse.json(await syncMachineAttendance(svc, istToday()))
  } catch (error) {
    console.error('[attendance/minop-sync] sync failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'The sync did not finish.' }, { status: 500 })
  }
}
