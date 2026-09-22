/**
 * The Confirmed Order pieces, rendered: the attention bar, the Order Summary
 * panel, the commercial breakdown, the payment figures, the records sections,
 * the activity trail, the overflow menu and the loading shell.
 *
 * Every component is a function of its props; these check what they SAY, that
 * nothing depends on colour alone, and that no URL or storage key reaches the
 * markup.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderWorkspace.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ACTIVITY_EMPTY,
  MoreActionsMenu,
  OrderActivityList,
  OrderAttentionBar,
  OrderDetailSkeleton,
  OrderPaymentListDialog,
  OrderStatusPill,
  OrderSummaryPanel,
  PaymentSummaryFigures,
  type OrderActivityItem,
} from './OrderWorkspace'
import {
  PAYMENT_LIST_EMPTY,
  PAYMENT_LIST_TITLE,
  orderPaymentList,
} from '@/lib/orders/orderPaymentLists'
import {
  CUSTOMIZATION_MARK,
  OrderCommercialBreakdown,
  OrderCustomizationCell,
} from './OrderPiSections'
import {
  SUMMARY_GROUP_TITLE,
  SUMMARY_NOT_AVAILABLE,
  SUMMARY_NOT_SET,
  SUMMARY_UNASSIGNED,
  orderAttentionItems,
  orderRecordFacts,
  orderSummaryFields,
  orderSummaryView,
} from '@/lib/orders/orderWorkspace'
import {
  ORDER_COMMERCIAL_TITLE,
  orderCommercialLines,
  orderStoredCommercialLines,
} from '@/lib/orders/orderCommercial'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { buildOrderFinancePosition, type OrderFinancePaymentRow } from '@/lib/finance/orderFinancePosition'
import type { PiAmountRow } from '@/lib/pi/previewView'

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r\n/g, '\n')

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

// ── The attention bar ─────────────────────────────────────────────────────────

describe('the attention bar', () => {
  test('renders nothing at all when nothing needs attention', () => {
    assert.equal(renderToStaticMarkup(<OrderAttentionBar items={[]} />), '')
  })

  test('names the count and every item, as words', () => {
    const items = orderAttentionItems({
      status: 'running', productionAligned: false, hasSalesperson: false, hasDueDate: false, hasLeadSource: true,
      isOverdue: false, awaitingVerificationCount: 0, pendingChangeRequests: 0,
      pendingPiRevision: false, documentsFailed: false, documentsOutdated: false,
    })
    const html = renderToStaticMarkup(<OrderAttentionBar items={items} />)
    const body = text(html)
    assert.ok(body.includes('3 items need attention'))
    assert.ok(body.includes('Production not aligned'))
    assert.ok(body.includes('Salesperson not set'))
    assert.ok(body.includes('Due date not set'))
    assert.match(html, /<ul/, 'a list, so a screen reader counts it')
    assert.match(html, /aria-label="3 items need attention"/)
    assert.match(html, /aria-hidden="true"/, 'the icon is decorative')
  })

  test('the overdue item is marked by a class as well as by its words', () => {
    const items = orderAttentionItems({
      status: 'running', productionAligned: true, hasSalesperson: true, hasDueDate: true, hasLeadSource: true,
      isOverdue: true, awaitingVerificationCount: 0, pendingChangeRequests: 0,
      pendingPiRevision: false, documentsFailed: false, documentsOutdated: false,
    })
    const html = renderToStaticMarkup(<OrderAttentionBar items={items} />)
    assert.ok(html.includes('order-attention-item--red'))
    assert.ok(text(html).includes('Due date has passed'))
  })
})

// ── The Order Summary panel: three groups ─────────────────────────────────────

const fields = (over: Partial<Parameters<typeof orderSummaryFields>[0]> = {}) => orderSummaryFields({
  clientName: 'Acme Exports',
  location: 'Jaipur',
  confirmDate: '8 Sep 2026',
  uploadDate: '2 Sep 2026, 11:04 am',
  dueDate: '30 Oct 2026',
  isOverdue: false,
  totalProductValue: '₹12,53,000.00',
  ...over,
})

const recordFacts = (over: Partial<Parameters<typeof orderRecordFacts>[0]> = {}) =>
  orderRecordFacts({
    status: 'running',
    salespersonName: 'Nishant Soni',
    leadSource: 'Reference',
    productionAligned: true,
    productionLabel: 'Aligned for Production',
    productionLine: 'Aligned by Nishant Soni · 21 Sep 2026, 10:00 am',
    ...over,
  })

const view = (over: {
  field?: Parameters<typeof fields>[0]
  fact?: Parameters<typeof recordFacts>[0]
  clientContact?: string | null
  productionAligned?: boolean
} = {}) => orderSummaryView({
  fields: fields(over.field ?? {}),
  facts: recordFacts(over.fact ?? {}),
  clientContact: over.clientContact === undefined ? '+91 98290 12345' : over.clientContact,
  productionAligned: over.productionAligned ?? true,
})

const summaryMarkup = (over: Parameters<typeof view>[0] = {}) =>
  renderToStaticMarkup(<OrderSummaryPanel view={view(over)} />)

describe('the Order Summary panel: group 1, client and value', () => {
  test('states the client name, the contact and the location', () => {
    const body = text(summaryMarkup())
    for (const s of ['Client and value', 'Acme Exports', 'Contact', '+91 98290 12345',
                     'Location', 'Jaipur']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('the client name is a LABELLED ROW like the three beside it', () => {
    const html = summaryMarkup()
    // It was the group's oversized primary text, captioned by nothing.
    assert.equal(html.includes('order-sum-client'), false)
    assert.ok(text(html).includes('Client Acme Exports'), 'label then value, in that order')
    // `Client`, not the field builder's `Client name`: every row in this group
    // is about the client and the extra word only lengthens the column.
    assert.equal(text(html).includes('Client name'), false)
  })

  test('the total product value is a row too, with slightly more weight', () => {
    const html = summaryMarkup()
    assert.ok(text(html).includes('Total product value ₹12,53,000.00'))
    // THE LARGE INSET PANEL IS GONE. It made one group two kinds of thing and
    // cost the card the height three groups of plain rows do not need.
    assert.equal(html.includes('order-sum-amount'), false)
    assert.ok(html.includes('order-sum-row--strong'), 'it keeps a half-step of weight')
    assert.equal((html.match(/order-sum-row--strong/g) ?? []).length, 1,
      'and it is the ONLY row that does')
  })

  test('the four rows are in the agreed order', () => {
    const body = text(summaryMarkup())
    const at = (s: string) => body.indexOf(s)
    assert.ok(at('Client Acme') < at('Contact'))
    assert.ok(at('Contact') < at('Location'))
    assert.ok(at('Location') < at('Total product value'))
  })

  test('every row is one label and one value, in that order', () => {
    const html = summaryMarkup()
    // A definition list: the label is the term, the value the description, and
    // a screen reader reads the pair. The right edge is the grid's, in CSS.
    const rows = html.match(/<div class="order-sum-row[^"]*"><dt class="order-sum-label">/g) ?? []
    assert.ok(rows.length >= 4, 'each field is a label/value row')
    assert.ok(css.includes('.order-sum-row {'))
    const rule = css.slice(css.indexOf('.order-sum-row {'), css.indexOf('.order-sum-row {') + 260)
    assert.match(rule, /display: grid/)
    assert.match(rule, /grid-template-columns: minmax\(0, auto\) minmax\(0, 1fr\)/)
    assert.match(css.slice(css.indexOf('.order-sum-value {')), /justify-content: flex-end/)
  })

  test('and it is STILL the ONLY amount in the header — payment is its own section', () => {
    const body = text(summaryMarkup())
    assert.equal((body.match(/₹/g) ?? []).length, 1)
    assert.ok(!/verified|awaiting|balance|order value/i.test(body))
  })

  test('a long client name and location wrap rather than widening the page', () => {
    const html = summaryMarkup({
      field: {
        clientName: 'Maharaja Heritage Furnishings and Export House Private Limited',
        location: 'Sitapura Industrial Area, Tonk Road, Jaipur, Rajasthan',
      },
    })
    const body = text(html)
    // Neither is truncated, and neither is hidden behind a title attribute.
    assert.ok(body.includes('Maharaja Heritage Furnishings and Export House Private Limited'))
    assert.ok(body.includes('Sitapura Industrial Area, Tonk Road, Jaipur, Rajasthan'))
    assert.equal(/title="/.test(html), false)
  })

  test('a missing contact says `Not available` and is marked absent, not at fault', () => {
    const html = summaryMarkup({ clientContact: null })
    assert.ok(text(html).includes(SUMMARY_NOT_AVAILABLE))
    assert.ok(html.includes('order-sum-row--missing'))
    assert.ok(!html.includes('order-sum-row--amber'))
  })
})

describe('the Order Summary panel: group 2, sales and production', () => {
  test('an ALIGNED order shows the state, the date and who aligned it', () => {
    const body = text(summaryMarkup())
    assert.ok(body.includes('Sales and production'))
    assert.ok(body.includes('Aligned for Production'))
    assert.ok(body.includes('Aligned by Nishant Soni'))
    assert.ok(body.includes('21 Sep 2026'))
  })

  test('the production state is a LABELLED ROW whose value is a badge', () => {
    const html = summaryMarkup()
    assert.ok(html.includes('order-sum-badge'))
    assert.ok(text(html).includes('Production Aligned for Production'),
      'it leads the group as a row, under its own label')
    // A reader who cannot tell green from amber still reads the state.
    assert.ok(text(html).includes('Aligned for Production'))
  })

  test('the three rows are in the agreed order', () => {
    const body = text(summaryMarkup())
    const at = (s: string) => body.indexOf(s)
    assert.ok(at('Production Aligned') < at('Lead source'))
    assert.ok(at('Lead source') < at('Salesperson'))
  })

  test('an UNALIGNED order shows the state and NO alignment metadata', () => {
    const html = summaryMarkup({
      productionAligned: false,
      fact: { productionAligned: false, productionLabel: 'Not Aligned for Production', productionLine: null },
    })
    const body = text(html)
    assert.ok(body.includes('Not Aligned for Production'))
    // No empty date and no empty actor — the row is absent, not blank.
    assert.equal(html.includes('order-sum-production-line'), false)
    assert.equal(/aligned by/i.test(body), false)
    assert.equal(/aligned on/i.test(body), false)
  })

  test('an alignment line is never drawn for an unaligned order EVEN IF one is passed', () => {
    // The helper already nulls it; the view says so a second time rather than
    // trusting a caller that hands over a stale line.
    const html = summaryMarkup({
      productionAligned: false,
      fact: {
        productionAligned: false,
        productionLabel: 'Not Aligned for Production',
        productionLine: 'Aligned by Somebody · 1 Jan 2026',
      },
    })
    assert.equal(/Somebody/.test(text(html)), false)
  })

  test('the lead source and the salesperson are shown, under their existing labels', () => {
    const body = text(summaryMarkup())
    for (const s of ['Lead source', 'Reference', 'Salesperson', 'Nishant Soni']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('a missing lead source or salesperson keeps its existing wording and its amber rule', () => {
    const html = summaryMarkup({
      fact: { salespersonName: null, leadSource: null },
    })
    const body = text(html)
    assert.ok(body.includes(SUMMARY_UNASSIGNED))
    assert.ok(body.includes(SUMMARY_NOT_SET))
    assert.equal((html.match(/order-sum-row--amber/g) ?? []).length, 2)
  })
})

describe('the Order Summary panel: group 3, the dates', () => {
  test('states the confirm date, the upload date and the due date', () => {
    const body = text(summaryMarkup())
    for (const s of ['Important dates', 'Confirm date', '8 Sep 2026',
                     'Upload date', '2 Sep 2026, 11:04 am', 'Due date', '30 Oct 2026']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('an overdue due date says so IN WORDS, not by colour alone', () => {
    const html = summaryMarkup({ field: { isOverdue: true } })
    assert.ok(text(html).includes('Overdue'))
    assert.equal((html.match(/order-sum-row--red/g) ?? []).length, 1)
  })

  test('a date the record has not got says `Not available`, quietly', () => {
    const html = summaryMarkup({ field: { uploadDate: null } })
    assert.ok(text(html).includes(SUMMARY_NOT_AVAILABLE))
    assert.ok(html.includes('order-sum-row--missing'))
  })
})

describe('the Order Summary panel as a whole', () => {
  test('the panel and each of its three groups are labelled for a reader not seeing it', () => {
    const html = summaryMarkup()
    assert.match(html, /aria-label="Order summary"/)
    for (const title of Object.values(SUMMARY_GROUP_TITLE)) {
      assert.ok(html.includes(`aria-label="${title}"`), title)
    }
  })

  test('a section heading and a row label are visibly DIFFERENT KINDS OF THING', () => {
    // They were both 10px uppercase grey, so a group title and a field caption
    // were indistinguishable at a glance and the panel had no hierarchy.
    const head = css.slice(css.indexOf('.order-sum-group-head {'), css.indexOf('.order-sum-group-head {') + 260)
    const label = css.slice(css.indexOf('.order-sum-label {'), css.indexOf('.order-sum-label {') + 260)
    assert.match(head, /font-weight: 700/, 'the heading is semibold or heavier')
    assert.match(head, /border-bottom/, 'and ruled off from the rows under it')
    assert.match(label, /font-weight: 500/, 'the label is lighter')
    // Darker heading, muted label — the two must not share a colour.
    const colour = (block: string) => (block.match(/color: (#[0-9A-Fa-f]{6})/) ?? [])[1]
    assert.ok(colour(head) && colour(label) && colour(head) !== colour(label),
      'the heading and the label must not be the same colour')
    // And the heading is no longer shouted in the labels' own uppercase.
    assert.equal(/text-transform: uppercase/.test(head), false)
  })

  test('the panel is SHORTER than it was: no oversized name, no inset amount', () => {
    const html = summaryMarkup()
    for (const gone of ['order-sum-client', 'order-sum-amount', 'order-sum-production"']) {
      assert.equal(html.includes(gone), false, gone + ' is still drawn')
    }
    for (const gone of ['.order-sum-client {', '.order-sum-amount {', '.order-sum-production {']) {
      assert.equal(css.includes(gone), false, gone + ' is still styled')
    }
  })

  test('RAISED BY IS STILL NOT DRAWN', () => {
    assert.equal(/raised by|requested by/i.test(text(summaryMarkup())), false)
  })

  test('the status is not restated here — it is the pill beside the order number', () => {
    assert.equal(/\bStatus\b/.test(text(summaryMarkup())), false)
  })

  test('nothing is hidden behind a hover: every value is in the markup', () => {
    const html = summaryMarkup()
    assert.equal(/onMouseOver|:hover/.test(html), false)
    assert.equal(/title="/.test(html), false)
  })
})

describe('the status pill', () => {
  test('says the status in words, in the tone it was given', () => {
    const html = renderToStaticMarkup(<OrderStatusPill label="In Production" tone="blue" />)
    assert.ok(text(html).includes('In Production'))
    assert.ok(html.includes('order-status-pill'))
  })

  test('every tone is paintable — no status can render without a colour', () => {
    for (const tone of ['neutral', 'blue', 'green', 'amber', 'red'] as const) {
      const html = renderToStaticMarkup(<OrderStatusPill label="X" tone={tone} />)
      assert.match(html, /background:/, tone)
    }
  })

  test('the WORD carries the meaning — colour is never the only signal', () => {
    // A reader who cannot tell amber from red still reads "Cancelled".
    assert.ok(text(renderToStaticMarkup(<OrderStatusPill label="Cancelled" tone="red" />)).includes('Cancelled'))
  })
})

// ── The payment section ───────────────────────────────────────────────────────

const payment = (over: Partial<OrderFinancePaymentRow>): OrderFinancePaymentRow => ({
  id: over.id ?? 'p1',
  client_name: 'Vittaazio', amount: 750000, payment_date: '2026-09-01', payment_mode: 'hdfc',
  order_number: '0524', status: 'approved_linked',
  allocatedAmount: 750000, source: 'allocation',
  exactAmount: '750000.00', exactAllocatedAmount: '750000.00',
  isPartialShare: false, attributionBasis: 'allocation',
  ...over,
} as OrderFinancePaymentRow)

function paymentMarkup(payments: OrderFinancePaymentRow[], orderValue: number | null, loaded = true) {
  return renderToStaticMarkup(
    <PaymentSummaryFigures
      finance={buildOrderFinancePosition(payments, orderValue)}
      loaded={loaded}
      onOpenList={() => {}}
    />,
  )
}

describe('the payment summary figures', () => {
  test('answers the four questions an owner asks, and states each ONCE', () => {
    const body = text(paymentMarkup([payment({})], 1564090))
    // How much is verified, and what share of the Order that is.
    assert.ok(body.includes('47.95%'))
    assert.ok(body.includes('₹7,50,000.00 verified of ₹15,64,090.00 order value'))
    // The two parts of what has been received.
    assert.ok(body.includes('Verified ₹7,50,000.00'))
    assert.ok(body.includes('Awaiting verification ₹0.00'))
    // What remains.
    assert.ok(body.includes('Balance ₹8,14,090.00'))
    // THE ORDER VALUE IS STATED ONCE, in the line under the headline.
    assert.equal((body.match(/₹15,64,090\.00/g) ?? []).length, 1)
  })

  test('the duplicated blocks are gone: no Received figure, no legend', () => {
    const html = paymentMarkup([payment({})], 1564090)
    const body = text(html)
    // `Received` was verified plus awaiting, both of which are named above it.
    assert.equal(/\bReceived\b/.test(body), false)
    assert.equal(body.includes('verified + awaiting'), false)
    // The legend named the two shares the buttons beside it name.
    assert.equal(html.includes('order-pay-legend'), false)
    assert.equal(html.includes('order-pay-swatch'), false)
    assert.equal(body.includes('Not received'), false)
    // And the second grid of captioned figures.
    assert.equal(html.includes('order-pay-figures'), false)
    assert.equal(html.includes('order-pay-figure-label'), false)
  })

  test('there is exactly ONE progress bar, and it still names all three shares', () => {
    const html = paymentMarkup([payment({})], 1564090)
    assert.equal((html.match(/role="progressbar"/g) ?? []).length, 1)
    // The SHARED three-share track, not this page's old single-fill bar.
    assert.equal(html.includes('order-pay-bar-fill'), false)
    for (const seg of ['confirmed', 'unpaid']) {
      assert.ok(html.includes(`data-segment="${seg}"`), seg)
    }
    // A reader who cannot see the bar is told what it measures.
    assert.match(html, /aria-label="Verified: 47\.95% of the order value [^"]*not received"/)
  })

  test('the payment WORDS are the Order’s own — verified is never called approved', () => {
    const body = text(paymentMarkup([payment({})], 1564090))
    assert.ok(body.includes('Verified'))
    assert.ok(body.includes('Awaiting verification'))
    assert.equal(/approved/i.test(body), false)
  })

  test('the two figures are real BUTTONS, each naming its own payment count', () => {
    const html = paymentMarkup([
      payment({}),
      payment({ id: 'p2', status: 'pending_approval', amount: 100000, allocatedAmount: 100000, exactAmount: '100000.00', exactAllocatedAmount: '100000.00' }),
    ], 1564090)
    const buttons = html.match(/<button[^>]*class="order-pay-metric[^"]*"[^>]*>/g) ?? []
    assert.equal(buttons.length, 2, 'both figures open their rows')
    for (const b of buttons) assert.match(b, /type="button"/)
    const body = text(html)
    assert.ok(body.includes('Verified ₹7,50,000.00 1 payment'))
    assert.ok(body.includes('Awaiting verification ₹1,00,000.00 1 payment'))
    // The accessible name says what the control DOES, not just what it shows.
    assert.match(html, /aria-label="Verified: [^"]*Show the payments\."/)
    assert.match(html, /aria-label="Awaiting verification: [^"]*Show the payments\."/)
  })

  test('an empty set still gets a button — a figure of zero is a set, not a fault', () => {
    const html = paymentMarkup([], 1564090)
    assert.equal((html.match(/<button[^>]*class="order-pay-metric/g) ?? []).length, 2)
    assert.ok(text(html).includes('no payments'))
  })

  test('money awaiting Finance is counted, and never added to verified', () => {
    const body = text(paymentMarkup([
      payment({}),
      payment({ id: 'p2', status: 'pending_approval', amount: 100000, allocatedAmount: 100000, exactAmount: '100000.00', exactAllocatedAmount: '100000.00' }),
    ], 1564090))
    assert.ok(body.includes('Verified ₹7,50,000.00'))
    assert.ok(body.includes('Awaiting verification ₹1,00,000.00'))
    // The balance is measured against VERIFIED money, exactly as before.
    assert.ok(body.includes('Balance ₹8,14,090.00'))
    assert.ok(body.includes('against verified'))
  })

  test('draws a skeleton, not zeros, until the reads land', () => {
    const html = paymentMarkup([], 1564090, false)
    assert.match(html, /role="status"/)
    assert.ok(!text(html).includes('₹'))
  })

  test('no URL and no payment id reaches the summary markup', () => {
    const html = paymentMarkup([payment({})], 1564090)
    assert.ok(!/href=/.test(html))
    assert.ok(!html.includes('p1'))
  })

  test('the figures themselves are unchanged — same builder, same arithmetic', () => {
    // Nothing in this pass touched a money rule. The position is the one the
    // shared builder produces, and the section only rearranges its output.
    const finance = buildOrderFinancePosition([payment({})], 1564090)
    assert.equal(finance.verified, '750000.00')
    assert.equal(finance.awaitingVerification, '0')
    assert.equal(finance.received, '750000.00')
    assert.equal(finance.pendingBalance, '814090.00')
    assert.equal(finance.verifiedPercent, '47.95')
  })
})

// ── The payments behind a figure ───────────────────────────────

const dialog = (
  rows: OrderFinancePaymentRow[],
  kind: 'verified' | 'awaiting',
  financeHref: ((id: string) => string) | null = null,
) => renderToStaticMarkup(
  <OrderPaymentListDialog
    kind={kind}
    rows={orderPaymentList(rows, kind)}
    formatDate={iso => (iso === null ? '—' : `${iso} formatted`)}
    financeHref={financeHref}
    onClose={() => {}}
  />,
)

const awaitingRow = payment({
  id: 'p2', status: 'pending_approval', amount: 100000, allocatedAmount: 100000,
  exactAmount: '100000.00', exactAllocatedAmount: '100000.00',
  payment_date: '2026-09-14', payment_mode: 'cash', client_name: 'Vittaazio',
})

describe('the payments behind a figure', () => {
  test('the VERIFIED dialog lists only payments Finance has confirmed', () => {
    const html = dialog([payment({}), awaitingRow], 'verified')
    const body = text(html)
    assert.ok(body.includes(PAYMENT_LIST_TITLE.verified))
    assert.ok(body.includes('₹7,50,000.00'), 'the verified payment')
    assert.equal(body.includes('₹1,00,000.00'), false, 'the awaiting one belongs to the other list')
    assert.equal((html.match(/order-pay-list-row/g) ?? []).length, 1)
  })

  test('the AWAITING dialog is the same dialog, filtered the other way', () => {
    const html = dialog([payment({}), awaitingRow], 'awaiting')
    const body = text(html)
    assert.ok(body.includes(PAYMENT_LIST_TITLE.awaiting))
    assert.ok(body.includes('₹1,00,000.00'))
    assert.equal(body.includes('₹7,50,000.00'), false)
  })

  test('a REJECTED payment is in neither list, exactly as it is in neither figure', () => {
    const rejected = payment({ id: 'p3', status: 'rejected' })
    for (const kind of ['verified', 'awaiting'] as const) {
      assert.equal(text(dialog([rejected], kind)).includes('₹7,50,000.00'), false, kind)
    }
  })

  test('each row says the useful things, and no more', () => {
    const body = text(dialog([payment({})], 'verified'))
    for (const s of ['₹7,50,000.00', 'Date', '2026-09-01 formatted', 'Mode', 'Client', 'Vittaazio']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('the status is stated only where it distinguishes anything', () => {
    // Every row in the verified list is verified; captioning each one so says
    // nothing. A row awaiting Finance may be pending or need clarification.
    assert.equal(text(dialog([payment({})], 'verified')).includes('Status'), false)
    assert.ok(text(dialog([awaitingRow], 'awaiting')).includes('Status Awaiting Verification'))
  })

  test('A SPLIT PAYMENT SHOWS THIS ORDER’S SHARE, never the full amount as the figure', () => {
    const split = payment({
      id: 'p4', amount: 500000, allocatedAmount: 200000,
      exactAmount: '500000.00', exactAllocatedAmount: '200000.00', isPartialShare: true,
    })
    const body = text(dialog([split], 'verified'))
    const amount = body.indexOf('₹2,00,000.00')
    const full = body.indexOf('₹5,00,000.00')
    assert.ok(amount > 0, "this Order's allocated share leads the row")
    assert.ok(full > amount, 'and the full payment is stated only underneath it')
    assert.ok(body.includes('allocated from ₹5,00,000.00 received'))
    // And the summary counts the SAME share, so the two cannot disagree.
    assert.equal(buildOrderFinancePosition([split], 1564090).verified, '200000.00')
  })

  test('an ordinary payment does NOT explain itself — that line is for splits only', () => {
    assert.equal(text(dialog([payment({})], 'verified')).includes('allocated from'), false)
  })

  test('the AWAITING zero state opens and says so', () => {
    const html = dialog([payment({})], 'awaiting')
    assert.ok(text(html).includes(PAYMENT_LIST_EMPTY.awaiting))
    assert.equal(PAYMENT_LIST_EMPTY.awaiting, 'No payments awaiting verification.')
    // It is still a dialog: the reader gets an answer, not a dead control.
    assert.match(html, /role="dialog"/)
    assert.equal((html.match(/order-pay-list-row/g) ?? []).length, 0)
  })

  test('the VERIFIED zero state does the same', () => {
    assert.ok(text(dialog([], 'verified')).includes(PAYMENT_LIST_EMPTY.verified))
  })

  test('the Finance record door is drawn only when the page passes one', () => {
    const without = dialog([payment({})], 'verified', null)
    assert.equal(/href=/.test(without), false, 'no door for a reader who may not open it')
    assert.equal(without.includes('order-pay-list-link'), false)

    const withDoor = dialog([payment({})], 'verified', id => `/finance/received/${id}`)
    assert.ok(withDoor.includes('href="/finance/received/p1"'))
    assert.ok(text(withDoor).includes('Finance record'))
  })

  test('it is a proper dialog: labelled, modal, and closable', () => {
    const html = dialog([payment({})], 'verified')
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    assert.match(html, new RegExp(`aria-label="${PAYMENT_LIST_TITLE.verified}"`))
    assert.match(html, /aria-label="Close"/)
  })

  test('the allocation semantics are stated, not assumed', () => {
    assert.ok(text(dialog([payment({})], 'verified')).includes("Amounts are this Order's allocated share"))
  })
})

// ── The overflow menu ─────────────────────────────────────────────────────────

describe('the overflow menu', () => {
  test('renders nothing when it would hold nothing', () => {
    assert.equal(renderToStaticMarkup(<MoreActionsMenu items={[]} onSelect={() => {}} />), '')
  })

  test('is a labelled menu button, closed by default', () => {
    const html = renderToStaticMarkup(
      <MoreActionsMenu items={[{ key: 'cleanup', label: 'Clean Up Test Transaction' }]} onSelect={() => {}} />,
    )
    assert.match(html, /aria-label="More actions"/)
    assert.match(html, /aria-haspopup="menu"/)
    assert.match(html, /aria-expanded="false"/)
    assert.ok(!html.includes('role="menu"'), 'the panel is not in the document until it opens')
  })
})

// ── The activity trail ────────────────────────────────────────────────────────

const event = (n: number): OrderActivityItem => ({
  key: `order:e${n}`, label: `Event ${n}`, detail: null, lines: [],
  actor: 'Ravi Menon', when: `${n} Sep 2026, 10:00 am`,
  dot: <span className="order-activity-dot" aria-hidden="true" />, fromPi: n % 2 === 0,
})
const events = (count: number) => Array.from({ length: count }, (_, i) => event(i + 1))

describe('the activity trail', () => {
  test('five or fewer events are all shown, with no expansion control', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={events(5)} />)
    const body = text(html)
    for (let n = 1; n <= 5; n++) assert.ok(body.includes(`Event ${n}`))
    assert.ok(!body.includes('View all'))
    assert.ok(!/aria-expanded/.test(html))
    assert.ok(body.includes('5 events'))
  })

  test('a longer trail shows the latest five and offers the rest', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={events(13)} />)
    const body = text(html)
    for (let n = 1; n <= 5; n++) assert.ok(body.includes(`Event ${n}`), `Event ${n}`)
    assert.ok(!body.includes('Event 6'), 'the sixth waits behind the control')
    assert.ok(body.includes('View all 13 events'))
    assert.ok(body.includes('Latest 5 of 13'), 'the header says more history exists')
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, /aria-controls="order-activity-list"/)
  })

  test('timestamps, actors and the PI marker survive exactly as handed over', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={[
      { ...event(1), lines: ['Due date: 1 Oct → 8 Oct'], detail: 'Running → On Hold' },
    ]} />)
    const body = text(html)
    assert.ok(body.includes('Ravi Menon · 1 Sep 2026, 10:00 am'))
    assert.ok(body.includes('Running → On Hold'))
    assert.ok(body.includes('Due date: 1 Oct → 8 Oct'))
    assert.ok(!body.includes(' PI '), 'an Order event is not marked as the PI\'s')
    assert.ok(text(renderToStaticMarkup(<OrderActivityList items={[event(2)]} />)).includes(' PI '))
  })

  test('an empty trail says so', () => {
    assert.ok(text(renderToStaticMarkup(<OrderActivityList items={[]} />)).includes(ACTIVITY_EMPTY))
  })
})

// ── Order records: the same documents section, embedded ───────────────────────

// ── The commercial breakdown ──────────────────────────────────────────────────

const breakdownLines = () => orderCommercialLines([
  { key: 'gross',      label: 'Gross product amount',   value: '₹11,70,000', kind: 'amount' },
  { key: 'discount',   label: 'Discount',               value: '₹20,000',    kind: 'amount' },
  { key: 'subtotal',   label: 'Subtotal after discount', value: '₹11,50,000', kind: 'amount' },
  { key: 'packing',    label: 'Packing cost',           value: 'Included',   kind: 'included' },
  { key: 'beforeGst',  label: 'Total before GST',       value: '₹11,70,000', kind: 'amount', groupStart: true },
  { key: 'gst',        label: 'GST',                    value: '₹2,10,600',  kind: 'amount' },
  { key: 'grandTotal', label: 'Grand Total',            value: '₹13,80,600', kind: 'amount', emphasis: 'total' },
] as PiAmountRow[])

describe('the commercial breakdown', () => {
  test('prints exactly the lines it is given, and invents none', () => {
    const html = renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    )
    const body = text(html)
    assert.ok(body.includes(ORDER_COMMERCIAL_TITLE))
    for (const s of ['₹11,70,000', 'Discount', '₹20,000', 'Subtotal after discount',
                     'Packing cost', 'Included', 'Total before GST', 'GST', '₹2,10,600',
                     '₹13,80,600']) {
      assert.ok(body.includes(s), s)
    }
    // One label per line, so this counts LINES rather than class tokens.
    assert.equal((html.match(/order-breakdown-label/g) ?? []).length, 7)
  })

  test('it opens on Product value and ends on Order value, in the Order`s words', () => {
    const body = text(renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    ))
    assert.ok(body.includes('Product value'))
    assert.ok(body.includes('Order value'))
    assert.ok(!body.includes('Gross product amount'))
    assert.ok(!body.includes('Grand Total'))
  })

  test('the final row is the strongest, and there is exactly one of it', () => {
    const html = renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    )
    assert.equal((html.match(/order-breakdown-line--final/g) ?? []).length, 1)
    assert.equal((html.match(/order-breakdown-line--base/g) ?? []).length, 1)
  })

  test('EVERY row’s value sits in the one value column — one right edge', () => {
    const lines = breakdownLines()
    const html = renderToStaticMarkup(<OrderCommercialBreakdown lines={lines} />)
    // Seven rows, seven values, and not a second money column between them.
    assert.equal((html.match(/order-breakdown-value/g) ?? []).length, lines.length)
    for (const gone of ['order-breakdown-adjust', 'order-breakdown-total']) {
      assert.equal(html.includes(gone), false, gone + ' is a column that no longer exists')
    }
  })

  test('and the final Order value shares it, rather than setting its own', () => {
    const html = renderToStaticMarkup(<OrderCommercialBreakdown lines={breakdownLines()} />)
    // The strongest row is still marked as such — it is its WEIGHT that differs,
    // not its column.
    assert.ok(html.includes('order-breakdown-line--final'))
    const finalAt = html.indexOf('order-breakdown-line--final')
    assert.ok(html.indexOf('order-breakdown-value', finalAt) > finalAt)
  })

  test('a worded value such as `Not applicable` sits in the same column as an amount', () => {
    const html = renderToStaticMarkup(<OrderCommercialBreakdown lines={[
      { key: 'gross', label: 'Product value', value: '₹1,00,000', kind: 'amount',
        role: 'base', sign: null, groupStart: false, note: null },
      { key: 'fabric', label: 'Fabric cost', value: 'Not applicable', kind: 'notApplicable',
        role: 'addition', sign: null, groupStart: false, note: null },
      { key: 'subtotal', label: 'Subtotal', value: '₹1,00,000', kind: 'amount',
        role: 'running', sign: null, groupStart: false, note: null },
    ]} />)
    assert.ok(text(html).includes('Not applicable'))
    // Three rows, three values, all in the one column: the worded cell
    // terminates exactly where the Subtotal below it does.
    assert.equal((html.match(/order-breakdown-value/g) ?? []).length, 3)
  })

  test('a sign is announced in words as well as drawn as a glyph', () => {
    const html = renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    )
    // The glyph is decorative; the word beside it is what a screen reader says.
    assert.match(html, /order-breakdown-sign"[^>]*aria-hidden="true"/)
    const body = text(html)
    assert.ok(body.includes('less'), 'the deduction is spoken')
    assert.ok(body.includes('plus'), 'the addition is spoken')
  })

  test('THE NET-EFFECT LINE IS NOT DRAWN, and nothing stands where it did', () => {
    const html = renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    )
    const body = text(html)

    // The label is gone, in every casing somebody might reintroduce it.
    for (const wording of ['Net effect', 'net effect', 'Net difference', 'net difference']) {
      assert.equal(body.includes(wording), false, wording)
    }
    // So is the markup that carried it, and its styling hooks.
    for (const hook of ['order-breakdown-net', 'order-breakdown-net-label',
                        'order-breakdown-net-value', 'order-breakdown-net-percent']) {
      assert.equal(html.includes(hook), false, hook)
    }
    // And so is the figure it stated: 13,80,600 − 11,70,000, with its percentage.
    assert.equal(body.includes(`+${formatMoney(210600)}`), false, 'the difference itself')
    assert.equal(body.includes('+18.0%'), false, 'the percentage')
  })

  test('the ORDER VALUE is now the last thing in the section', () => {
    const body = text(renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    ))
    // Nothing follows the answer. This is the property the removal was for.
    assert.ok(body.trimEnd().endsWith('₹13,80,600'), body.slice(-80))
  })

  test('and EVERY OTHER ROW SURVIVED the removal, with its sign', () => {
    // Product value, each individual adjustment, the running totals and the
    // final Order value — the whole point is that only one line went.
    const html = renderToStaticMarkup(
      <OrderCommercialBreakdown lines={breakdownLines()} />,
    )
    const body = text(html)
    for (const s of ['Product value', '₹11,70,000', 'Discount', '₹20,000',
                     'Subtotal after discount', 'Packing cost', 'Included',
                     'Total before GST', 'GST', '₹2,10,600',
                     'Order value', '₹13,80,600']) {
      assert.ok(body.includes(s), s)
    }
    assert.equal((html.match(/order-breakdown-label/g) ?? []).length, 7)
    assert.equal((html.match(/order-breakdown-line--final/g) ?? []).length, 1)
    assert.ok(body.includes('less'), 'the deduction is still spoken')
    assert.ok(body.includes('plus'), 'the addition is still spoken')
  })

  test('the Order with no PI still states its two stored figures', () => {
    const body = text(renderToStaticMarkup(
      <OrderCommercialBreakdown
        lines={orderStoredCommercialLines({ productValue: '₹5,000.00', orderValue: '₹5,900.00' })}
      />,
    ))
    assert.ok(body.includes('Product value ₹5,000.00'))
    assert.ok(body.includes('Order value ₹5,900.00'))
    // And states no third figure between or after them.
    assert.equal(body.includes(formatMoney(900)), false, 'no derived difference')
  })
})

// ── The customization cell ────────────────────────────────────────────────────

describe('the customization cell on the Order', () => {
  test('keeps the instruction fully readable in dark text, marked CUSTOM', () => {
    const html = renderToStaticMarkup(
      <OrderCustomizationCell text="Charcoal weave, brass caps" thumbnails={[]} compact={false} />,
    )
    assert.ok(text(html).includes('Charcoal weave, brass caps'))
    assert.ok(text(html).includes(CUSTOMIZATION_MARK))
    assert.ok(html.includes('order-custom'))
    assert.ok(!/color:#9B1C25|color:#B3222E;font-weight:600/.test(html), 'the words are not printed in red')
  })

  test('a line with nothing custom is quiet: no mark, no ground', () => {
    const html = renderToStaticMarkup(<OrderCustomizationCell text={null} thumbnails={[]} compact={false} />)
    assert.ok(!text(html).includes(CUSTOMIZATION_MARK))
    assert.ok(!html.includes('class="order-custom"'))
  })
})

// ── The loading shell ─────────────────────────────────────────────────────────

describe('the loading shell', () => {
  test('is announced as busy and has the workspace shape', () => {
    const html = renderToStaticMarkup(<OrderDetailSkeleton />)
    assert.match(html, /role="status"/)
    assert.match(html, /aria-busy="true"/)
    assert.ok(html.includes('order-command-header'))
    assert.ok(html.includes('order-summary'))
    assert.ok(html.includes('order-products'))
    assert.ok(!/\d/.test(text(html)), 'no figure is invented while loading')
  })
})
