// POST /api/day-close/strikes/[id]   { decision: 'upheld' | 'waived', note }   the Day Close reviewer only.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { decideStrike } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'strikes', caller => decideStrike(caller, id, body))
}
