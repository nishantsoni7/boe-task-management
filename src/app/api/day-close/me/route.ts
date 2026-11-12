// GET  /api/day-close/me    the caller's own day: plan, items, what to do now
// POST /api/day-close/me    { action: 'add_item' | 'remove_item' | 'file_plan' | 'close_item' | 'close_day', ... }
//
// Always the caller's own day: the person comes from the bearer token and no id in the body can name
// anybody else. Rules: src/lib/dayClose/rules.ts; reads and writes: src/lib/dayClose/server.ts.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { addOwnItem, closeDay, closeItem, filePlan, loadMyDay, removeOwnItem, type Result } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'me', caller => loadMyDay(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  const itemId = typeof body.item_id === 'string' ? body.item_id : ''
  return dayCloseRoute(req, 'me', async (caller): Promise<Result> => {
    switch (body.action) {
      case 'add_item': return addOwnItem(caller, body)
      case 'remove_item': return removeOwnItem(caller, itemId)
      case 'file_plan': return filePlan(caller)
      case 'close_item': return closeItem(caller, itemId, body)
      case 'close_day': return closeDay(caller, body)
      default: return { status: 400, body: { error: 'Unknown action.' } }
    }
  })
}
