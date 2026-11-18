// POST /api/day-close/holds/[id]   { reason }   lift an attendance hold (administrators and the Day Close reviewer).
// The person is told when today's hold is lifted. Rules: src/lib/dayClose/hold.ts (liftHold).

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { liftHold } from '@/lib/dayClose/hold'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'holds', caller => liftHold(caller, id, body))
}
