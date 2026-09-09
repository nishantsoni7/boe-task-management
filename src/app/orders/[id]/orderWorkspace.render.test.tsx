/**
 * The Confirmed Order pieces, rendered: the attention bar, the Order Summary,
 * the payment figures, the records sections, the activity trail, the overflow
 * menu and the loading shell.
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
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ACTIVITY_EMPTY,
  MoreActionsMenu,
  OrderActivityList,
  OrderAttentionBar,
  OrderCommercialTotals,
  OrderDetailSkeleton,
  OrderImportantDatesSection,
  OrderStatusPill,
  OrderSummary,
  PaymentSummaryFigures,
  type OrderActivityItem,
} from './OrderWorkspace'
import {
  CUSTOMIZATION_MARK,
  ORDER_COMMERCIAL_TITLE,
  OrderCommercialBreakdown,
  OrderCustomizationCell,
  OrderDocumentsCard,
} from './OrderPiSections'
import {
  SUMMARY_NOT_SET,
  SUMMARY_UNASSIGNED,
  orderAttentionItems,
  orderImportantDates,
  orderSummaryFacts,
} from '@/lib/orders/orderWorkspace'
import { buildOrderFinancePosition, type OrderFinancePaymentRow } from '@/lib/finance/orderFinancePosition'
import {
  ORDER_DOCUMENTS_EXCEL_LABEL,
  ORDER_DOCUMENTS_PDF_LABEL,
  ORDER_DOCUMENTS_TITLE,
  buildOrderDocumentsView,
  orderDocumentAttemptPath,
  type OrderDocumentRow,
} from '@/lib/orders/orderDocuments'
import type { PiAmountRow } from '@/lib/pi/previewView'

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

// ── The identity band, the status pill and Important Dates ────────────────────

const facts = (over: Partial<Parameters<typeof orderSummaryFacts>[0]> = {}) => orderSummaryFacts({
  status: 'running', customerName: 'Acme Exports',
  productionAligned: false, productionLabel: 'Not Aligned', productionLine: null,
  salespersonName: null, leadSource: null,
  raisedByName: null, sourceRequestNumber: null,
  ...over,
})

function summaryMarkup(over: Parameters<typeof facts>[0] = {}, commercial: React.ReactNode = null) {
  return renderToStaticMarkup(<OrderSummary facts={facts(over)} commercial={commercial} />)
}

describe('the identity band', () => {
  test('states who the Order is for and who is carrying it', () => {
    const body = text(summaryMarkup({
      salespersonName: 'Nishant', leadSource: 'Reference', raisedByName: 'Dhruv',
    }))
    for (const s of ['Customer', 'Acme Exports', 'Salesperson', 'Nishant',
                     'Lead source', 'Reference', 'Production', 'Not Aligned',
                     'Raised by', 'Dhruv']) {
      assert.ok(body.includes(s), s)
    }
  })

  test('states NEITHER the status NOR a date — those are the header and Important Dates', () => {
    const body = text(summaryMarkup({ salespersonName: 'Nishant', leadSource: 'Reference' }))
    assert.ok(!/\bStatus\b/.test(body))
    assert.ok(!/\bRunning\b/.test(body))
    assert.ok(!/date/i.test(body))
  })

  test('says neither Owner nor Assignee anywhere', () => {
    const html = summaryMarkup({ salespersonName: 'Nishant' })
    assert.ok(!/owner|assignee/i.test(text(html)))
  })

  test('shows NO payment figure — payment is its own section', () => {
    const body = text(summaryMarkup({ salespersonName: 'Nishant' }))
    assert.ok(!/verified|awaiting|balance|₹/i.test(body))
  })

  test('a gap is marked by a class as well as by its words', () => {
    const html = summaryMarkup()
    // production, salesperson and lead source are all missing here
    assert.equal((html.match(/order-fact--amber/g) ?? []).length, 3)
    assert.ok(text(html).includes(SUMMARY_UNASSIGNED))
    assert.ok(text(html).includes(SUMMARY_NOT_SET))
  })

  test('the dot is decorative; the words carry the meaning', () => {
    assert.match(summaryMarkup(), /class="order-fact-dot"[^>]*aria-hidden="true"/)
  })

  test('the commercial column is whatever the page hands it, and nothing when it hands none', () => {
    const withMoney = summaryMarkup({}, <div>Product value ₹12,53,000</div>)
    assert.ok(text(withMoney).includes('₹12,53,000'))
    assert.ok(withMoney.includes('order-summary-commercial'))
    assert.ok(!summaryMarkup().includes('order-summary-commercial'),
      'a reader who may see no commercial figure gets no empty column')
  })

  test('the two stored totals read as label and figure', () => {
    const body = text(renderToStaticMarkup(
      <OrderCommercialTotals productValue="₹12,53,000.00" orderValue="₹15,64,090.00" />,
    ))
    assert.ok(body.includes('Product value ₹12,53,000.00'))
    assert.ok(body.includes('Order value ₹15,64,090.00'))
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

const importantDates = (over: Partial<Parameters<typeof orderImportantDates>[0]> = {}) =>
  orderImportantDates({
    status: 'running', confirmDate: '8 Sep 2026', dueDate: '30 Oct 2026', isOverdue: false,
    createdAt: '8 Sep 2026', updatedAt: '9 Sep 2026',
    ...over,
  })

describe('Important Dates', () => {
  test('draws the planning pair and the audit pair, each in its own list', () => {
    const html = renderToStaticMarkup(<OrderImportantDatesSection dates={importantDates()} />)
    const body = text(html)
    for (const s of ['Important Dates', 'Confirm date', '8 Sep 2026', 'Due date', '30 Oct 2026',
                     'Created', 'Last updated', '9 Sep 2026']) {
      assert.ok(body.includes(s), s)
    }
    assert.ok(html.includes('order-dates-primary'))
    assert.ok(html.includes('order-dates-secondary'))
  })

  test('the primary pair is marked as such, so the hierarchy is not colour alone', () => {
    const html = renderToStaticMarkup(<OrderImportantDatesSection dates={importantDates()} />)
    assert.equal((html.match(/order-date--primary/g) ?? []).length, 2)
    assert.equal((html.match(/order-date--secondary/g) ?? []).length, 2)
  })

  test('an overdue due date says so in words', () => {
    const body = text(renderToStaticMarkup(
      <OrderImportantDatesSection dates={importantDates({ isOverdue: true })} />,
    ))
    assert.ok(body.includes('Overdue'))
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
    <PaymentSummaryFigures finance={buildOrderFinancePosition(payments, orderValue)} loaded={loaded} />,
  )
}

describe('the payment summary figures', () => {
  test('states all six figures the business reads', () => {
    const body = text(paymentMarkup([payment({})], 1564090))
    assert.ok(body.includes('Order value ₹15,64,090.00'))
    assert.ok(body.includes('Verified ₹7,50,000.00'))
    assert.ok(body.includes('Awaiting verification ₹0.00'))
    assert.ok(body.includes('Received ₹7,50,000.00'))
    assert.ok(body.includes('Balance ₹8,14,090.00'))
    assert.ok(body.includes('Verified % 47.95%'))
    assert.match(paymentMarkup([payment({})], 1564090), /class="order-pay-bar"/)
  })

  test('money awaiting Finance is counted', () => {
    const body = text(paymentMarkup([
      payment({}),
      payment({ id: 'p2', status: 'pending_approval', amount: 100000, allocatedAmount: 100000, exactAmount: '100000.00', exactAllocatedAmount: '100000.00' }),
    ], 1564090))
    assert.ok(body.includes('Awaiting verification ₹1,00,000.00 1 payment with Finance'))
    assert.ok(body.includes('Received ₹8,50,000.00'))
  })

  test('draws a skeleton, not zeros, until the reads land', () => {
    const html = paymentMarkup([], 1564090, false)
    assert.match(html, /role="status"/)
    assert.ok(!text(html).includes('₹'))
  })

  test('no URL and no payment id reaches the markup', () => {
    const html = paymentMarkup([payment({})], 1564090)
    assert.ok(!/href=/.test(html))
    assert.ok(!html.includes('p1'))
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

function docRow(over: Partial<OrderDocumentRow> = {}): OrderDocumentRow {
  const id = '11111111-2222-3333-4444-555555555555'
  return {
    id: 'v1', order_id: id, version: 1, status: 'ready', attempt_count: 1,
    claimed_at: null, completed_at: '2026-08-20T10:00:00Z',
    last_error_code: null, last_error_message: null,
    excel_path: orderDocumentAttemptPath(id, 1, 1, 'xlsx'),
    pdf_path: orderDocumentAttemptPath(id, 1, 1, 'pdf'),
    excel_sha256: 'a'.repeat(64), pdf_sha256: 'b'.repeat(64),
    excel_bytes: 1000, pdf_bytes: 2000,
    created_at: '2026-08-20T09:00:00Z', updated_at: '2026-08-20T10:00:00Z',
    ...over,
  }
}

describe('the documents section, embedded in Order records', () => {
  test('is a titled section rather than a card, with every word and control intact', () => {
    const html = renderToStaticMarkup(
      <OrderDocumentsCard
        embedded
        view={buildOrderDocumentsView([docRow()])}
        canGenerate onGenerate={() => {}} generating={false}
        onDownload={() => {}} downloading={null} error={null}
      />,
    )
    assert.match(html, /<section[^>]*aria-label="Documents"/)
    assert.match(html, /<h3[^>]*>Documents<\/h3>/)
    const body = text(html)
    assert.ok(body.includes(ORDER_DOCUMENTS_TITLE))
    assert.ok(body.includes(ORDER_DOCUMENTS_EXCEL_LABEL))
    assert.ok(body.includes(ORDER_DOCUMENTS_PDF_LABEL))
    assert.ok(body.includes('Ready'))
    assert.ok(body.includes('Version 1'))
    assert.ok(!/href=/.test(html))
  })
})

// ── The commercial breakdown ──────────────────────────────────────────────────

describe('the commercial breakdown', () => {
  test('prints exactly the rows it is given, the grand total on the shared ground', () => {
    const rows: PiAmountRow[] = [
      { key: 'products', label: 'Products', value: '₹11,70,000', kind: 'amount' },
      { key: 'gst', label: 'GST 18%', value: '₹2,10,600', kind: 'amount', groupStart: true },
      { key: 'total', label: 'Grand total', value: '₹13,80,600', kind: 'amount', emphasis: 'total' },
    ] as PiAmountRow[]
    const html = renderToStaticMarkup(<OrderCommercialBreakdown rows={rows} />)
    const body = text(html)
    assert.ok(body.includes(ORDER_COMMERCIAL_TITLE))
    for (const s of ['Products', '₹11,70,000', 'GST 18%', '₹2,10,600', 'Grand total', '₹13,80,600']) assert.ok(body.includes(s), s)
    assert.equal((html.match(/order-commercial-row/g) ?? []).length, 3, 'no row is invented')
    assert.equal((html.match(/pi-commercial-grand-total/g) ?? []).length, 1)
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
