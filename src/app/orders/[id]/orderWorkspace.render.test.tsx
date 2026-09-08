/**
 * The Confirmed Order workspace pieces, rendered: the attention bar, the health
 * card, the payment position, the overflow menu and the loading shell.
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
  ORDER_HEALTH_TITLE,
  OrderActivityList,
  OrderAttentionBar,
  OrderDetailSkeleton,
  OrderHealthCard,
  PAYMENT_POSITION_TITLE,
  PaymentPositionCard,
  VIEW_PAYMENT_DETAILS_LABEL,
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
  HEALTH_PAYMENT_LOADING,
  orderAttentionItems,
  orderHealthRows,
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
      status: 'running', productionAligned: false, hasAssignee: false, hasDueDate: false,
      isOverdue: false, awaitingVerificationCount: 0, pendingChangeRequests: 0,
      pendingPiRevision: false, documentsFailed: false, documentsOutdated: false,
    })
    const html = renderToStaticMarkup(<OrderAttentionBar items={items} />)
    const body = text(html)
    assert.ok(body.includes('3 items need attention'))
    assert.ok(body.includes('Production not aligned'))
    assert.ok(body.includes('No assignee'))
    assert.ok(body.includes('Due date not set'))
    assert.match(html, /<ul/, 'a list, so a screen reader counts it')
    assert.match(html, /aria-label="3 items need attention"/)
    assert.match(html, /aria-hidden="true"/, 'the icon is decorative')
  })

  test('the overdue item is marked by a class as well as by its words', () => {
    const items = orderAttentionItems({
      status: 'running', productionAligned: true, hasAssignee: true, hasDueDate: true,
      isOverdue: true, awaitingVerificationCount: 0, pendingChangeRequests: 0,
      pendingPiRevision: false, documentsFailed: false, documentsOutdated: false,
    })
    const html = renderToStaticMarkup(<OrderAttentionBar items={items} />)
    assert.ok(html.includes('order-attention-item--red'))
    assert.ok(text(html).includes('Due date has passed'))
  })
})

// ── The health card ───────────────────────────────────────────────────────────

const rows = (over: Partial<Parameters<typeof orderHealthRows>[0]> = {}) => orderHealthRows({
  status: 'running', statusLabel: 'Running', statusTone: 'blue',
  verifiedPercent: '47.95%', verified: '₹7,50,000.00', orderValue: '₹15,64,090.00',
  fullyPaid: false, paymentCount: 2, paymentsLoaded: true,
  productionAligned: false, productionLabel: 'Not Aligned', productionLine: null,
  dueDate: null, isOverdue: false, ownerName: null, confirmedDate: '8 Sep 2026',
  ...over,
})

describe('the health card', () => {
  test('is a definition list of the six lines, headed Order health', () => {
    const html = renderToStaticMarkup(<OrderHealthCard rows={rows()} />)
    const body = text(html)
    assert.ok(body.includes(ORDER_HEALTH_TITLE))
    assert.match(html, /<dl/)
    assert.equal((html.match(/<dt/g) ?? []).length, 6)
    for (const word of ['Running', '47.95% verified', '₹7,50,000.00 of ₹15,64,090.00', 'Not Aligned', 'Not set', 'Unassigned', '8 Sep 2026']) {
      assert.ok(body.includes(word), word)
    }
  })

  test('every tone is also a word, never a colour alone', () => {
    // The dot is decorative; the value beside it carries the meaning.
    const html = renderToStaticMarkup(<OrderHealthCard rows={rows({ isOverdue: true, dueDate: '1 Sep 2026' })} />)
    assert.match(html, /class="order-health-dot"[^>]*aria-hidden="true"/)
    assert.ok(text(html).includes('Overdue'))
  })

  test('only a warning row is marked; ordinary rows stay quiet', () => {
    const html = renderToStaticMarkup(<OrderHealthCard rows={rows()} />)
    // production, due date and owner are gaps; status, payment and confirmed are not
    assert.equal((html.match(/order-health-row--amber/g) ?? []).length, 3)
    assert.equal((html.match(/order-health-row--red/g) ?? []).length, 0)
    const settled = renderToStaticMarkup(<OrderHealthCard rows={rows({
      productionAligned: true, productionLabel: 'Aligned', dueDate: '30 Oct 2026', ownerName: 'Nishant',
    })} />)
    assert.ok(!settled.includes('order-health-row--'))
  })

  test('says Loading… while the payment reads are in flight, and never a zero', () => {
    const html = renderToStaticMarkup(<OrderHealthCard rows={rows({ paymentsLoaded: false, paymentCount: 0 })} />)
    assert.ok(text(html).includes(HEALTH_PAYMENT_LOADING))
    assert.ok(!text(html).includes('No payments recorded'))
  })
})

// ── The payment position ──────────────────────────────────────────────────────

const payment = (over: Partial<OrderFinancePaymentRow>): OrderFinancePaymentRow => ({
  id: over.id ?? 'p1',
  client_name: 'Vittaazio', amount: 750000, payment_date: '2026-09-01', payment_mode: 'hdfc',
  order_number: '0524', status: 'approved_linked',
  allocatedAmount: 750000, source: 'allocation',
  exactAmount: '750000.00', exactAllocatedAmount: '750000.00',
  isPartialShare: false, attributionBasis: 'allocation',
  ...over,
} as OrderFinancePaymentRow)

function positionMarkup(payments: OrderFinancePaymentRow[], orderValue: number | null, loaded = true) {
  return renderToStaticMarkup(
    <PaymentPositionCard
      finance={buildOrderFinancePosition(payments, orderValue)}
      loaded={loaded}
      onViewDetails={() => {}}
    />,
  )
}

describe('the payment position', () => {
  test('leads with the verified money, the percentage beside its bar, then what it is measured against', () => {
    const html = positionMarkup([payment({})], 1564090)
    const body = text(html)
    assert.ok(body.includes(PAYMENT_POSITION_TITLE))
    assert.ok(body.includes('₹7,50,000.00 Verified'))
    assert.ok(body.includes('47.95%'))
    assert.ok(body.includes('of ₹15,64,090.00 order value'))
    assert.ok(body.includes('Remaining ₹8,14,090.00'))
    assert.ok(body.includes('Awaiting verification ₹0.00'))
    assert.ok(body.includes('Received ₹7,50,000.00'))
    assert.ok(body.includes('1 payment'))
    assert.ok(body.includes(VIEW_PAYMENT_DETAILS_LABEL))
    // Reading order: the amount, then the percentage, then the order value.
    assert.ok(body.indexOf('₹7,50,000.00') < body.indexOf('47.95%'))
    assert.ok(body.indexOf('47.95%') < body.indexOf('order value'))
    assert.match(html, /class="order-pay-bar"/, 'the bar is drawn')
  })

  test('money awaiting Finance is stated with its count', () => {
    const body = text(positionMarkup([
      payment({}),
      payment({ id: 'p2', status: 'pending_approval', amount: 100000, allocatedAmount: 100000, exactAmount: '100000.00', exactAllocatedAmount: '100000.00' }),
    ], 1564090))
    assert.ok(body.includes('Awaiting verification ₹1,00,000.00 1 with Finance'))
    assert.ok(body.includes('Received ₹8,50,000.00'))
  })

  test('an Order with no payments says so', () => {
    const html = positionMarkup([], 1564090)
    assert.ok(text(html).includes('No payments'))
    assert.ok(text(html).includes('₹0.00 Verified'))
    assert.ok(text(html).includes('Remaining ₹15,64,090.00'))
  })

  test('an Order with no value states that rather than a percentage', () => {
    const body = text(positionMarkup([payment({})], null))
    assert.ok(body.includes('Order value not recorded'))
    assert.ok(!body.includes('%'))
    assert.ok(!body.includes('Remaining'))
  })

  test('draws a skeleton, not zeros, until the reads land', () => {
    const html = positionMarkup([], 1564090, false)
    assert.match(html, /role="status"/)
    assert.ok(!text(html).includes('₹'))
  })

  test('no URL and no identifier reaches the markup', () => {
    const html = positionMarkup([payment({})], 1564090)
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
    assert.match(html, /<section[^>]*aria-label="Order documents"/)
    assert.match(html, /<h3[^>]*>Order documents<\/h3>/)
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
    assert.ok(html.includes('order-workspace-main'))
    assert.ok(html.includes('order-workspace-aside'))
    assert.ok(!/\d/.test(text(html)), 'no figure is invented while loading')
  })
})
