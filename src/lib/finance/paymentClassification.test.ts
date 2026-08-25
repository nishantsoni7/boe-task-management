/**
 * The canonical payment classification, over the worked examples A–O.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentClassification.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CLASSIFICATION_FIXTURES,
  CLASSIFICATION_FIXTURE_ORDER,
  type ClassificationFixture,
} from './classificationFixtures'
import {
  CLASSIFIED_PAYMENT_STATUSES,
  DEFAULT_PAYMENT_VIEW,
  PAYMENT_VIEWS,
  PAYMENT_VIEW_OPTIONS,
  classificationConservationHolds,
  classifyPayment,
  isClassifiedPaymentStatus,
  isPaymentView,
  paymentClassificationAvailable,
  paymentIsInView,
  paymentRowFigures,
  paymentVerification,
  paymentViewClauses,
  readPaymentView,
  remainderOf,
  PAYMENT_CLASSIFICATION_COLUMNS,
  type ClassifiablePayment,
} from './paymentClassification'

// ── Turning a fixture into the row the projection would return ───────────────
//
// The fixture describes ALLOCATIONS; the projection returns SUMS. Building the
// sums here is what the database's `filter (where ...)` aggregates do, and doing
// it in the test rather than in the module is deliberate: classifyPayment must
// be given the same shape a real row has, or the test proves something the
// application never runs.

function rowFor(f: ClassificationFixture): ClassifiablePayment {
  const active = f.allocations.filter(a => a.status === 'active')
  const sum = (kind: 'order' | 'submission') =>
    active.filter(a => a.targetKind === kind).reduce((total, a) => total + Number(a.amount), 0)

  return {
    id: f.paymentId,
    amount: f.amount,
    status: f.status,
    order_id: f.directLinkTarget,
    order_allocated_total: active.length ? sum('order').toFixed(2) : '0',
    pi_allocated_total: active.length ? sum('submission').toFixed(2) : '0',
    allocated_total: active.reduce((total, a) => total + Number(a.amount), 0).toFixed(2),
    active_allocation_count: active.length,
    attribution_complete: f.attributionComplete,
  }
}

/** Money compared as money, so '0' and '0.00' are the same figure. */
function assertMoney(actual: string | null, expected: string | null, message?: string) {
  if (expected === null || actual === null) {
    assert.equal(actual, expected, message)
    return
  }
  assert.equal(Number(actual).toFixed(2), Number(expected).toFixed(2), message)
}

describe('every worked example classifies exactly as the business decision says', () => {
  for (const key of CLASSIFICATION_FIXTURE_ORDER) {
    const f = CLASSIFICATION_FIXTURES[key]

    test(`${f.label} — ${f.note.split('.')[0]}`, () => {
      const c = classifyPayment(rowFor(f))

      assertMoney(c.orderLinked, f.expected.orderLinked, `${f.label}: money attributed to Orders`)
      assertMoney(c.piLinked, f.expected.piLinked, `${f.label}: money attributed to PI Drafts`)
      assertMoney(c.available, f.expected.available, `${f.label}: available balance`)
      assert.equal(c.allocationCount, f.expected.allocationCount,
        `${f.label}: a reversed allocation must not be counted`)
      assert.equal(c.verification, f.expected.verification, `${f.label}: verification state`)
      assert.equal(c.overAllocated, f.expected.overAllocated, `${f.label}: over-allocation`)
    })

    test(`${f.label} appears in exactly the right views`, () => {
      for (const view of PAYMENT_VIEWS) {
        const expected = f.expected.views.includes(view)
        assert.equal(paymentIsInView(rowFor(f), view), expected,
          `${f.label}: ${expected ? 'must' : 'must NOT'} appear in "${view}"`)
      }
    })
  }
})

describe('the four properties the classification exists for', () => {
  test('a mixed Order/PI payment appears in BOTH linked views', () => {
    const row = rowFor(CLASSIFICATION_FIXTURES.J_mixed)
    assert.ok(paymentIsInView(row, 'orders'), 'the Order half must be findable')
    assert.ok(paymentIsInView(row, 'pi_drafts'), 'the PI half must be findable')
    // The case a single-bucket classification would have to lie about.
    assert.ok(paymentIsInView(row, 'available'), 'and its remainder is still free')
  })

  test('Available includes PARTIALLY allocated money, not only untouched money', () => {
    // B has ₹5L of ₹10L allocated. A yes/no "is it allocated" badge would say
    // "yes" and hide ₹5L that still needs somebody.
    assert.ok(paymentIsInView(rowFor(CLASSIFICATION_FIXTURES.B), 'available'))
    assert.ok(paymentIsInView(rowFor(CLASSIFICATION_FIXTURES.K_unallocated), 'available'))
    // And a fully allocated one is not in it.
    assert.equal(paymentIsInView(rowFor(CLASSIFICATION_FIXTURES.D), 'available'), false)
  })

  test('an over-allocated payment stays visible and is never silently capped', () => {
    const c = classifyPayment(rowFor(CLASSIFICATION_FIXTURES.F))
    assert.equal(c.overAllocated, true)
    assertMoney(c.orderLinked, '1500000.00', 'the excess must remain visible on the row')
    // It offers nothing to allocate, floored at zero rather than negative.
    assertMoney(c.available, '0.00', 'an over-allocated payment offers no balance')
    assert.equal(paymentIsInView(rowFor(CLASSIFICATION_FIXTURES.F), 'available'), false)
  })

  test('rejected money is in no view, including All', () => {
    const row = rowFor(CLASSIFICATION_FIXTURES.M_rejected)
    for (const view of PAYMENT_VIEWS) {
      assert.equal(paymentIsInView(row, view), false, `rejected money must not appear in "${view}"`)
    }
    // Its figures are still computed truthfully, so a screen that opens it can
    // still say what happened to the money.
    assert.equal(classifyPayment(row).verification, 'rejected')
  })
})

describe('the canonical rule is not restated, it is obeyed', () => {
  test('a dormant link attributes nothing when an allocation names another Order', () => {
    // C: linked to X, allocated to Y. X must be attributed NOTHING — the ₹14L
    // defect PR #49 fixed.
    const c = classifyPayment(rowFor(CLASSIFICATION_FIXTURES.C))
    assertMoney(c.orderLinked, '400000.00', 'only the allocation counts, never the link as well')
    assertMoney(c.available, '600000.00')
  })

  test('a reversed-only allocation leaves the payment attributed to nobody', () => {
    // E. A withdrawn claim counts for nothing, and with the fallback gone there
    // is nothing behind it — so the payment is wholly available, not full.
    const c = classifyPayment(rowFor(CLASSIFICATION_FIXTURES.E))
    assertMoney(c.orderLinked, '0.00', 'a withdrawn claim attributes nothing')
    assertMoney(c.available, '1000000.00', 'and the whole payment is free again')
    assert.equal(c.allocationCount, 0)
  })

  test('NEITHER an Order NOR a PI is attributed an unallocated payment', () => {
    // The PI side never had a fallback — there is no linkage column for one.
    // The Order side had one and no longer does, so both behave alike.
    const c = classifyPayment({
      id: 'p', amount: '100.00', status: 'approved_unlinked',
      order_id: 'ORDER_X', allocated_total: '0', order_allocated_total: '0', pi_allocated_total: '0',
      active_allocation_count: 0, attribution_complete: true,
    })
    assertMoney(c.orderLinked, '0', 'a dormant order_id attributes nothing')
    assertMoney(c.piLinked, '0', 'an unallocated payment can never be attributed to a PI')
    assertMoney(c.available, '100.00', 'it is free money awaiting allocation')
    assert.equal(c.views.includes('orders'), false, 'and it is not an Order-linked payment')
  })

  test('the legacy columns cannot reach the calculation at all', () => {
    // Proved by absence in the source, so no future edit can reintroduce the
    // fallback without this failing.
    const src = readFileSync(join(process.cwd(), 'src/lib/finance/paymentClassification.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function classifyPayment'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    for (const col of ['row.order_id', 'order_request_id', 'payment_against']) {
      assert.equal(body.includes(col), false,
        `classifyPayment must not read ${col} — allocations are the only source`)
    }
  })

  test('a retired Order Request attributes nothing, so its money reads as available', () => {
    // The row a historical request-linked payment produces: order_id is null,
    // no allocations. `order_request_id` is not even an input to the rule.
    const c = classifyPayment({
      id: 'legacy-request-payment',
      amount: '750000.00',
      status: 'approved_unlinked',
      order_id: null,
      allocated_total: '0',
      order_allocated_total: '0',
      pi_allocated_total: '0',
      active_allocation_count: 0,
      attribution_complete: true,
    })
    assertMoney(c.orderLinked, '0')
    assertMoney(c.piLinked, '0')
    assertMoney(c.available, '750000.00',
      'money parked on a retired Order Request now needs a real home')
    assert.deepEqual(c.views.sort(), ['all', 'available'])
  })
})

describe('an incomplete view of the allocations withholds rather than overstates', () => {
  test('the balance is null, not the remainder of a partial sum', () => {
    const c = classifyPayment(rowFor(CLASSIFICATION_FIXTURES.O_incomplete))
    assert.equal(c.available, null,
      'telling a reader there is free money when there is not is the one error that must never happen')
    // What they CAN see is still reported: the allocation onto their own PI.
    assertMoney(c.piLinked, '200000.00')
    assert.equal(paymentIsInView(rowFor(CLASSIFICATION_FIXTURES.O_incomplete), 'available'), false)
    assert.equal(paymentIsInView(rowFor(CLASSIFICATION_FIXTURES.O_incomplete), 'pi_drafts'), true)
  })

  test('a missing completeness flag is read as NOT complete', () => {
    const c = classifyPayment({
      id: 'p', amount: '100.00', status: 'approved_unlinked', order_id: null,
      allocated_total: '0', order_allocated_total: '0', pi_allocated_total: '0',
      active_allocation_count: 0,
      // attribution_complete deliberately absent
    })
    assert.equal(c.available, null, 'absent must fail closed')
  })
})

describe('exact decimal arithmetic', () => {
  test('paise survive the split and the remainder', () => {
    const c = classifyPayment(rowFor(CLASSIFICATION_FIXTURES.N_paise))
    assertMoney(c.orderLinked, '333.34')
    assertMoney(c.piLinked, '333.33')
    // 1000.03 - 666.67 is 333.36 and nothing else. A float gives
    // 333.35999999999996.
    assert.equal(c.available, '333.36')
    assert.equal(c.attributed, '666.67')
  })

  test('conservation holds exactly, at the paisa', () => {
    for (const key of CLASSIFICATION_FIXTURE_ORDER) {
      const f = CLASSIFICATION_FIXTURES[key]
      const result = classificationConservationHolds(rowFor(f))
      if (f.expected.overAllocated) {
        assert.equal(result.reason, 'over_allocated',
          `${f.label}: an over-allocated payment must FAIL conservation visibly`)
        continue
      }
      if (f.expected.available === null) {
        assert.equal(result.reason, 'not_determinable',
          `${f.label}: a withheld balance cannot be balanced against`)
        continue
      }
      assert.ok(result.holds,
        `${f.label}: orders + pi + available must equal the payment exactly`)
    }
  })

  test('the remainder helper agrees with the classification', () => {
    const f = CLASSIFICATION_FIXTURES.J_mixed
    const c = classifyPayment(rowFor(f))
    assertMoney(remainderOf(f.amount, c.attributed), c.available)
  })
})

describe('verification is a second axis, never folded into attribution', () => {
  test('the three states, from the ledger vocabulary', () => {
    assert.equal(paymentVerification('approved_unlinked'), 'verified')
    assert.equal(paymentVerification('approved_linked'), 'verified')
    assert.equal(paymentVerification('rejected'), 'rejected')
    assert.equal(paymentVerification('pending_approval'), 'awaiting')
    assert.equal(paymentVerification('needs_clarification'), 'awaiting')
    assert.equal(paymentVerification(null), 'awaiting', 'unknown is not verified')
  })

  test('awaiting money classifies exactly like verified money', () => {
    const awaiting = classifyPayment(rowFor(CLASSIFICATION_FIXTURES.L_awaiting))
    assertMoney(awaiting.orderLinked, '100000.00')
    assertMoney(awaiting.available, '300000.00')
    assert.equal(awaiting.verification, 'awaiting',
      'and stays marked awaiting, so nothing adds it to verified money by accident')
  })

  test('the classified status scope excludes rejected and nothing else', () => {
    assert.equal(isClassifiedPaymentStatus('rejected'), false)
    for (const status of ['approved_unlinked', 'approved_linked', 'pending_approval', 'needs_clarification']) {
      assert.ok(isClassifiedPaymentStatus(status), `${status} must be classified`)
    }
    assert.equal(CLASSIFIED_PAYMENT_STATUSES.includes('rejected' as never), false)
  })
})

describe('the narrowing is the database\'s', () => {
  test('each view maps to one predicate over a projection column', () => {
    assert.deepEqual(paymentViewClauses('all'), [])
    assert.deepEqual(paymentViewClauses('orders'),
      [{ kind: 'eq', column: 'is_linked_to_order', value: 'true' }])
    assert.deepEqual(paymentViewClauses('pi_drafts'),
      [{ kind: 'eq', column: 'is_linked_to_pi', value: 'true' }])
    assert.deepEqual(paymentViewClauses('available'),
      [{ kind: 'eq', column: 'is_available_to_allocate', value: 'true' }])
  })

  test('every column the narrowing names is one the caller selects', () => {
    for (const view of PAYMENT_VIEWS) {
      for (const clause of paymentViewClauses(view)) {
        if (clause.kind === 'eq') {
          assert.ok(
            (PAYMENT_CLASSIFICATION_COLUMNS as readonly string[]).includes(clause.column),
            `${clause.column} is filtered on but never selected`)
        }
      }
    }
  })

  test('the availability probe fails closed', () => {
    assert.equal(paymentClassificationAvailable(null), false)
    assert.equal(paymentClassificationAvailable(undefined), false)
    assert.equal(paymentClassificationAvailable({ columns: [] }), false)
    assert.equal(paymentClassificationAvailable({ columns: ['is_linked_to_order'] }), false,
      'a partial column set must not enable a filter over the missing ones')
    assert.ok(paymentClassificationAvailable({ columns: [...PAYMENT_CLASSIFICATION_COLUMNS] }))
  })
})

describe('the view parameter is a URL somebody can type', () => {
  test('anything unrecognised resolves to All rather than an empty list', () => {
    assert.equal(readPaymentView(null), DEFAULT_PAYMENT_VIEW)
    assert.equal(readPaymentView(''), DEFAULT_PAYMENT_VIEW)
    assert.equal(readPaymentView('requests'), DEFAULT_PAYMENT_VIEW)
    assert.equal(readPaymentView('ORDERS'), DEFAULT_PAYMENT_VIEW, 'case-sensitive, like every other param')
    assert.equal(readPaymentView('available'), 'available')
  })

  test('the tab strip offers exactly the four views, in order', () => {
    assert.deepEqual(PAYMENT_VIEW_OPTIONS.map(o => o.value), [...PAYMENT_VIEWS])
    assert.deepEqual(PAYMENT_VIEWS, ['all', 'orders', 'pi_drafts', 'available'])
    for (const option of PAYMENT_VIEW_OPTIONS) {
      assert.ok(isPaymentView(option.value))
      assert.ok(option.description.length > 10, `${option.value} needs a description a reader can act on`)
    }
  })

  test('no view is named after the retired Order Request workflow', () => {
    const text = JSON.stringify(PAYMENT_VIEW_OPTIONS).toLowerCase()
    assert.equal(text.includes('order request'), false)
    assert.equal(text.includes('order_request'), false)
  })
})

describe('the row figures are the classification, not a second reading of it', () => {
  test('every figure a payment row prints comes from classifyPayment', () => {
    for (const key of CLASSIFICATION_FIXTURE_ORDER) {
      const row = rowFor(CLASSIFICATION_FIXTURES[key])
      const figures = paymentRowFigures(row)
      const classification = classifyPayment(row)
      assert.equal(figures.orderLinked, classification.orderLinked)
      assert.equal(figures.piLinked, classification.piLinked)
      assert.equal(figures.available, classification.available)
      assert.equal(figures.allocationCount, classification.allocationCount)
      assert.equal(figures.verification, classification.verification)
      assert.equal(figures.overAllocated, classification.overAllocated)
    }
  })
})
