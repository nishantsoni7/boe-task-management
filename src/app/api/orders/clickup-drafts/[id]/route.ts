import { NextRequest, NextResponse } from 'next/server'

import { isUuid } from '@/lib/orders/submissionPayload'
import { fail, isMissing, NOT_SET_UP, requireDraftsAdmin } from '../guard'

// GET /api/orders/clickup-drafts/{id} → { order }  one draft order, everything
// Administrator only (guard.ts).

export const runtime = 'nodejs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return fail(400, 'BAD_REQUEST', 'This order id is not valid.')
  const gate = await requireDraftsAdmin()
  if (!gate.ok) return gate.response

  const { data, error } = await gate.service.from('clickup_draft_orders').select('*').eq('id', id).maybeSingle()
  if (error) {
    if (isMissing(error)) return NOT_SET_UP()
    console.error('[clickup-drafts] read failed', { code: error.code })
    return fail(500, 'DB_ERROR', 'The order could not be read. Please try again.')
  }
  if (!data) return fail(404, 'NOT_FOUND', 'This draft order does not exist.')
  return NextResponse.json({ order: data }, { headers: { 'Cache-Control': 'private, no-store' } })
}
