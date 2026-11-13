import { NextRequest, NextResponse } from 'next/server'

import { fetchAllRows } from '@/lib/supabasePaging'
import type { DraftOrder } from '@/lib/orders/clickupDrafts'
import { fail, NOT_SET_UP, requireDraftsAdmin } from './guard'

// GET /api/orders/clickup-drafts          → { rows }  the list (a few fields each)
// GET /api/orders/clickup-drafts?full=1   → { rows }  everything, for the Excel
//
// Administrator only (guard.ts). Read in pages: PostgREST stops at 1000 rows
// without saying so, and the list is 521 today.

export const runtime = 'nodejs'

// The list shows these four ClickUp fields; the rest is read on the order's own page.
const LIST_FIELDS = ['Confirm Date', 'Total Product Value', 'FABRIC STATUS', 'FINISH STATUS']
const LIST_COLUMNS = 'id, order_no, name, client_name, status, assignees, due_date, fields, file_count, comment_count'

export async function GET(req: NextRequest) {
  const gate = await requireDraftsAdmin()
  if (!gate.ok) return gate.response
  const full = req.nextUrl.searchParams.get('full') === '1'

  const result = await fetchAllRows<DraftOrder>((from, to) =>
    gate.service.from('clickup_draft_orders').select(full ? '*' : LIST_COLUMNS).order('id').range(from, to) as unknown as PromiseLike<{ data: DraftOrder[] | null; error: { message: string } | null }>)
  if (!result.ok) {
    if (/clickup_draft_orders/.test(result.error) && /does not exist|schema cache/.test(result.error)) return NOT_SET_UP()
    console.error('[clickup-drafts] list failed')
    return fail(500, 'DB_ERROR', 'The orders could not be read. Please try again.')
  }
  if (result.truncated) return fail(500, 'TOO_MANY', 'There are more orders than one read can hold.')

  const rows = full
    ? result.rows
    : result.rows.map(r => ({ ...r, fields: Object.fromEntries(LIST_FIELDS.flatMap(k => (r.fields[k] ? [[k, r.fields[k]]] : []))) }))
  return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'private, no-store' } })
}
