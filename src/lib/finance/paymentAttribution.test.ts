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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** What one target is attributed, under the rule, for one fixture.
 *
 *  ONE INPUT. The rule reads the active allocations naming this target and
 *  nothing else — not the payment's amount, not what it does elsewhere, and not
 *  its dormant `order_id`. `directLinkTarget` stays in the fixtures because the
 *  SQL still reads it; the application does not. */
function shareFor(f: AttributionFixture, target: string) {
  const active = f.allocations.filter(a => a.status === 'active')
  return attributeToTarget({
    paymentId: f.paymentId,
    ownActiveAllocations: active.filter(a => a.targetId === target).map(a => a.amount),
  })
}

/** The whole-payment position for a fixture, from its active allocations. */
function positionFor(f: AttributionFixture) {
  const active = f.allocations.filter(a => a.status === 'active')
  return paymentPosition({
    amount: f.amount,
    activeAllocationTotal: active.reduce((sum, a) => sum + Number(a.amount), 0).toFixed(2),
  })
}

// ── Examples A–F, verbatim from the business decision ────────────────────────

describe('the worked examples', () => {
  test('A. ₹10L with a dormant link to X and no active allocations — ZERO ALLOCATED', () => {
    // THE RULE THAT CHANGED. This used to attribute the whole payment to X
    // through the direct-link fallback. Link and Unlink are gone, allocation
    // rows are the only source of attribution, and a payment with none is
    // free money that somebody still has to allocate.
    const f = ATTRIBUTION_FIXTURES.A
    assert.equal(shareFor(f, 'ORDER_X').share, '0',
      'a dormant order_id attributes nothing')
    assert.equal(shareFor(f, 'ORDER_X').basis, 'none')

    const position = positionFor(f)
    assert.equal(position.attributed, '0')
    assert.equal(position.unallocated, L(10), 'the whole payment is free')
    assert.equal(position.state, 'unallocated')
  })

  test('B. ₹10L legacy-linked to X, ₹5L actively allocated to X', () => {
    // The legacy ₹10L must NOT be counted. Allocations are authoritative the
    // moment any exists — including when they name the same Order.
    const f = ATTRIBUTION_FIXTURES.B
    assert.equal(shareFor(f, 'ORDER_X').share, L(5))
    assert.equal(shareFor(f, 'ORDER_X').basis, 'allocation')

    const position = positionFor(f)
    assert.equal(position.attributed, L(5))
    assert.equal(position.unallocated, L(5))
    assert.equal(position.state, 'partial')
  })

  test('C. ₹10L legacy-linked to X, ₹4L actively allocated to Y', () => {
    // THE HEADLINE CASE. X gets nothing — its link is overridden — and the
    // total across Orders is ₹4L, never ₹14L.
    const f = ATTRIBUTION_FIXTURES.C
    assert.equal(shareFor(f, 'ORDER_X').share, '0')
    assert.equal(shareFor(f, 'ORDER_X').basis, 'none',
      'no allocation names X, so nothing attributes this payment to it')
    assert.equal(shareFor(f, 'ORDER_Y').share, L(4))
    assert.equal(shareFor(f, 'ORDER_Y').basis, 'allocation')

    const total = targetsOf(f).reduce((sum, t) => sum + Number(shareFor(f, t).share), 0)
    assert.equal(total, 400000)
    assert.notEqual(total, 1400000)

    const position = positionFor(f)
    assert.equal(position.unallocated, L(6))
  })

  test('D. ₹10L legacy-linked to X, ₹4L to X and ₹6L to Y', () => {
    const f = ATTRIBUTION_FIXTURES.D
    assert.equal(shareFor(f, 'ORDER_X').share, L(4))
    assert.equal(shareFor(f, 'ORDER_Y').share, L(6))

    const position = positionFor(f)
    assert.equal(position.unallocated, '0.00')
    assert.equal(position.state, 'full')
  })

  test('E. a reversed allocation is the only allocation — ZERO ALLOCATED', () => {
    // A withdrawn claim counts for nothing, which leaves no active row at all.
    // There is no fallback behind it any more, so this is A.
    const f = ATTRIBUTION_FIXTURES.E
    assert.equal(shareFor(f, 'ORDER_X').share, '0')
    assert.equal(shareFor(f, 'ORDER_X').basis, 'none')
    assert.equal(shareFor(f, 'ORDER_Y').share, '0',
      'and the reversed target gets nothing either')

    const position = positionFor(f)
    assert.equal(position.state, 'unallocated')
    assert.equal(position.unallocated, L(10))
  })

  test('F. active allocations exceeding the payment stay visible', () => {
    // The capacity trigger refuses to CREATE this and the amount guard refuses
    // to lower a payment into it, so a row here is legacy data needing a person.
    // Rounding it into 'full' would erase the only evidence.
    const f = ATTRIBUTION_FIXTURES.F
    assert.equal(shareFor(f, 'ORDER_X').share, L(15))

    const position = positionFor(f)
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
      const position = positionFor(f)

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

describe('a target is attributed its own rows and nothing else', () => {
  test('no allocation naming this target means nothing is attributed to it', () => {
    const result = attributeToTarget({ paymentId: 'p', ownActiveAllocations: [] })
    assert.equal(result.share, '0')
    assert.equal(result.basis, 'none')
  })

  test('a target with its own allocations gets exactly them', () => {
    const result = attributeToTarget({ paymentId: 'p', ownActiveAllocations: [L(3)] })
    assert.equal(result.share, L(3))
    assert.equal(result.basis, 'allocation')
  })

  test('attribution cannot be indeterminate any more', () => {
    // It used to be: the fallback needed to know whether the payment had
    // allocations ELSEWHERE, a fact a single Order cannot see, and 'null' meant
    // "withhold the fallback". With no fallback there is no such dependency —
    // a target's share is the rows naming it, which the caller has read or has
    // not. The whole-payment total is no longer an input at all.
    const source = readFileSync(join(process.cwd(), 'src/lib/finance/paymentAttribution.ts'), 'utf8')
    const fn = source.slice(source.indexOf('export function attributeToTarget'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    assert.equal(body.includes('activeAllocationTotal'), false,
      'attributeToTarget must not read the whole-payment total')
    assert.equal(body.includes('directlyLinkedToTarget'), false,
      'nor any direct linkage')
    assert.equal(source.includes("'indeterminate'"), false, 'the basis is gone')
    assert.equal(source.includes("'legacy'"), false, 'and so is the legacy basis')
  })

  test('the whole-payment position still reports unknown on an unreadable total', () => {
    // This distinction survives: paymentPosition DOES take the total, because
    // "how much of this payment is spoken for" genuinely needs it. Null still
    // means unknown and must never read as unallocated.
    const position = paymentPosition({ amount: L(10), activeAllocationTotal: null })
    assert.equal(position.state, 'unknown')
    assert.equal(position.unallocated, null)
  })
})

// ── Exactness ────────────────────────────────────────────────────────────────

describe('the arithmetic is exact to the paise', () => {
  test('shares that floats cannot add come out right', () => {
    const result = attributeToTarget({
      paymentId: 'p',
      ownActiveAllocations: ['0.10', '0.20', '0.30'],
    })
    assert.equal(result.share, '0.60')
    assert.notEqual(String(0.1 + 0.2 + 0.3), '0.6')
  })

  test('an unallocated remainder is exact', () => {
    const position = paymentPosition({
      amount: '1000.00', activeAllocationTotal: '333.33',
    })
    assert.equal(position.unallocated, '666.67')
  })

  test('a payment whose amount cannot be read never becomes zero', () => {
    const position = paymentPosition({
      amount: null, activeAllocationTotal: '100.00',
    })
    assert.equal(position.state, 'unknown')
    assert.equal(position.unallocated, null)
  })
})
