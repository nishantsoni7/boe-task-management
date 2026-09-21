/**
 * ADVANCE RECEIVED — the figure, the threshold, and what is excluded from both.
 *
 * THE FIGURE IS NOT COMPUTED HERE and these prove it: every case below builds a
 * real OrderFinancePosition through buildOrderFinancePosition and withExactAmounts
 * — the same path Finance uses — and asserts that the card reports what that
 * produced. A second arithmetic path is exactly what would let this screen and
 * the Finance module print different percentages for the same payments.
 *
 * Pure functions. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderAdvance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ADVANCE_NOT_AVAILABLE,
  ADVANCE_RISKY_LABEL,
  ADVANCE_SAFE_LABEL,
  ADVANCE_SAFE_THRESHOLD_PERCENT,
  advanceStanding,
  classifyAdvance,
} from './orderAdvance'
import {
  buildOrderFinancePosition,
  withExactAmounts,
  type OrderFinancePaymentRow,
} from '@/lib/finance/orderFinancePosition'
import { formatMoney, formatPercent } from '@/lib/finance/piPaymentView'

type Row = {
  id: string
  amount: number
  status: string
  /** How much of it an ACTIVE allocation gives this Order. Null = none. */
  allocatedToThisOrder: number | null
}

/**
 * A finance position built the way the page builds it.
 *
 * A payment with no allocation to this Order still appears in the list — that
 * is the legacy direct-link case — and attributeToTarget gives it a zero share,
 * which is the canonical rule. Nothing here bypasses it.
 */
function position(rows: Row[], orderValue: number | null) {
  const merged = rows.map(r => ({
    id: r.id, client_name: 'Kalyan', amount: r.amount,
    payment_date: '2026-09-09', payment_mode: 'neft', order_number: '0524',
    status: r.status,
    allocatedAmount: r.allocatedToThisOrder ?? 0,
    source: r.allocatedToThisOrder === null ? 'linked' : 'allocation',
  }))
  const allocations = rows
    .filter(r => r.allocatedToThisOrder !== null)
    .map(r => ({
      allocated_amount: r.allocatedToThisOrder,
      payment: { id: r.id, amount: r.amount },
    }))
  const exact = withExactAmounts(
    merged as unknown as readonly OrderFinancePaymentRow[],
    {
      linked: rows.filter(r => r.allocatedToThisOrder === null).map(r => ({ id: r.id, amount: r.amount })),
      allocations,
      allocationTotals: new Map(rows.map(r => [r.id, r.allocatedToThisOrder ?? 0])),
    } as never,
  )
  return buildOrderFinancePosition(exact, orderValue)
}

const standing = (rows: Row[], orderValue: number | null) =>
  advanceStanding({ finance: position(rows, orderValue), formatAmount: formatMoney, formatPercent })

const verified = (id: string, amount: number, allocated: number | null = amount): Row =>
  ({ id, amount, status: 'approved_linked', allocatedToThisOrder: allocated })

// ── The figure ────────────────────────────────────────────────────────────────

describe('what counts toward the advance', () => {
  test('NO PAYMENTS: nothing received, and the percentage is a real zero', () => {
    const s = standing([], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(0))
    assert.equal(s.percent, '0.00')
    assert.equal(s.classification?.label, ADVANCE_RISKY_LABEL)
  })

  test('a VERIFIED, ALLOCATED payment counts in full', () => {
    const s = standing([verified('p1', 500000)], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(500000))
    assert.equal(s.percent, '50.00')
  })

  test('A PENDING PAYMENT IS EXCLUDED — Finance has not said it arrived', () => {
    const s = standing([
      verified('p1', 350000),
      { id: 'p2', amount: 400000, status: 'pending_approval', allocatedToThisOrder: 400000 },
    ], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(350000))
    assert.equal(s.percent, '35.00')
  })

  test('a payment in CLARIFICATION is excluded for the same reason', () => {
    const s = standing([
      verified('p1', 500000),
      { id: 'p2', amount: 400000, status: 'needs_clarification', allocatedToThisOrder: 400000 },
    ], 1000000)
    assert.equal(s.percent, '50.00')
  })

  test('A REJECTED PAYMENT IS EXCLUDED', () => {
    const s = standing([
      verified('p1', 500000),
      { id: 'p2', amount: 900000, status: 'rejected', allocatedToThisOrder: 900000 },
    ], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(500000))
    assert.equal(s.percent, '50.00')
  })

  test('A VERIFIED BUT UNALLOCATED PAYMENT IS EXCLUDED', () => {
    // It reached the list through the legacy order_id link and no allocation
    // stands behind it, so the canonical rule attributes it zero.
    const s = standing([verified('p1', 900000, null)], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(0))
    assert.equal(s.percent, '0.00')
  })

  test('MONEY ALLOCATED SOMEWHERE ELSE IS EXCLUDED, and only this share counts', () => {
    // A ₹9,00,000 payment of which ₹3,00,000 is allocated here.
    const s = standing([verified('p1', 900000, 300000)], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(300000))
    assert.equal(s.percent, '30.00')
  })

  test('several verified allocations are SUMMED', () => {
    const s = standing([
      verified('p1', 200000), verified('p2', 150000), verified('p3', 50000),
    ], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(400000))
    assert.equal(s.percent, '40.00')
  })

  test('the denominator is the FINAL ORDER VALUE, not the product value', () => {
    // 4,00,000 of an Order worth 10,00,000 is 40%. If the product subtotal
    // (say 8,00,000) were used it would read 50%.
    const s = standing([verified('p1', 400000)], 1000000)
    assert.equal(s.percent, '40.00')
    assert.equal(s.orderValue, formatMoney(1000000))
  })
})

// ── The threshold ─────────────────────────────────────────────────────────────

describe('Risky and Safe', () => {
  test('the line is 35, and the boundary belongs to the cautious side', () => {
    assert.equal(ADVANCE_SAFE_THRESHOLD_PERCENT, 35)
  })

  test('EXACTLY 35.00% IS RISKY', () => {
    const s = standing([verified('p1', 350000)], 1000000)
    assert.equal(s.percent, '35.00')
    assert.equal(s.classification?.label, ADVANCE_RISKY_LABEL)
    assert.equal(s.classification?.tone, 'red')
    assert.equal(s.classification?.safe, false)
  })

  test('35.01% IS SAFE', () => {
    const s = standing([verified('p1', 350100)], 1000000)
    assert.equal(s.percent, '35.01')
    assert.equal(s.classification?.label, ADVANCE_SAFE_LABEL)
    assert.equal(s.classification?.tone, 'green')
    assert.equal(s.classification?.safe, true)
  })

  test('34.99% is Risky', () => {
    const s = standing([verified('p1', 349900)], 1000000)
    assert.equal(s.classification?.label, ADVANCE_RISKY_LABEL)
  })

  test('the boundary is read straight off the percentage, either side of it', () => {
    for (const [percent, label] of [
      ['0', ADVANCE_RISKY_LABEL], ['34.999', ADVANCE_RISKY_LABEL],
      ['35', ADVANCE_RISKY_LABEL], ['35.0', ADVANCE_RISKY_LABEL],
      ['35.001', ADVANCE_SAFE_LABEL], ['40', ADVANCE_SAFE_LABEL],
      ['100', ADVANCE_SAFE_LABEL],
    ] as const) {
      assert.equal(classifyAdvance(percent)?.label, label, percent)
    }
  })
})

// ── The edges ─────────────────────────────────────────────────────────────────

describe('the figures that cannot be derived', () => {
  test('A ZERO ORDER VALUE DIVIDES BY NOTHING: `Not available`, not 0%', () => {
    const s = standing([verified('p1', 100000)], 0)
    assert.equal(s.percent, null)
    assert.equal(s.percentLabel, ADVANCE_NOT_AVAILABLE)
    assert.equal(s.classification, null, 'and no Risky/Safe claim is made')
  })

  test('an Order with NO value says the same, and still states what was received', () => {
    const s = standing([verified('p1', 100000)], null)
    assert.equal(s.percentLabel, ADVANCE_NOT_AVAILABLE)
    assert.equal(s.orderValue, null)
    assert.equal(s.verifiedAmount, formatMoney(100000))
  })

  test('the note says WHY a percentage is missing rather than leaving a blank', () => {
    assert.match(standing([], 0).note, /no value/i)
    assert.match(standing([verified('p1', 1)], 1000).note, /verified/i)
  })

  test('a non-numeric percentage is classified as nothing', () => {
    for (const bad of ['', 'n/a', 'NaN']) assert.equal(classifyAdvance(bad), null, bad)
    assert.equal(classifyAdvance(null), null)
  })
})

describe('a genuine overpayment', () => {
  test('IS NOT CAPPED AT 100% — the real figure is the one that matters', () => {
    const s = standing([verified('p1', 1200000)], 1000000)
    assert.equal(s.percent, '120.00')
    assert.equal(s.percentLabel, formatPercent('120.00'))
    assert.equal(s.classification?.label, ADVANCE_SAFE_LABEL)
  })

  test('and the received amount is the real one too', () => {
    const s = standing([verified('p1', 1200000)], 1000000)
    assert.equal(s.verifiedAmount, formatMoney(1200000))
  })
})

// ── What this indicator must not be mistaken for ──────────────────────────────

describe('the 35% line is an indicator, not the confirmation gate', () => {
  test('this module states no opinion about approving a PI', () => {
    // Comments stripped: this module DOCUMENTS at length that it is not the
    // confirmation gate, and a raw search would match the sentences saying so.
    const code = readFileSync('src/lib/orders/orderAdvance.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    for (const forbidden of ['approve_order_submission', 'PI_ADVANCE_PERCENT',
                             'advance_exception', 'computeRequiredAdvance']) {
      assert.equal(code.includes(forbidden), false,
        forbidden + ' must not be referenced by the indicator')
    }
    // And it holds its own threshold rather than borrowing the gate's 40.
    assert.ok(code.includes('ADVANCE_SAFE_THRESHOLD_PERCENT = 35'))
  })
})
