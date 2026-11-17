import { NextRequest, NextResponse } from 'next/server'

import { isUuid } from '@/lib/orders/submissionPayload'
import { CLICKUP_DRAFT_BUCKET, draftFilePath, isFileId, type DraftFile } from '@/lib/orders/clickupDrafts'
import { piSheetApplies, piSheetCandidates, piSheetReason, piSheetViewOf, piSheetViewOfQuotation, type PiSheetView } from '@/lib/orders/clickupPiSheet'
import { thumbnailDataUrl } from '@/lib/orders/clickupPiThumbnails'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { readQuotationWorkbook } from '@/lib/pi/quotationSheet'
import { OLD_ORDER_MAX_WORKBOOK_BYTES } from '@/lib/pi/workbookReader'
import { fail, isMissing, NOT_SET_UP, requireDraftsAdmin } from '../../guard'

// GET /api/orders/clickup-drafts/{id}/pi-sheet[?file={fileId}] → the order's PI Excel
// read as a product list (picture, code, name, size, material, quantity, rate, total,
// the totals); an order whose Excel is a quotation export (a Quotation tab, no Master tab)
// is read by readQuotationWorkbook and drawn by the same card. Without ?file it is the newest Excel that reads. The workbook is read
// from the private bucket on each call and nothing is saved. Orders 300 and up only
// (`piSheetApplies`). Administrator only (guard.ts).

export const runtime = 'nodejs'
export const maxDuration = 60

type Reply = {
  applies: boolean
  /** Every Excel of the order, newest first, for the switch. */
  files: { id: string; name: string; uploaded_at: string | null }[]
  /** The Excel the list was read from, or the one asked for. */
  current: string | null
  sheet: PiSheetView | null
  /** Why there is no list, in words. */
  reason: string | null
}

const reply = (body: Reply) => NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=300' } })

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wanted = req.nextUrl.searchParams.get('file')
  if (!isUuid(id) || (wanted !== null && !isFileId(wanted))) return fail(400, 'BAD_REQUEST', 'This link is not valid.')
  const gate = await requireDraftsAdmin()
  if (!gate.ok) return gate.response

  const { data, error } = await gate.service.from('clickup_draft_orders').select('clickup_id, order_no, files').eq('id', id).maybeSingle()
  if (error) {
    if (isMissing(error)) return NOT_SET_UP()
    console.error('[clickup-drafts] pi-sheet lookup failed', { code: error.code })
    return fail(500, 'DB_ERROR', 'The order could not be found. Please try again.')
  }
  if (!data) return fail(404, 'NOT_FOUND', 'This order does not exist.')

  const none: Reply = { applies: false, files: [], current: null, sheet: null, reason: null }
  if (!piSheetApplies(data.order_no as string | null)) return reply(none)
  const candidates = piSheetCandidates((data.files ?? []) as DraftFile[])
  const files = candidates.map(f => ({ id: f.id, name: f.name, uploaded_at: f.uploaded_at }))
  if (candidates.length === 0) return reply({ ...none, applies: true, reason: 'No Excel file was attached to this order in ClickUp.' })

  const tryOrder = wanted ? candidates.filter(f => f.id === wanted) : candidates
  if (tryOrder.length === 0) return fail(404, 'NOT_FOUND', 'This file does not exist.')

  let reason = 'This Excel could not be read as a PI.'
  for (const file of tryOrder) {
    if (file.size > OLD_ORDER_MAX_WORKBOOK_BYTES) { reason = 'This Excel is too large to read here. Download it instead.'; continue }
    const download = await gate.service.storage.from(CLICKUP_DRAFT_BUCKET).download(draftFilePath(data.clickup_id as string, file.id))
    if (download.error || !download.data) { reason = 'This file was not stored. Import the backup folder again.'; continue }
    const bytes = new Uint8Array(await download.data.arrayBuffer())
    let parsed
    try {
      parsed = await parseBoePiWorkbook(bytes, { oldOrder: true })
    } catch {
      reason = 'This Excel could not be opened.'
      continue
    }
    if (!parsed.ok) {
      // A quotation export has a Quotation tab and no Master tab: the same card shows it.
      if (parsed.errors.some(e => e.code === 'MASTER_SHEET_MISSING')) {
        const quotation = await readQuotationWorkbook(bytes).catch(() => null)
        if (quotation?.ok) {
          const pictures = new Map<number, string>()
          for (const l of quotation.data.lines) {
            const thumb = l.image ? await thumbnailDataUrl(l.image.bytes) : null
            if (thumb) pictures.set(l.row, thumb)
          }
          return reply({ applies: true, files, current: file.id, sheet: piSheetViewOfQuotation(quotation.data, pictures), reason: null })
        }
      }
      reason = piSheetReason(parsed.errors)
      continue
    }
    if (parsed.data.products.length === 0) { reason = piSheetReason([{ code: 'NO_PRODUCT_ROWS' }]); continue }

    const pictures = new Map<number, string>()
    for (const p of parsed.data.products) {
      const thumb = p.representativeImage ? await thumbnailDataUrl(p.representativeImage.bytes) : null
      if (thumb) pictures.set(p.row, thumb)
    }
    return reply({ applies: true, files, current: file.id, sheet: piSheetViewOf(parsed, pictures), reason: null })
  }
  return reply({ applies: true, files, current: tryOrder[0].id, sheet: null, reason })
}
