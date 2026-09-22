/**
 * ONE FACT, ONE PLACE — the Confirmed Order detail page's information
 * architecture, asserted over its source.
 *
 * The page used to state the same fact in three places: the status in the
 * header AND in Order Health; production in the header, the attention strip
 * AND Order Health; the two dates in the header, the Approved PI card AND
 * Order Health; payment in Order Health, Payment Position AND the payments
 * table; the commercial totals in the breakdown AND the details strip. Each of
 * those is now stated exactly once, and these hold that.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderDetailArchitecture.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const PAGE = 'src/app/orders/[id]/page.tsx'
const WORKSPACE = 'src/app/orders/[id]/OrderWorkspace.tsx'
const SECTIONS = 'src/app/orders/[id]/OrderPiSections.tsx'
const STATUS = 'src/app/orders/[id]/OrderStatusWorkspace.tsx'
const CSS = 'src/app/globals.css'

/** The page with its comments removed: these assertions are about what RENDERS,
 *  and this file documents in prose the very things it must not draw twice. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

const page = code(PAGE)

/** The JSX the page returns, which is where "how many times is this drawn"
 *  can honestly be counted. */
const body = page.slice(page.indexOf('<OrdersLayout'))

// ══ 1. The sections, and their order ══════════════════════════════════════════

describe('the page reads in one order, with no second summary', () => {
  const marks = {
    header:   body.indexOf('className="order-command-header"'),
    summary:  body.indexOf('<OrderSummaryPanel'),
    attention: body.indexOf('<OrderAttentionBar'),
    documents: body.indexOf('<OrderDocumentsRow>'),
    products: body.indexOf('className="order-products"'),
    payment:  body.indexOf('PAYMENT_SECTION_TITLE'),
    activity: body.indexOf('<OrderActivityList'),
  }

  test('every section is present', () => {
    for (const [name, at] of Object.entries(marks)) {
      assert.ok(at > 0, `${name} is missing from the page`)
    }
  })

  test('and they appear in the agreed reading order', () => {
    const order = Object.entries(marks).sort((a, b) => a[1] - b[1]).map(([name]) => name)
    assert.deepEqual(order, [
      'header', 'summary', 'attention', 'documents', 'products',
      'payment', 'activity',
    ])
  })

  test('each is drawn ONCE', () => {
    assert.equal((body.match(/<OrderSummaryPanel/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderDocumentsRow>/g) ?? []).length, 1)
    // ONE DOCUMENTS BOX, holding the PI, the design files and the client PO.
    // A second copy of any of them would be the same paperwork stated twice.
    assert.equal((body.match(/<OrderDocumentsPanel/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderFabricFinishCard/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderAttentionBar/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderActivityList/g) ?? []).length, 1)
    assert.equal((body.match(/PAYMENT_SECTION_TITLE/g) ?? []).length, 1)
  })
})

// ══ 2. The surfaces that were removed ═════════════════════════════════════════

describe('the redundant surfaces are gone', () => {
  // ── THE SEPARATE FILE CARDS ──
  test('there is ONE Documents box, and it holds all three kinds of paperwork', () => {
    const docs = code(STATUS)
    for (const title of ['DOC_MAIN_PI_TITLE', 'DOC_DESIGN_FILES_TITLE', 'DOC_CLIENT_PO_TITLE']) {
      assert.ok(docs.includes(title), title)
    }
    // The two cards it replaced are gone, not merely unused.
    for (const gone of ['OrderMainPiCard', 'OrderDesignFilesCard', 'OrderCurrentStatus']) {
      assert.equal(docs.includes('export function ' + gone), false, gone)
      assert.equal(body.includes('<' + gone), false, gone + ' is still drawn')
    }
  })

  test('Fabric & Finish is BESIDE the box, and is the only place the approvals are stated', () => {
    const row = body.slice(body.indexOf('<OrderDocumentsRow>'), body.indexOf('</OrderDocumentsRow>'))
    assert.ok(row.indexOf('<OrderDocumentsPanel') < row.indexOf('<OrderFabricFinishCard'))
    // The Documents box does not summarise them a column away from the card
    // that states them in full.
    const panel = code(STATUS).slice(code(STATUS).indexOf('export function OrderDocumentsPanel'))
    const upTo = panel.slice(0, panel.indexOf('export function OrderFabricFinishCard'))
    assert.equal(/APPROVAL_STATUS_LABEL|approvals\.kinds/.test(upTo), false)
  })

  // ── ADVANCE RECEIVED ──
  test('the Advance Received card is gone, and its figures live only in Payment', () => {
    assert.equal(/OrderAdvanceCard|advanceStanding/.test(page), false)
    assert.equal(/Advance Received/i.test(body), false)
    assert.equal(code(STATUS).includes('export function OrderAdvanceCard'), false)
    // The builder and its own suite are untouched: a display went, not a rule.
    assert.ok(read('src/lib/orders/orderAdvance.ts').includes('export function advanceStanding'))
    assert.ok(read('src/lib/orders/orderAdvance.test.ts').length > 0)
  })

  test('and the CSS of every card that left went with it', () => {
    for (const cls of ['order-status-workspace', 'order-current-status',
                       'order-current-status-cards', 'order-status-lines']) {
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, cls + ' is still styled')
    }
  })

  // ── MANUFACTURING STATUS ──
  //
  // Its one real line was the production alignment, which the Sales and
  // production group at the top of the page already states. A reader met the
  // same alignment twice on one screen.
  test('the lower Current Status area draws NO Manufacturing Status card', () => {
    const current = body.slice(body.indexOf('<OrderCurrentStatus>'), body.indexOf('</OrderCurrentStatus>'))
    assert.equal(/OrderManufacturingCard/.test(current), false, 'the card is still drawn')
    assert.equal(/Manufacturing/i.test(body), false, 'and it is not named anywhere on the page')
    assert.equal(/OrderManufacturingCard/.test(code(STATUS)), false, 'and it no longer exists')
  })

  test('Main PI and Design Files are both still there, in the Documents box', () => {
    const panel = body.slice(body.indexOf('<OrderDocumentsPanel'), body.indexOf('<OrderFabricFinishCard'))
    // The box is handed all three kinds of paperwork, and every control the
    // Main PI card used to own.
    for (const kept of ['mainPi', 'design', 'clientPo',
                        'onView', 'onDownload', 'onHistory', 'onManageDesign',
                        'viewing', 'downloading']) {
      assert.ok(panel.includes(kept + '='), kept + ' was dropped from the Documents box')
    }
  })

  test('THE MANUFACTURING DATA AND THE ALIGNMENT LOGIC ARE UNTOUCHED', () => {
    // A display removal only. The describer, its rules and its tests stay; the
    // alignment the page DOES still state comes from the same helper as before,
    // and every control that SETS one is where it was.
    const lib = read('src/lib/orders/orderCurrentStatus.ts')
    assert.ok(lib.includes('export function describeManufacturingStatus'))
    assert.ok(read('src/lib/orders/orderCurrentStatus.test.ts').includes('describeManufacturingStatus'))
    assert.ok(page.includes('describeProductionAlignment({'))
    assert.ok(page.includes('canAlignProduction'))
    assert.ok(page.includes('<ProductionAlignmentModal'))
  })

  // ── ORDER RECORDS ──
  //
  // It held one thing: the source PI, named, with a Download. The PI in force —
  // which for a converted Order IS that document — is the Main PI card, with
  // its own View, Download and View history.
  test('the Order records section is gone', () => {
    assert.equal(body.includes('title="Order records"'), false, 'the section is still drawn')
    assert.equal(/Order records/i.test(body), false, 'and it is not named on the page')
    assert.equal(/Source PI/i.test(body), false, 'nor is the row it held')
  })

  test('and no dead page code was left behind by it', () => {
    for (const gone of ['downloadWorkbook', 'wbPath', 'wbBusy', 'wbError',
                        'ORDER_PI_UNAVAILABLE_BODY', 'orderPiWorkbookPath']) {
      assert.equal(page.includes(gone), false, gone + ' is still on the page')
    }
    for (const cls of ['order-records-body', 'order-source-pi', 'order-doc-name', 'order-doc-meta']) {
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, cls + ' is still styled')
    }
    // The three the commercial breakdown and the PI history list still use.
    for (const cls of ['order-record-section', 'order-record-head', 'order-record-title']) {
      assert.ok(read(CSS).includes('.' + cls + ' '), cls + ' was removed and is still used')
    }
  })

  test('BUT THE PI, ITS FILES AND ITS HISTORY ARE ALL STILL HERE', () => {
    // Removing the section must not remove the record, the relation or the
    // reader's way to the document.
    assert.ok(page.includes("from('order_pi_versions')"))
    assert.ok(page.includes('ORDER_PI_HANDOFF_COLUMNS'))
    assert.ok(page.includes('describePiVersionHistory'))
    assert.ok(page.includes('canProposePiRevision'))
    assert.ok(page.includes('canDecidePiRevision'))
    assert.ok(page.includes('source_order_submission_id'))
    // The document itself: signed through the Documents box's own reads.
    assert.ok(body.includes('<OrderDocumentsPanel'))
    assert.ok(page.includes('openVersionFile'))
    assert.equal((body.match(/<PiHistoryModal/g) ?? []).length, 1)
    // And the shared helper the PI Drafts module still uses is untouched.
    assert.ok(read('src/lib/orders/orderPiHandoff.ts').includes('export function orderPiWorkbookPath'))
  })

  test('there is no Order Health card anywhere', () => {
    for (const path of [PAGE, WORKSPACE]) {
      const source = code(path)
      assert.equal(/OrderHealthCard/.test(source), false, `${path} still draws Order Health`)
      assert.equal(/Order health/i.test(source), false, `${path} still names Order health`)
    }
    assert.equal(/orderHealthRows/.test(code('src/lib/orders/orderWorkspace.ts')), false,
      'and the helper that fed it is gone with it')
  })

  test('there is no Payment Position card', () => {
    for (const path of [PAGE, WORKSPACE]) {
      const source = code(path)
      assert.equal(/PaymentPositionCard/.test(source), false, `${path} still draws Payment Position`)
      assert.equal(/Payment position/i.test(source), false, `${path} still names Payment position`)
    }
  })

  test('there is no "View payment details" link — the payment section IS the destination', () => {
    assert.equal(/View payment details/i.test(page), false)
    assert.equal(/VIEW_PAYMENT_DETAILS_LABEL/.test(code(WORKSPACE)), false)
  })

  test('the large Approved PI summary card is not rendered', () => {
    assert.equal(/<OrderPiSummaryCard/.test(page), false)
    // The component may still exist for the PI screens; what matters is that
    // the Confirmed Order does not draw it.
    assert.equal(/OrderPiSummaryCard/.test(body), false)
  })

  // ── Record Information ──
  //
  // THE SECTION IS GONE FROM THE PAGE. It sat below the payment and held three
  // operational facts; those three are now in the summary panel at the top,
  // beside the sale they belong to. Nothing it stated was dropped — the tests
  // below hold each thing that had to survive, and where it survived to.
  test('the Record Information section is no longer rendered', () => {
    assert.equal(/OrderRecordInformation/.test(page), false,
      'the page must not draw it')
    assert.equal(/RECORD_INFORMATION_TITLE/.test(code(WORKSPACE)), false,
      'and the component must be gone with it')
    for (const cls of ['order-record-info', 'order-record-facts']) {
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, '.' + cls + ' is still styled')
    }
  })

  test('its three facts are STILL DRAWN — in the summary panel, from the same builder', () => {
    // The salesperson, the lead source and production. Each is something the
    // attention strip can raise a gap in, so none of them may be invisible.
    assert.ok(body.includes('<OrderSummaryPanel view={summaryView}'))
    assert.ok(page.includes('facts: recordFacts'),
      'the panel is handed orderRecordFacts own output')
    const ws = read('src/lib/orders/orderWorkspace.ts')
    for (const key of ["key: 'salesperson'", "key: 'lead_source'", "key: 'production'"]) {
      assert.ok(ws.includes(key), key)
    }
    for (const label of ["label: 'Salesperson'", "label: 'Lead source'", "label: 'Production'"]) {
      assert.ok(ws.includes(label), label + ' — the existing wording, unchanged')
    }
  })

  test('the alignment date and actor are shown ONLY for an aligned Order', () => {
    // describeProductionAlignment already nulls the line for an unaligned
    // Order; the view refuses to draw it a second time rather than trusting a
    // caller that hands over a stale one.
    const ws = read('src/lib/orders/orderWorkspace.ts')
    assert.ok(ws.includes('line: input.productionAligned ? (production?.detail ?? null) : null'))
  })

  test('and each of the three still comes from its original source', () => {
    // A move, not a re-resolution: the same column, the same helper, the same
    // capability behind the production control.
    assert.ok(page.includes('salespersonName: order.assigned_to_name ?? null'))
    assert.ok(page.includes('const leadSource = leadSourceLabel(order.lead_source)'))
    assert.ok(page.includes('leadSource,'))
    assert.ok(page.includes('describeProductionAlignment({'))
    assert.ok(page.includes('canAlign: mayAlignProduction'))
    assert.ok(page.includes('const mayAlignProduction = canAlignProduction(ordersCaps, Boolean(viewAsUserId))'))
  })

  test('its OLD markup and styling did not come back with it', () => {
    for (const cls of ['order-details', 'order-details-head', 'order-details-grid']) {
      assert.equal(page.includes('"' + cls + '"'), false, cls + ' is still used')
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, '.' + cls + ' is still styled')
    }
  })

  test('the notes survived it: operational content, still on the page', () => {
    // The one thing on Record Information that was never metadata — somebody
    // typed it about this Order for somebody else to read.
    assert.ok(body.includes('aria-label="Order notes"'))
    assert.ok(body.includes('{order.notes}'))
  })

  // ── RAISED BY ──
  //
  // A DISPLAY REMOVAL AND NOTHING ELSE. The summary panel no longer draws who
  // raised the Order. The column is still selected, still carried on the row,
  // still what the PI-revision rule reads to find the PI's owner, and the
  // activity trail still names who did what.
  test('Raised by is not drawn anywhere on the page', () => {
    assert.equal(/Raised by/i.test(body), false, 'the page must not draw it')
    const ws = read('src/lib/orders/orderWorkspace.ts')
    assert.equal(/'raised_by'/.test(ws), false, 'and no builder must produce it')
  })

  test('but the audit data underneath it is untouched', () => {
    assert.ok(page.includes('requested_by'), 'the column is still selected')
    assert.ok(page.includes('requested_by_name'), 'and still mapped onto the row')
    // The rule that decides who may propose a revised PI reads exactly this.
    assert.ok(page.includes('canProposePiRevision'))
  })

  test('the originating request number and the audit timestamps are not drawn either', () => {
    // Neither is something anybody plans against, and both competed with the
    // six facts that are. Both columns are still read.
    for (const gone of ['From request', 'Last updated']) {
      assert.equal(body.includes(gone), false, gone + ' is still drawn')
    }
    assert.ok(page.includes('source_request_number'), 'the column is still selected')
    assert.ok(page.includes('updated_at'), 'and so is the timestamp')
  })

  test('the internal request UUID is not displayed anywhere', () => {
    // A database key is not a fact about the Order. It used to ride along as a
    // title attribute on the request number.
    assert.equal(body.includes('source_order_request_id'), false)
  })

  test('the two-column workspace and its sticky rail are gone', () => {
    for (const cls of ['order-workspace', 'order-workspace-aside', 'order-workspace-main']) {
      assert.equal(page.includes(cls), false, `${cls} is still used`)
      assert.equal(read(CSS).includes(`.${cls} `) || read(CSS).includes(`.${cls}{`), false,
        `.${cls} is still styled`)
    }
  })
})

// ══ 3. One fact, one place ════════════════════════════════════════════════════

describe('no Order fact is stated twice', () => {
  test('the command header carries the number, the status and the actions — and no other fact', () => {
    const header = body.slice(body.indexOf('className="order-command-header"'), body.indexOf('<OrderSummary'))
    // The number IS the identity and the status is what every reader arrives
    // asking; both are stated here and nowhere else on the page.
    assert.ok(header.includes('order-command-title'))
    assert.ok(header.includes('<OrderStatusPill'))
    // Everything else is a fact belonging to the band or the dates below.
    for (const forbidden of ['order-command-client', 'production', 'Confirmed ', 'Requested by',
                             'confirm_date', 'due_date', 'lead_source']) {
      assert.equal(header.includes(forbidden), false, `${forbidden} must not be in the command header`)
    }
  })

  test('the status is stated ONCE — in the header, never again in the band', () => {
    assert.equal((body.match(/<OrderStatusPill/g) ?? []).length, 1)
    const ws = code('src/lib/orders/orderWorkspace.ts')
    const facts = ws.slice(ws.indexOf('export function orderSummaryFacts'),
                           ws.indexOf('export function orderImportantDates'))
    assert.equal(/key: 'status'/.test(facts), false, 'the identity band must not restate the status')
  })

  test('the six summary facts are stated by ONE panel, built ONCE', () => {
    // The page hands them to one component and draws none of them itself.
    // The three groups are COMPOSED from the two builders, each called once,
    // so no fact in the header is resolved twice or resolved differently.
    assert.equal((page.match(/orderSummaryFields\(/g) ?? []).length, 1)
    assert.equal((page.match(/orderRecordFacts\(/g) ?? []).length, 1)
    assert.equal((page.match(/orderSummaryView\(/g) ?? []).length, 1)
    assert.ok(page.includes('fields: summaryFields'))
    assert.ok(page.includes('view={summaryView}'))
  })

  test('the upload date is the APPROVED PI version’s, never another date', () => {
    // Not the Order's creation date, not the draft's, not the confirmation
    // date. The approved row of order_pi_versions, and nothing else.
    assert.ok(page.includes('const piUploadedAt = piHistory.current?.uploadedAt ?? null'))
    assert.ok(page.includes('uploadDate: piUploadedAt'))
    assert.equal(/uploadDate: fmtDate\(order\./.test(page), false,
      'an Order column must never stand in for the PI upload stamp')
  })

  test('the location is the saved client city, never an address line', () => {
    assert.ok(page.includes('piHandoff.client.city'))
    for (const forbidden of ['billing_address', 'shipping_address',
                             'billTo.address', 'shipTo.address']) {
      assert.equal(page.includes('location: ' + forbidden), false, forbidden)
    }
  })

  test('every date this page draws is one of the panel’s three', () => {
    const ws = code('src/lib/orders/orderWorkspace.ts')
    const fields = ws.slice(ws.indexOf('export function orderSummaryFields'))
    for (const key of ["'confirm_date'", "'upload_date'", "'due_date'"]) {
      assert.ok(fields.includes(key), key)
    }
    // And the separate Important Dates band is gone with its builder.
    assert.equal(/orderImportantDates/.test(read('src/lib/orders/orderWorkspace.ts')), false)
    assert.equal(/OrderImportantDatesSection/.test(code(WORKSPACE)), false)
    assert.equal(read(CSS).includes('.order-dates {'), false, 'and so is its styling')
  })

  test('payment is stated in ONE place, below the products', () => {
    // It used to be stated twice: the Advance Received card carried the verified
    // share of the Order value beside the Documents, and the Payment section
    // carried the same two figures with the rest of the position.
    assert.ok(body.indexOf('className="order-products"') < body.indexOf('PAYMENT_SECTION_TITLE'))
    const above = body.slice(0, body.indexOf('className="order-products"'))
    for (const figure of ['finance.verified', 'finance.received', 'finance.pendingBalance',
                          'finance.awaitingVerification', 'verifiedPercent', 'advance']) {
      assert.equal(above.includes(figure), false, figure + ' appears above the product list')
    }
  })

  test('every payment figure lives in the payment section and nowhere else', () => {
    // The figures are drawn by one component, used once.
    assert.equal((body.match(/<PaymentSummaryFigures/g) ?? []).length, 1)
    // And the summary is handed no payment figure at all.
    const summary = body.slice(body.indexOf('<OrderSummary'), body.indexOf('<OrderAttentionBar'))
    for (const forbidden of ['finance.verified', 'finance.received', 'finance.pendingBalance',
                             'finance.awaitingVerification', 'verifiedPercent']) {
      assert.equal(summary.includes(forbidden), false, `${forbidden} must not be in the Order Summary`)
    }
  })

  test('there is ONE commercial presentation, and the totals block is gone', () => {
    // The `Product value` / `Order value` pair restated the breakdown's own
    // first and last lines under different captions — the same rupees twice.
    assert.equal(/OrderCommercialTotals/.test(page), false, 'the page must not draw it')
    assert.equal(/OrderCommercialTotals/.test(code(WORKSPACE)), false, 'and it must not exist')
    for (const cls of ['order-commercial-totals', 'order-commercial-total']) {
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, cls + ' is still styled')
    }

    // In the lower workspace's right column, and after the products.
    const aside = body.slice(body.indexOf('order-lower-aside'))
    assert.ok(aside.includes('<OrderCommercialBreakdown'))
    assert.ok(body.indexOf('className="order-products"') < body.indexOf('order-lower-aside'),
      'the money sits below the products it describes')
    assert.equal((body.match(/<OrderCommercialBreakdown/g) ?? []).length, 1)
  })

  test('the three record facts are NOT restated in the summary panel', () => {
    const ws = code('src/lib/orders/orderWorkspace.ts')
    const fields = ws.slice(ws.indexOf('export function orderSummaryFields'),
                            ws.indexOf('export type OrderRecordFactKey'))
    for (const forbidden of ["'salesperson'", "'lead_source'", "'production'"]) {
      assert.equal(fields.includes(forbidden), false, forbidden + ' belongs to Record information')
    }
    // And the page builds each list exactly once.
    assert.equal((page.match(/orderRecordFacts\(/g) ?? []).length, 1)
  })

  test('the summary panel states the product value and no other figure', () => {
    // Its Total Product Value is the product subtotal BEFORE any commercial
    // adjustment; the Order value belongs to the breakdown alone.
    const summary = body.slice(body.indexOf('<OrderSummaryPanel'), body.indexOf('<OrderAttentionBar'))
    for (const forbidden of ['total_value', 'OrderCommercialBreakdown', 'finance.']) {
      assert.equal(summary.includes(forbidden), false, forbidden)
    }
    assert.ok(page.includes('totalProductValue: order.total_product_value === null ? null : fmtAmount(order.total_product_value)'))
  })

  test('the breakdown recomputes NOTHING — and now derives nothing either', () => {
    const lib = code('src/lib/orders/orderCommercial.ts')
    // The net-effect line took the module's only arithmetic with it.
    assert.equal((lib.match(/Math\.round\(/g) ?? []).length, 0)
    assert.equal(lib.includes('total - base'), false)
    // The page hands the section rows and nothing else — no net, no formatter.
    assert.ok(page.includes('orderCommercialLines(piHandoff.commercialRows)'))
    assert.ok(page.includes('<OrderCommercialBreakdown lines={commercialLines} embedded />'))
    assert.equal(page.includes('orderCommercialNet'), false)
  })

  test('the lower workspace puts the record left and the money right', () => {
    const lower = body.slice(body.indexOf('className="order-lower"'))
    const main = lower.indexOf('order-lower-main')
    const aside = lower.indexOf('order-lower-aside')
    assert.ok(main > 0 && aside > main, 'the record column comes first, the money column second')
    // The three sections that belong on the left, in order, all before the aside.
    const left = lower.slice(main, aside)
    for (const section of ['PAYMENT_SECTION_TITLE', '<OrderActivityList']) {
      assert.ok(left.includes(section), `${section} belongs in the left column`)
    }
  })
})

// ══ 4. The payment surface ══════════════════════════════════════════════════

describe('the payment section states a position and opens its rows', () => {
  const pay = body.slice(body.indexOf('PAYMENT_SECTION_TITLE'), body.indexOf('order-lower-aside'))

  test('the inline PAYMENT RECORDS table is gone, with its explanatory prose', () => {
    assert.equal(/Payment records/i.test(body), false, 'the block is still drawn')
    assert.equal(pay.includes('<table'), false, 'a payment table is still on the page')
    assert.equal(/Amounts are this Order/.test(body), false, 'its caption is still on the page')
    for (const cls of ['order-pay-records', 'order-pay-records-head']) {
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, cls + ' is still styled')
    }
  })

  test('and the duplicated figures with it', () => {
    // Order value is in the headline's own line; Received was verified plus
    // awaiting, both of which are named and clickable above it; the legend
    // named the shares the two buttons name.
    const ws = code(WORKSPACE)
    for (const gone of ['order-pay-figures', 'order-pay-legend', 'order-pay-swatch', 'order-pay-split']) {
      assert.equal(ws.includes(gone), false, gone + ' is still drawn')
      assert.equal(read(CSS).includes('.' + gone + ' {'), false, gone + ' is still styled')
    }
  })

  test('the two figures are BUTTONS, and each opens its own filtered dialog', () => {
    const ws = code(WORKSPACE)
    assert.ok(ws.includes('onOpenList(metric.kind)'), 'the metric blocks must be controls')
    assert.ok(/<button[\s\S]*?className={`order-pay-metric/.test(ws), 'and real buttons')
    assert.ok(pay.includes('onOpenList={setPaymentList}'))
    assert.equal((body.match(/<OrderPaymentListDialog/g) ?? []).length, 1,
      'one dialog component, told which list to show and which row is open')
    assert.ok(body.includes('rows={orderPaymentList(payments, paymentList, paymentDetails)}'))
  })

  test('the dialog is filtered by the SAME predicates the totals use', () => {
    const lists = code('src/lib/orders/orderPaymentLists.ts')
    assert.ok(lists.includes('isVerifiedPaymentStatus'))
    assert.ok(lists.includes('isAwaitingVerification'))
    // It filters. It does not total, convert or re-derive a share.
    assert.equal(/Math\.|parseFloat|Number\(/.test(lists), false, 'the builder must compute nothing')
    assert.equal(lists.includes('allocatedAmount'), false,
      'the share is withExactAmounts\' answer, read not re-derived')
    assert.ok(lists.includes('exactAllocatedAmount'))
  })

  test('the rest of a payment opens HERE, in the same dialog', () => {
    // It was a link into the Finance module. Everything it went for is a column
    // of a row this page already holds, so the dialog states it in place.
    assert.equal(page.includes('financePaymentHref'), false)
    assert.ok(body.includes('openId={paymentDetailId}'))
    assert.ok(body.includes('onBack={() => setPaymentDetailId(null)}'))
    assert.ok(code(WORKSPACE).includes('PAYMENT_DETAIL_BACK'))
  })

  test('THE DETAIL IS THE SAME ROWS, WIDENED — not a second read and not a wider gate', () => {
    // finance_payment_requests is guarded row by row, so a reader shown a
    // payment was already entitled to every column of it. The page asks the two
    // reads it already issues for the rest of those columns.
    for (const column of ['human_payment_id', 'proof_note', 'admin_note',
                          'approved_at', 'rejected_at', 'clarification_requested_at']) {
      assert.ok(page.includes(column), column + ' is not read')
    }
    // No third query appeared to fetch them.
    assert.equal((page.match(/from\('finance_payment_requests'\)/g) ?? []).length, 1)
    assert.ok(page.includes('setPaymentDetails(details)'))
  })
})

// ══ NO SUPPORTING DETAIL LEAVES THIS PAGE ════════════════════════════════════

describe('every supporting record opens over the Order, not in another module', () => {
  test('the content area builds no route into Finance or a PI screen', () => {
    // A ROUTE, not a module name: Finance's own payment-entry FORM is mounted
    // on this page as a dialog, which is the opposite of navigating to it.
    for (const route of ['financePaymentHref', 'piSubmissionHref', 'order_document_versions']) {
      assert.equal(page.includes(route), false, route + ' is still reachable from this page')
    }
    assert.equal(/href="\/finance|push\('\/finance|push\("\/finance/.test(page), false)
    assert.equal(/href="\/orders\/drafts|push\('\/orders\/drafts/.test(page), false)
  })

  test('nor does anything the content area renders', () => {
    // The three files that draw the Order's own body. A <Link> or an <a> in any
    // of them is a way off the page, and the only ones allowed are Back to
    // Orders and the sidebar, neither of which lives here.
    for (const path of [WORKSPACE, STATUS, SECTIONS]) {
      const source = code(path)
      assert.equal(/from 'next\/link'/.test(source), false, path + ' imports Link')
      assert.equal(/href=/.test(source), false, path + ' renders an href')
    }
  })

  test('the page itself keeps ONE link, and it is Back to Orders', () => {
    assert.equal(/from 'next\/link'/.test(page), false, 'no Link component is imported')
    assert.equal((body.match(/<RecordBackLink/g) ?? []).length, 1)
    assert.ok(body.includes('fallbackHref="/orders/all"'))
  })

  test('the Switch to Finance control is not offered from this screen', () => {
    assert.ok(page.includes('showModuleSwitch={false}'))
    // AND EVERY OTHER ORDERS SCREEN KEEPS IT. The layout defaults to showing it.
    const layout = read('src/components/layout/OrdersLayout.tsx')
    assert.ok(layout.includes('showModuleSwitch = true'))
    assert.ok(layout.includes('{showModuleSwitch && <ModuleSwitchButton target="finance" />}'))
  })

  test('each supporting record has a dialog, and the page mounts it only when open', () => {
    for (const [state, dialog] of [
      ['historyOpen', '<PiHistoryModal'],
      ['designOpen', '<OrderDesignFilesDialog'],
      ['evidence', '<OrderEvidenceDialog'],
      ['paymentList', '<OrderPaymentListDialog'],
    ] as const) {
      assert.ok(body.includes('{' + state + ' && ('), state + ' does not gate its dialog')
      assert.equal((body.match(new RegExp(dialog, 'g')) ?? []).length, 1, dialog)
    }
  })

  test('a proof is a dialog now, not a new tab', () => {
    // The URL is still signed on the press, through the reader's own session.
    assert.ok(page.includes('setEvidence({ url: null, failure: null })'))
    const fn = page.slice(page.indexOf('const viewEvidence'), page.indexOf('const recordApprovals'))
    assert.ok(fn.includes('createSignedUrl('), 'still signed on demand')
    assert.equal(fn.includes('window.open'), false, 'and no longer opened in a tab')
  })

  test('THE TWO FILE HAND-OFFS ARE STILL FILE HAND-OFFS, which is allowed', () => {
    // View and Download on the PI give the browser a workbook. A spreadsheet
    // cannot be previewed in a dialog, and a signed storage URL is a download,
    // not a page in another module.
    const fn = page.slice(page.indexOf('const openVersionFile'), page.indexOf('const viewEvidence'))
    assert.ok(fn.includes('createSignedUrl('))
    assert.ok(fn.includes('window.open'))
    assert.ok(fn.includes("'_blank', 'noopener,noreferrer'"))
    // And it is a storage URL, never an app route.
    assert.equal(/router\.push|href=/.test(fn), false)
  })

  test('no dialog navigates with the browser', () => {
    for (const path of [PAGE, WORKSPACE, STATUS]) {
      assert.equal(/history\.back\(\)|router\.back\(\)/.test(code(path)), false, path)
    }
  })
})

// ══ 5. What must not have changed ═════════════════════════════════════════════

describe('the business rules this pass must not touch', () => {
  test('every payment figure still comes from the one shared builder', () => {
    assert.ok(page.includes('buildOrderFinancePosition(payments, order.total_value)'))
    assert.ok(page.includes('withExactAmounts('))
    // No money is added, subtracted or percentaged on the page.
    assert.equal(/\(order\.total_value \?\? 0\) -/.test(page), false)
    assert.equal(/Math\.round\(\(received/.test(page), false)
  })

  test('the Finance CAPABILITY is still resolved, and still gates Add payment', () => {
    // The page no longer LINKS into Finance, but it still asks Finance's own
    // resolver whether this reader may record a payment — which is the one
    // Finance authority this screen ever acted on.
    assert.ok(page.includes('useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)'))
    assert.ok(page.includes(`getEffectivePermissions(supabase, session.user.id, 'finance')`))
    assert.ok(page.includes('canAllocatePayment: financeCaps.canAllocatePayment'))
  })

  // ── Add payment ──
  //
  // A DOOR, DRAWN ONCE, IN THE PAYMENT SECTION. The form behind it is Finance's
  // own; what this holds is that the Order opens it rather than growing one,
  // and that adding the door moved no figure and no rule.
  test('Add payment is drawn once, and inside the payment section', () => {
    assert.equal((body.match(/ADD_PAYMENT_ACTION_LABEL/g) ?? []).length, 1)
    assert.equal((body.match(/<RecordSplitPaymentModal/g) ?? []).length, 1)
    // Between the payment section's title and the section that follows it.
    const payment = body.indexOf('PAYMENT_SECTION_TITLE')
    const after = body.indexOf('<OrderActivityList')
    const control = body.indexOf('ADD_PAYMENT_ACTION_LABEL')
    assert.ok(payment > 0 && after > payment)
    assert.ok(control > payment && control < after,
      'the control belongs to the Payment section, not to the header')
    // AND ITS RULE IS UNCHANGED: the same capability, the same modal, the same
    // refresh. This pass rearranged the section around it and touched neither.
    assert.ok(page.includes('const mayRecordPayment = canRecordPaymentAgainstOrder({'))
    assert.ok(body.includes('{mayRecordPayment && ('))
    assert.ok(body.includes('{recordingPayment && mayRecordPayment && ('))
  })

  test('and it changes none of the figures beside it', () => {
    // The builder, the exact amounts and the absence of arithmetic are asserted
    // above; this holds that the payment section still draws the same one
    // component from the same position, with the control added beside it.
    const figures = body.slice(body.indexOf('<PaymentSummaryFigures'))
    assert.ok(figures.startsWith(`<PaymentSummaryFigures
              finance={finance}
              loaded={recordsReady}
              onOpenList={setPaymentList}
            />`), 'the component is handed the position, the load flag and a door — nothing else')
    assert.ok(page.includes('buildOrderFinancePosition(payments, order.total_value)'))
  })

  test('the writing path is Finance’s, and the refresh is the page’s own', () => {
    // The modal is handed the client and the actor and nothing else that could
    // decide anything; what it records, it records through its own RPC.
    assert.ok(page.includes('<RecordSplitPaymentModal'))
    assert.ok(page.includes('void loadOrder()'), 'the page settles the way it already settles')
    // And the page never reaches for the allocation RPC itself.
    assert.equal(code(PAGE).includes('record_payment_with_allocations'), false)
  })

  test('production alignment and the amendment doors are unchanged', () => {
    assert.ok(page.includes('canAlignProduction(ordersCaps, Boolean(viewAsUserId))'))
    assert.ok(page.includes("rpc('set_order_production_alignment'"))
    assert.ok(page.includes('const mayManageOrders = ordersCaps.canManageOrders && !viewAsUserId'))
  })

  test('the PRODUCT CODE leads every row, and the name stays whole beside it', () => {
    const sections = code(SECTIONS)
    // Both layouts, one treatment: the code is its own class and the name is
    // one step quieter, rather than the code being the palest thing in the row.
    assert.equal((sections.match(/className="order-product-code/g) ?? []).length, 2)
    assert.equal((sections.match(/className="order-product-name"/g) ?? []).length, 2)
    const css = read(CSS)
    assert.match(css, /\.order-product-code \{[\s\S]*?font-weight: 700;/)
    assert.match(css, /\.order-product-name \{[\s\S]*?font-weight: 500;/)
    // NOTHING WAS DROPPED: the name is still rendered whole, through the shared
    // multi-line renderer, which never truncates.
    assert.equal((sections.match(/<MultilineText className="order-product-name"/g) ?? []).length, 2)
  })

  test('the products table keeps its full-width fixed layout and all nine columns', () => {
    const sections = read(SECTIONS)
    assert.ok(sections.includes('className="order-products-table"'))
    assert.equal((sections.match(/<col /g) ?? []).length + (sections.match(/<col\/>|<col \/>/g) ?? []).length >= 9, true)
    const css = read(CSS)
    assert.match(css, /\.order-products-table \{\s*\n\s*table-layout: fixed;/)
    for (let n = 1; n <= 9; n++) {
      assert.ok(css.includes(`.order-products-table col:nth-child(${n})`), `column ${n} is sized`)
    }
    assert.ok(page.includes('className="order-products"'), 'and it is full width, above everything else')
  })

  test('the shell-first loading architecture is intact', () => {
    assert.ok(page.includes('Promise.race([shell, loadOrder().catch(() => {})])'))
    assert.ok(page.includes('const releaseShell'))
    assert.ok(page.includes('setRecordsReady(true)'))
    assert.ok(page.includes('setHandoffReady(true)'))
  })

  test('nothing caches order or payment state, and nothing refetches on focus', () => {
    for (const forbidden of ['localStorage', 'sessionStorage', 'staleTime', 'visibilitychange', 'setInterval(']) {
      assert.equal(page.includes(forbidden), false, `${forbidden} must not appear`)
    }
  })
})

// ══ 6. What the page must not go back to doing ════════════════════════════════
//
// STRUCTURAL, NOT TIMED. These pin the shape of the work — how many times the
// page waits, and how much it re-reads after a small write — because that is
// the property that changed and the one a later edit would quietly undo.

describe('the critical path to the product table', () => {
  test('the names and the signed URLs are asked for TOGETHER, not one after the other', () => {
    // Both depend on the handoff group above them and NEITHER depends on the
    // other: the names belong to PI History and Activity, both below the fold,
    // and the signed URLs are the photographs in the table under the summary.
    // Run in series, the most prominent section on the screen waited a whole
    // round trip for an enrichment it never reads.
    const handoff = page.slice(page.indexOf('const loadPiHandoff'), page.indexOf('const activityQuery'))
    const group = handoff.slice(handoff.indexOf('const [peopleRes, signedRes] = await Promise.all(['))
    assert.ok(group.length > 0, 'the two reads share one Promise.all')
    const namesAt = group.indexOf("from('users')")
    const signAt = group.indexOf('createSignedUrls(')
    const closeAt = group.indexOf('])')
    assert.ok(namesAt > 0 && signAt > 0, 'both reads are inside it')
    assert.ok(namesAt < closeAt && signAt < closeAt, 'and both before it closes')

    // The serial form is gone: no await on the users read on its own.
    assert.equal(/await supabase\s*\n?\s*\.from\('users'\)/.test(handoff), false,
      'the actor names must not be awaited before the signing')
  })

  test('the images are signed in ONE batched call, never one per row', () => {
    assert.ok(page.includes('createSignedUrls('), 'the plural, batched signer')
    const handoff = page.slice(page.indexOf('const loadPiHandoff'), page.indexOf('const activityQuery'))
    assert.equal((handoff.match(/createSignedUrl\(/g) ?? []).length, 0,
      'no single-object signer runs while loading the table')
  })

  test('each PI version is signed ON THE CLICK, not at load', () => {
    // A page that signed every version's file up front would spend a request
    // per archived PI for something nobody opened.
    //
    // THE SOURCE-PI WORKBOOK HANDLER IS GONE, with the Order records section
    // that was the only thing offering it; the document itself is downloaded
    // from the Main PI card, through this same on-demand signer.
    const at = page.indexOf('const openVersionFile')
    assert.ok(at > 0, 'const openVersionFile')
    assert.ok(page.slice(at, at + 900).includes('createSignedUrl('), 'it signs on demand')
  })
})

describe('a narrow write does not re-read the whole page', () => {
  const bodyOf = (name: string) => {
    const at = page.indexOf(name)
    assert.ok(at > 0, `${name} not found`)
    const rest = page.slice(at)
    return rest.slice(0, rest.indexOf('\n  }\n'))
  }

  test('production alignment re-reads the Order row and the trail, and nothing else', () => {
    // It moves four columns on `orders` and appends one activity entry. The
    // full load re-read fourteen things and re-signed every photograph.
    const fn = bodyOf('const setAlignment')
    assert.ok(fn.includes('await reloadOrderRow()'))
    assert.equal(fn.includes('loadOrder()'), false,
      'alignment must not fall back to the full page load')
  })

  test('a status change is still the narrowest of all — the trail alone', () => {
    assert.match(page, /onStatusChanged=\{updated => \{[\s\S]{0,900}?reloadActivity\(\)/)
  })

  test('each narrow refresh reads through the SHARED query, so it cannot drift', () => {
    // One definition each, used by the full load and by the narrow refresh.
    assert.equal((page.match(/orderRowQuery\(\)/g) ?? []).length, 2,
      'the Order row query: the full load and the narrow refresh')
    assert.equal((page.match(/activityQuery\(\)/g) ?? []).length, 2,
      'the activity query: the full load and the narrow refresh')
    // And each of those tables is SELECTed from in exactly one place: the
    // trail has one read, and the Order row's single read sits beside the one
    // UPDATE a status change performs.
    assert.equal((page.match(/\.from\('order_activity_log'\)\s*\n?\s*\.select\(/g) ?? []).length, 1)
    assert.equal((page.match(/\.from\('orders'\)\s*\n?\s*\.select\(/g) ?? []).length, 1)
  })

  test('every path that CAN move commercial data still reloads everything', () => {
    // The narrowing is deliberately confined to writes whose blast radius is
    // known. An amendment, a cancellation and a change-request decision all
    // rewrite columns the rest of the page reports.
    const after = page.slice(page.indexOf('const afterChange'))
    const fn = after.slice(0, after.indexOf('\n  }\n'))
    assert.ok(fn.includes('loadOrder()'))
    assert.equal(fn.includes('reloadOrderRow()'), false)
  })

  test('the chronology is derived once per load, not per render', () => {
    // Opening the image viewer, expanding the trail or opening a menu
    // re-renders this component. Without these the whole merged chronology was
    // rebuilt and re-sorted for a state change that touched none of it.
    for (const memo of [
      'const history = useMemo(',
      'const orderEntryById = useMemo(',
      'const piHistory = useMemo(',
    ]) {
      assert.ok(page.includes(memo), memo + ' must be memoised')
    }
  })

  test('and the finance position is still the one expression Finance pins', () => {
    // Deliberately NOT memoised: it sits after the early returns where a hook
    // may not go, and moving it would move the expression two Finance tests
    // read as proof that this screen adds no money of its own.
    assert.ok(page.includes('buildOrderFinancePosition(payments, order.total_value)'))
  })
  test('nothing on this page reloads the browser', () => {
    for (const forbidden of ['window.location.reload', 'location.href =', 'router.refresh()']) {
      assert.equal(page.includes(forbidden), false, `${forbidden} must not appear`)
    }
  })
})

// ══ 10. A refused approval leaves nothing behind ══════════════════════════════
//
// The upload MUST precede record_order_approval_event(), because that function
// refuses a path naming no object. Every refusal therefore happens with a file
// already written and no row referencing it. These pin the two halves of the
// answer: don't upload for a status that cannot carry evidence, and remove the
// orphan when the write is refused anyway.

describe('a refused approval leaves no orphan in the evidence bucket', () => {
  const handler = page.slice(
    page.indexOf('const recordApprovals = async'),
    page.indexOf('// ── The image viewer ──'),
  )

  test('the handler is where the upload and the write both live', () => {
    assert.ok(handler.length > 0, 'recordApprovals must still be on the page')
    assert.ok(handler.includes('.upload('))
    assert.ok(handler.includes("supabase.rpc('record_order_approval_event'"))
  })

  test('NOT APPROVED IS NEVER UPLOADED FOR', () => {
    // The dialog already sends file: null for it. Said again at the only line
    // that creates an object, because the RPC now refuses such a path outright
    // and the upload would be writing a file for a call that cannot succeed.
    assert.match(handler, /if \(change\.file && change\.status !== 'not_approved'\)/)
  })

  test('THE ORPHAN IS REMOVED WHEN THE WRITE IS REFUSED', () => {
    assert.match(handler, /if \(path\) \{\s*\n\s*await supabase\.storage\.from\(APPROVAL_EVIDENCE_BUCKET\)\.remove\(\[path\]\)/)
  })

  test('and the removal is scoped to the key this press generated', () => {
    // remove() is called with exactly [path] — the uuid key built two lines
    // earlier — and never with a list, a prefix or a wildcard.
    const removals = handler.match(/\.remove\([^)]*\)/g) ?? []
    assert.equal(removals.length, 1, 'exactly one removal')
    assert.equal(removals[0], '.remove([path])')
    for (const forbidden of ['.list(', 'prefix', '*']) {
      assert.equal(removals[0].includes(forbidden), false)
    }
  })

  test('the cleanup runs only on refusal, never on success', () => {
    // It sits inside the `if (error)` arm, so a recorded event keeps its proof.
    const refusal = handler.slice(handler.indexOf('if (error) {'))
    assert.ok(refusal.includes('.remove([path])'))
    const success = handler.slice(0, handler.indexOf('if (error) {'))
    assert.equal(success.includes('.remove('), false)
  })

  test('the refusal is what the reader is told, not the cleanup', () => {
    // describeApprovalFailure(error) is called with the RPC's error after the
    // tidy-up, so a failed removal cannot overwrite the real message.
    assert.match(
      handler,
      /\.remove\(\[path\]\)[\s\S]*?setApprovalError\(describeApprovalFailure\(error\)\)/,
    )
  })
})
