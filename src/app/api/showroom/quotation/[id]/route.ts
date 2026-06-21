import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit') as typeof import('pdfkit')

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

// ── GET /api/showroom/quotation/[id] ─────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await requireAuth(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch inquiry with items + product details + salesperson name
  const { data: inquiry, error: inqErr } = await caller.client
    .from('showroom_inquiries')
    .select(`
      id, salesperson_id, customer_name, customer_mobile,
      company, city, project_name, lead_source,
      status, discount_percent, notes, created_at,
      users ( full_name ),
      showroom_inquiry_items (
        id, quantity, mrp_at_time,
        showroom_products ( product_code, name, category )
      )
    `)
    .eq('id', id)
    .single()

  if (inqErr || !inquiry) {
    return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 })
  }

  // Access control: own inquiry or admin
  if (caller.role !== 'admin' && inquiry.salesperson_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Build PDF ───────────────────────────────────────────────────────────────

  let pdfBytes: Buffer
  try {
    pdfBytes = await buildPdf(inquiry as unknown as InquiryRow)
  } catch (e) {
    console.error('[quotation] buildPdf failed:', e)
    return NextResponse.json({ error: 'Failed to generate PDF. Please try again.' }, { status: 500 })
  }

  // ── Update status to quotation_sent if currently new or in_discussion ───────

  if (inquiry.status === 'new' || inquiry.status === 'in_discussion') {
    await caller.client
      .from('showroom_inquiries')
      .update({ status: 'quotation_sent' })
      .eq('id', id)
  }

  // ── Return PDF ──────────────────────────────────────────────────────────────

  const date    = new Date().toISOString().slice(0, 10)
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

// ── PDF builder ──────────────────────────────────────────────────────────────

type InquiryRow = {
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
  lead_source: string
  discount_percent: number
  created_at: string
  users: { full_name: string }[] | null
  showroom_inquiry_items: Array<{
    quantity: number
    mrp_at_time: number
    showroom_products: { product_code: string; name: string; category: string } | null
  }>
}

function buildPdf(inquiry: InquiryRow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc  = new PDFDocument({ margin: 50, size: 'A4' })
    const buffers: Buffer[] = []
    doc.on('data', (chunk: Buffer) => buffers.push(chunk))
    doc.on('end',  ()             => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const pageWidth  = doc.page.width  - 100   // margins 50 each side
    const usersArr = inquiry.users as { full_name: string }[] | { full_name: string } | null
    const salesperson = Array.isArray(usersArr)
      ? (usersArr[0]?.full_name ?? '—')
      : (usersArr as { full_name: string } | null)?.full_name ?? '—'
    const date        = new Date(inquiry.created_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    })
    const items = inquiry.showroom_inquiry_items ?? []

    // ── BOE Header ──────────────────────────────────────────────────────────

    doc
      .fontSize(22).font('Helvetica-Bold').fillColor('#1A2035')
      .text('BOE', 50, 50)
      .fontSize(9).font('Helvetica').fillColor('#6B7280')
      .text('BOE Operating System', 50, 76)

    doc
      .fontSize(16).font('Helvetica-Bold').fillColor('#1A2035')
      .text('Quotation', 50, 50, { align: 'right', width: pageWidth })
      .fontSize(9).font('Helvetica').fillColor('#6B7280')
      .text(`Date: ${date}`, 50, 76, { align: 'right', width: pageWidth })

    doc.moveTo(50, 100).lineTo(50 + pageWidth, 100).strokeColor('#E5E7EB').lineWidth(1).stroke()

    // ── Customer details ────────────────────────────────────────────────────

    let y = 116
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#9CA3AF').text('CUSTOMER', 50, y)
    y += 14

    const customerLines = [
      inquiry.customer_name,
      inquiry.customer_mobile,
      ...(inquiry.company     ? [inquiry.company]     : []),
      ...(inquiry.city        ? [inquiry.city]         : []),
      ...(inquiry.project_name ? [`Project: ${inquiry.project_name}`] : []),
    ]
    doc.fontSize(10).font('Helvetica').fillColor('#111827')
    customerLines.forEach(line => {
      doc.text(line, 50, y); y += 14
    })

    // Salesperson (right column)
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#9CA3AF').text('SALESPERSON', 310, 116)
    doc.fontSize(10).font('Helvetica').fillColor('#111827').text(salesperson, 310, 130)

    y = Math.max(y, 145) + 16

    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 14

    // ── Product table header ────────────────────────────────────────────────

    const COL = { code: 50, name: 110, qty: 340, mrp: 385, total: 465 }

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6B7280')
    doc.text('CODE',    COL.code, y)
    doc.text('PRODUCT', COL.name, y)
    doc.text('QTY',     COL.qty,  y, { width: 40, align: 'right' })
    doc.text('MRP',     COL.mrp,  y, { width: 75, align: 'right' })
    doc.text('TOTAL',   COL.total, y, { width: 85, align: 'right' })
    y += 12

    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 8

    // ── Product rows ────────────────────────────────────────────────────────

    let mrpTotal = 0

    items.forEach((item, idx) => {
      const prod = item.showroom_products
      const lineTotal = item.mrp_at_time * item.quantity
      mrpTotal += lineTotal

      // Alternate row shading
      if (idx % 2 === 0) {
        doc.rect(48, y - 2, pageWidth + 4, 16).fillColor('#F9FAFB').fill()
      }

      doc.fontSize(9).font('Helvetica').fillColor('#111827')
      doc.text(prod?.product_code ?? '—', COL.code, y, { width: 55 })
      doc.text(prod?.name ?? 'Unknown',   COL.name, y, { width: 220 })
      doc.text(String(item.quantity),     COL.qty,  y, { width: 40,  align: 'right' })
      doc.text(fmt(item.mrp_at_time),     COL.mrp,  y, { width: 75,  align: 'right' })
      doc.text(fmt(lineTotal),            COL.total, y, { width: 85, align: 'right' })
      y += 16
    })

    y += 4
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#D1D5DB').lineWidth(0.5).stroke()
    y += 12

    // ── Totals ──────────────────────────────────────────────────────────────

    const discPct    = inquiry.discount_percent
    const discAmt    = mrpTotal * discPct / 100
    const finalTotal = mrpTotal - discAmt

    const totalsX = 380

    doc.fontSize(9).font('Helvetica').fillColor('#374151')
    doc.text('MRP Total',        totalsX, y, { width: 100 })
    doc.text(fmt(mrpTotal),      totalsX, y, { width: 165, align: 'right' }); y += 14

    if (discPct > 0) {
      doc.fillColor('#059669')
      doc.text(`Discount (${discPct}%)`,            totalsX, y, { width: 100 })
      doc.text(`− ${fmt(discAmt)}`, totalsX, y, { width: 165, align: 'right' }); y += 14
    }

    doc.moveTo(totalsX, y).lineTo(50 + pageWidth, y).strokeColor('#D1D5DB').lineWidth(0.5).stroke()
    y += 10

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1A2035')
    doc.text('Final Total',      totalsX, y, { width: 100 })
    doc.text(fmt(finalTotal),    totalsX, y, { width: 165, align: 'right' }); y += 24

    // ── Footer ──────────────────────────────────────────────────────────────

    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
    y += 12

    doc
      .fontSize(8).font('Helvetica').fillColor('#9CA3AF')
      .text(
        'This is an estimated showroom quotation. Final pricing and terms will be confirmed by BOE.',
        50, y, { width: pageWidth, align: 'center' }
      )

    doc.end()
  })
}

function fmt(n: number): string {
  // Use "Rs." instead of ₹ — Helvetica (built-in PDF font) only covers Latin-1;
  // the rupee sign U+20B9 is outside that range and causes PDFKit to throw.
  return 'Rs. ' + Math.round(n).toLocaleString('en-IN')
}
