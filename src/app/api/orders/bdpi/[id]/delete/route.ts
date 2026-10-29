import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/orders/submissionPayload'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'

// POST /api/orders/bdpi/{id}/delete  { reason }
//
// A BDPI uploaded by mistake. delete_bdpi() (as the person) decides: an active
// administrator, a reason of 10+ characters, and no lot marked dispatched. It
// returns the stored files, which the service role then removes.

export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'A valid BDPI is required.' }, { status: 400 })
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'UNAUTHORIZED', message: 'Please sign in again.' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason : ''
  const res = await authClient.rpc('delete_bdpi', { p_bdpi_id: id, p_reason: reason })
  if (res.error) {
    const msg = res.error.message
    const message = /BDPI_HAS_DISPATCHES/.test(msg) ? 'This BDPI has dispatched lots, so it cannot be deleted.'
      : /DISPATCH_REASON_REQUIRED/.test(msg) ? 'Give a reason of at least 10 characters.'
      : /administrator/i.test(msg) || res.error.code === '42501' ? 'Only an Admin can delete a BDPI.'
      : 'The BDPI could not be deleted. Please try again.'
    return NextResponse.json({ error: 'REFUSED', message }, { status: 400 })
  }
  const prefix = `bdpi/${id}/`
  const paths = ((res.data ?? []) as unknown[]).filter((p): p is string => typeof p === 'string' && p.startsWith(prefix))
  const admin = adminClient()
  if (admin.ok && paths.length > 0) await admin.client.storage.from(ORDER_FILES_BUCKET).remove(paths)
  return NextResponse.json({ deleted: true })
}
