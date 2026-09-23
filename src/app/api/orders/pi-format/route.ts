import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { hasPermission } from '@/lib/permissions/resolver'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import {
  PI_FORMAT_BYTES,
  PI_FORMAT_CONTENT_TYPE,
  PI_FORMAT_FILENAME,
  PI_FORMAT_OBJECT_PATH,
  PI_FORMAT_SHA256,
} from '@/lib/orders/piFormat'

// GET /api/orders/pi-format — the approved PI Excel format, as an attachment.
//
// A plain link on the Orders dashboard points here, so the browser's own session
// cookie is the credential and the download is an ordinary navigation: no form,
// no blob, nothing that behaves differently on a phone.
//
// Authorization is Orders module ENTRY — the same rule as the Orders guard
// (src/app/orders/layout.tsx) and module_entry_open('orders'): an admin, or
// effective `orders.view`. It is NOT `orders.create`; a viewer who cannot upload
// a PI may still download the format. The workbook is in a private bucket at a
// key no client policy reaches (see src/lib/orders/piFormat.ts), so this route is
// the only way to it.

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET() {
  // ── 1. Who is asking ──
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'Please sign in to download the PI format.')

  const admin = adminClient()
  if (!admin.ok) {
    // Variable NAMES go to the server log only, never to the response.
    console.error('[orders/pi-format] not configured; missing:', admin.missing.join(', '))
    return fail(503, 'The PI format download is not configured on this deployment.')
  }
  const service = admin.client

  // ── 2. May they enter Order Management ──
  const { data: me } = await service
    .from('users').select('id, role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (!me || me.is_active !== true || me.is_deleted === true) {
    return fail(403, 'You do not have access to Order Management.')
  }
  const allowed = me.role === 'admin'
    || await hasPermission(service, user.id, 'orders', 'view').catch(() => false)
  if (!allowed) return fail(403, 'You do not have access to Order Management.')

  // ── 3. The approved bytes, and only those ──
  const { data: blob, error } = await service.storage
    .from(ORDER_FILES_BUCKET).download(PI_FORMAT_OBJECT_PATH)
  if (error || !blob) {
    console.error('[orders/pi-format] download failed:', error?.message ?? 'no data')
    return fail(502, 'The PI format could not be loaded. Please try again, or report it if it keeps happening.')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== PI_FORMAT_BYTES || sha256 !== PI_FORMAT_SHA256) {
    console.error('[orders/pi-format] stored object is not the approved workbook:', bytes.byteLength, sha256)
    return fail(502, 'The stored PI format does not match the approved file. Please report it.')
  }

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': PI_FORMAT_CONTENT_TYPE,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${PI_FORMAT_FILENAME}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
