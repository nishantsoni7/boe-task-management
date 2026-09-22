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
    workspace: body.indexOf('<OrderStatusWorkspace>'),
    products: body.indexOf('className="order-products"'),
    payment:  body.indexOf('PAYMENT_SECTION_TITLE'),
    records:  body.indexOf('title="Order records"'),
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
      'header', 'summary', 'attention', 'workspace', 'products', 'payment',
      'records', 'activity',
    ])
  })

  test('each is drawn ONCE', () => {
    assert.equal((body.match(/<OrderSummaryPanel/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderStatusWorkspace>/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderMainPiCard/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderAttentionBar/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderActivityList/g) ?? []).length, 1)
    assert.equal((body.match(/PAYMENT_SECTION_TITLE/g) ?? []).length, 1)
  })
})

// ══ 2. The surfaces that were removed ═════════════════════════════════════════

describe('the redundant surfaces are gone', () => {
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

  test('every payment figure lives in the payment section and nowhere else', () => {
    // The six figures are drawn by one component, used once.
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
    for (const section of ['PAYMENT_SECTION_TITLE', 'title="Order records"', '<OrderActivityList']) {
      assert.ok(left.includes(section), `${section} belongs in the left column`)
    }
  })
})

// ══ 4. Order records ══════════════════════════════════════════════════════════

describe('Order records holds the documents, the source PI and the history', () => {
  const records = body.slice(body.indexOf('title="Order records"'), body.indexOf('<OrderActivityList'))

  test('it holds the SOURCE PI provenance, and no longer the version history', () => {
    // Source PI is the document this Order was CREATED from — a permanent
    // provenance record. The PI in force is a different fact once a revision
    // has been approved, and it has its own card above the products. The
    // version history moved into the modal that card opens, so no surface
    // states it twice.
    assert.ok(records.includes('Source PI'))
    assert.equal(records.includes('<OrderPiHistoryCard'), false)
    assert.equal(page.includes('<OrderPiHistoryCard'), false,
      'the history card is not drawn anywhere on this page')
  })

  test('the PI in force is stated by the Main PI card, and once', () => {
    assert.ok(body.includes('<OrderMainPiCard'))
    assert.ok(page.includes('const mainPi = mainPiCard(piHistory)'))
    assert.equal((page.match(/mainPiCard\(/g) ?? []).length, 1)
  })

  test('the whole version trail is stated by the modal, and once', () => {
    assert.equal((body.match(/<PiHistoryModal/g) ?? []).length, 1)
    assert.equal((page.match(/piVersionTimeline\(/g) ?? []).length, 1)
    // Mounted only while it is open: a closed modal reads no files and signs
    // nothing.
    assert.ok(body.includes('{historyOpen && ('))
  })

  // ── DOCUMENTS ──
  //
  // The section and the Generate Document control left this page. The register,
  // its route, its storage rule and its RLS are untouched and still tested by
  // orderDocuments.test.ts and documentsRoute.test.ts — only the surface went.
  test('the Documents section and the Generate control are gone from the page', () => {
    for (const gone of ['OrderDocumentsCard', 'documentsQuery', 'documentsView',
                        'mayGenerateDocuments', 'ORDER_DOCUMENT_COLUMNS',
                        'buildOrderDocumentsView', 'order_document_versions']) {
      assert.equal(page.includes(gone), false, gone + ' is still on the page')
    }
  })

  test('and no dead presentation code was left behind', () => {
    const sections = code(SECTIONS)
    assert.equal(/OrderDocumentsCard/.test(sections), false)
    assert.equal(/ORDER_DOCUMENTS_/.test(sections), false)
    for (const cls of ['order-doc-row', 'order-doc-icon']) {
      assert.equal(read(CSS).includes('.' + cls + ' {'), false, cls + ' is still styled')
    }
    // The two the Source PI reference still uses are deliberately kept.
    assert.ok(read(CSS).includes('.order-doc-name {'))
  })

  test('THE SHARED SERVICE IS UNTOUCHED — only the screen stopped asking', () => {
    for (const kept of ['src/lib/orders/orderDocuments.ts',
                        'src/app/api/orders/[id]/documents/route.ts']) {
      assert.ok(read(kept).length > 0, kept)
    }
  })

  // ── The PI door ──
  //
  // AFTER CONVERSION, THIS PAGE IS THE SOURCE OF TRUTH. A prominent way back
  // to the superseded draft invited operational readers to work from it, so
  // the action is gone. Everything underneath it is untouched, and the two
  // tests below are the halves of that: no button, and no lost record.
  test('there is no "Open source PI" action for an ordinary reader', () => {
    assert.equal(/Open source PI/i.test(body), false, 'the page must not offer it')
    assert.equal(body.includes('piSubmissionHref('), false,
      'and it must not build a route back to the draft')
  })

  test('the source PI is still NAMED and its workbook still downloadable', () => {
    // Removing the door must not remove the reference: the file this Order was
    // built from is a record, and Download reads it rather than reopening the
    // draft as a working surface.
    const source = records.slice(records.indexOf('Source PI'), records.indexOf('<OrderPiHistoryCard'))
    assert.ok(source.includes('piHandoff.workbookName'))
    assert.ok(source.includes('downloadWorkbook'))
    // None of what the big card used to restate.
    for (const forbidden of ['piHandoff.dates', 'piHandoff.figures', 'piHandoff.billing', 'Total before GST']) {
      assert.equal(source.includes(forbidden), false, `${forbidden} belongs to the Order Summary now`)
    }
  })

  test('the PI relationship, its data and its history are all still reachable', () => {
    // Removing the card must not remove the record.
    assert.ok(page.includes("from('order_pi_versions')"))
    assert.ok(page.includes('ORDER_PI_HANDOFF_COLUMNS'))
    assert.ok(page.includes('describePiVersionHistory'))
    assert.ok(page.includes('canProposePiRevision'))
    assert.ok(page.includes('canDecidePiRevision'))
    // And the relation itself is read, so traceability survives the button.
    assert.ok(page.includes('source_order_submission_id'))
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

  test('the Finance link is still gated on Finance module entry', () => {
    assert.ok(page.includes('financeCaps.canAccessFinanceModule && ('))
    assert.ok(page.includes('financePaymentHref(p.id)'))
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

  test('the workbook and each PI version are signed ON THE CLICK, not at load', () => {
    // A page that signed every version's file up front would spend a request
    // per archived PI for something nobody opened.
    for (const handler of ['const downloadWorkbook', 'const openVersionFile']) {
      const at = page.indexOf(handler)
      assert.ok(at > 0, handler)
      assert.ok(page.slice(at, at + 900).includes('createSignedUrl('), handler + ' signs on demand')
    }
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
