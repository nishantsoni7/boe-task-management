import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/orders/submissionPayload'
import { buildConfirmedPdfModel } from '@/lib/orders/confirmedPdf'
import { renderConfirmedPdf } from '@/lib/orders/confirmedPdfRender'
import { ORDER_FILES_BUCKET, PI_DRAFT_ITEM_COLUMNS, type PersistedItem } from '@/lib/orders/draftsView'
import { ORDER_PI_HANDOFF_COLUMNS, type OrderPiRow } from '@/lib/orders/orderPiHandoff'
import {
  formatOrderOperationalNumber,
  orderProductCodesByItemId,
  type OrderProductCodeRecord,
} from '@/lib/orders/orderProductCodes'
import { piVersionPdfFilename, piVersionPdfSource, type PiVersionDetail } from '@/lib/orders/piVersionPdf'
import { isCanonicalPiImageKey } from '@/lib/orders/piImageKey'

// ── ONE PI VERSION AS A PDF (20270116000000) ─────────────────────────────────
//
// GET /api/orders/{orderId}/pi-versions/{versionId}/pdf[?download=1]
//
// Rendered on request from THAT version's own content — the current version
// from the PI's rows, a replaced one from what was captured when it was
// replaced, an edit proposal from its server-built proposal — with the same
// model and renderer the Confirmed documents use. Nothing is stored: a PDF of
// V1 is always V1, and an edited V2 never borrows V1's workbook.
//
// ACCESS is the caller's: the Order is read under their own row security, and
// the version's content through order_pi_version_detail(), which asks for the
// signed-in person. The service role only reads rows and pictures after that.

export const runtime = 'nodejs'

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

async function readLogo(): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(process.cwd(), 'public', 'branding', 'boe-logo-full.png')))
  } catch {
    return null
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id: orderId, versionId } = await params
  if (!isUuid(orderId) || !isUuid(versionId)) return fail(400, 'BAD_REQUEST', 'A valid Order and version are required.')

  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  // ── As the caller: may they open this Order, and this version of it? ──
  const { data: orderRow } = await authClient
    .from('orders').select('id, display_number, confirm_date, source_order_submission_id').eq('id', orderId).maybeSingle()
  const order = orderRow as { display_number: string | null; confirm_date: string | null; source_order_submission_id: string | null } | null
  if (!order?.source_order_submission_id) return fail(404, 'NOT_FOUND', 'This Order could not be found.')
  const submissionId = order.source_order_submission_id

  const { data: versionRow } = await authClient
    .from('order_pi_versions').select('id, order_id, submission_id, version_number, status').eq('id', versionId).maybeSingle()
  const version = versionRow as { order_id: string; submission_id: string; version_number: number; status: string } | null
  // THIS Order's version of THIS Order's PI — pictures are then read only
  // from that PI's own image folder.
  if (!version || version.order_id !== orderId || version.submission_id !== submissionId) {
    return fail(404, 'NOT_FOUND', 'This PI version could not be found.')
  }

  const detail = await authClient.rpc('order_pi_version_detail', { p_version_id: versionId })
  if (detail.error || !detail.data) return fail(404, 'NOT_FOUND', 'This PI version could not be found.')
  const d = detail.data as PiVersionDetail

  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'PDFs are not configured on this deployment. Please report it.')
  const service = admin.client

  const displayNumber = String(order.display_number ?? '').trim()
  const orderNumber = formatOrderOperationalNumber(displayNumber) ?? displayNumber

  const { data: codeRows } = await service.from('order_product_codes')
    .select('submission_item_id, boe_sequence, source_product_code, source_item_sequence').eq('order_id', orderId)
  const liveCodes = orderProductCodesByItemId(displayNumber, (codeRows ?? []) as unknown as OrderProductCodeRecord[])

  let submission: OrderPiRow
  let items: PersistedItem[]
  let pictureByItem: Map<string, string>
  let productCodes: ReadonlyMap<string, string>

  if (d.source === 'live') {
    const [{ data: piRow }, { data: itemRows }, { data: imageRows }] = await Promise.all([
      service.from('order_submissions').select(ORDER_PI_HANDOFF_COLUMNS).eq('id', submissionId).maybeSingle(),
      service.from('order_submission_items').select(PI_DRAFT_ITEM_COLUMNS)
        .eq('submission_id', submissionId).order('sort_order', { ascending: true }),
      service.from('order_submission_item_images').select('item_id, role, position, storage_path')
        .eq('submission_id', submissionId).order('position', { ascending: true }),
    ])
    if (!piRow) return fail(500, 'PI_UNREADABLE', 'This PI could not be read. Please try again.')
    submission = piRow as unknown as OrderPiRow
    items = (itemRows ?? []) as unknown as PersistedItem[]
    pictureByItem = new Map()
    for (const m of (imageRows ?? []) as { item_id: string; role: string; storage_path: string }[]) {
      if (m.role === 'representative' && !pictureByItem.has(m.item_id)
          && isCanonicalPiImageKey(m.storage_path, { submissionId, itemId: m.item_id, role: 'representative' })) {
        pictureByItem.set(m.item_id, m.storage_path)
      }
    }
    productCodes = liveCodes
  } else {
    const src = piVersionPdfSource({ detail: d, submissionId, orderDisplayNumber: displayNumber, liveCodes })
    if (!src.ok) return fail(409, src.code, src.message)
    ;({ submission, items, pictureByItem, productCodes } = src)
  }

  const pathByRow = new Map<number, string>()
  for (const i of items) {
    const p = pictureByItem.get(i.id)
    if (p && !pathByRow.has(i.source_row)) pathByRow.set(i.source_row, p)
  }

  const model = buildConfirmedPdfModel({
    orderNumber, submission, items, imageRows: new Set(pathByRow.keys()), productCodes,
  })

  let pdf: Buffer
  try {
    pdf = await renderConfirmedPdf({
      model,
      logo: await readLogo(),
      // No date: the renderer stamps the fixed CLIENT_PDF_DATE, never the
      // Order's internal confirm date (20270122000000).
      metadata: {
        title: `Order ${orderNumber} — PI V${version.version_number}`,
      },
      loadImage: async (row) => {
        const path = pathByRow.get(row)
        // The last check before a privileged read: the whole canonical key of
        // this PI, whatever path produced it.
        if (!path || !isCanonicalPiImageKey(path, { submissionId })) return null
        const { data, error } = await service.storage.from(ORDER_FILES_BUCKET).download(path)
        if (error || !data) return null
        return new Uint8Array(await data.arrayBuffer())
      },
    })
  } catch {
    return fail(500, 'PDF_RENDER_FAILED', 'The PDF could not be produced just now. Please try again.')
  }

  const filename = piVersionPdfFilename(orderNumber, version.version_number)
  const download = req.nextUrl.searchParams.get('download') === '1'
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
