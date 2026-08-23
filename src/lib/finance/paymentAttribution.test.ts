/**
 * The canonical attribution rule.
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * The old rule was "the legacy link wins": a payment carrying order_id = X was
 * credited to X AT ITS FULL AMOUNT, whatever its allocations said. Both can
 * exist — allocate_payment_to_target() does not refuse a payment that already
 * carries an order_id — so a ₹10,00,000 payment linked to X and allocated
 * ₹4,00,000 to Y was credited ₹10,00,000 to X *and* ₹4,00,000 to Y:
 * ₹14,00,000 of attribution for ₹10,00,000 of money, with the overstatement
 * landing on the Order that had received nothing.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * Examples A–F from the business decision, verbatim, plus the conservation
 * invariant they exist to protect:
 *
 *     attributed across every target + unallocated === payment amount
 *
 * The SAME fixtures are executed against the SQL in
 * supabase/tests/payment_attribution_assertions.sql, and
 * attributionParity.test.ts requires the two to agree figure for figure.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentAttribution.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  attributeToTarget,
  conservationHolds,
  paymentPosition,
} from './paymentAttribution'
import { ATTRIBUTION_FIXTURES, type AttributionFixture } from './attributionFixtures'

const L = (lakh: number) => (lakh * 100000).toFixed(2)

/** Every target named by a fixture, in a stable order. */
function targetsOf(f: AttributionFixture): string[] {
  const seen = new Set<string>()
  if (f.directLinkTarget) seen.add(f.directLinkTarget)
  for (const a of f.allocations) seen.add(a.targetId)
  return [...seen].sort()
}

/** What one target is attributed, under the rule, for one fixture. */
function shareFor(f: AttributionFixture, target: string) {
  const active = f.allocations.filter(a => a.status === 'active')
  return attributeToTarget({
    paymentId: f.paymentId,
    amount: f.amount,
    // The whole-payment fact, as the database supplies it.
    activeAllocationTotal: active
      .reduce((sum, a) => sum + Number(a.amount), 0)
      .toFixed(2),
    ownActiveAllocations: active.filter(a => a.targetId === target).map(a => a.amount),
    directlyLinkedToTarget: f.directLinkTarget === target,
  })
}

// ── Examples A–F, verbatim from the business decision ────────────────────────

describe('the worked examples', () => {
  test('A. ₹10L legacy-linked to X, no active allocations', () => {
    const f = ATTRIBUTION_FIXTURES.A
    assert.equal(shareFor(f, 'ORDER_X').share, L(10))
    assert.equal(shareFor(f, 'ORDER_X').basis, 'legacy')

    const position = paymentPosition({
      amount: f.amount, activeAllocationTotal: '0.00', hasDirectLink: true,
    })
    // Fully attributed by the fallback, so NOTHING is free. Reporting ₹10L as
    // unallocated would put committed money into Finance's suspense queue.
    assert.equal(position.unallocated, '0')
    assert.equal(position.state, 'full')
  })

  test('B. ₹10L legacy-linked to X, ₹5L actively allocated to X', () => {
    // The legacy ₹10L must NOT be counted. Allocations are authoritative the
    // moment any exists — including when they name the same Order.
    const f = ATTRIBUTION_FIXTURES.B
    assert.equal(shareFor(f, 'ORDER_X').share, L(5))
    assert.equal(shareFor(f, 'ORDER_X').basis, 'allocation')

    const position = paymentPosition({
      amount: f.amount, activeAllocationTotal: L(5), hasDirectLink: true,
    })
    assert.equal(position.attributed, L(5))
    assert.equal(position.unallocated, L(5))
    assert.equal(position.state, 'partial')
  })

  test('C. ₹10L legacy-linked to X, ₹4L actively allocated to Y', () => {
    // THE HEADLINE CASE. X gets nothing — its link is overridden — and the
    // total across Orders is ₹4L, never ₹14L.
    const f = ATTRIBUTION_FIXTURES.C
    assert.equal(shareFor(f, 'ORDER_X').share, '0')
    assert.equal(shareFor(f, 'ORDER_X').basis, 'allocation')
    assert.equal(shareFor(f, 'ORDER_Y').share, L(4))

    const total = targetsOf(f).reduce((sum, t) => sum + Number(shareFor(f, t).share), 0)
    assert.equal(total, 400000)
    assert.notEqual(total, 1400000)

    const position = paymentPosition({
      amount: f.amount, activeAllocationTotal: L(4), hasDirectLink: true,
    })
    assert.equal(position.unallocated, L(6))
  })

  test('D. ₹10L legacy-linked to X, ₹4L to X and ₹6L to Y', () => {
    const f = ATTRIBUTION_FIXTURES.D
    assert.equal(shareFor(f, 'ORDER_X').share, L(4))
    assert.equal(shareFor(f, 'ORDER_Y').share, L(6))

    const position = paymentPosition({
      amount: f.amount, activeAllocationTotal: L(10), hasDirectLink: true,
    })
    assert.equal(position.unallocated, '0.00')
    assert.equal(position.state, 'full')
  })

  test('E. a reversed allocation is the only allocation — the fallback applies', () => {
    const f = ATTRIBUTION_FIXTURES.E
    assert.equal(shareFor(f, 'ORDER_X').share, L(10))
    assert.equal(shareFor(f, 'ORDER_X').basis, 'legacy',
      'a withdrawn claim must not suppress the direct linkage')

    const position = paymentPosition({
      amount: f.amount, activeAllocationTotal: '0.00', hasDirectLink: true,
    })
    assert.equal(position.state, 'full')
    assert.equal(position.unallocated, '0')
  })

  test('F. active allocations exceeding the payment stay visible', () => {
    // The capacity trigger refuses to CREATE this and the amount guard refuses
    // to lower a payment into it, so a row here is legacy data needing a person.
    // Rounding it into 'full' would erase the only evidence.
    const f = ATTRIBUTION_FIXTURES.F
    assert.equal(shareFor(f, 'ORDER_X').share, L(15))

    const position = paymentPosition({
      amount: f.amount, activeAllocationTotal: L(15), hasDirectLink: false,
    })
    assert.equal(position.state, 'over')
    assert.equal(position.attributed, L(15))
    // Not negative, and not silently rebalanced.
    assert.equal(position.unallocated, '0.00')
  })
})

// ── The conservation invariant ───────────────────────────────────────────────

describe('conservation: attribution + unallocated === the payment', () => {
  for (const [name, f] of Object.entries(ATTRIBUTION_FIXTURES)) {
    test(`${name} conserves the payment amount exactly`, () => {
      const active = f.allocations.filter(a => a.status === 'active')
      const activeTotal = active.reduce((s, a) => s + Number(a.amount), 0).toFixed(2)
      const position = paymentPosition({
        amount: f.amount,
        activeAllocationTotal: activeTotal,
        hasDirectLink: f.directLinkTarget !== null,
      })

      // Every target's share must sum to what the position calls attributed.
      const summed = targetsOf(f).reduce((s, t) => s + Number(shareFor(f, t).share), 0)
      assert.equal(summed.toFixed(2), Number(position.attributed).toFixed(2),
        `${name}: per-target shares must sum to the attributed total`)

      const check = conservationHolds({ amount: f.amount, position })
      if (f.overAllocated) {
        // F alone. It is REPORTED as breaking the law, not quietly balanced.
        assert.equal(check.holds, false)
        assert.equal(check.reason, 'over_allocated')
        assert.ok(summed > Number(f.amount),
          'the over-allocation must remain visible as an excess')
      } else {
        assert.equal(check.holds, true, `${name}: ${check.reason}`)
        assert.equal(
          (Number(position.attributed) + Number(position.unallocated)).toFixed(2),
          Number(f.amount).toFixed(2))
      }
    })
  }

  test('and no fixture ever attributes more than the payment, except F', () => {
    // Rule 6, stated directly.
    for (const [name, f] of Object.entries(ATTRIBUTION_FIXTURES)) {
      const summed = targetsOf(f).reduce((s, t) => s + Number(shareFor(f, t).share), 0)
      if (f.overAllocated) continue
      assert.ok(summed <= Number(f.amount),
        `${name}: attributed ${summed} exceeds the payment ${f.amount}`)
    }
  })
})

// ── The safety property when the whole-payment total is unknown ──────────────

describe('an unknown allocation total withholds the fallback', () => {
  test('a directly linked payment attributes nothing rather than everything', () => {
    // The failure that matters is "this Order has been paid in full" when it has
    // not. Under-stating is recoverable; over-stating is what let ₹14L of
    // attribution exist for ₹10L of money.
    const result = attributeToTarget({
      paymentId: 'p', amount: L(10),
      activeAllocationTotal: null,
      ownActiveAllocations: [],
      directlyLinkedToTarget: true,
    })
    assert.equal(result.share, '0')
    assert.equal(result.basis, 'indeterminate')
  })

  test('but a target with its own allocations still gets them', () => {
    // Its own share is provable from its own read, whatever is unknown
    // elsewhere.
    const result = attributeToTarget({
      paymentId: 'p', amount: L(10),
      activeAllocationTotal: null,
      ownActiveAllocations: [L(3)],
      directlyLinkedToTarget: true,
    })
    assert.equal(result.share, L(3))
    assert.equal(result.basis, 'allocation')
  })

  test('and the position reports unknown rather than unallocated', () => {
    const position = paymentPosition({
      amount: L(10), activeAllocationTotal: null, hasDirectLink: true,
    })
    assert.equal(position.state, 'unknown')
    assert.equal(position.unallocated, null)
  })
})

// ── Exactness ────────────────────────────────────────────────────────────────

describe('the arithmetic is exact to the paise', () => {
  test('shares that floats cannot add come out right', () => {
    const result = attributeToTarget({
      paymentId: 'p', amount: '0.60',
      activeAllocationTotal: '0.60',
      ownActiveAllocations: ['0.10', '0.20', '0.30'],
      directlyLinkedToTarget: false,
    })
    assert.equal(result.share, '0.60')
    assert.notEqual(String(0.1 + 0.2 + 0.3), '0.6')
  })

  test('an unallocated remainder is exact', () => {
    const position = paymentPosition({
      amount: '1000.00', activeAllocationTotal: '333.33', hasDirectLink: false,
    })
    assert.equal(position.unallocated, '666.67')
  })

  test('a payment whose amount cannot be read never becomes zero', () => {
    const position = paymentPosition({
      amount: null, activeAllocationTotal: '100.00', hasDirectLink: false,
    })
    assert.equal(position.state, 'unknown')
    assert.equal(position.unallocated, null)
  })
})
