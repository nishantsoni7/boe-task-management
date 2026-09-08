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
    attention: body.indexOf('<OrderAttentionBar'),
    products: body.indexOf('className="order-products"'),
    payment:  body.indexOf('PAYMENT_SECTION_TITLE'),
    records:  body.indexOf('title="Order records"'),
    info:     body.indexOf('aria-label="Record information"'),
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
      'header', 'summary', 'attention', 'products', 'payment', 'records', 'info', 'activity',
    ])
  })

  test('each is drawn ONCE', () => {
    assert.equal((body.match(/<OrderSummary/g) ?? []).length, 1)
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
  test('the command header carries the identity and the actions, and no fact', () => {
    const header = body.slice(body.indexOf('className="order-command-header"'), body.indexOf('<OrderSummary'))
    // The number and the client are the identity; everything else is a fact
    // and belongs to the summary below.
    assert.ok(header.includes('order-command-title'))
    assert.ok(header.includes('order-command-client'))
    for (const forbidden of ['StatusBadge', 'ToneBadge', 'production', 'Confirmed ', 'Requested by']) {
      assert.equal(header.includes(forbidden), false, `${forbidden} must not be in the command header`)
    }
  })

  test('the six operational facts are stated only by the summary', () => {
    // The page hands them to one component and draws none of them itself.
    assert.equal((page.match(/orderSummaryFacts\(/g) ?? []).length, 1)
    assert.ok(page.includes('facts={summaryFacts}'))
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

  test('the commercial totals are stated in the summary, and not again below', () => {
    const summary = body.slice(body.indexOf('<OrderSummary'), body.indexOf('<OrderAttentionBar'))
    assert.ok(summary.includes('total_product_value'))
    assert.ok(summary.includes('total_value'))
    assert.ok(summary.includes('<OrderCommercialBreakdown'))
    // Record Information must not repeat them.
    const info = body.slice(body.indexOf('aria-label="Record information"'))
    for (const forbidden of ['total_product_value', 'total_value', 'lead_source', 'assigned_to_name']) {
      assert.equal(info.includes(forbidden), false, `${forbidden} must not be repeated in Record information`)
    }
  })

  test('Record Information carries only secondary audit metadata', () => {
    const info = body.slice(body.indexOf('aria-label="Record information"'), body.indexOf('<OrderActivityList'))
    for (const kept of ['Requested By', 'Created', 'Last Updated']) {
      assert.ok(info.includes(kept), kept)
    }
    assert.equal(/label="Assignee"|label="Lead Source"|Total Order Value|Total Product Value/.test(info), false)
  })
})

// ══ 4. Order records ══════════════════════════════════════════════════════════

describe('Order records holds the documents, the source PI and the history', () => {
  const records = body.slice(body.indexOf('title="Order records"'), body.indexOf('aria-label="Record information"'))

  test('all three sections are inside it, each embedded rather than a card of its own', () => {
    assert.ok(records.includes('<OrderDocumentsCard'))
    assert.ok(records.includes('Source PI'))
    assert.ok(records.includes('<OrderPiHistoryCard'))
    assert.equal((records.match(/embedded/g) ?? []).length >= 2, true)
  })

  test('the source PI is a reference and an action, not a summary', () => {
    const source = records.slice(records.indexOf('Source PI'), records.indexOf('<OrderPiHistoryCard'))
    assert.ok(source.includes('Open source PI'))
    assert.ok(source.includes('piSubmissionHref(piHandoff.submissionId)'))
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
