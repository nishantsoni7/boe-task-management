// GET  /api/scoreboard/star-seller   last month's Star Seller, their Super Priority pick (Order number, line),
//                                    and, for the Star Seller alone before picking, their own open Orders
// POST /api/scoreboard/star-seller   { order_id, note }   the Star Seller's one pick into Factory Focus
// Rules: src/lib/scoreboard/starSeller.ts; the database guard (20270628000000) checks the pick again.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { loadStarSeller, pickOrder } from '@/lib/scoreboard/starSeller'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'scoreboard/star-seller', caller => loadStarSeller(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'scoreboard/star-seller', caller => pickOrder(caller, body))
}
