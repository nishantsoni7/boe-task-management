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
    summary:  body.indexOf('<OrderSummary'),
    dates:    body.indexOf('<OrderImportantDatesSection'),
    attention: body.indexOf('<OrderAttentionBar'),
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
      'header', 'summary', 'dates', 'attention', 'products', 'payment', 'records', 'activity',
    ])
  })

  test('each is drawn ONCE', () => {
    assert.equal((body.match(/<OrderSummary/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderImportantDatesSection/g) ?? []).length, 1)
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
  // It stated five things and each of them was either MOVED or deliberately
  // dropped; none was simply deleted. See the block that replaced it on the
  // page for the mapping, and the two tests below for what has to survive.
  test('the Record Information section is gone, and so is its styling', () => {
    assert.equal(body.includes('aria-label="Record information"'), false)
    assert.equal(/Record information/i.test(body), false, 'the page must not still name it')
    for (const cls of ['order-details', 'order-details-head', 'order-details-grid']) {
      assert.equal(page.includes(`"${cls}"`), false, `${cls} is still used`)
      assert.equal(read(CSS).includes(`.${cls} {`), false, `.${cls} is still styled`)
    }
  })

  test('nothing was lost with it: every useful value has a new home', () => {
    // Who raised it and the originating request number: the identity band.
    const ws = read('src/lib/orders/orderWorkspace.ts')
    assert.ok(ws.includes("key: 'raised_by'") && ws.includes("label: 'Raised by'"))
    assert.ok(ws.includes("key: 'source_request'") && ws.includes("label: 'From request'"))
    assert.ok(page.includes('raisedByName: order.requested_by_name'))
    assert.ok(page.includes('sourceRequestNumber: order.source_request_number'))

    // The two audit timestamps: Important Dates, as its secondary pair.
    assert.ok(ws.includes("key: 'created_at'") && ws.includes("key: 'updated_at'"))
    assert.ok(page.includes('createdAt: fmtDate(order.created_at)'))
    assert.ok(page.includes('updatedAt: fmtDate(order.updated_at)'))

    // The notes: their own block, still on the page.
    assert.ok(body.includes('aria-label="Order notes"'))
    assert.ok(body.includes('{order.notes}'))
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

  test('the identity facts are stated only by the band', () => {
    // The page hands them to one component and draws none of them itself.
    assert.equal((page.match(/orderSummaryFacts\(/g) ?? []).length, 1)
    assert.ok(page.includes('facts={summaryFacts}'))
  })

  test('every date is stated only by Important Dates', () => {
    assert.equal((page.match(/orderImportantDates\(/g) ?? []).length, 1)
    assert.ok(page.includes('dates={importantDates}'))
    // And the band it used to share them with states none.
    const ws = code('src/lib/orders/orderWorkspace.ts')
    const facts = ws.slice(ws.indexOf('export function orderSummaryFacts'),
                           ws.indexOf('export function orderImportantDates'))
    for (const forbidden of ["key: 'confirm_date'", "key: 'due_date'"]) {
      assert.equal(facts.includes(forbidden), false, `${forbidden} belongs to Important Dates now`)
    }
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

  test('the commercial figures are stated ONCE, in their own column below Products', () => {
    // NOT in the identity band: that band is identity only, and the money
    // belongs under the product list it describes.
    const summary = body.slice(body.indexOf('<OrderSummary'), body.indexOf('<OrderAttentionBar'))
    for (const forbidden of ['total_product_value', 'total_value', 'OrderCommercialTotals', 'OrderCommercialBreakdown']) {
      assert.equal(summary.includes(forbidden), false, `${forbidden} must not be in the Order Summary`)
    }

    // In the lower workspace's right column, and after the products.
    const aside = body.slice(body.indexOf('order-lower-aside'))
    assert.ok(aside.includes('<OrderCommercialTotals'))
    assert.ok(aside.includes('total_product_value'))
    assert.ok(aside.includes('total_value'))
    assert.ok(aside.includes('<OrderCommercialBreakdown'))
    assert.ok(body.indexOf('className="order-products"') < body.indexOf('order-lower-aside'),
      'the money sits below the products it describes')

    // Drawn once each.
    assert.equal((body.match(/<OrderCommercialTotals/g) ?? []).length, 1)
    assert.equal((body.match(/<OrderCommercialBreakdown/g) ?? []).length, 1)
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

  test('all three sections are inside it, each embedded rather than a card of its own', () => {
    assert.ok(records.includes('<OrderDocumentsCard'))
    assert.ok(records.includes('Source PI'))
    assert.ok(records.includes('<OrderPiHistoryCard'))
    assert.equal((records.match(/embedded/g) ?? []).length >= 2, true)
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

  test('production alignment, the amendment doors and the generate gate are unchanged', () => {
    assert.ok(page.includes('canAlignProduction(ordersCaps, Boolean(viewAsUserId))'))
    assert.ok(page.includes("rpc('set_order_production_alignment'"))
    assert.ok(page.includes('const mayManageOrders = ordersCaps.canManageOrders && !viewAsUserId'))
    assert.ok(page.includes('canApproveOrderSubmission && !viewAsUserId'))
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

  test('the workbook and each document are signed ON THE CLICK, not at load', () => {
    // A page that signed every version's file up front would spend a request
    // per archived PI for something nobody opened.
    for (const handler of ['const downloadWorkbook', 'const openVersion', 'const downloadDocument']) {
      const at = page.indexOf(handler)
      assert.ok(at > 0, handler)
      assert.ok(page.slice(at, at + 900).includes('createSignedUrl('), `${handler} signs on demand`)
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

  test('asking for documents re-reads the register and the trail, and nothing else', () => {
    const fn = bodyOf('const requestDocuments')
    assert.ok(fn.includes('await reloadDocuments()'))
    assert.equal(fn.includes('loadOrder()'), false,
      'document generation must not fall back to the full page load')
  })

  test('a status change is still the narrowest of all — the trail alone', () => {
    assert.match(page, /onStatusChanged=\{updated => \{[\s\S]{0,900}?reloadActivity\(\)/)
  })

  test('each narrow refresh reads through the SHARED query, so it cannot drift', () => {
    // One definition each, used by the full load and by the narrow refresh.
    assert.equal((page.match(/orderRowQuery\(\)/g) ?? []).length, 2,
      'the Order row query: the full load and the narrow refresh')
    assert.equal((page.match(/documentsQuery\(\)/g) ?? []).length, 2,
      'the documents query: the full load and the narrow refresh')
    assert.equal((page.match(/activityQuery\(\)/g) ?? []).length, 2,
      'the activity query: the full load and the narrow refresh')
    // And each of those tables is SELECTed from in exactly one place: the
    // register and the trail have one read each, and the Order row's single
    // read sits beside the one UPDATE a status change performs.
    assert.equal((page.match(/\.from\('order_document_versions'\)/g) ?? []).length, 1)
    assert.equal((page.match(/\.select\(ORDER_DOCUMENT_COLUMNS\)/g) ?? []).length, 1)
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

  test('the chronology and the register are derived once per load, not per render', () => {
    // Opening the image viewer, expanding the trail or opening a menu
    // re-renders this component. Without these the whole merged chronology was
    // rebuilt and re-sorted for a state change that touched none of it.
    for (const memo of [
      'const history = useMemo(',
      'const orderEntryById = useMemo(',
      'const piHistory = useMemo(',
      'const documentsView = useMemo(',
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
