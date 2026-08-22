/**
 * THE CONFIRMED ORDER'S PI HANDOFF, ACTUALLY RENDERED.
 *
 * Source guards prove a string is in a file. They cannot prove that a figure
 * reached the markup, that an absent one did NOT reach it as ₹0, or that the
 * screen does not now state the same money twice under two captions. This file
 * renders the real sections and reads what comes out.
 *
 * WHAT IS NOT TESTED HERE: inline pixel values. A padding is a design decision
 * that will change, and a test that fails when a card breathes differently is a
 * test nobody keeps. What is asserted is content, absence, and the preservation
 * of the shared components both PI screens already use.
 *
 * Run:
 *   npx tsx --test "src/app/orders/*\/orderPiHandoff.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ORDER_PI_PRODUCTS_TITLE,
  ORDER_PI_SECTION_TITLE,
  OrderDocumentsCard,
  OrderPiNoSource,
  OrderPiProducts,
  OrderPiSummaryCard,
  OrderPiUnavailable,
} from './OrderPiSections'
import {
  ORDER_DOCUMENTS_EXCEL_LABEL,
  ORDER_DOCUMENTS_GENERATE_LABEL,
  ORDER_DOCUMENTS_NONE,
  ORDER_DOCUMENTS_PDF_LABEL,
  ORDER_DOCUMENTS_RETRY_LABEL,
  ORDER_DOCUMENTS_WORKING,
  ORDER_DOCUMENT_FAILURES,
  buildOrderDocumentsView,
  orderDocumentAttemptPath,
  type OrderDocumentRow,
} from '@/lib/orders/orderDocuments'
import {
  ORDER_PI_NO_SOURCE_BODY,
  ORDER_PI_UNAVAILABLE_BODY,
  ORDER_PI_WORKBOOK_LABEL,
  buildOrderPiHandoff,
  type OrderCommercialFacts,
  type OrderPiRow,
} from '@/lib/orders/orderPiHandoff'
import { PiCommercialSummary } from '@/components/orders/piPreview'
import { persistedProducts, type PersistedItem, type PersistedProduct } from '@/lib/orders/draftsView'
import { BILLING_UNDECLARED } from '@/lib/orders/billingPercentage'

const SUBMISSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

function piRow(overrides: Partial<OrderPiRow> = {}): OrderPiRow {
  return {
    id: SUBMISSION_ID,
    client_name: 'Marigold Interiors',
    bill_to_name: 'Marigold Interiors Pvt Ltd',
    ship_to_name: 'Marigold Site Office',
    creation_date: '2026-07-01',
    source_created_by: 'R. Sharma',
    contact_number: '+91 98200 11223',
    bill_to_phone: null,
    ship_to_phone: null,
    billing_address: '14 Nariman Point, Mumbai',
    shipping_address: 'Plot 8, Sector 21, Gurugram',
    order_confirmation_date: '2026-07-04',
    dispatch_commitment: '6 weeks from date of confirmation',
    due_date: '2026-08-15',
    gross_product_amount: '1200000.00',
    discount_amount: '50000.00',
    subtotal_after_discount: '1150000.00',
    fabric_cost: '0',
    fabric_cost_meaning: 'not_applicable',
    fabric_cost_text: null,
    packing_cost: '0',
    packing_cost_meaning: 'included',
    packing_cost_text: 'Inclusive',
    transportation_amount: '20000.00',
    transportation_text: null,
    total_before_gst: '1170000.00',
    gst_amount: '210600.00',
    grand_total: '1380600.00',
    billing_percentage: '65',
    source_workbook_name: 'Marigold-PI-July.xlsx',
    source_workbook_path: `submissions/${SUBMISSION_ID}/original/9f1c-marigold.xlsx`,
    ...overrides,
  }
}

const ORDER: OrderCommercialFacts = { totalProductValue: 1200000, totalValue: 1380600 }

function handoffOf(row = piRow(), order = ORDER) {
  const h = buildOrderPiHandoff(row, order)
  if (h.kind !== 'ready') throw new Error('fixture must be ready')
  return h
}

function summaryMarkup(row = piRow(), order = ORDER, opts: {
  workbookName?: string | null
  downloading?: boolean
  downloadError?: string | null
} = {}) {
  const h = handoffOf(row, order)
  return renderToStaticMarkup(
    <OrderPiSummaryCard
      client={h.client}
      onOpenClient={() => {}}
      dates={h.dates}
      figures={h.figures}
      billing={h.billing}
      workbookName={opts.workbookName === undefined ? h.workbookName : opts.workbookName}
      onDownloadWorkbook={() => {}}
      downloading={opts.downloading ?? false}
      downloadError={opts.downloadError ?? null}
    />,
  )
}

// ── Products ──────────────────────────────────────────────────────────────────

const ITEMS: PersistedItem[] = [
  {
    id: 'item-1', source_row: 41, item_sequence: '1', product_name: 'Cane Lounge Chair',
    quantity: 12, dimensions: '720 × 680 × 900', material: 'Rattan / Teak',
    customization: 'Charcoal weave, brass caps', cost_per_piece: '48000.00',
    total_amount: '576000.00', sort_order: 0,
  },
  {
    id: 'item-2', source_row: 42, item_sequence: '2', product_name: 'Marble Side Table',
    quantity: 8, dimensions: '450 × 450 × 520', material: 'Statuario',
    customization: null, cost_per_piece: '78000.00',
    total_amount: '624000.00', sort_order: 1,
  },
]

const PRODUCTS: PersistedProduct[] = persistedProducts(ITEMS)

function productsMarkup(opts: {
  isMobile?: boolean
  withImages?: boolean
  unresolved?: number
  products?: readonly PersistedProduct[]
} = {}) {
  const urls = new Map<number, string>([
    [41, 'https://signed.example/one.png?token=abc'],
    [42, 'https://signed.example/two.png?token=def'],
  ])
  return renderToStaticMarkup(
    <OrderPiProducts
      products={opts.products ?? PRODUCTS}
      isMobile={opts.isMobile ?? false}
      representativeThumbnail={row => ({
        url: opts.withImages === false ? undefined : urls.get(row),
        label: `Row ${row}`,
        onOpen: () => {},
      })}
      customizationThumbnails={() => []}
      unresolvedImages={opts.unresolved ?? 0}
    />,
  )
}

// ── 1. A PI-linked Order shows the PI ─────────────────────────────────────────

describe('the summary card', () => {
  test('is headed as the approved PI, so the reader knows whose facts these are', () => {
    assert.ok(summaryMarkup().includes(ORDER_PI_SECTION_TITLE))
  })

  test('names the client, and the name is the control that opens the details', () => {
    const html = summaryMarkup()
    assert.ok(html.includes('Marigold Interiors'))
    assert.match(html, /aria-haspopup="dialog"/)
    assert.match(html, /class="pi-detail-summary-client"/)
  })

  test('does NOT print the contact number or either address on the card itself', () => {
    // Reference material. It lives in the dialog behind the name — the approved
    // PI screen's own arrangement, unchanged.
    const html = summaryMarkup()
    assert.ok(!html.includes('98200 11223'))
    assert.ok(!html.includes('Nariman Point'))
    assert.ok(!html.includes('Sector 21'))
  })

  test('prints both schedule dates in the approved schedule band', () => {
    const html = summaryMarkup()
    assert.match(html, /class="pi-detail-summary-schedule"/)
    assert.ok(html.includes('Confirm date'))
    assert.ok(html.includes('Due date'))
  })

  test('an absent due date shows the commitment as prose, never as a date', () => {
    const html = summaryMarkup(piRow({ due_date: null }))
    assert.ok(html.includes('6 weeks from date of confirmation'))
    assert.match(html, /class="pi-detail-summary-metric-absent"/)
  })

  test('states Total before GST — the figure the Order has no column for', () => {
    const html = summaryMarkup()
    assert.ok(html.includes('Total before GST'))
    assert.ok(html.includes('11,70,000'))
  })
})

// ── 2. Billing ────────────────────────────────────────────────────────────────

describe('the billing declaration on the Order', () => {
  test('a declared percentage prints with its derived value', () => {
    const html = summaryMarkup()
    assert.ok(html.includes('Billing percentage'))
    assert.ok(html.includes('65%'))
    assert.ok(html.includes('Billing value'))
    assert.ok(html.includes('7,60,500'))
  })

  test('an undeclared percentage says Undeclared and shows NO value row', () => {
    const html = summaryMarkup(piRow({ billing_percentage: null }))
    assert.ok(html.includes(BILLING_UNDECLARED))
    // `>0%<` and not `0%`: inline styles legitimately carry `max-width:100%`,
    // and matching that would make this assertion pass for the wrong reason.
    assert.ok(!/>\s*0%\s*</.test(html), 'undeclared is not zero per cent')
    assert.ok(!/>\s*—\s*</.test(html), 'undeclared is not an em dash either')
    assert.ok(!html.includes('Billing value'), 'there is nothing to measure')
  })

  test('a declared percentage against a MISSING pre-GST total never renders ₹0', () => {
    const html = summaryMarkup(piRow({ total_before_gst: null }))
    assert.ok(html.includes('65%'))
    assert.ok(html.includes('Billing value'))
    assert.ok(!/₹\s*0(?!\d)/.test(html), 'a missing total must not become ₹0')
  })

  test('the card offers no way to CHANGE the percentage', () => {
    // set_order_submission_billing_percentage refuses an approved record; an
    // Edit control would offer a door the database has closed.
    const html = summaryMarkup()
    assert.ok(!html.includes('pi-detail-summary-billing-action'))
    assert.ok(!/>Edit</.test(html))
    assert.ok(!/>Set</.test(html))
  })
})

// ── 3. The original workbook ──────────────────────────────────────────────────

describe('the original uploaded workbook', () => {
  test('is offered by name, as a control the reader presses', () => {
    const html = summaryMarkup()
    assert.ok(html.includes(ORDER_PI_WORKBOOK_LABEL))
    assert.ok(html.includes('Marigold-PI-July.xlsx'))
    assert.match(html, /<button[^>]*>[\s\S]*?Marigold-PI-July\.xlsx/)
  })

  test('NO URL is embedded in the markup — the link is minted on the click', () => {
    const html = summaryMarkup()
    assert.ok(!/href=/.test(html), 'a signed URL in the page is a URL that outlives the session that made it')
    assert.ok(!html.includes('supabase'))
    assert.ok(!html.includes('token='))
    assert.ok(!html.includes('/storage/v1/'))
  })

  test('the private storage KEY never reaches the markup', () => {
    const html = summaryMarkup()
    assert.ok(!html.includes('submissions/'))
    assert.ok(!html.includes(SUBMISSION_ID))
  })

  test('a viewer with no usable workbook path is offered nothing', () => {
    const html = summaryMarkup(piRow(), ORDER, { workbookName: null })
    assert.ok(!html.includes(ORDER_PI_WORKBOOK_LABEL))
  })

  test('a refusal is one quiet line, and the control stays', () => {
    const html = summaryMarkup(piRow(), ORDER, { downloadError: 'That file is not available to you right now.' })
    assert.ok(html.includes('That file is not available to you right now.'))
    assert.ok(html.includes(ORDER_PI_WORKBOOK_LABEL))
  })

  test('while preparing, the control says so and is disabled', () => {
    const html = summaryMarkup(piRow(), ORDER, { downloading: true })
    assert.ok(html.includes('Preparing…'))
    assert.match(html, /disabled/)
  })
})

// ── 4. Nothing financial is said twice ────────────────────────────────────────

describe('the handoff adds facts rather than repeating them', () => {
  test('Product value is absent when the Order\'s own strip already states it', () => {
    const html = summaryMarkup()
    assert.ok(!html.includes('Product value'),
      'orders.total_product_value is already on screen above this card')
  })

  test('Product value appears when the Order states none', () => {
    const html = summaryMarkup(piRow(), { totalProductValue: null, totalValue: 1380600 })
    assert.ok(html.includes('Product value'))
  })

  test('the card carries NO payment surface of its own', () => {
    // The Order's own Payment Summary above is the verified position. A second
    // one here would answer the same question with a figure that stopped being
    // the authority when the money moved onto the Order.
    const html = summaryMarkup()
    for (const forbidden of [
      'Payment received', 'Verified payment', 'Add payment', 'Payment details',
      'pi-detail-summary-bar', 'pi-detail-summary-received', 'awaiting',
    ]) {
      assert.ok(!html.includes(forbidden), `the handoff must not show "${forbidden}"`)
    }
  })

  test('and no Order-owned identity is restated', () => {
    const html = summaryMarkup()
    for (const forbidden of ['Order Value', 'Completion', 'Requested By', 'Assignee', 'Lead Source']) {
      assert.ok(!html.includes(forbidden), `"${forbidden}" belongs to the Order header`)
    }
  })
})

// ── 5. Products and their photographs ─────────────────────────────────────────

describe('the product lines', () => {
  test('render through the SHARED table head both PI screens use', () => {
    const html = productsMarkup()
    assert.ok(html.includes(ORDER_PI_PRODUCTS_TITLE))
    for (const column of ['Product', 'Qty', 'Dimensions', 'Material', 'Customization']) {
      assert.ok(html.includes(column), `${column} must be in the shared head`)
    }
  })

  test('every line, its figures and its line total reach the markup', () => {
    const html = productsMarkup()
    assert.ok(html.includes('Cane Lounge Chair'))
    assert.ok(html.includes('Marble Side Table'))
    assert.ok(html.includes('5,76,000'))
    assert.ok(html.includes('6,24,000'))
    assert.ok(html.includes('2 lines'))
  })

  test('product images render as thumbnails from their SIGNED urls', () => {
    const html = productsMarkup()
    assert.ok(html.includes('https://signed.example/one.png?token=abc'))
    assert.ok(html.includes('https://signed.example/two.png?token=def'))
    assert.match(html, /<img/)
  })

  test('a picture that could not be signed shows the honest empty box, not a broken image', () => {
    const html = productsMarkup({ withImages: false })
    assert.ok(!html.includes('https://signed.example/'))
    assert.ok(!/<img[^>]*src=""/.test(html), 'an empty src is a broken image')
  })

  test('pictures the record names but could not sign are REPORTED', () => {
    const html = productsMarkup({ unresolved: 3 })
    assert.ok(html.includes('3 images unavailable'))
  })

  test('a PI with no stored lines says so rather than showing an empty table', () => {
    const html = productsMarkup({ products: [] })
    assert.ok(html.includes('No product lines are stored against the approved PI.'))
  })

  test('at phone width the table becomes a stack of cards', () => {
    const html = productsMarkup({ isMobile: true })
    assert.ok(!html.includes('<table'))
    assert.ok(html.includes('Cane Lounge Chair'))
    assert.ok(html.includes('Line total'))
  })
})

// ── 6. The commercial breakdown ───────────────────────────────────────────────

describe('the commercial breakdown', () => {
  const html = renderToStaticMarkup(
    <PiCommercialSummary rows={handoffOf().commercialRows} title="Commercial breakdown" variant="detail" />,
  )

  test('is the approved PI\'s own calculation, line for line', () => {
    for (const label of [
      'Gross product amount', 'Discount', 'Subtotal after discount',
      'Fabric cost', 'Packing cost', 'Transportation',
      'Total before GST', 'GST', 'Grand Total',
    ]) {
      assert.ok(html.includes(label), `${label} must be in the breakdown`)
    }
  })

  test('keeps the cost MEANINGS the workbook stated', () => {
    assert.ok(html.includes('Not applicable'))
    assert.ok(html.includes('Included'))
  })

  test('does NOT state the advance requirement — this Order already exists', () => {
    assert.ok(!html.includes('Required advance'))
  })
})

// ── 7. The unavailable state ──────────────────────────────────────────────────

describe('when the linked PI cannot be read', () => {
  const html = renderToStaticMarkup(<OrderPiUnavailable />)

  test('says so in one restrained sentence', () => {
    assert.ok(html.includes(ORDER_PI_UNAVAILABLE_BODY))
  })

  test('shows NOT ONE figure — never ₹0, never an invented value', () => {
    assert.ok(!html.includes('₹'))
    assert.ok(!/\d/.test(html.replace(/<[^>]*>/g, '')))
  })

  test('offers no retry and no explanation of why', () => {
    assert.ok(!html.includes('Try again'))
    assert.ok(!/permission|not allowed|forbidden|denied/i.test(html))
  })
})

// ── 8. The page wires it the way the module intends ───────────────────────────

describe('/orders/[id] itself', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')

  /**
   * CORRECTED. This test used to assert the opposite — that an Order with no
   * linked PI rendered nothing at all — and the assertion was faithfully
   * enforcing a decision that turned out to be wrong in use. The first person
   * to open this screen could not tell "this Order has no PI" apart from "the
   * feature was never deployed", and reported the feature missing.
   *
   * Silence is only a good answer when the reader can already infer the
   * reason. Here they cannot, so the screen says it.
   */
  test('an Order with no source PI is TOLD it has none, not left silent', () => {
    assert.ok(page.includes("piHandoff.kind === 'ready'"))
    assert.ok(page.includes("piHandoff.kind === 'unavailable'"))
    assert.ok(page.includes("piHandoff.kind === 'none' && <OrderPiNoSource />"))
    assert.ok(page.includes('OrderPiNoSource,'), 'the component must be imported')
  })

  test('the no-PI panel still gets NO documents card — there is nothing to generate', () => {
    // The documents card stays behind `kind !== 'none'`. Explaining the absence
    // must not become an invitation to generate a document that cannot exist.
    assert.match(page, /piHandoff\.kind !== 'none' && \(/)
    const noSourceAt = page.indexOf("piHandoff.kind === 'none' && <OrderPiNoSource />")
    const cardAt = page.indexOf("piHandoff.kind !== 'none' && (")
    assert.ok(noSourceAt > cardAt, 'the explanation follows the card gate, it does not widen it')
  })

  test('reads the PI through the caller\'s own session, with no service key anywhere', () => {
    assert.ok(!/service_role|SERVICE_ROLE|createServiceClient/.test(page))
    assert.ok(page.includes("from('order_submissions')"))
  })

  test('signs the workbook on demand and never builds a public URL', () => {
    assert.ok(page.includes('createSignedUrl('))
    assert.ok(!page.includes('getPublicUrl'))
  })

  test('the four anchored Order reads are issued together', () => {
    assert.ok(page.includes('await Promise.all(['))
    assert.ok(page.includes('const handoff = loadPiHandoff(mapped)'))
  })

  test('the Order select asks for the link and the billing percentage', () => {
    assert.ok(page.includes('source_order_submission_id, billing_percentage'))
  })
})

// ── 9. The confirmed documents card ───────────────────────────────────────────

const DOC_ORDER = '11111111-2222-3333-4444-555555555555'

function docRow(over: Partial<OrderDocumentRow> = {}): OrderDocumentRow {
  return {
    id: 'v1', order_id: DOC_ORDER, version: 1, status: 'ready', attempt_count: 1,
    claimed_at: null, completed_at: '2026-08-20T10:00:00Z',
    last_error_code: null, last_error_message: null,
    excel_path: orderDocumentAttemptPath(DOC_ORDER, 1, 1, 'xlsx'),
    pdf_path: orderDocumentAttemptPath(DOC_ORDER, 1, 1, 'pdf'),
    excel_sha256: 'a'.repeat(64), pdf_sha256: 'b'.repeat(64),
    excel_bytes: 1000, pdf_bytes: 2000,
    created_at: '2026-08-20T09:00:00Z', updated_at: '2026-08-20T10:00:00Z',
    ...over,
  }
}

function documentsMarkup(rows: OrderDocumentRow[], opts: {
  canGenerate?: boolean
  generating?: boolean
  downloading?: 'xlsx' | 'pdf' | null
  error?: string | null
} = {}) {
  return renderToStaticMarkup(
    <OrderDocumentsCard
      view={buildOrderDocumentsView(rows)}
      canGenerate={opts.canGenerate ?? false}
      onGenerate={() => {}}
      generating={opts.generating ?? false}
      onDownload={() => {}}
      downloading={opts.downloading ?? null}
      error={opts.error ?? null}
    />,
  )
}

describe('the confirmed documents card', () => {
  test('an Order nobody has asked about says so, and offers no download', () => {
    const html = documentsMarkup([])
    assert.ok(html.includes(ORDER_DOCUMENTS_NONE))
    assert.ok(!html.includes(ORDER_DOCUMENTS_EXCEL_LABEL))
    assert.ok(!html.includes(ORDER_DOCUMENTS_PDF_LABEL))
  })

  test('a ready version offers BOTH downloads', () => {
    const html = documentsMarkup([docRow()])
    assert.ok(html.includes(ORDER_DOCUMENTS_EXCEL_LABEL))
    assert.ok(html.includes(ORDER_DOCUMENTS_PDF_LABEL))
    assert.ok(html.includes('Ready'))
    assert.ok(html.includes('Version 1'))
  })

  test('NO STORAGE PATH AND NO URL reaches the markup', () => {
    // The link is minted on the click, through the reader's own session, so the
    // page never carries one that could outlive it.
    const html = documentsMarkup([docRow()])
    assert.ok(!html.includes('orders/'))
    assert.ok(!html.includes('approved.xlsx'))
    assert.ok(!html.includes(DOC_ORDER))
    assert.ok(!/href=/.test(html))
    assert.ok(!html.includes('token='))
  })

  test('a HALF-ready version offers nothing — document-ready means both files', () => {
    for (const half of [{ pdf_path: null }, { excel_path: null }]) {
      const html = documentsMarkup([docRow(half)])
      assert.ok(!html.includes(ORDER_DOCUMENTS_EXCEL_LABEL), JSON.stringify(half))
      assert.ok(!html.includes(ORDER_DOCUMENTS_PDF_LABEL), JSON.stringify(half))
    }
  })

  test('a generation in flight says so, with NO progress bar and no estimate', () => {
    const html = documentsMarkup([docRow({
      status: 'claimed', excel_path: null, pdf_path: null, completed_at: null,
    })])
    assert.ok(html.includes(ORDER_DOCUMENTS_WORKING))
    assert.ok(html.includes('Generating'), 'a lease is not a person\'s concern')
    assert.ok(!html.includes('Claimed'))
    assert.ok(!/%/.test(html.replace(/max-width:\s*100%/g, '')))
  })

  test('a failure shows its PREWRITTEN sentence and never its code', () => {
    const html = documentsMarkup([docRow({
      status: 'failed', excel_path: null, pdf_path: null, completed_at: null,
      last_error_code: 'WORKBOOK_UNREADABLE',
      last_error_message: ORDER_DOCUMENT_FAILURES.WORKBOOK_UNREADABLE,
    })])
    assert.ok(html.includes(ORDER_DOCUMENT_FAILURES.WORKBOOK_UNREADABLE))
    assert.ok(!html.includes('WORKBOOK_UNREADABLE'))
  })

  test('the generate control appears only for somebody who may press it', () => {
    assert.ok(!documentsMarkup([]).includes(ORDER_DOCUMENTS_GENERATE_LABEL))
    assert.ok(documentsMarkup([], { canGenerate: true }).includes(ORDER_DOCUMENTS_GENERATE_LABEL))
  })

  test('and it reads `Try again` once a version has failed', () => {
    const failed = docRow({
      status: 'failed', excel_path: null, pdf_path: null, completed_at: null,
      last_error_code: 'PDF_RENDER_FAILED',
      last_error_message: ORDER_DOCUMENT_FAILURES.PDF_RENDER_FAILED,
    })
    const html = documentsMarkup([failed], { canGenerate: true })
    assert.ok(html.includes(ORDER_DOCUMENTS_RETRY_LABEL))
    assert.ok(!html.includes(ORDER_DOCUMENTS_GENERATE_LABEL))
  })

  test('it is HIDDEN while a generation is in flight, so nobody queues a second', () => {
    const busy = docRow({ status: 'pending', excel_path: null, pdf_path: null, completed_at: null })
    const html = documentsMarkup([busy], { canGenerate: true })
    assert.ok(!html.includes(ORDER_DOCUMENTS_GENERATE_LABEL))
    assert.ok(!html.includes(ORDER_DOCUMENTS_RETRY_LABEL))
  })

  test('an amendment generating over existing documents keeps BOTH truths', () => {
    const ready1 = docRow({ id: 'v1', version: 1 })
    const busy2 = docRow({
      id: 'v2', version: 2, status: 'claimed',
      excel_path: null, pdf_path: null, completed_at: null,
    })
    const html = documentsMarkup([ready1, busy2])
    assert.ok(html.includes(ORDER_DOCUMENTS_EXCEL_LABEL), 'version 1 is still downloadable')
    assert.ok(html.includes(ORDER_DOCUMENTS_WORKING), 'and version 2 is on its way')
  })

  test('a refusal is one quiet line and the card survives it', () => {
    const html = documentsMarkup([docRow()], { error: 'That could not be done just now.' })
    assert.ok(html.includes('That could not be done just now.'))
    assert.ok(html.includes(ORDER_DOCUMENTS_EXCEL_LABEL))
  })

  test('a download being prepared disables BOTH buttons', () => {
    const html = documentsMarkup([docRow()], { downloading: 'pdf' })
    assert.ok(html.includes('Preparing…'))
    assert.equal((html.match(/disabled/g) ?? []).length, 2)
  })
})

// ── 10. The page wires the documents card the way the module intends ─────────

describe('/orders/[id] and its documents', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')

  test('reads the register with NAMED columns, and never the lease token', () => {
    assert.ok(page.includes("from('order_document_versions')"))
    assert.ok(page.includes('ORDER_DOCUMENT_COLUMNS'))
    // Comments stripped: the page DOCUMENTS that the token is unreadable, and a
    // raw search would match the sentence promising the thing it verifies.
    const code = page
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    assert.ok(!code.includes('claim_token'))
  })

  test('the generate control is gated on the approval authority, not on a role', () => {
    assert.ok(page.includes('ordersCaps.canApproveOrderSubmission'))
    assert.ok(page.includes('mayGenerateDocuments'))
    // Suppressed under View As, exactly as every other authority on this page.
    assert.match(page, /canApproveOrderSubmission && !viewAsUserId/)
  })

  test('the request goes to the route, with NO body of its own', () => {
    assert.match(page, /fetch\(`\/api\/orders\/\$\{id\}\/documents`, \{ method: 'POST' \}\)/)
  })

  test('a download is signed on demand and never built as a public URL', () => {
    assert.ok(page.includes('ORDER_DOCUMENT_URL_TTL_SECONDS'))
    assert.ok(!page.includes('getPublicUrl'))
  })

  test('no service-role credential exists anywhere in this client page', () => {
    assert.ok(!/SERVICE_ROLE|createServiceClient/.test(page))
  })

  test('an Order with NO source PI gets no documents card at all', () => {
    assert.match(page, /piHandoff\.kind !== 'none' && \(/)
  })
})

// ── 9. The Order that came from no PI at all ──────────────────────────────────

describe('OrderPiNoSource', () => {
  const html = renderToStaticMarkup(<OrderPiNoSource />)

  test('states the reason in words a reader can act on', () => {
    assert.ok(html.includes(ORDER_PI_NO_SOURCE_BODY))
    assert.ok(/not created from a PI submission/i.test(html))
  })

  test('says how an Order DOES come to carry a PI', () => {
    // Without this, the panel tells somebody they are stuck without telling
    // them what the working case looks like.
    assert.ok(/approving one/i.test(html))
  })

  test('offers no action, because none exists', () => {
    // CONTROLS, not vocabulary. The prose says the words "generate" and
    // "documents" while explaining that neither is available here, and a test
    // that banned the words would forbid the sentence from being clear. What
    // must not appear is something clickable.
    assert.ok(!/<button/i.test(html))
    assert.ok(!/<a\s/i.test(html))
    assert.ok(!/<input/i.test(html))
    assert.ok(!/onclick/i.test(html))
    assert.ok(!/role="button"/i.test(html))
  })

  test('does not promise a document', () => {
    assert.ok(!/\.xlsx|\.pdf/i.test(html))
  })

  test('is distinguishable from the RLS-refusal panel', () => {
    // The two answer the same question for different reasons. A reader who
    // lacks access must not be told the Order has no PI, and vice versa.
    const refused = renderToStaticMarkup(<OrderPiUnavailable />)
    assert.notEqual(html, refused)
    assert.ok(!html.includes(ORDER_PI_UNAVAILABLE_BODY))
    assert.ok(!refused.includes(ORDER_PI_NO_SOURCE_BODY))
  })
})
