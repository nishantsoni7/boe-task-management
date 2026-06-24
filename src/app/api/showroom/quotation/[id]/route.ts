import { createClient, SupabaseClient } from '@supabase/supabase-js'
import fsPromises from 'fs/promises'
import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import sharp from 'sharp'

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

/**
 * Resolves a raw image field value to a fetchable HTTPS URL.
 *
 * Handles three shapes stored in showroom_products:
 *   1. Full URL  — "https://…"
 *   2. Supabase storage path — "products/abc.jpg"  (no scheme)
 *   3. JSON array  — already unwrapped by caller before reaching here,
 *      but guard anyway
 *
 * For storage paths we generate a signed URL via the admin client so the
 * request works even when the bucket is not public.
 */
async function resolveImageUrl(rawValue: unknown): Promise<string | null> {
  // Unwrap JSON arrays — take the first element
  let value = rawValue
  if (Array.isArray(value)) value = value[0] ?? null
  if (!value || typeof value !== 'string') return null

  const str = value.trim()
  if (!str) return null

  // Already an absolute URL
  if (str.startsWith('http://') || str.startsWith('https://')) return str

  // Supabase storage path — generate a signed URL (1 hour)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.warn('[image] storage path detected but SUPABASE_SERVICE_ROLE_KEY is missing — cannot sign URL:', str)
    return null
  }

  // Determine bucket: first path segment if it looks like "bucket/path…", else "products"
  const slash = str.indexOf('/')
  const bucket = slash > 0 ? str.slice(0, slash) : 'products'
  const objectPath = slash > 0 ? str.slice(slash + 1) : str

  try {
    const adminClient = createClient(supabaseUrl, serviceKey)
    const { data, error } = await adminClient.storage
      .from(bucket)
      .createSignedUrl(objectPath, 3600)
    if (error || !data?.signedUrl) {
      console.warn('[image] createSignedUrl failed for', str, error?.message)
      return null
    }
    return data.signedUrl
  } catch (err) {
    console.warn('[image] createSignedUrl threw for', str, err)
    return null
  }
}

async function fetchImageBuffer(
  rawImageField: unknown,
  label: string,   // product code/name for logging
): Promise<Buffer | null> {
  console.log(`[pdf-img] ${label} | raw field:`, JSON.stringify(rawImageField))

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    console.warn(`[pdf-img] ${label} | SUPABASE_SERVICE_ROLE_KEY is not set — image fetch will likely fail for private buckets`)
  }

  const url = await resolveImageUrl(rawImageField)
  console.log(`[pdf-img] ${label} | resolved URL:`, url ?? '(null — skipping)')
  if (!url) return null

  try {
    const headers: Record<string, string> = serviceKey
      ? { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
      : {}
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    console.log(`[pdf-img] ${label} | fetch status: ${res.status}, content-type: ${res.headers.get('content-type') ?? 'unknown'}`)
    if (!res.ok) {
      console.warn(`[pdf-img] ${label} | fetch failed with status ${res.status}`)
      return null
    }

    const buf = Buffer.from(await res.arrayBuffer())
    console.log(`[pdf-img] ${label} | buffer size: ${buf.length} bytes, magic: 0x${buf[0]?.toString(16) ?? '??'}${buf[1]?.toString(16) ?? '??'}`)

    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      console.log(`[pdf-img] ${label} | detected PNG — will embed`)
      return buf
    }
    // JPEG: FF D8
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      console.log(`[pdf-img] ${label} | detected JPEG — will embed`)
      return buf
    }
    // WebP: starts with RIFF….WEBP (bytes 0-3 = 52 49 46 46, bytes 8-11 = 57 45 42 50)
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf.length >= 12 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      console.log(`[pdf-img] ${label} | detected WebP — converting to JPEG via sharp`)
      try {
        const jpeg = await sharp(buf).jpeg({ quality: 85 }).toBuffer()
        console.log(`[pdf-img] ${label} | WebP→JPEG conversion succeeded, size: ${jpeg.length} bytes`)
        return jpeg
      } catch (convErr) {
        console.error(`[pdf-img] ${label} | WebP→JPEG conversion failed:`, convErr)
        return null
      }
    }

    const ct = res.headers.get('content-type') ?? ''
    console.warn(`[pdf-img] ${label} | unrecognised format (content-type: ${ct}) — skipping`)
    return null
  } catch (err) {
    console.error(`[pdf-img] ${label} | fetch threw:`, err)
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

// ── PDF builder ───────────────────────────────────────────────────────────────

async function buildEnhancedPdf(data: PdfData): Promise<Buffer> {
  // Load BOE logo from project public assets
  const logoPath = path.join(process.cwd(), 'public', 'branding', 'boe-logo-full.png')
  let logoBuffer: Buffer | null = null
  try {
    logoBuffer = await fsPromises.readFile(logoPath)
  } catch {
    console.warn('[pdf] logo not found at', logoPath)
  }

  // Pre-fetch product images concurrently (best-effort)
  const imageBuffers: Array<Buffer | null> = await Promise.all(
    data.items.map(item => {
      const label = `${item.product?.product_code ?? '?'} / ${item.product?.name ?? '?'}`
      return fetchImageBuffer(item.product?.image_url ?? null, label)
    })
  )

  return new Promise<Buffer>((resolve, reject) => {
    const doc      = new PDFDocument({ margin: 36, size: 'A4' })
    const buffers: Buffer[] = []
    doc.on('data',  (chunk: Buffer) => buffers.push(chunk))
    doc.on('end',   ()              => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const pageW    = doc.page.width   // 595
    const L        = 36
    const contentW = pageW - L - 36   // 523
    const R_EDGE   = pageW - 36       // 559

    // Brand palette — derived from BOE logo
    const RED    = '#C41920'
    const DARK   = '#1F2937'
    const GRAY   = '#6B7280'
    const LGRAY  = '#9CA3AF'
    const BORDER = '#E5E7EB'

    const date = new Date(data.created_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    })

    // ── Red top accent stripe ─────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 3).fillColor(RED).fill()

    // ── Header: logo left, quotation meta right ───────────────────────────────
    let y = 40

    // Logo — natural ratio ~2.65:1, rendered at height 44 → width ≈ 117
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, L, y, { height: 44 })
      } catch {
        doc.fontSize(20).font('Helvetica-Bold').fillColor(RED).text('BOE', L, y)
      }
    } else {
      doc.fontSize(20).font('Helvetica-Bold').fillColor(RED).text('BOE', L, y)
    }

    // Tagline sits below the logo
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor(RED)
       .text('CRAFTING SPACES. DEFINING EXPERIENCES.', L, y + 52)

    // Right: QUOTATION heading, right-aligned
    doc.fontSize(22).font('Helvetica-Bold').fillColor(DARK)
       .text('QUOTATION', L, y, { align: 'right', width: contentW })

    // Short red accent dash under the heading
    doc.moveTo(R_EDGE - 36, y + 29).lineTo(R_EDGE, y + 29)
       .strokeColor(RED).lineWidth(2).stroke()

    // Quotation details — two-column grid anchored to the right
    const qLabelW  = 96
    const qBlockX  = R_EDGE - 260
    const qValueX  = qBlockX + qLabelW + 8
    const qValueW  = R_EDGE - qValueX
    const qRow1    = y + 38
    const qRow2    = qRow1 + 17

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(LGRAY)
       .text('QUOTATION NO.', qBlockX, qRow1, { width: qLabelW })
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
       .text(data.quotation_no ?? '—', qValueX, qRow1, { width: qValueW })

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(LGRAY)
       .text('DATE', qBlockX, qRow2, { width: qLabelW })
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
       .text(date, qValueX, qRow2, { width: qValueW })

    // Advance past whichever header column is taller
    y = Math.max(y + 52 + 10, qRow2 + 18) + 10

    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 20

    // ── Client block ─────────────────────────────────────────────────────────
    doc.fontSize(7).font('Helvetica-Bold').fillColor(RED)
       .text('QUOTATION FOR', L, y)
    doc.moveTo(L, y + 10).lineTo(L + 40, y + 10).strokeColor(RED).lineWidth(1.5).stroke()
    y += 18

    doc.fontSize(16).font('Helvetica-Bold').fillColor(DARK)
       .text(data.customer_name, L, y)
    y += 22

    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
       .text(data.customer_mobile, L, y)
    y += 13

    if (data.company) {
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text(data.company, L, y)
      y += 13
    }
    if (data.city) {
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text(data.city, L, y)
      y += 13
    }
    if (data.project_name) {
      doc.fontSize(8).font('Helvetica').fillColor(LGRAY)
         .text(`Project: ${data.project_name}`, L, y)
      y += 13
    }

    y += 22
    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 20

    // ── Product cards ─────────────────────────────────────────────────────────
    // Single horizontal card per product — image left, all info right.
    // Spec row sits inside the right column (no full-width bottom section).
    // Target: 4 cards per page, ~180pt each.
    const CARD_PAD = 10
    const IMG_SIZE = 160                          // 160×160 fit box
    const IMG_X    = L + CARD_PAD                // 46
    const INFO_X   = IMG_X + IMG_SIZE + 14       // 220
    const INFO_W   = R_EDGE - INFO_X - CARD_PAD  // 329
    const CARD_H   = CARD_PAD + IMG_SIZE + CARD_PAD  // 180
    const CARD_GAP = 8

    let subtotal = 0

    data.items.forEach((item, idx) => {
      const prod      = item.product
      const lineTotal = item.rate * item.quantity
      subtotal       += lineTotal

      // Build dimension string
      const dimParts: string[] = []
      if (prod?.dimensions) {
        const d = prod.dimensions
        const u = d.unit === 'inches' ? '"' : ` ${d.unit ?? 'in'}`
        if (d.width  != null) dimParts.push(`W ${d.width}${u}`)
        if (d.depth  != null) dimParts.push(`D ${d.depth}${u}`)
        if (d.height != null) dimParts.push(`H ${d.height}${u}`)
      }
      const dimStr = dimParts.join(' × ') || '—'

      if (y + CARD_H > doc.page.height - 80) {
        doc.addPage()
        y = 50
      }

      const cardY = y

      // Card border
      doc.rect(L, cardY, contentW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke()

      // ── Image (left column) ──────────────────────────────────────────────────
      const imgBuf = imageBuffers[idx]
      if (imgBuf) {
        try {
          doc.image(imgBuf, IMG_X, cardY + CARD_PAD, {
            fit: [IMG_SIZE, IMG_SIZE],
            align: 'center',
            valign: 'center',
          })
        } catch (imgErr) {
          const label = `${prod?.product_code ?? '?'} / ${prod?.name ?? '?'}`
          console.error(`[pdf-img] ${label} | image insert failed:`, imgErr)
        }
      }

      // ── Right column: name → code → note → spec row ──────────────────────────
      let infoY = cardY + CARD_PAD

      // Product name
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK)
         .text(prod?.name ?? 'Unknown product', INFO_X, infoY, { width: INFO_W })
      infoY += 17

      // Product code
      if (prod?.product_code && prod.product_code !== '—') {
        doc.fontSize(7).font('Helvetica').fillColor(LGRAY)
           .text(prod.product_code, INFO_X, infoY, { width: INFO_W })
        infoY += 13
      }

      // Customization note — compact tinted strip
      if (item.customization_note) {
        const np    = 7
        const noteH = 26
        doc.rect(INFO_X, infoY, INFO_W, noteH).fillColor('#F9FAFB').fill()
        doc.fontSize(6).font('Helvetica-Bold').fillColor(LGRAY)
           .text('CUSTOMIZATION', INFO_X + np, infoY + 5, { width: INFO_W - np * 2 })
        doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
           .text(item.customization_note, INFO_X + np, infoY + 14, { width: INFO_W - np * 2 })
        infoY += noteH + 6
      } else {
        infoY += 4
      }

      // Thin separator before spec row
      doc.moveTo(INFO_X, infoY + 4).lineTo(R_EDGE - CARD_PAD, infoY + 4)
         .strokeColor(BORDER).lineWidth(0.5).stroke()

      // Spec row — 4 equal blocks across INFO_W
      const specLabelY = infoY + 10
      const specValueY = specLabelY + 10
      const blkW       = INFO_W / 4   // ~82pt each

      const specs: Array<{ label: string; value: string }> = [
        { label: 'DIMENSIONS', value: dimStr },
        { label: 'MRP',        value: fmt(item.rate) },
        { label: 'QTY',        value: String(item.quantity) },
        { label: 'LINE TOTAL', value: fmt(lineTotal) },
      ]

      specs.forEach((spec, i) => {
        const bx = INFO_X + i * blkW
        doc.fontSize(6).font('Helvetica-Bold').fillColor(LGRAY)
           .text(spec.label, bx, specLabelY, { width: blkW, align: 'center' })
        doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
           .text(spec.value, bx, specValueY, { width: blkW, align: 'center' })
      })

      y = cardY + CARD_H + CARD_GAP
    })

    y += 6

    // ── Commercial summary card ───────────────────────────────────────────────
    const discAmt    = subtotal * data.discount_percent / 100
    const finalTotal = subtotal - discAmt

    const SUM_PAD = 20
    const nRows   = 1 + (data.discount_percent > 0 ? 1 : 0)
    const SUM_H   = SUM_PAD + nRows * 20 + 12 + 46 + SUM_PAD

    if (y + SUM_H > doc.page.height - 80) {
      doc.addPage()
      y = 50
    }

    const sumCardY = y
    doc.rect(L, sumCardY, contentW, SUM_H).strokeColor(BORDER).lineWidth(0.5).stroke()

    const sumLabelX = L + SUM_PAD
    const sumValueX = R_EDGE - 200
    const sumLabelW = sumValueX - sumLabelX - 8
    const sumValueW = 200 - SUM_PAD

    let sumY = sumCardY + SUM_PAD

    doc.fontSize(8.5).font('Helvetica').fillColor(LGRAY)
       .text('Subtotal (Ex-Factory)', sumLabelX, sumY, { width: sumLabelW })
    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
       .text(fmt(subtotal), sumValueX, sumY, { width: sumValueW, align: 'right' })
    sumY += 20

    if (data.discount_percent > 0) {
      doc.fontSize(8.5).font('Helvetica').fillColor(LGRAY)
         .text(`Discount (${data.discount_percent}%)`, sumLabelX, sumY, { width: sumLabelW })
      doc.fontSize(8.5).font('Helvetica').fillColor(LGRAY)
         .text(`- ${fmt(discAmt)}`, sumValueX, sumY, { width: sumValueW, align: 'right' })
      sumY += 20
    }

    doc.moveTo(L + SUM_PAD, sumY + 6).lineTo(R_EDGE - SUM_PAD, sumY + 6)
       .strokeColor(RED).lineWidth(0.75).stroke()
    sumY += 14

    doc.fontSize(8).font('Helvetica-Bold').fillColor(RED)
       .text('FINAL QUOTATION VALUE', sumLabelX, sumY + 10, { width: sumLabelW })
    doc.fontSize(22).font('Helvetica-Bold').fillColor(RED)
       .text(fmt(finalTotal), sumValueX, sumY, { width: sumValueW, align: 'right' })

    y += SUM_H + 20

    // ── Commercial notes ──────────────────────────────────────────────────────
    if (y > doc.page.height - 180) {
      doc.addPage()
      y = 50
    }

    y += 4
    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 16

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(DARK)
       .text('COMMERCIAL NOTES', L, y)
    doc.moveTo(L, y + 11).lineTo(L + 32, y + 11).strokeColor(RED).lineWidth(1.5).stroke()
    y += 20

    const notes = [
      'Prices are ex-factory.',
      'GST @ 18% extra.',
      'Fabric cost extra depending on selected fabric.',
      'Packing charges extra.',
      'Transport / logistics charges extra, if applicable.',
      'This is a preliminary showroom quotation. Final detailed quotation will be shared after confirmation.',
    ]

    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
    for (const note of notes) {
      doc.text(`•  ${note}`, L + 4, y, { width: contentW - 4 })
      y += 13
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 44
    doc.moveTo(L, footerY).lineTo(R_EDGE, footerY).strokeColor(RED).lineWidth(0.75).stroke()

    doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
       .text(
         'B-7, Trade World, Basni Phase-II, Jodhpur, Rajasthan 342005',
         L, footerY + 9, { width: contentW * 0.44 },
       )
    doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
       .text(
         '+91 80030 34966   |   info@bestofexports.com   |   bestofexports.com',
         L, footerY + 9, { width: contentW, align: 'right' },
       )

    doc.end()
  })
}
