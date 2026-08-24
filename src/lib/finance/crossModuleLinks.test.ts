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

  test('a Finance link goes to the LIST route, with no view of its own', () => {
    // The list resolves `?payment=` by id when the row is not on the current
    // page, so a deep link no longer has to guess which set holds it — and must
    // not, because a payment split between an Order and a PI is in several.
    assert.equal(financePaymentHref('pay-1'), '/finance/received?payment=pay-1')
    assert.ok(!financePaymentHref('pay-1').includes('/linked'))
    assert.ok(!financePaymentHref('pay-1').includes('/unlinked'))
    assert.ok(!financePaymentHref('pay-1').includes('view='),
      'a deep link names the record, never the view it happens to sit in')
  })

  test('the Finance parameter is the one the list already reads', () => {
    // The Admin Action Queue and Finance notifications already deep-link with
    // it; a second spelling would quietly stop opening the modal.
    assert.equal(FINANCE_PAYMENT_PARAM, 'payment')
    const list = readFileSync(FINANCE_VIEW, 'utf8')
    assert.ok(list.includes(`searchParams.get('payment')`))
  })

  test('the two retired child routes still answer, and forward the whole query', () => {
    // Bookmarks, old sidebar entries and links in somebody's message all point
    // at /linked and /unlinked. A 404 would tell a reader their link is broken;
    // dropping ?payment= would turn a working deep link into a plain list,
    // which looks like nothing happened.
    const forward = readFileSync('src/app/finance/received/RetiredReceivedRoute.tsx', 'utf8')
    assert.ok(forward.includes('new URLSearchParams(searchParams.toString())'))
    assert.ok(forward.includes('router.replace('), 'a forward, not a push — Back must still work')
    for (const route of ['linked', 'unlinked']) {
      const src = readFileSync(`src/app/finance/received/${route}/page.tsx`, 'utf8')
      assert.ok(src.includes('RetiredReceivedRoute'), `${route} must forward rather than 404`)
    }
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

  test('every destination its money went to is still resolved, from the allocations — not just one', () => {
    // REVISED (Requirement 2): the CONFIRMED PAYMENTS ROW itself no longer
    // draws a per-destination badge list (<DestinationsCell> is retired in
    // favour of exact Total Allocated / Remaining figures and an expandable
    // PI-Draft/Order breakdown) — but paymentLinks still resolves every
    // destination from the allocations, for the detail modal's
    // AllocationPanel (below) and for the delete-summary sentence, so a
    // payment split three ways is still known to be split three ways.
    assert.ok(view.includes('paymentLinks({'))
    assert.ok(!view.includes('<DestinationsCell'),
      'the row-level destination badge list is retired; the row shows exact figures now')
  })

  test('the destinations follow the canonical rule, not a second priority', () => {
    // directOrderOf drops the legacy link the moment anything is allocated —
    // rule 1 — so a row can never offer a door to an Order its own figures
    // attribute nothing to.
    assert.ok(view.includes('directOrder: directOrderOf(r)'))
  })

  test('and a door only to a reader who holds Orders module entry', () => {
    assert.ok(view.includes('canOpenOrderRecord(ordersCaps.canAccessOrdersModule)'))
    // The gating itself now lives only in AllocationPanel (the detail modal),
    // since that is the one place a destination is still rendered as a named
    // link — see "a target the reader cannot NAME is never rendered as a
    // link" below.
    assert.ok(view.includes('canOpenLinkedRecord && target.label ? ('),
      'a destination is a door only when the reader can both see and open it')
  })

  test('the allocation panel links to both an Order and a PI', () => {
    assert.ok(view.includes('orderDetailHref(target.targetId)'))
    assert.ok(view.includes('piSubmissionHref(target.targetId)'))
  })

  test('a target the reader cannot NAME is never rendered as a link', () => {
    // A door labelled "A Confirmed Order" is a door with no sign on it. In the
    // allocation panel the rule is written inline; in the row it is
    // paymentLinks' own `named && canOpenOrders`.
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

describe('the trail runs both ways between an Order and its PI', () => {
  test('the Order offers the approved PI it was created from', () => {
    // THE DOOR EXISTED IN THE DATABASE AND NOTHING USED IT.
    // can_view_order_submission_via_order (20260924000000 §3) was added so that
    // "this submission became an Order the caller may see" is a way onto the PI,
    // deliberately separate from PI-REVIEW visibility. Until this control there
    // was no way to walk through it, so the trail ran one way only: a PI could
    // reach its Order, and the Order could not reach its PI.
    const page = readFileSync(ORDER_PAGE, 'utf8')
    assert.ok(page.includes('piSubmissionHref(piHandoff.submissionId)'))
    assert.ok(page.includes('onOpenPi={'))
  })

  test('and offers it only for an Order that HAS one', () => {
    // The control hangs off the `ready` handoff branch. An Order created from an
    // Order Request has no source PI, and gets no door to a record that does not
    // exist — `none` renders nothing at all, exactly as before.
    const page = readFileSync(ORDER_PAGE, 'utf8')
    const readyBranch = page.slice(page.indexOf("piHandoff.kind === 'ready'"))
    assert.ok(readyBranch.indexOf('onOpenPi={') < readyBranch.indexOf('<OrderPiProducts'),
      'the PI door belongs to the summary card inside the ready branch')

    const sections = readFileSync('src/app/orders/[id]/OrderPiSections.tsx', 'utf8')
    assert.ok(sections.includes('right={onOpenPi && ('),
      'no control is drawn when no PI was handed over')
  })

  test('the PI already offered its Order, and that is unchanged', () => {
    const piPage = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    assert.ok(piPage.includes('onOpenOrder={'))
  })
})
