/**
 * Navigation between Order Management and Finance.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * Order Management and Finance are two module views over ONE set of records, and
 * a reader looking at money in either should be able to reach the other. These
 * are the two rules that make that safe:
 *
 *   A LINK IS NOT A PERMISSION. Every destination re-reads its own record under
 *   the caller's RLS. An id in a URL is not a capability, and no href here is
 *   built from anything a reader could not already see.
 *
 *   BUT A DEAD LINK IS STILL A DEFECT. A control is drawn only for a reader who
 *   holds the destination module's ENTRY permission, so nobody is offered a door
 *   that shuts in their face.
 *
 * Plus the wiring: that both screens actually gate on those capabilities, and
 * that neither invented a route of its own.
 *
 * Run:
 *   npx tsx --test src/lib/finance/crossModuleLinks.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  FINANCE_PAYMENT_PARAM,
  canOpenFinanceRecord,
  canOpenOrderRecord,
  financePaymentHref,
  orderDetailHref,
  piSubmissionHref,
} from './crossModuleLinks'
import { orderHref } from '@/lib/orders/finalApproval'
import { draftDetailHref } from '@/lib/orders/draftsView'

/**
 * The body of a page's startup Promise.all — the group whose members cost only
 * the slowest one's latency, rather than the sum of all of them.
 */
function parallelGroup(source: string): string {
  const init = source.slice(source.indexOf('const init = async ()'))
  const open = init.indexOf('await Promise.all([')
  // Closed on a line that is ONLY `])`, not on the first `])` found: a member
  // ending `.catch(() => [])` contains that pair, and searching for it naively
  // cuts the group off in the middle.
  const close = init.slice(open).search(/\n\s*\]\)/)
  return init.slice(open, open + close)
}

const ORDER_PAGE = 'src/app/orders/[id]/page.tsx'
const FINANCE_VIEW = 'src/app/finance/received/ReceivedPaymentsView.tsx'

// ── The routes ────────────────────────────────────────────────────────────────

describe('no new route is invented', () => {
  test('an Order link is the shape the Orders module already produces', () => {
    // Two builders for one route would be one edit away from disagreeing.
    assert.equal(orderDetailHref('order-1'), orderHref('order-1'))
  })

  test('a PI link is the shape the PI module already produces', () => {
    assert.equal(piSubmissionHref('sub-1'), draftDetailHref('sub-1'))
  })

  test('a Finance link goes to the PARENT route, which resolves the rest', () => {
    // Whether a payment is Linked or Non-Linked changes the moment somebody
    // allocates it. /finance/received looks that up and forwards; a caller that
    // guessed a child page would send the reader to the list that does not hold
    // the row.
    assert.equal(financePaymentHref('pay-1'), '/finance/received?payment=pay-1')
    assert.ok(!financePaymentHref('pay-1').includes('/linked'))
    assert.ok(!financePaymentHref('pay-1').includes('/unlinked'))
  })

  test('the Finance parameter is the one the route already reads', () => {
    // The Admin Action Queue and Finance notifications already deep-link with
    // it; a second spelling would quietly stop opening the modal.
    assert.equal(FINANCE_PAYMENT_PARAM, 'payment')
    const route = readFileSync('src/app/finance/received/page.tsx', 'utf8')
    assert.ok(route.includes(`searchParams.get('payment')`))
  })

  test('ids are encoded, so a hostile id cannot become extra query parameters', () => {
    assert.equal(financePaymentHref('a&b=c'), '/finance/received?payment=a%26b%3Dc')
    assert.equal(orderDetailHref('a/b'), '/orders/a%2Fb')
  })
})

// ── The drawing gates ─────────────────────────────────────────────────────────

describe('a control is drawn only for a reader who can get through the door', () => {
  test('Finance entry, and nothing finer, decides a link into Finance', () => {
    // NOT finance.view_all: a reader who may see only their own payments still
    // legitimately opens the Finance record of a payment they submitted.
    assert.equal(canOpenFinanceRecord(true), true)
    assert.equal(canOpenFinanceRecord(false), false)
    assert.equal(canOpenFinanceRecord(null), false)
    assert.equal(canOpenFinanceRecord(undefined), false)
  })

  test('Orders entry decides a link into an Order', () => {
    assert.equal(canOpenOrderRecord(true), true)
    assert.equal(canOpenOrderRecord(false), false)
    assert.equal(canOpenOrderRecord(undefined), false)
  })

  test('the default is CLOSED — an unresolved capability draws nothing', () => {
    // Both pages start their capabilities empty and widen them only once
    // resolve_effective_permissions answers, so a link cannot flash before the
    // reader is known to be able to follow it.
    for (const gate of [canOpenFinanceRecord, canOpenOrderRecord]) {
      assert.equal(gate(undefined), false)
    }
  })
})

// ── The wiring ────────────────────────────────────────────────────────────────

describe('the Order screen links into Finance, and gates it', () => {
  const page = readFileSync(ORDER_PAGE, 'utf8')

  test('a payment row offers its Finance record', () => {
    assert.ok(page.includes('financePaymentHref(p.id)'))
  })

  test('and only to a reader who holds Finance module entry', () => {
    assert.ok(page.includes('financeCaps.canAccessFinanceModule && ('),
      'the Finance control is gated on Finance module entry')
  })

  test('the capability starts empty and is resolved, not assumed from the role', () => {
    assert.ok(page.includes('useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)'),
      'no Finance authority is assumed before the resolver answers')
    assert.ok(page.includes(`getEffectivePermissions(supabase, session.user.id, 'finance')`),
      'Finance authority comes from resolve_effective_permissions')
  })

  test('resolving it costs no extra wait — it joins the existing parallel group', () => {
    // A fourth independent call in a group that already waits for the slowest is
    // free; a fourth sequential await would not be.
    const parallel = parallelGroup(page)
    assert.ok(parallel.includes(`'finance'`), 'the finance resolve is inside the Promise.all')
    assert.ok(parallel.includes(`'orders'`), 'beside the orders resolve it already made')
    assert.ok(parallel.includes('loadOrder()'), 'and beside the page load')
  })
})

describe('the Finance list links into Order Management, and gates it', () => {
  const view = readFileSync(FINANCE_VIEW, 'utf8')

  test('a row attached to a Confirmed Order offers that Order', () => {
    assert.ok(view.includes('onOpenLinked(orderDetailHref(linkedOrderId))'))
  })

  test('the Order it offers is resolved by the SAME priority as the badge', () => {
    // resolveLinkedAgainst prefers the legacy link, then an active allocation.
    // A link built from a different priority could point at a different Order
    // than the badge beside it names.
    assert.ok(view.includes('r.order_id ?? r.allocated_order_id'),
      'legacy link first, then the active allocation — the badge\'s own order')
  })

  test('and only to a reader who holds Orders module entry', () => {
    assert.ok(view.includes('canOpenOrderRecord(ordersCaps.canAccessOrdersModule)'))
    assert.ok(view.includes('canOpenLinkedRecord ? ('),
      'the badge is a button only when the reader can follow it')
  })

  test('the allocation panel links to both an Order and a PI', () => {
    assert.ok(view.includes('orderDetailHref(target.targetId)'))
    assert.ok(view.includes('piSubmissionHref(target.targetId)'))
  })

  test('a target the reader cannot NAME is never rendered as a link', () => {
    // A door labelled "A Confirmed Order" is a door with no sign on it.
    assert.ok(view.includes('canOpenLinkedRecord && target.label ? ('))
  })

  test('resolving Orders authority costs no extra wait either', () => {
    const parallel = parallelGroup(view)
    assert.ok(parallel.includes('ordersPromise'))
    assert.ok(parallel.includes('financePromise'))
    assert.ok(parallel.includes('loadRequests()'))
  })
})

describe('neither screen reveals a record it could not already read', () => {
  test('the Order screen builds its Finance links from payments RLS already returned', () => {
    const page = readFileSync(ORDER_PAGE, 'utf8')
    // `p` is a row of the merged payment list, which comes from the two
    // Order-anchored, RLS-checked reads. No id is fetched to make a link.
    assert.ok(page.includes('financePaymentHref(p.id)'))
    assert.ok(!page.includes('financePaymentHref(id)'),
      'a link is never built from the route parameter or any unchecked id')
  })

  test('the Finance list builds its Order links from the projection, not a second read', () => {
    const view = readFileSync(FINANCE_VIEW, 'utf8')
    // allocated_order_id/number come from finance_received_payments, which is
    // security_invoker — it can show nothing the base tables would not.
    assert.ok(view.includes('allocated_order_id, allocated_order_number, is_order_allocated'))
  })
})
