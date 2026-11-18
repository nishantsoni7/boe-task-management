// GET  /api/day-close/me    the caller's own day: their tasks due today, what to do now
// POST /api/day-close/me    { action: 'close_day', summary, carryovers: [{ task_id, reason, next_date }] }
// (No 'file_plan' any more: owner, 2026-11-18, today's tasks are the plan.)
//
// Always the caller's own day: the person comes from the bearer token and no id in the body can name
// anybody else. The day's work is the person's own tasks in Task Management (owner, 2026-11-12).
// Rules: src/lib/dayClose/rules.ts; reads and writes: src/lib/dayClose/server.ts.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { closeDay, loadMyDay, type Result } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'me', caller => loadMyDay(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'me', async (caller): Promise<Result> => {
    switch (body.action) {
      case 'close_day': return closeDay(caller, body)
      default: return { status: 400, body: { error: 'Unknown action.' } }
    }
  })
}
