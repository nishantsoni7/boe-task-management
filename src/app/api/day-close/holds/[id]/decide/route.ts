// POST /api/day-close/holds/[id]/decide   { decision: 'counted' | 'absent' }   administrators only.
// "absent" goes through the existing attendance correction (versioned, recalculated). Rules: hold.ts (decideHold).

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { decideHold } from '@/lib/dayClose/hold'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'holds/decide', caller => decideHold(caller, id, body))
}
