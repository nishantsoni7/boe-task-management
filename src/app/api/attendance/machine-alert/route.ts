// GET /api/attendance/machine-alert
//
// The daily check that tells admins when the attendance machine has stopped
// sending. Driven by Vercel Cron (see `crons` in vercel.json), which calls with
// GET and `Authorization: Bearer $CRON_SECRET`.
//
// The Today tab and the For you card work this out when they are opened, so they
// turn red at 11:00 IST. This run is what reaches an admin who is not looking.
// Vercel may start it late, so the notification can follow by up to about an hour.
// All of the logic is in src/lib/minop/machineHealth.ts. It writes one notification
// per admin, once a day, and touches nothing else.
//
// With CRON_SECRET unset the route answers 503 and does nothing.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readMachineHealth, sendMachineStoppedAlert } from '@/lib/minop/machineHealth'

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
    console.error('[attendance/machine-alert] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The check is not configured.' }, { status: 503 })
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
    const health = await readMachineHealth(svc)
    return NextResponse.json({ state: health.state, told: await sendMachineStoppedAlert(svc, health) })
  } catch (error) {
    console.error('[attendance/machine-alert] check failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'The check did not finish.' }, { status: 500 })
  }
}
