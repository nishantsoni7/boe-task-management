// GET /api/day-close/evaluate
//
// The nightly Day Close check: writes the day's strikes (no plan, plan late, day not closed, closed after
// leaving) for everybody switched on. Driven by Vercel Cron at 17:45 UTC = 23:15 IST (see `crons` in
// vercel.json), with `Authorization: Bearer $CRON_SECRET`. Idempotent: a strike is written once, and a
// decided one is never touched, so a second run changes nothing. All of the logic is in
// src/lib/dayClose/rules.ts (judgeDay) and src/lib/dayClose/server.ts (evaluateDay).
//
// With CRON_SECRET unset the route answers 503 and does nothing.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serviceClient } from '@/lib/security/attendancePayrollApiAuth'
import { istToday } from '@/lib/istDate'
import { evaluateDay } from '@/lib/dayClose/server'

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
    return NextResponse.json(await evaluateDay(serviceClient(), date))
  } catch (error) {
    console.error('[day-close/evaluate] check failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'The check did not finish.' }, { status: 500 })
  }
}
