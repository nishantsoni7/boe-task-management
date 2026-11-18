// GET /api/day-close/evaluate
//
// The nightly Day Close check (owner, 2026-11-18): the ATTENDANCE HOLD. Anybody switched on who came in on the
// day and still has a task due that day (or overdue) open gets the next working day put on hold, and is told.
// No strikes any more. Driven by Vercel Cron at 17:45 UTC = 23:15 IST (see `crons` in vercel.json), with
// `Authorization: Bearer $CRON_SECRET`. Idempotent: a hold is written once, so a second run changes nothing.
// All of the logic is in src/lib/dayClose/hold.ts (writeHolds).
//
// With CRON_SECRET unset the route answers 503 and does nothing.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serviceClient } from '@/lib/security/attendancePayrollApiAuth'
import { istToday } from '@/lib/istDate'
import { writeHolds } from '@/lib/dayClose/hold'

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
    console.error('[day-close/evaluate] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The check is not configured.' }, { status: 503 })
  }
  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The day just ending, in India. A date in the past may be named to re-run a missed night.
  const asked = new URL(req.url).searchParams.get('date')
  const today = istToday()
  const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today

  try {
    return NextResponse.json(await writeHolds(serviceClient(), date))
  } catch (error) {
    console.error('[day-close/evaluate] check failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'The check did not finish.' }, { status: 500 })
  }
}
