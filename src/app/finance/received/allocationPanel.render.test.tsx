/**
 * WHERE THE MONEY WENT, ACTUALLY RENDERED.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The Received Payment record answers eight questions, and two of them are
 * money: which record is this payment against, and is any of it still free.
 * Both are answered by this one panel, so both are asserted against real
 * markup rather than against the source that produces it.
 *
 * IT USED TO ANSWER THEM TWICE. Under the per-allocation list sat a second
 * pair of aggregates — "Allocated to PI Drafts —" and "Allocated to Orders
 * ₹7,50,000" — summing the very lines above them, and beside the list a badge
 * reading "Fully Allocated", which is what Allocated and Remaining already say.
 * The list and its two totals are what survived; these tests pin that the
 * totals still reconcile, which is the only reason the aggregates were ever
 * defensible.
 *
 * THE FIGURES ARE NEVER ROUND. Every fixture uses amounts that would survive
 * an off-by-a-rupee — 7,50,000 split 4,00,000 / 2,00,000 / 1,50,000 — so a
 * total computed from the wrong field could not pass by coincidence.
 *
 * Run:
 *   npx tsx --test src/app/finance/received/allocationPanel.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { AllocationPanel } from './ReceivedPaymentsView'
import {
  summarizePaymentAllocations,
  type PaymentAllocationRow,
} from '@/lib/finance/paymentAllocations'

const PAYMENT_ID    = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp'
const ORDER_A       = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_B       = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SUBMISSION_C  = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const AMOUNT = 750000

const LABELS = new Map<string, string>([
  [ORDER_A,      '0524'],
  [ORDER_B,      '0529'],
  [SUBMISSION_C, '019'],
])

function allocation(
  id: string,
  amount: string,
  target: { order?: string; submission?: string },
  createdAt: string | null = '2026-09-04T05:17:00.000Z',
): PaymentAllocationRow {
  return {
    id,
    payment_request_id: PAYMENT_ID,
    allocated_amount: amount,
    status: 'active',
    order_id: target.order ?? null,
    order_submission_id: target.submission ?? null,
    created_at: createdAt,
  }
}

/** The panel as the detail modal mounts it, for a reader who may open targets. */
function panel(
  rows: PaymentAllocationRow[],
  opts: { amount?: number; readable?: boolean; canOpen?: boolean; labels?: ReadonlyMap<string, string> } = {},
): string {
  const amount = opts.amount ?? AMOUNT
  const summary = summarizePaymentAllocations(
    [{ id: PAYMENT_ID, amount: String(amount) }],
    rows,
    {
      readable: opts.readable !== false,
      emptyIsConclusive: true,
      labels: opts.labels ?? LABELS,
    },
  ).get(PAYMENT_ID)
  assert.ok(summary, 'the fixture produced no summary')
  return renderToStaticMarkup(
    <AllocationPanel
      summary={summary}
      amount={amount}
      canOpenLinkedRecord={opts.canOpen !== false}
      onOpen={() => {}}
    />,
  )
}

/** Markup, with tags removed, so an assertion reads the WORDS on the screen. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
}

describe('one Order takes the whole payment', () => {
  const markup = panel([allocation('alloc-1', '750000', { order: ORDER_A })])

  test('the Order, the amount, and the share it took', () => {
    const words = text(markup)
    assert.ok(words.includes('Order 0524'), 'the Order is named by its display number')
    assert.ok(words.includes('₹7,50,000'), 'with the amount allocated to it')
    assert.ok(words.includes('100% allocated'), 'and what share of the payment that is')
  })

  test('Allocated and Remaining reconcile it, and Remaining is zero', () => {
    const words = text(markup)
    assert.ok(/Allocated ₹7,50,000/.test(words), 'the total of every line above')
    assert.ok(/Remaining ₹0\b/.test(words), 'and nothing left to assign')
  })

  test('the state is not ALSO stated as a badge word beside the figures', () => {
    // "Fully Allocated" is Allocated === the payment, which the two figures
    // above say exactly. The panel prints the numbers, not a second opinion.
    const words = text(markup)
    assert.ok(!words.includes('Fully allocated') && !words.includes('Fully Allocated'))
    assert.ok(!words.includes('Partly allocated'))
  })

  test('the totals are not restated as a PI/Order split', () => {
    const words = text(markup)
    assert.ok(!words.includes('Allocated to PI Drafts'))
    assert.ok(!words.includes('Allocated to Orders'))
  })
})

describe('a payment split across Orders and a PI Draft', () => {
  const markup = panel([
    allocation('alloc-1', '400000', { order: ORDER_A }),
    allocation('alloc-2', '200000', { order: ORDER_B }),
    allocation('alloc-3', '150000', { submission: SUBMISSION_C }),
  ])
  const words = text(markup)

  test('every allocation is its own row, with its own amount', () => {
    for (const [target, amount] of [
      ['Order 0524',    '₹4,00,000'],
      ['Order 0529',    '₹2,00,000'],
      ['PI Draft 019',  '₹1,50,000'],
    ]) {
      assert.ok(words.includes(target), `${target} must be listed`)
      assert.ok(words.includes(amount), `${amount} must be shown against it`)
    }
  })

  test('a PI is called a PI Draft — the words the rest of Finance uses', () => {
    assert.ok(words.includes('PI Draft 019'))
    assert.ok(!/\bPI 019\b/.test(words))
  })

  test('the three rows add up to Allocated, and Remaining is zero', () => {
    assert.ok(/Allocated ₹7,50,000/.test(words))
    assert.ok(/Remaining ₹0\b/.test(words))
  })

  test('no per-row percentage on a split — three of them explain nothing', () => {
    assert.ok(!words.includes('% allocated'))
  })
})

describe('a partly allocated payment', () => {
  const words = text(panel([allocation('alloc-1', '400000', { order: ORDER_A })]))

  test('Remaining is the figure somebody acts on, and it is exact', () => {
    assert.ok(words.includes('Order 0524') && words.includes('₹4,00,000'))
    assert.ok(/Allocated ₹4,00,000/.test(words))
    assert.ok(/Remaining ₹3,50,000/.test(words), 'the rupee-exact balance, never rounded')
  })

  test('the share it took is stated as a percentage of the payment', () => {
    assert.ok(words.includes('53% allocated'))
  })
})

describe('a payment with no allocation at all', () => {
  const words = text(panel([]))

  test('it is an empty state, and it still states the free amount', () => {
    assert.ok(words.includes('No funds from this payment have been allocated yet'))
    assert.ok(words.includes('₹7,50,000'), 'how much there is to allocate')
  })
})

describe('an over-allocated payment', () => {
  const words = text(panel([
    allocation('alloc-1', '500000', { order: ORDER_A }),
    allocation('alloc-2', '400000', { order: ORDER_B }),
  ]))

  test('it is called over, and never reads as settled', () => {
    assert.ok(/Allocated ₹9,00,000/.test(words), 'the sum of the lines, above the payment')
    assert.ok(words.includes('Over the payment by'), 'named for what it is')
    assert.ok(!words.includes('Remaining'), 'never the reassuring word')
  })

  test('KNOWN LIMITATION, unchanged by this redesign: the excess is not sized', () => {
    // summarizePaymentAllocations floors `unallocated` at zero on every state
    // from `full` upwards (paymentAllocations.ts: `comparison >= 0 ?
    // exactToString(ZERO)`), so "Over the payment by" is followed by ₹0.00
    // rather than by ₹1,50,000. That predates this work and is a FIGURE, not a
    // label — the database's capacity trigger refuses an over-allocation, so
    // the state is a guard rail rather than one anybody meets. It is pinned
    // here so the next person to look at it finds it stated rather than
    // discovering it in production.
    assert.ok(/Over the payment by ₹0\.00/.test(words))
  })
})

describe('a reader who cannot see the allocation ledger', () => {
  const markup = panel([allocation('alloc-1', '750000', { order: ORDER_A })], { readable: false })
  const words = text(markup)

  test('is told the limit of their own sight, and shown no figure', () => {
    assert.ok(words.includes('Not visible to you'))
    assert.ok(!words.includes('₹'), 'a withheld view must not print a money figure at all')
  })
})

describe('a target the reader may not open', () => {
  test('is still shown as spoken for — it loses its number, not its amount', () => {
    const words = text(panel(
      [allocation('alloc-1', '750000', { order: ORDER_A })],
      { labels: new Map() },
    ))
    assert.ok(words.includes('A Confirmed Order'), 'described rather than named')
    assert.ok(words.includes('₹7,50,000'), 'and the money is still accounted for')
    assert.ok(!words.includes(ORDER_A), 'a raw id is never rendered')
  })

  test('and is not a link, because a link with no name is a door with no sign', () => {
    const markup = panel(
      [allocation('alloc-1', '750000', { order: ORDER_A })],
      { labels: new Map() },
    )
    assert.ok(!markup.includes('<button'), 'nothing to click when nothing can be named')
  })

  test('a reader without Orders module entry gets the name but no link', () => {
    const markup = panel([allocation('alloc-1', '750000', { order: ORDER_A })], { canOpen: false })
    assert.ok(text(markup).includes('Order 0524'))
    assert.ok(!markup.includes('<button'))
  })

  test('a reader with both gets a real control back to the record', () => {
    const markup = panel([allocation('alloc-1', '750000', { order: ORDER_A })])
    assert.ok(markup.includes('<button'), 'the existing navigation, unchanged')
  })
})

describe('when the allocation was made', () => {
  test('is shown when the caller selected the column', () => {
    const words = text(panel([allocation('alloc-1', '750000', { order: ORDER_A })]))
    assert.ok(/Allocated 4 Sept? 2026/.test(words))
  })

  test('and its absence is simply nothing — no total depends on it', () => {
    const words = text(panel([allocation('alloc-1', '750000', { order: ORDER_A }, null)]))
    assert.ok(words.includes('100% allocated'), 'the share is still stated')
    assert.ok(!/Allocated 4 Sept? 2026/.test(words), 'and no empty date row is drawn')
    assert.ok(/Allocated ₹7,50,000/.test(words), 'the totals are unaffected')
  })
})

describe('a long client name and a long Order number cannot break the layout', () => {
  test('a wide display number wraps rather than pushing the amount off', () => {
    const markup = panel(
      [allocation('alloc-1', '750000', { order: ORDER_A })],
      { labels: new Map([[ORDER_A, 'ORD-2026-EXPORT-CONSIGNMENT-0000000524']]) },
    )
    assert.ok(markup.includes("word-break:break-word"), 'the name wraps')
    assert.ok(markup.includes('white-space:nowrap'), 'and the amount never splits across lines')
  })
})
