import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { parsePiWorkbook, PiParseError, type PiParseResult } from '@/lib/meetings/piImport'
import { authorizePiImporter, rejectPiFile } from '@/lib/meetings/piRequest'

// Confirm a PI import: create the order and its products, then attach the
// photographs.
//
// ONE SERVER-CONTROLLED OPERATION, and the ordering is the whole design.
// PostgreSQL and Storage cannot share a transaction, so the sequence is chosen
// so that every failure point leaves a state a person can understand:
//
//   1. Re-parse the workbook. The browser sends the FILE again, never the
//      preview it was shown — a confirmation that trusted client-side data
//      would let an edited payload write products the parser never approved.
//   2. Create the order and all items in ONE call to import_meeting_rows(),
//      which is atomic and already exists. If it fails, nothing is uploaded and
//      nothing is left behind.
//   3. Upload the deduplicated photographs.
//   4. Attach each stored key to its items.
//
// IDEMPOTENCY comes free from the existing RPC and is not re-implemented here:
// import_meeting_rows matches an order on (meeting_id, order_number_key) and an
// item on (meeting_order_id, sku_key), creating only what is absent. Confirming
// the same PI twice therefore UPDATES the same order rather than making a second
// one. The image keys are content-addressed, so a retry re-derives the identical
// path and overwrites in place instead of accumulating copies.
//
// CLEANUP: an object uploaded during a run that then fails to be attached is
// removed, and only if this run created it. An object that already existed is
// never deleted — another item may reference it, and content addressing means
// an identical photograph legitimately has one key shared by many rows.
//
// Everything here runs AS THE CALLER, not as the service role: the Supabase
// client is built with the user's own token, so RLS and every meeting policy
// apply exactly as they would from the browser.

export const maxDuration = 60

type ConfirmResult = {
  orderNumber: string
  itemsCreated: number
  itemsUpdated: number
  imagesUploaded: number
  imagesFailed: number
  warnings: string[]
}

export async function POST(req: NextRequest) {
  const token = await authorizePiImporter(req)
  if (!token) {
    return NextResponse.json({ error: 'You do not have permission to import into meetings.' }, { status: 403 })
  }

  let file: File | null = null
  let meetingId = ''
  try {
    const form = await req.formData()
    file = form.get('file') as File | null
    meetingId = String(form.get('meeting_id') ?? '')
  } catch {
    return NextResponse.json({ error: 'Could not read the uploaded file.' }, { status: 400 })
  }

  if (!file || !meetingId) {
    return NextResponse.json({ error: 'The PI file and the meeting are both required.' }, { status: 400 })
  }
  const rejection = rejectPiFile(file)
  if (rejection) return NextResponse.json({ error: rejection.error }, { status: rejection.status })

  // As the caller. Every write below is subject to the same RLS the browser has.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  )

  // ── 1. Re-parse ──
  let parsed: PiParseResult
  try {
    parsed = parsePiWorkbook(new Uint8Array(await file.arrayBuffer()))
  } catch (err) {
    if (err instanceof PiParseError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('[meetings:import-pi:confirm] parse failed')
    return NextResponse.json({ error: 'That PI could not be read.' }, { status: 500 })
  }

  const warnings: string[] = []

  // ── 2. Rows, atomically, through the existing RPC ──
  const rows = parsed.products.map(product => ({
    order_number: parsed.piNumber,
    order_type: 'new_order',
    sku: product.code,
    product_name: product.name || product.code,
    quantity: product.quantity == null ? '' : String(product.quantity),
    dimensions: product.dimensions ?? '',
    spec_note: product.specNote ?? '',
  }))

  const { error: rpcError } = await supabase.rpc('import_meeting_rows', {
    p_meeting_id: meetingId,
    p_rows: rows,
  })

  if (rpcError) {
    // Nothing was uploaded, so there is nothing to clean up. This is why the
    // rows go first.
    console.error('[meetings:import-pi:confirm] row import refused:', rpcError.code)
    return NextResponse.json(
      { error: rpcError.message?.replace(/^[A-Z_]+:\s*/, '') || 'The products could not be imported.' },
      { status: 400 },
    )
  }

  // ── 3. Find the order and its items, to key the uploads ──
  const { data: orderRow } = await supabase
    .from('meeting_orders')
    .select('id, order_number')
    .eq('meeting_id', meetingId)
    .eq('order_number_key', parsed.piNumber.trim().toUpperCase())
    .maybeSingle()

  if (!orderRow) {
    // The rows committed but cannot be read back — the reviewer still has their
    // products, so this is reported as a partial success, not a failure.
    return NextResponse.json({
      orderNumber: parsed.piNumber, itemsCreated: parsed.products.length, itemsUpdated: 0,
      imagesUploaded: 0, imagesFailed: parsed.images.size,
      warnings: ['The products were imported, but their photographs could not be attached. Re-run the import to add them.'],
    } satisfies ConfirmResult)
  }

  const { data: itemRows } = await supabase
    .from('meeting_order_items')
    .select('id, sku, image_path')
    .eq('meeting_order_id', orderRow.id)

  const itemBySku = new Map(
    (itemRows ?? []).map((r: { id: string; sku: string; image_path: string | null }) =>
      [r.sku.trim().toUpperCase(), r]),
  )

  // ── 4. Upload deduplicated photographs, then attach ──
  let uploaded = 0
  let failed = 0
  /** Keys this run put into the bucket, for cleanup if attaching fails. */
  const createdKeys: string[] = []

  for (const image of parsed.images.values()) {
    const key = `${orderRow.id}/${image.hash}.${image.ext}`
    const contentType = image.ext === 'png' ? 'image/png' : 'image/jpeg'

    if (image.bytes.byteLength > 2 * 1024 * 1024) {
      // The bucket refuses it regardless; say so rather than failing opaquely.
      failed++
      warnings.push(`One photograph is over 2 MB and was not stored (${image.rows.length} product(s) affected).`)
      continue
    }

    // upsert: a retry re-derives the same content-addressed key, so repeating a
    // confirmation overwrites identical bytes instead of duplicating them.
    const { error: uploadError } = await supabase.storage
      .from('meeting-product-images')
      .upload(key, image.bytes, { contentType, upsert: true })

    if (uploadError) {
      failed++
      continue
    }
    uploaded++
    createdKeys.push(key)

    for (const row of image.rows) {
      const product = parsed.products.find(p => p.row === row)
      if (!product) continue
      const item = itemBySku.get(product.code.trim().toUpperCase())
      if (!item) continue
      const { error: attachError } = await supabase.rpc('set_meeting_item_image_path', {
        p_item_id: item.id,
        p_image_path: key,
      })
      if (attachError) failed++
    }
  }

  // Remove anything this run uploaded that no item ended up referencing. Only
  // keys created here are considered — an object that was already present may
  // belong to another item and is never touched.
  if (createdKeys.length > 0) {
    const { data: after } = await supabase
      .from('meeting_order_items')
      .select('image_path')
      .eq('meeting_order_id', orderRow.id)
      .not('image_path', 'is', null)
    const referenced = new Set((after ?? []).map((r: { image_path: string }) => r.image_path))
    const orphans = createdKeys.filter(k => !referenced.has(k))
    if (orphans.length > 0) {
      await supabase.storage.from('meeting-product-images').remove(orphans)
    }
  }

  if (failed > 0) {
    warnings.push(
      `${failed} photograph${failed === 1 ? '' : 's'} could not be attached. `
      + 'The products were imported — re-run the import to try the images again.',
    )
  }
  for (const w of parsed.warnings) {
    if (w.code === 'residual_rows_ignored' || w.code === 'boundary_disagreement') warnings.push(w.message)
  }

  return NextResponse.json({
    orderNumber: orderRow.order_number,
    itemsCreated: parsed.products.length,
    itemsUpdated: 0,
    imagesUploaded: uploaded,
    imagesFailed: failed,
    warnings,
  } satisfies ConfirmResult)
}
