import { createClient } from '@supabase/supabase-js'
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

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
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
      customization_note: (item.customization_note as string | null) ?? null,
      product: prod ? {
        product_code: (prod.product_code as string) || '—',
        name:         (prod.name         as string) || 'Unknown',
        image_url:    primaryImg,
        dimensions:   prod.dimensions as NonNullable<PdfItem['product']>['dimensions'],
      } : null,
    }
  })

  // ── 7. Build PDF ────────────────────────────────────────────────────────────
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
      quotation_no:     (inquiry.quotation_no as string | null) ?? null,
      created_at:       inquiry.created_at,
      items:            mergedItems,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.error('[quotation GET] buildEnhancedPdf failed:', detail)
    return NextResponse.json({ error: `PDF generation failed: ${detail}` }, { status: 500 })
  }

  // ── 8. Update status ────────────────────────────────────────────────────────
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

  // ── 9. Return PDF ───────────────────────────────────────────────────────────
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
      customization_note: note || null,
      product: prod ? {
        product_code: (prod.product_code as string) || '—',
        name:         (prod.name         as string) || 'Unknown',
        image_url:    primaryImg,
        dimensions:   prod.dimensions as NonNullable<PdfItem['product']>['dimensions'],
      } : null,
    }
  })

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
      quotation_no:     (inquiry.quotation_no as string | null) ?? null,
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

    const pageWidth = doc.page.width - 100
    const date = new Date(data.created_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    })

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1A2035').text('BOE', 50, 50)
    doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('Best of Exports', 50, 76)
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1A2035')
       .text('Quotation', 50, 50, { align: 'right', width: pageWidth })
    doc.fontSize(9).font('Helvetica').fillColor('#6B7280')
       .text(`No: ${data.quotation_no ?? 'Pending'}`, 50, 69, { align: 'right', width: pageWidth })
    doc.fontSize(9).font('Helvetica').fillColor('#6B7280')
       .text(`Date: ${date}`, 50, 82, { align: 'right', width: pageWidth })
    doc.moveTo(50, 100).lineTo(50 + pageWidth, 100).strokeColor('#E5E7EB').lineWidth(1).stroke()

    // ── Customer + salesperson ───────────────────────────────────────────────
    let y = 116
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#9CA3AF').text('CUSTOMER', 50, y)
    y += 14
    const customerLines = [
      data.customer_name,
      data.customer_mobile,
      ...(data.company      ? [data.company]                      : []),
      ...(data.city         ? [data.city]                         : []),
      ...(data.project_name ? [`Project: ${data.project_name}`]   : []),
    ]
    doc.fontSize(10).font('Helvetica').fillColor('#111827')
    customerLines.forEach(line => { doc.text(line, 50, y); y += 14 })

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#9CA3AF').text('SALESPERSON', 310, 116)
    doc.fontSize(10).font('Helvetica').fillColor('#111827').text(data.salesperson_name, 310, 130)

    y = Math.max(y, 145) + 16
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 14

    // ── Table header ─────────────────────────────────────────────────────────
    const COL = { img: 50, code: 100, name: 162, qty: 342, rate: 387, total: 462 }
    const IMG = 36

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6B7280')
    doc.text('CODE',    COL.code, y, { width: 58 })
    doc.text('PRODUCT', COL.name, y, { width: 175 })
    doc.text('QTY',     COL.qty,  y, { width: 40,  align: 'right' })
    doc.text('RATE',    COL.rate, y, { width: 70,  align: 'right' })
    doc.text('TOTAL',   COL.total, y, { width: 88, align: 'right' })
    y += 12
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 8

    // ── Product rows ─────────────────────────────────────────────────────────
    let subtotal = 0

    data.items.forEach((item, idx) => {
      const prod      = item.product
      const lineTotal = item.rate * item.quantity
      subtotal       += lineTotal

      // Estimate row height
      const hasDims = !!prod?.dimensions && (() => {
        const d = prod!.dimensions!
        return d.width != null || d.depth != null || d.height != null
      })()
      const hasNote   = !!item.customization_note
      const textLines = 1 + (hasDims ? 1 : 0) + (hasNote ? 1 : 0)
      const rowHeight = Math.max(IMG + 8, textLines * 13 + 8)

      if (y + rowHeight > doc.page.height - 120) {
        doc.addPage()
        y = 50
      }

      if (idx % 2 === 0) {
        doc.rect(48, y - 2, pageWidth + 4, rowHeight + 4).fillColor('#F9FAFB').fill()
      }

      // Image thumbnail
      const imgBuf = imageBuffers[idx]
      if (imgBuf) {
        try {
          doc.image(imgBuf, COL.img, y, { fit: [IMG, IMG] })
        } catch { /* skip if format unsupported */ }
      }

      // Code + name + dimensions + note
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827')
         .text(prod?.product_code ?? '—', COL.code, y, { width: 58 })

      doc.fontSize(9).font('Helvetica').fillColor('#111827')
         .text(prod?.name ?? 'Unknown', COL.name, y, { width: 175 })

      let textY = y + 13
      if (hasDims && prod?.dimensions) {
        const d = prod.dimensions
        const u = d.unit === 'inches' ? '"' : ` ${d.unit ?? 'in'}`
        const parts: string[] = []
        if (d.width  != null) parts.push(`W ${d.width}${u}`)
        if (d.depth  != null) parts.push(`D ${d.depth}${u}`)
        if (d.height != null) parts.push(`H ${d.height}${u}`)
        if (parts.length > 0) {
          doc.fontSize(7).font('Helvetica').fillColor('#6B7280')
             .text(parts.join(' x '), COL.name, textY, { width: 175 })
          textY += 11
        }
      }
      if (item.customization_note) {
        doc.fontSize(7).font('Helvetica').fillColor('#6B7280')
           .text(`Note: ${item.customization_note}`, COL.name, textY, { width: 175 })
      }

      // Qty / rate / total (right-aligned columns)
      doc.fontSize(9).font('Helvetica').fillColor('#111827')
      doc.text(String(item.quantity), COL.qty,   y, { width: 40,  align: 'right' })
      doc.text(fmt(item.rate),        COL.rate,  y, { width: 70,  align: 'right' })
      doc.text(fmt(lineTotal),        COL.total, y, { width: 88,  align: 'right' })

      y += rowHeight + 4
    })

    y += 4
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#D1D5DB').lineWidth(0.5).stroke()
    y += 12

    // ── Totals ───────────────────────────────────────────────────────────────
    const discAmt    = subtotal * data.discount_percent / 100
    const finalTotal = subtotal - discAmt
    const totalsX    = 380

    doc.fontSize(9).font('Helvetica').fillColor('#374151')
    doc.text('Subtotal',   totalsX, y, { width: 82 })
    doc.text(fmt(subtotal), totalsX, y, { width: 170, align: 'right' }); y += 14

    if (data.discount_percent > 0) {
      doc.fillColor('#059669')
      doc.text(`Discount (${data.discount_percent}%)`, totalsX, y, { width: 82 })
      doc.text(`- ${fmt(discAmt)}`, totalsX, y, { width: 170, align: 'right' }); y += 14
    }

    doc.moveTo(totalsX, y).lineTo(50 + pageWidth, y).strokeColor('#D1D5DB').lineWidth(0.5).stroke()
    y += 10

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1A2035')
    doc.text('Final Total',   totalsX, y, { width: 82 })
    doc.text(fmt(finalTotal), totalsX, y, { width: 170, align: 'right' }); y += 24

    // ── Footer ───────────────────────────────────────────────────────────────
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 12
    doc.fontSize(8).font('Helvetica').fillColor('#9CA3AF')
       .text(
         'This is an estimated showroom quotation. Final pricing and terms will be confirmed by BOE.',
         50, y, { width: pageWidth, align: 'center' }
       )

    doc.end()
  })
}
