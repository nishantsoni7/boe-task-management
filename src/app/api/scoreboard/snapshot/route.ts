// GET /api/scoreboard/snapshot
//
// The nightly Scoreboard record: everybody's month-to-date score as the day ends, written once and never
// changed (scoreboard_daily). Vercel Cron at 18:00 UTC = 23:30 IST, after the Day Close check (23:15 IST),
// with `Authorization: Bearer $CRON_SECRET`.
//
//   ?date=YYYY-MM-DD           one past day (a missed night)
//   ?from=YYYY-MM-DD&to=...    a range, at most 40 days (filling the November trial month once)
//
// A day already written is skipped, so a second run changes nothing. With CRON_SECRET unset: 503.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serviceClient } from '@/lib/security/attendancePayrollApiAuth'
import { istAddDays, istToday } from '@/lib/istDate'
import { snapshotDay } from '@/lib/scoreboard/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DATE = /^\d{4}-\d{2}-\d{2}$/

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[scoreboard/snapshot] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The record is not configured.' }, { status: 503 })
  }
  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = new URL(req.url).searchParams
  const today = istToday()
  const one = q.get('date')
  let from = one && DATE.test(one) ? one : today
  let to = from
  const f = q.get('from'), t = q.get('to')
  if (f && t && DATE.test(f) && DATE.test(t) && f <= t) { from = f; to = t }
  if (to > today) to = today
  const days: string[] = []
  for (let d = from; d <= to && days.length < 40; d = istAddDays(d, 1)) days.push(d)

  try {
    const results = []
    for (const d of days) results.push(await snapshotDay(serviceClient(), d))
    return NextResponse.json({ days: results })
  } catch (error) {
    console.error('[scoreboard/snapshot] failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'The record did not finish.' }, { status: 500 })
  }
}
