/**
 * Who sees what on the payments surface — and, above all, what nobody sees.
 *
 * THE TWO FAILURES THIS FILE EXISTS TO PREVENT
 * -------------------------------------------
 *
 * 1. OVERSTATING FREE MONEY. `available_balance` is derived from the total of
 *    EVERY active allocation against a payment, and a reader may be entitled to
 *    see the payment while entitled to only some of its allocations. Their sum
 *    understates the attribution, which OVERSTATES the balance — and somebody
 *    acting on that number allocates the same rupees twice. So the balance is
 *    withheld, never guessed, unless the reader's sight is complete.
 *
 * 2. LEAKING A RECORD THROUGH A LINK, A LABEL OR A COUNT. A payment split with
 *    somebody else's Order must tell its owner that it is split — it is their
 *    money — without telling them whose business the other share is. A
 *    destination the reader may not open is named by its KIND and nothing else:
 *    no number, no id, no client, no door.
 *
 * The six readers below are the real ones the two modules produce, and each is
 * expressed as what RLS would return for them rather than as a role name — which
 * is the only honest way to state it, because RLS is what actually decides.
 *
 * Pure data-in/data-out. No DB, no network.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentSurfaceAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { classifyPayment, paymentIsInView, type ClassifiablePayment } from './paymentClassification'
import { paymentLinks, linkCounts, unnamedLabel, directOrderOf } from './paymentLinks'
import type { PaymentAllocationSummary } from './paymentAllocations'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import type { EffectivePermission } from '@/lib/permissions/types'

const allow = (...keys: string[]): EffectivePermission[] =>
  keys.map(actionKey => ({ actionKey, allowed: true, source: 'employee_override' as const }))

// ── The payment every reader below is looking at ──────────────────────────────
//
// ONE payment of ₹10,00,000, split ₹3L to an Order and ₹4.5L to a PI Draft, with
// ₹2.5L still free. Every difference in what the six readers see is a difference
// in THEIR entitlement, never in the data.

const ORDER_ID = 'order-1'
const PI_ID = 'sub-1'

const ORDER_ALLOCATION = {
  allocationId: 'a1', kind: 'order' as const, targetId: ORDER_ID, label: null, amount: '300000.00',
}
const PI_ALLOCATION = {
  allocationId: 'a2', kind: 'submission' as const, targetId: PI_ID, label: null, amount: '450000.00',
}

function summaryOf(targets: PaymentAllocationSummary['targets']): PaymentAllocationSummary {
  return { paymentId: 'p1', state: 'partial', allocated: null, unallocated: null, targets }
}

/**
 * The projection row THIS reader would receive.
 *
 * The sums are what their RLS lets them add up, and `attribution_complete` is
 * the projection's own statement about them — company-wide Finance sight, or
 * their own submitted payment. Everything else is identical.
 */
function rowFor(reader: {
  visibleAllocations: readonly { kind: 'order' | 'submission'; amount: string }[]
  attributionComplete: boolean
}): ClassifiablePayment {
  const sum = (kind: 'order' | 'submission') =>
    reader.visibleAllocations.filter(a => a.kind === kind)
      .reduce((total, a) => total + Number(a.amount), 0).toFixed(2)
  return {
    id: 'p1',
    amount: '1000000.00',
    status: 'approved_unlinked',
    order_id: null,
    order_allocated_total: sum('order'),
    pi_allocated_total: sum('submission'),
    allocated_total: reader.visibleAllocations
      .reduce((total, a) => total + Number(a.amount), 0).toFixed(2),
    active_allocation_count: reader.visibleAllocations.length,
    attribution_complete: reader.attributionComplete,
  }
}

const BOTH_VISIBLE = [
  { kind: 'order' as const, amount: '300000.00' },
  { kind: 'submission' as const, amount: '450000.00' },
]

// ══ 1. The balance is stated only where it can be trusted ═════════════════════

describe('who may be told what is available', () => {
  test('an ADMIN sees the whole split and the true balance', () => {
    const caps = deriveFinanceCapabilities('admin', [])
    assert.equal(caps.canViewAllFinance, true)
    const c = classifyPayment(rowFor({ visibleAllocations: BOTH_VISIBLE, attributionComplete: true }))
    assert.equal(Number(c.orderLinked), 300000)
    assert.equal(Number(c.piLinked), 450000)
    assert.equal(Number(c.available), 250000)
  })

  test('FINANCE view_all sees exactly what the admin sees', () => {
    // The same two cases payment_active_allocation_totals() treats as complete,
    // and for the same reason: their RLS returns every allocation there is.
    const caps = deriveFinanceCapabilities('member', allow('view', 'view_all'))
    assert.equal(caps.canViewAllFinance, true)
    const c = classifyPayment(rowFor({ visibleAllocations: BOTH_VISIBLE, attributionComplete: true }))
    assert.equal(Number(c.available), 250000)
  })

  test('a FINANCE VERIFIER WITHOUT view_all is told nothing rather than something wrong', () => {
    // finance.approve is the authority to say the money arrived. It is NOT
    // company-wide sight, and it does not entitle them to every allocation — so
    // for a payment they did not submit, the balance is withheld.
    const caps = deriveFinanceCapabilities('member', allow('view', 'approve'))
    assert.equal(caps.canApprovePayment, true)
    assert.equal(caps.canViewAllFinance, false, 'verifying is not seeing everything')

    const c = classifyPayment(rowFor({
      visibleAllocations: [ORDER_ALLOCATION],
      attributionComplete: false,
    }))
    assert.equal(c.available, null,
      'an incomplete sum would OVERSTATE the balance, which is the one direction that must never happen')
    assert.equal(paymentIsInView(rowFor({
      visibleAllocations: [ORDER_ALLOCATION], attributionComplete: false,
    }), 'available'), false)
  })

  test('a PI OWNER sees the allocation onto their own PI, and no balance', () => {
    // They reach the payment through PI participation (20260919000000 §4), so
    // finance_payment_allocations returns the row naming their PI and no other.
    const row = rowFor({ visibleAllocations: [PI_ALLOCATION], attributionComplete: false })
    const c = classifyPayment(row)
    assert.equal(Number(c.piLinked), 450000, 'what is theirs is reported')
    assert.equal(Number(c.orderLinked), 0, 'and what is not, is not')
    assert.equal(c.available, null)
    assert.equal(paymentIsInView(row, 'pi_drafts'), true)
    assert.equal(paymentIsInView(row, 'available'), false)
  })

  test('an ORDER requester or assignee sees the Order share, and no balance', () => {
    const row = rowFor({ visibleAllocations: [ORDER_ALLOCATION], attributionComplete: false })
    const c = classifyPayment(row)
    assert.equal(Number(c.orderLinked), 300000)
    assert.equal(Number(c.piLinked), 0)
    assert.equal(c.available, null)
    assert.equal(paymentIsInView(row, 'orders'), true)
    assert.equal(paymentIsInView(row, 'pi_drafts'), false,
      'a share they cannot see must not put the payment in a view for them')
  })

  test('the payment SUBMITTER is complete, even without view_all', () => {
    // finance_payment_allocations_payment_owner_select entitles them to every
    // allocation of THAT payment — which is why the projection treats their
    // sum as the true sum.
    const c = classifyPayment(rowFor({ visibleAllocations: BOTH_VISIBLE, attributionComplete: true }))
    assert.equal(Number(c.available), 250000)
  })

  test('an UNRELATED salesperson sees nothing at all, because RLS returns no row', () => {
    // Stated as the absence of a row rather than as a redaction: the payment is
    // not theirs, not allocated to anything of theirs, and not submitted by
    // them, so no policy admits it and the list simply does not contain it.
    // What is asserted here is that their CAPABILITIES do not widen that.
    const finance = deriveFinanceCapabilities('member', allow('view'))
    assert.equal(finance.canViewAllFinance, false)
    const orders = deriveOrdersCapabilities('member', allow('view'))
    assert.equal(orders.canViewAllOrders, false)
    // And module entry alone confers no allocation authority.
    assert.equal(finance.canAllocatePayment, false)
  })
})

// ══ 2. No inaccessible target is leaked, by link, label or count ══════════════

describe('a destination the viewer cannot open is never named', () => {
  const summary = summaryOf([ORDER_ALLOCATION, PI_ALLOCATION])

  test('a viewer who may open only ONE of two sees one door and one placeholder', () => {
    // The exact mixed case: their own Order, and somebody else's PI.
    const links = paymentLinks({
      summary,
      directOrder: null,
      labels: new Map([[ORDER_ID, 'ORD-2026-0007']]),
      canOpenOrders: true,
    })
    assert.deepEqual(links.map(l => l.label), ['ORD-2026-0007', unnamedLabel('submission')])
    assert.deepEqual(links.map(l => l.href), ['/orders/order-1', null])
    assert.deepEqual(linkCounts(links), { total: 2, openable: 1, hidden: 1 })
  })

  test('the placeholder carries no id, no number and no client', () => {
    const links = paymentLinks({ summary, directOrder: null, labels: new Map(), canOpenOrders: true })
    for (const link of links) {
      assert.equal(link.href, null)
      assert.equal(link.named, false)
      for (const secret of [ORDER_ID, PI_ID, 'ORD-2026-0007', 'Acme']) {
        assert.equal(link.label.includes(secret), false, `"${link.label}" leaks ${secret}`)
      }
    }
    assert.deepEqual(links.map(l => l.label), [unnamedLabel('order'), unnamedLabel('submission')])
  })

  test('the count says HOW MANY are hidden, never which', () => {
    const links = paymentLinks({
      summary, directOrder: null, labels: new Map([[PI_ID, 'PI-0042']]), canOpenOrders: true,
    })
    const counts = linkCounts(links)
    assert.equal(counts.hidden, 1)
    // The count is a number. Nothing in it identifies the record.
    assert.equal(typeof counts.hidden, 'number')
  })

  test('module entry is a second gate, and can only ever narrow further', () => {
    // A reader without Orders module entry is offered no door at all, even to a
    // record RLS returned. The label survives — it is on their own payment —
    // but there is nowhere to send them.
    const links = paymentLinks({
      summary,
      directOrder: null,
      labels: new Map([[ORDER_ID, 'ORD-2026-0007'], [PI_ID, 'PI-0042']]),
      canOpenOrders: false,
    })
    assert.deepEqual(links.map(l => l.href), [null, null])
    assert.deepEqual(linkCounts(links), { total: 2, openable: 0, hidden: 0 })
  })

  test('the legacy direct link is subject to exactly the same rule', () => {
    const links = paymentLinks({
      summary: summaryOf([]),
      directOrder: { id: ORDER_ID, number: null },
      labels: new Map(),
      canOpenOrders: true,
    })
    assert.deepEqual(links.map(l => l.label), [unnamedLabel('order')])
    assert.equal(links[0].href, null)
  })

  test('and it is not offered at all once anything is allocated', () => {
    // Rule 1 of the canonical attribution rule. A door to an Order the figures
    // attribute nothing to is a door to a record with no reason to be there.
    assert.equal(directOrderOf({ order_id: ORDER_ID, order_number: 'ORD-1', allocated_total: '750000.00' }), null)
  })
})

// ══ 3. Sales visibility is preserved, and not widened ═════════════════════════

describe('the surface widens nothing', () => {
  test('allocating needs finance.allocate, and module entry does not confer it', () => {
    assert.equal(deriveFinanceCapabilities('member', allow('view')).canAllocatePayment, false)
    assert.equal(deriveFinanceCapabilities('member', allow('view', 'view_all')).canAllocatePayment, false)
    assert.equal(deriveFinanceCapabilities('member', allow('view', 'allocate')).canAllocatePayment, true)
  })

  test('reversing an allocation is a THIRD authority, separate from both', () => {
    // Verifying money, deciding whose it is, and undoing that decision are three
    // decisions the business has chosen to keep assignable to three people.
    const allocator = deriveFinanceCapabilities('member', allow('view', 'allocate'))
    assert.equal(allocator.canCorrectPaymentAllocation, false)
    assert.equal(allocator.canApprovePayment, false)
  })

  test('seeing the classification confers no authority over the money', () => {
    const viewer = deriveFinanceCapabilities('member', allow('view', 'view_all'))
    assert.equal(viewer.canApprovePayment, false)
    assert.equal(viewer.canAllocatePayment, false)
    assert.equal(viewer.canManageFinance, false)
    assert.equal(viewer.canDeletePaymentRecord, false)
  })

  test('neither orders.view_all nor finance.view_all is required to use the surface', () => {
    // A salesperson with plain module entry still reads their own payments and
    // still sees their own destinations. What they lose is the BALANCE, and only
    // on payments whose allocations they cannot see in full.
    const finance = deriveFinanceCapabilities('member', allow('view'))
    assert.equal(finance.canAccessFinanceModule, true)
    const orders = deriveOrdersCapabilities('member', allow('view'))
    assert.equal(orders.canAccessOrdersModule, true)
    assert.equal(orders.canViewAllOrders, false)
  })

  test('a rejected payment is offered to nobody, whatever they hold', () => {
    const rejected: ClassifiablePayment = {
      ...rowFor({ visibleAllocations: BOTH_VISIBLE, attributionComplete: true }),
      status: 'rejected',
    }
    for (const view of ['all', 'orders', 'pi_drafts', 'available'] as const) {
      assert.equal(paymentIsInView(rejected, view), false)
    }
  })
})
