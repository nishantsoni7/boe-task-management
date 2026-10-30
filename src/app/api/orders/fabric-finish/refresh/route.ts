// ── Update from workbook: read only a PI's two side sheets again ─────────────
//
// Approvals usually arrive after the PI was uploaded (owner, 2026-10-30). This
// reads the "Packing cost and Fabric Cost" and "Fabric and Finish" sheets of a
// newer workbook and nothing else: the PI's products, prices and totals do not
// move, and anything typed in the app still wins.
//
// TWO STEPS, because a PI is up to 10 MiB and a serverless request body is
// smaller. `prepare` hands the browser a signed upload key for one temporary
// object; the second call downloads that object, parses it HERE (the browser's
// parse is never an input) and removes it. Who may is the database's answer, the
// same one typing on the sheet gets, on both steps.
//
// Privacy, as for process-draft: counts and fixed sentences only.

import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { matchFabricFinishSheets, normProductCode } from '@/lib/pi/fabricFinishSheets'
import { PI_MAX_WORKBOOK_BYTES } from '@/lib/pi/workbookReader'
import { isUuid, sha256Hex } from '@/lib/orders/submissionPayload'
import {
  FABRIC_FINISH_LINE_COLUMNS,
  saveFabricFinishSheets,
  sheetLinesFor,
  type SheetLine,
} from '@/lib/orders/fabricFinishServer'

export const runtime = 'nodejs'

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

const uploadFolder = (submissionId: string) => `submissions/${submissionId}/fabric-finish/workbook/`
const uploadPath = (submissionId: string, path: string) =>
  path.startsWith(uploadFolder(submissionId)) && /^[0-9a-f-]{36}\.xlsx$/.test(path.slice(uploadFolder(submissionId).length))

type StoredItem = { id: string; item_sequence: string | null; source_row: number; source_product_code: string | null }
type StoredLine = Record<string, unknown>

/** A stored item's line key: its item number, or its row id when it has none. */
const lineKey = (item: StoredItem) => (item.item_sequence ?? '').trim() || item.id

/** The sheet values a line already has, so a line this workbook lacks keeps them. */
function keptLine(row: StoredLine): SheetLine {
  const num = (key: string) => (row[key] === null || row[key] === undefined ? null : Number(row[key]))
  const finish = Array.isArray(row.sheet_finish) ? row.sheet_finish as SheetLine['finish'] : []
  return {
    item_sequence: String(row.item_sequence),
    fabric_metres_per_piece: num('sheet_fabric_metres_per_piece'),
    fabric_price_per_metre: num('sheet_fabric_price_per_metre'),
    packing_cost_per_piece: num('sheet_packing_cost_per_piece'),
    packing_type: typeof row.sheet_packing_type === 'string' ? row.sheet_packing_type : null,
    finish,
  }
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: { submissionId?: unknown; path?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, 'BAD_REQUEST', 'A PI is required.') }
  const submissionId = typeof body.submissionId === 'string' ? body.submissionId : ''
  if (!isUuid(submissionId)) return fail(400, 'BAD_REQUEST', 'A PI is required.')

  const may = await authClient.rpc('can_edit_order_submission_fabric_finish', { p_submission_id: submissionId })
  if (may.error || may.data !== true) {
    return fail(403, 'FORBIDDEN', 'You cannot change the fabric and finish details of this PI.')
  }

  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Reading a workbook is not configured on this deployment.')
  const service = admin.client
  const bucket = service.storage.from('order-files')

  // ── Step one: somewhere to put the file ──
  if (body.path === undefined) {
    const path = `${uploadFolder(submissionId)}${randomUUID()}.xlsx`
    const signed = await bucket.createSignedUploadUrl(path)
    if (signed.error || !signed.data) return fail(500, 'UPLOAD_NOT_PREPARED', 'The workbook could not be received. Please try again.')
    return NextResponse.json({ path: signed.data.path, token: signed.data.token })
  }

  // ── Step two: read it, and always remove it ──
  const path = typeof body.path === 'string' ? body.path : ''
  if (!uploadPath(submissionId, path)) return fail(400, 'BAD_PATH', 'The uploaded file could not be located.')
  try {
    const download = await bucket.download(path)
    if (download.error || !download.data) return fail(404, 'WORKBOOK_NOT_STORED', 'The workbook could not be found. Please choose it again.')
    const bytes = new Uint8Array(await download.data.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > PI_MAX_WORKBOOK_BYTES) {
      return fail(413, 'WORKBOOK_SIZE', 'A PI workbook must be between 1 byte and 10 MB.')
    }

    let parsed
    try {
      parsed = await parseBoePiWorkbook(bytes)
    } catch {
      return fail(422, 'PARSE_FAILED', 'This workbook could not be read. Please check the file and try again.')
    }
    // Blocking issues concern the Master, which this does not store.
    if (!parsed.ok || !parsed.data.fabricFinish) {
      return fail(422, 'PARSE_FAILED', 'This workbook could not be read. Please check the file and try again.')
    }

    const { data: items, error: itemsError } = await service.from('order_submission_items')
      .select('id, item_sequence, source_row, source_product_code').eq('submission_id', submissionId)
    if (itemsError || !items) return fail(500, 'LOOKUP_FAILED', 'This PI could not be read. Please try again.')
    const stored = items as StoredItem[]

    // By item number, then product code, then the row it was read from.
    const match = matchFabricFinishSheets(parsed.data.fabricFinish, parsed.data.products)
    const masterProduct = new Map(parsed.data.products.map(p => [p.row, p]))
    const taken = new Set<string>()
    const lines = sheetLinesFor(match, product => {
      const sequence = normProductCode(masterProduct.get(product.productRow)?.itemSequence)
      const code = normProductCode(product.code)
      const item = stored.find(i => !taken.has(i.id) && sequence !== '' && normProductCode(i.item_sequence) === sequence)
        ?? stored.find(i => !taken.has(i.id) && code !== '' && normProductCode(i.source_product_code) === code)
        ?? stored.find(i => !taken.has(i.id) && i.source_row === product.productRow)
      if (!item) return null
      taken.add(item.id)
      return lineKey(item)
    })

    if (lines.length === 0 || lines.length * 2 < stored.length) {
      return fail(422, 'WORKBOOK_NOT_THIS_PI', 'This workbook does not match the products on this PI, so nothing was changed.')
    }

    // A line this workbook lacks keeps what the sheet already said for it.
    const read = new Set(lines.map(l => l.item_sequence))
    const { data: existing, error: existingError } = await service.from('order_submission_fabric_finish_lines')
      .select(FABRIC_FINISH_LINE_COLUMNS).eq('submission_id', submissionId)
    if (existingError) return fail(500, 'LOOKUP_FAILED', 'This PI could not be read. Please try again.')
    const kept = ((existing ?? []) as unknown as StoredLine[])
      .filter(row => row.sheet_read_at && !read.has(String(row.item_sequence)))
      .map(keptLine)

    const result = await saveFabricFinishSheets(service, submissionId, sha256Hex(bytes), [...lines, ...kept])
    if (!result.saved) return fail(500, 'SAVE_FAILED', 'The workbook was read but could not be saved. Please try again.')
    return NextResponse.json({ ok: true, products: lines.length, total: stored.length, pictures: result.pictures })
  } finally {
    await bucket.remove([path]).catch(() => undefined)
  }
}
