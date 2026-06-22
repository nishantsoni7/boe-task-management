import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

// PDFKit is a CJS module. Next.js may wrap it so the constructor lands on .default.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocumentRaw = require('pdfkit')
const PDFDocument: typeof import('pdfkit') = PDFDocumentRaw.default ?? PDFDocumentRaw

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function requireAuth(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null
  const client = svc()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null
  const { data: profile } = await client
    .from('users').select('id, role, full_name').eq('id', user.id).single()
  if (!profile) return null
  return {
    client,
    id:        profile.id        as string,
    role:      profile.role      as string,
    full_name: profile.full_name as string,
  }
}

// Idempotent: returns existing quotation_no or generates the next one.
// Safe to call twice — the DB function never increments the counter twice
// for the same inquiry.
async function getOrCreateQuotationNo(
  client: SupabaseClient,
  inquiryId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('get_or_create_quotation_no', {
    p_inquiry_id: inquiryId,
  })
  if (error) {
    console.error('[getOrCreateQuotationNo] rpc failed:', error.message)
    return null
  }
  return data as string | null
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    // Include Supabase service-role key so images from private Storage buckets
    // are accessible on the server without a signed URL.
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
    const headers: Record<string, string> = supabaseKey
      ? { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
      : {}
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    // Only return buffers PDFKit can embed: PNG (\x89PNG) or JPEG (\xff\xd8)
    if (buf[0] === 0x89 && buf[1] === 0x50) return buf  // PNG
    if (buf[0] === 0xff && buf[1] === 0xd8) return buf  // JPEG
    return null
  } catch {
    return null
  }
}

// ── GET /api/showroom/quotation/[id] ─────────────────────────────────────────
// Uses the same flat-query pattern as POST to avoid PostgREST schema-cache
// failures when showroom_products columns change (e.g. images, dimensions).

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // ── 1. Fetch inquiry (flat) ─────────────────────────────────────────────────
  const { data: inquiry, error: inqErr } = await caller.client
    .from('showroom_inquiries')
    .select('id, salesperson_id, customer_name, customer_mobile, company, city, project_name, status, discount_percent, quotation_no, quotation_status, quotation_sent_at, created_at')
    .eq('id', id)
    .single()

  if (inqErr || !inquiry) {
    return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 })
  }

  // ── 2. Access control ───────────────────────────────────────────────────────
  if (caller.role !== 'admin' && inquiry.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── 3. Fetch salesperson name (flat) ────────────────────────────────────────
  const { data: spProfile } = await caller.client
    .from('users').select('full_name').eq('id', inquiry.salesperson_id).single()

  // ── 4. Fetch items (flat, include saved quotation overrides) ────────────────
  const { data: dbItems, error: itemsErr } = await caller.client
    .from('showroom_inquiry_items')
    .select('id, product_id, quantity, mrp_at_time, rate_override, customization_note')
    .eq('inquiry_id', id)
    .order('created_at')

  if (itemsErr) {
    return NextResponse.json({ error: 'Failed to load items' }, { status: 500 })
  }

  // ── 5. Fetch products (flat, wildcard to pick up new columns) ───────────────
  const productIds = [...new Set((dbItems ?? []).map(i => i.product_id))]
  const productsById: Record<string, Record<string, unknown>> = {}
  if (productIds.length > 0) {
    const { data: products } = await caller.client
      .from('showroom_products').select('*').in('id', productIds)
    for (const p of products ?? []) productsById[p.id as string] = p
  }

  // ── 6. Merge: rate_override > mrp_at_time ───────────────────────────────────
  const mergedItems: PdfItem[] = (dbItems ?? []).map(item => {
    const prod = productsById[item.product_id] ?? null
    const dbRate   = Number(item.rate_override)
    const fallback = Math.max(0, Number(item.mrp_at_time))
    const primaryImg = (prod?.images as string[] | null)?.[0] ?? (prod?.image_url as string | null) ?? null
    return {
      quantity:           Math.max(1, Number(item.quantity) || 1),
      rate:               (dbRate > 0) ? dbRate : fallback,
      mrp_at_time:        fallback,
      customization_note: (item.customization_note as string | null) ?? null,
      product: prod ? {
        product_code: (prod.product_code as string) || '—',
        name:         (prod.name         as string) || 'Unknown',
        image_url:    primaryImg,
        dimensions:   prod.dimensions as NonNullable<PdfItem['product']>['dimensions'],
      } : null,
    }
  })

  // ── 7. Assign quotation number (idempotent) ─────────────────────────────────
  const quotationNo = await getOrCreateQuotationNo(caller.client, id)

  // ── 8. Build PDF ────────────────────────────────────────────────────────────
  let pdfBytes: Buffer
  try {
    pdfBytes = await buildEnhancedPdf({
      customer_name:    inquiry.customer_name,
      customer_mobile:  inquiry.customer_mobile,
      company:          inquiry.company,
      city:             inquiry.city,
      project_name:     inquiry.project_name,
      salesperson_name: (spProfile as { full_name: string } | null)?.full_name ?? '—',
      discount_percent: Number(inquiry.discount_percent),
      quotation_no:     quotationNo,
      created_at:       inquiry.created_at,
      items:            mergedItems,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.error('[quotation GET] buildEnhancedPdf failed:', detail)
    return NextResponse.json({ error: `PDF generation failed: ${detail}` }, { status: 500 })
  }

  // ── 9. Update status ────────────────────────────────────────────────────────
  if (inquiry.status === 'new' || inquiry.status === 'in_discussion') {
    await caller.client
      .from('showroom_inquiries')
      .update({ status: 'quotation_sent' })
      .eq('id', id)
  }
  // Mark quotation as sent only if still in draft — never overwrite converted/lost.
  // COALESCE preserves the original quotation_sent_at if already recorded.
  if (inquiry.quotation_status === 'draft') {
    await caller.client
      .from('showroom_inquiries')
      .update({
        quotation_status:  'sent',
        quotation_sent_at: inquiry.quotation_sent_at ?? new Date().toISOString(),
      })
      .eq('id', id)
      .eq('quotation_status', 'draft')
  }

  // ── 10. Return PDF ──────────────────────────────────────────────────────────
  const date     = new Date().toISOString().slice(0, 10)
  const safeName = inquiry.customer_name.replace(/[^a-zA-Z0-9\-_]/g, '_')
  const filename = `BOE-Quotation-${safeName}-${date}.pdf`

  return new NextResponse(new Uint8Array(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(pdfBytes.length),
    },
  })
}

function fmt(n: number): string {
  // Use "Rs." instead of ₹ — Helvetica (built-in PDF font) only covers Latin-1;
  // the rupee sign U+20B9 is outside that range and causes PDFKit to throw.
  return 'Rs. ' + Math.round(n).toLocaleString('en-IN')
}

// ── POST /api/showroom/quotation/[id] ────────────────────────────────────────
// Accepts edited item rates, quantities, customization notes, and discount.
// Builds an enhanced PDF with product images and dimensions.

type OverrideItem = {
  id: string
  quantity: number
  rate: number
  customization_note?: string | null
}

type PdfItem = {
  quantity: number
  rate: number
  mrp_at_time: number
  customization_note: string | null
  product: {
    product_code: string
    name: string
    image_url: string | null
    dimensions: { width?: number | null; depth?: number | null; height?: number | null; unit?: string } | null
  } | null
}

type PdfData = {
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
  salesperson_name: string
  discount_percent: number
  quotation_no: string | null
  created_at: string
  items: PdfItem[]
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  let body: { discount_percent?: number; items?: OverrideItem[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const discountPercent = Math.max(0, Math.min(100, Number(body.discount_percent) || 0))

  // ── Fetch inquiry (flat) ─────────────────────────────────────────────────────
  const { data: inquiry, error: inqErr } = await caller.client
    .from('showroom_inquiries')
    .select('id, salesperson_id, customer_name, customer_mobile, company, city, project_name, status, quotation_no, quotation_status, quotation_sent_at, created_at')
    .eq('id', id)
    .single()

  if (inqErr || !inquiry) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (caller.role !== 'admin' && inquiry.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Fetch salesperson name ───────────────────────────────────────────────────
  const { data: spProfile } = await caller.client
    .from('users').select('full_name').eq('id', inquiry.salesperson_id).single()

  // ── Fetch items (flat, include saved quotation overrides) ────────────────────
  const { data: dbItems, error: itemsErr } = await caller.client
    .from('showroom_inquiry_items')
    .select('id, product_id, quantity, mrp_at_time, rate_override, customization_note')
    .eq('inquiry_id', id)
    .order('created_at')

  if (itemsErr) return NextResponse.json({ error: 'Failed to load items' }, { status: 500 })

  // ── Fetch products (flat) ────────────────────────────────────────────────────
  const productIds = [...new Set((dbItems ?? []).map(i => i.product_id))]
  const productsById: Record<string, Record<string, unknown>> = {}
  if (productIds.length > 0) {
    const { data: products } = await caller.client
      .from('showroom_products').select('*').in('id', productIds)
    for (const p of products ?? []) productsById[p.id as string] = p
  }

  // ── Merge: client payload > DB rate_override > mrp_at_time ──────────────────
  const overrideMap = new Map((body.items ?? []).map(i => [i.id, i]))

  const mergedItems: PdfItem[] = (dbItems ?? []).map(item => {
    const override = overrideMap.get(item.id)
    const prod = productsById[item.product_id] ?? null

    // Rate: client override → saved rate_override → mrp_at_time
    const clientRate = Number(override?.rate)
    const dbRate     = Number(item.rate_override)
    const fallback   = Math.max(0, Number(item.mrp_at_time))
    const rate = (clientRate > 0) ? clientRate : (dbRate > 0) ? dbRate : fallback

    // Quantity: client override → DB quantity
    const qty = Math.max(1, Math.round(Number(override?.quantity ?? item.quantity) || 1))

    // Note: client override → saved customization_note
    const clientNote = override?.customization_note?.trim() ?? null
    const note = clientNote ?? (item.customization_note as string | null) ?? null

    const primaryImg = (prod?.images as string[] | null)?.[0] ?? (prod?.image_url as string | null) ?? null
    return {
      quantity: qty,
      rate,
      mrp_at_time: fallback,
      customization_note: note || null,
      product: prod ? {
        product_code: (prod.product_code as string) || '—',
        name:         (prod.name         as string) || 'Unknown',
        image_url:    primaryImg,
        dimensions:   prod.dimensions as NonNullable<PdfItem['product']>['dimensions'],
      } : null,
    }
  })

  // ── Assign quotation number (idempotent) ─────────────────────────────────────
  const quotationNo = await getOrCreateQuotationNo(caller.client, id)

  // ── Build PDF ────────────────────────────────────────────────────────────────
  let pdfBytes: Buffer
  try {
    pdfBytes = await buildEnhancedPdf({
      customer_name:    inquiry.customer_name    || 'Customer',
      customer_mobile:  inquiry.customer_mobile  || '—',
      company:          inquiry.company          ?? null,
      city:             inquiry.city             ?? null,
      project_name:     inquiry.project_name     ?? null,
      salesperson_name: (spProfile as { full_name: string } | null)?.full_name ?? '—',
      discount_percent: discountPercent,
      quotation_no:     quotationNo,
      created_at:       inquiry.created_at,
      items:            mergedItems,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.error('[quotation POST] buildEnhancedPdf failed:', detail)
    return NextResponse.json({ error: `PDF generation failed: ${detail}` }, { status: 500 })
  }

  // ── Update status + persist discount ─────────────────────────────────────────
  if (inquiry.status === 'new' || inquiry.status === 'in_discussion') {
    await caller.client
      .from('showroom_inquiries')
      .update({ status: 'quotation_sent', discount_percent: discountPercent })
      .eq('id', id)
  } else {
    await caller.client
      .from('showroom_inquiries')
      .update({ discount_percent: discountPercent })
      .eq('id', id)
  }
  // Mark quotation as sent only if still in draft — never overwrite converted/lost.
  // COALESCE preserves the original quotation_sent_at if already recorded.
  if (inquiry.quotation_status === 'draft') {
    await caller.client
      .from('showroom_inquiries')
      .update({
        quotation_status:  'sent',
        quotation_sent_at: inquiry.quotation_sent_at ?? new Date().toISOString(),
      })
      .eq('id', id)
      .eq('quotation_status', 'draft')
  }

  const date     = new Date().toISOString().slice(0, 10)
  const safeName = inquiry.customer_name.replace(/[^a-zA-Z0-9\-_]/g, '_')
  const filename = `BOE-Quotation-${safeName}-${date}.pdf`

  return new NextResponse(new Uint8Array(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(pdfBytes.length),
    },
  })
}

// ── Enhanced PDF builder ──────────────────────────────────────────────────────

async function buildEnhancedPdf(data: PdfData): Promise<Buffer> {
  // Pre-fetch product images concurrently (best-effort, failures silently skipped)
  const imageBuffers: Array<Buffer | null> = await Promise.all(
    data.items.map(item =>
      item.product?.image_url ? fetchImageBuffer(item.product.image_url) : Promise.resolve(null)
    )
  )

  return new Promise<Buffer>((resolve, reject) => {
    const doc      = new PDFDocument({ margin: 50, size: 'A4' })
    const buffers: Buffer[] = []
    doc.on('data',  (chunk: Buffer) => buffers.push(chunk))
    doc.on('end',   ()              => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const pageW = doc.page.width   // 595
    const L = 40, R = 40           // left / right margin
    const contentW = pageW - L - R // 515

    const date = new Date(data.created_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    })

    // ── Header band ─────────────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 72).fillColor('#1A2035').fill()

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF')
       .text('BOE', L, 18)
    doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
       .text('Best of Exports', L, 42)

    doc.fontSize(18).font('Helvetica-Bold').fillColor('#FFFFFF')
       .text('QUOTATION', L, 18, { align: 'right', width: contentW })
    doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
       .text(`No. ${data.quotation_no ?? 'Pending'}`, L, 40, { align: 'right', width: contentW })
    doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
       .text(`Date: ${date}`, L, 52, { align: 'right', width: contentW })

    // ── Customer + salesperson block ─────────────────────────────────────────
    let y = 88
    const colMid = L + Math.floor(contentW / 2) + 8

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#9CA3AF').text('BILL TO', L, y)
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#9CA3AF').text('PREPARED BY', colMid, y)
    y += 12

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(data.customer_name, L, y)
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(data.salesperson_name, colMid, y)
    y += 13

    doc.fontSize(9).font('Helvetica').fillColor('#374151').text(data.customer_mobile, L, y)
    doc.fontSize(9).font('Helvetica').fillColor('#374151').text('Best of Exports', colMid, y)
    y += 12

    if (data.company) {
      doc.fontSize(9).font('Helvetica').fillColor('#374151').text(data.company, L, y)
      y += 12
    }
    if (data.city) {
      doc.fontSize(9).font('Helvetica').fillColor('#374151').text(data.city, L, y)
      y += 12
    }
    if (data.project_name) {
      doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text(`Project: ${data.project_name}`, L, y)
      y += 12
    }

    y += 10
    doc.moveTo(L, y).lineTo(L + contentW, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 12

    // ── Table columns ────────────────────────────────────────────────────────
    // img | code | name/dims/note | qty | unit price | total
    const IMG_W  = 52
    const CODE_W = 56
    const QTY_W  = 28
    const RATE_W = 76
    const TOT_W  = 76
    const NAME_W = contentW - IMG_W - CODE_W - QTY_W - RATE_W - TOT_W - 10 // ~227

    const cImg  = L
    const cCode = cImg  + IMG_W + 6
    const cName = cCode + CODE_W + 4
    const cQty  = cName + NAME_W + 4
    const cRate = cQty  + QTY_W  + 4
    const cTot  = cRate + RATE_W + 4

    // Table header row
    doc.rect(L - 2, y - 4, contentW + 4, 18).fillColor('#F1F5F9').fill()
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#64748B')
    doc.text('IMAGE',    cImg,  y, { width: IMG_W })
    doc.text('CODE',     cCode, y, { width: CODE_W })
    doc.text('PRODUCT / DIMENSIONS', cName, y, { width: NAME_W })
    doc.text('QTY',  cQty,  y, { width: QTY_W,  align: 'right' })
    doc.text('UNIT PRICE', cRate, y, { width: RATE_W, align: 'right' })
    doc.text('TOTAL', cTot, y, { width: TOT_W,  align: 'right' })
    y += 18

    doc.moveTo(L, y).lineTo(L + contentW, y).strokeColor('#CBD5E1').lineWidth(0.5).stroke()
    y += 6

    // ── Product rows ─────────────────────────────────────────────────────────
    let subtotal = 0

    data.items.forEach((item, idx) => {
      const prod      = item.product
      const lineTotal = item.rate * item.quantity
      subtotal       += lineTotal

      // Build text lines for height estimation
      const dimParts: string[] = []
      if (prod?.dimensions) {
        const d = prod.dimensions
        const u = d.unit === 'inches' ? '"' : ` ${d.unit ?? 'in'}`
        if (d.width  != null) dimParts.push(`W ${d.width}${u}`)
        if (d.depth  != null) dimParts.push(`D ${d.depth}${u}`)
        if (d.height != null) dimParts.push(`H ${d.height}${u}`)
      }
      const hasDims   = dimParts.length > 0
      const hasNote   = !!item.customization_note
      const hasAdj    = item.mrp_at_time > 0 && Math.abs(item.rate - item.mrp_at_time) > 0.5
      const textLines = 1 + (hasDims ? 1 : 0) + (hasNote ? 1 : 0) + (hasAdj ? 1 : 0)
      const IMG_H     = 52
      const rowHeight = Math.max(IMG_H + 8, textLines * 13 + 10)

      if (y + rowHeight > doc.page.height - 160) {
        doc.addPage()
        y = 50
      }

      // Alternating row background
      if (idx % 2 === 1) {
        doc.rect(L - 2, y - 2, contentW + 4, rowHeight + 4).fillColor('#F8FAFC').fill()
      }

      // Product image
      const imgBuf = imageBuffers[idx]
      if (imgBuf) {
        try {
          doc.image(imgBuf, cImg, y, { fit: [IMG_W, IMG_H], align: 'center', valign: 'center' })
        } catch { /* skip unsupported format */ }
      } else {
        doc.rect(cImg, y, IMG_W, IMG_H).fillColor('#F1F5F9').fill()
        doc.fontSize(6).font('Helvetica').fillColor('#CBD5E1')
           .text('No image', cImg, y + IMG_H / 2 - 4, { width: IMG_W, align: 'center' })
      }

      // Product code
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1E293B')
         .text(prod?.product_code ?? '—', cCode, y, { width: CODE_W })

      // Product name
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827')
         .text(prod?.name ?? 'Unknown product', cName, y, { width: NAME_W })

      let textY = y + 13

      // Dimensions
      if (hasDims) {
        doc.fontSize(7.5).font('Helvetica').fillColor('#6B7280')
           .text(dimParts.join(' x '), cName, textY, { width: NAME_W })
        textY += 11
      }

      // Customization note
      if (item.customization_note) {
        doc.fontSize(7.5).font('Helvetica').fillColor('#92400E')
           .text(`Customization: ${item.customization_note}`, cName, textY, { width: NAME_W })
        textY += 11
      }

      // Price adjustment indicator
      if (hasAdj) {
        const delta = item.rate - item.mrp_at_time
        const sign  = delta > 0 ? '+' : ''
        doc.fontSize(7).font('Helvetica').fillColor(delta < 0 ? '#059669' : '#DC2626')
           .text(`Adj: ${sign}${fmt(delta)} vs MRP ${fmt(item.mrp_at_time)}`, cName, textY, { width: NAME_W })
      }

      // Qty / unit price / line total
      doc.fontSize(9).font('Helvetica').fillColor('#111827')
      doc.text(String(item.quantity), cQty,  y, { width: QTY_W,  align: 'right' })

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1A2035')
         .text(fmt(item.rate), cRate, y, { width: RATE_W, align: 'right' })

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#0F172A')
         .text(fmt(lineTotal), cTot, y, { width: TOT_W, align: 'right' })

      y += rowHeight + 4

      // Light row divider
      doc.moveTo(L, y - 2).lineTo(L + contentW, y - 2).strokeColor('#F1F5F9').lineWidth(0.3).stroke()
    })

    y += 6
    doc.moveTo(L, y).lineTo(L + contentW, y).strokeColor('#CBD5E1').lineWidth(0.5).stroke()
    y += 14

    // ── Totals block (right-aligned) ─────────────────────────────────────────
    const discAmt    = subtotal * data.discount_percent / 100
    const finalTotal = subtotal - discAmt
    const tLabelX    = L + contentW - TOT_W - RATE_W - 10
    const tValueX    = L + contentW - TOT_W
    const tLabelW    = RATE_W + 6
    const tValueW    = TOT_W

    doc.fontSize(9).font('Helvetica').fillColor('#374151')
    doc.text('Subtotal (Ex-Factory)',  tLabelX, y, { width: tLabelW })
    doc.text(fmt(subtotal), tValueX, y, { width: tValueW, align: 'right' })
    y += 15

    if (data.discount_percent > 0) {
      doc.fillColor('#059669')
      doc.text(`Discount (${data.discount_percent}%)`, tLabelX, y, { width: tLabelW })
      doc.text(`- ${fmt(discAmt)}`, tValueX, y, { width: tValueW, align: 'right' })
      y += 15
    }

    doc.moveTo(tLabelX, y).lineTo(L + contentW, y).strokeColor('#CBD5E1').lineWidth(0.5).stroke()
    y += 10

    // Final Quotation Value — prominent
    doc.rect(tLabelX - 8, y - 4, contentW - (tLabelX - L) + 8, 28)
       .fillColor('#1A2035').fill()
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFFFFF')
       .text('Final Quotation Value', tLabelX, y + 2, { width: tLabelW })
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#FFFFFF')
       .text(fmt(finalTotal), tValueX, y + 1, { width: tValueW, align: 'right' })
    y += 36

    // ── Commercial Notes ─────────────────────────────────────────────────────
    if (y > doc.page.height - 140) {
      doc.addPage()
      y = 50
    }

    doc.moveTo(L, y).lineTo(L + contentW, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 12

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('COMMERCIAL NOTES', L, y)
    y += 13

    const notes = [
      'Prices are ex-factory.',
      'GST @ 18% extra.',
      'Fabric cost extra depending on selected fabric.',
      'Packing charges extra.',
      'Transport / logistics charges extra, if applicable.',
      'This is a preliminary showroom quotation. Final detailed quotation will be shared after confirmation.',
    ]

    doc.fontSize(8).font('Helvetica').fillColor('#6B7280')
    for (const note of notes) {
      doc.text(`•  ${note}`, L + 4, y, { width: contentW - 4 })
      y += 12
    }

    // ── Page footer ──────────────────────────────────────────────────────────
    const footerY = doc.page.height - 32
    doc.moveTo(L, footerY).lineTo(L + contentW, footerY).strokeColor('#E5E7EB').lineWidth(0.3).stroke()
    doc.fontSize(7).font('Helvetica').fillColor('#9CA3AF')
       .text('Best of Exports  |  Showroom Preliminary Quotation', L, footerY + 6, { width: contentW, align: 'center' })

    doc.end()
  })
}
