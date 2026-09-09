import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { pickPrimaryImage } from '@/lib/showroom/quotationImages'
import {
  buildEnhancedPdf,
  type OverrideItem,
  type PdfItem,
} from '@/lib/showroom/quotationPdf'

export const runtime = 'nodejs'

// This route downloads one image per line item from a public web origin, may
// re-encode them, and renders a multi-page PDF — the same shape as the order
// documents route, which is why it takes the same budget. Without it the
// function ran on the platform default, and because image fetching is
// deliberately best-effort, a slow origin did not fail the request: it produced
// a quotation with the images silently missing.
export const maxDuration = 60

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
    // One rule for which image represents a product, shared with the tests that
    // pin it: images[0] first, the legacy image_url second, blanks skipped.
    const primaryImg = pickPrimaryImage(prod)
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

  // ── 7. Quotation number — READ, never assign ────────────────────────────────
  //
  // Preview must not call get_or_create_quotation_no(). Despite the name, that
  // function is a WRITE when the number is null: it increments
  // showroom_quotation_seq for the year and UPDATEs showroom_inquiries.
  // Previewing a quotation would therefore consume a number from the company's
  // sequence — and a salesperson who previewed twice and generated once would
  // leave a permanent gap in BOE-QTN-YYYY-NNNN.
  //
  // The number is already in the row fetched in step 1, so preview shows the
  // real one once it exists. Before that it says DRAFT, which is true: the
  // quotation has not been issued, and the number is allocated by POST at the
  // moment it is.
  const quotationNo = inquiry.quotation_no ?? 'DRAFT'

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

  // ── 9. Return the PDF for PREVIEW ───────────────────────────────────────────
  //
  // GET writes nothing. It used to set `status = 'quotation_sent'` and
  // `quotation_status = 'sent'`, which meant merely LOOKING at the document
  // recorded it as sent to the customer — the salesperson could not check a
  // rate before committing to it, and an inquiry could show "Quotation Sent"
  // with a `quotation_sent_at` timestamp when nothing had left the building.
  //
  // That was also plainly wrong as HTTP: a GET must be safe, and anything that
  // prefetches, retries or crawls this URL was changing pipeline state.
  //
  // Sending is POST, which is the verb the Download/Share action already uses
  // and where the status writes now live exclusively. This is the whole of the
  // preview/send separation — no new state, no new column, no state machine
  // change, and the converted/lost protections are untouched because the only
  // code that could move the status is the one that already had them.
  //
  // `inline` rather than `attachment`: a preview should open in the viewer, not
  // land in the downloads folder.
  const date     = new Date().toISOString().slice(0, 10)
  const safeName = inquiry.customer_name.replace(/[^a-zA-Z0-9\-_]/g, '_')
  const filename = `BOE-Quotation-${safeName}-${date}.pdf`

  return new NextResponse(new Uint8Array(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length':      String(pdfBytes.length),
      // A preview must never be served from a cache after a rate was edited.
      'Cache-Control':       'no-store',
    },
  })
}

// ── POST /api/showroom/quotation/[id] ────────────────────────────────────────
// Accepts edited item rates, quantities, customization notes, and discount.
// Builds an enhanced PDF with product images and dimensions.

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

    // One rule for which image represents a product, shared with the tests that
    // pin it: images[0] first, the legacy image_url second, blanks skipped.
    const primaryImg = pickPrimaryImage(prod)
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
