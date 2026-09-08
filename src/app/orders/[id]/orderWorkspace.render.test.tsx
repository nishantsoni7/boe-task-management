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
  MoreActionsMenu,
  ORDER_HEALTH_TITLE,
  OrderAttentionBar,
  OrderDetailSkeleton,
  OrderHealthCard,
  PAYMENT_POSITION_TITLE,
  PaymentPositionCard,
  VIEW_PAYMENT_DETAILS_LABEL,
} from './OrderWorkspace'
import {
  HEALTH_PAYMENT_LOADING,
  orderAttentionItems,
  orderHealthRows,
} from '@/lib/orders/orderWorkspace'
import { buildOrderFinancePosition, type OrderFinancePaymentRow } from '@/lib/finance/orderFinancePosition'

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
  test('leads with the verified money, then what it is measured against', () => {
    const html = positionMarkup([payment({})], 1564090)
    const body = text(html)
    assert.ok(body.includes(PAYMENT_POSITION_TITLE))
    assert.ok(body.includes('₹7,50,000.00 verified'))
    assert.ok(body.includes('of ₹15,64,090.00 · 47.95%'))
    assert.ok(body.includes('Remaining ₹8,14,090.00'))
    assert.ok(body.includes('Awaiting verification ₹0.00'))
    assert.ok(body.includes('1 payment'))
    assert.ok(body.includes(VIEW_PAYMENT_DETAILS_LABEL))
  })

  test('money awaiting Finance is stated with its count', () => {
    const body = text(positionMarkup([
      payment({}),
      payment({ id: 'p2', status: 'pending_approval', amount: 100000, allocatedAmount: 100000, exactAmount: '100000.00', exactAllocatedAmount: '100000.00' }),
    ], 1564090))
    assert.ok(body.includes('Awaiting verification ₹1,00,000.00 · 1 with Finance'))
    assert.ok(body.includes('Received ₹8,50,000.00'))
  })

  test('an Order with no payments says so and shows no bar', () => {
    const html = positionMarkup([], 1564090)
    assert.ok(text(html).includes('No payments'))
    assert.ok(text(html).includes('₹0.00 verified'))
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
