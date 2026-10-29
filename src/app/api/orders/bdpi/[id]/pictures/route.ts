import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/orders/submissionPayload'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'

// GET /api/orders/bdpi/{id}/pictures → { urls: { [item_sequence]: signedUrl } }
//
// The person's right to see this BDPI is asked first, as them
// (bdpi_payment_plan_read). Only then does the service role read the lines'
// picture paths and sign them for an hour. A picture that cannot be signed is
// simply left out (the screen shows "No image").

export const runtime = 'nodejs'

const URL_TTL_SECONDS = 3600

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 })

  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const gate = await authClient.rpc('bdpi_payment_plan_read', { p_bdpi_id: id })
  if (gate.error) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })

  const admin = adminClient()
  if (!admin.ok) return NextResponse.json({ urls: {} })
  const { data: rows } = await admin.client.from('bdpi_items')
    .select('item_sequence, image_path').eq('bdpi_id', id).not('image_path', 'is', null)
  const list = (rows ?? []) as { item_sequence: string; image_path: string }[]
  const prefix = `bdpi/${id}/`
  const own = list.filter(r => r.image_path.startsWith(prefix))
  if (own.length === 0) return NextResponse.json({ urls: {} })

  const signed = await admin.client.storage.from(ORDER_FILES_BUCKET)
    .createSignedUrls(own.map(r => r.image_path), URL_TTL_SECONDS)
  const byPath = new Map<string, string>()
  for (const s of signed.data ?? []) if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl)
  const urls: Record<string, string> = {}
  for (const r of own) {
    const u = byPath.get(r.image_path)
    if (u) urls[r.item_sequence] = u
  }
  return NextResponse.json({ urls }, { headers: { 'Cache-Control': 'private, no-store' } })
}
