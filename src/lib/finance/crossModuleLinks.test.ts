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
  canRecordPaymentAgainstOrder,
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
  /** Where the per-payment rows are drawn: the dialog the figures open. */
  const workspace = readFileSync('src/app/orders/[id]/OrderWorkspace.tsx', 'utf8')

  test('a payment row opens the REST OF ITS RECORD, and does it here', () => {
    // It was a link into the Finance module: a different layout, and the Order
    // lost behind it. Everything it went for is a column of a row this page
    // already holds, so the dialog states it in place.
    assert.equal(page.includes('financePaymentHref'), false, 'no route into Finance is built')
    assert.ok(workspace.includes('PAYMENT_DETAIL_VIEW'))
    assert.ok(page.includes('openId={paymentDetailId}'))
  })

  test('and it keeps the Finance gate the link had', () => {
    // A LINK IS NOT A PERMISSION, but the control that offered it WAS gated —
    // on Finance module entry — and moving it into a dialog does not change who
    // may open it. The brief list is the Order's own money; the record behind it
    // is Finance's, and stays behind Finance's door.
    assert.ok(page.includes('const mayViewPaymentDetails = financeCaps.canAccessFinanceModule'))
    assert.ok(page.includes('canViewDetails={mayViewPaymentDetails}'))
    // And nothing sensitive is fetched for a reader who may not open it.
    assert.ok(page.includes('orderPaymentDetailQuery({'))
    assert.ok(page.includes('canViewPaymentDetails: mayViewPaymentDetails'))
    // The Finance CAPABILITY is still resolved, and still gates Add payment.
    assert.ok(page.includes('useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)'))
    assert.ok(page.includes('canAllocatePayment: financeCaps.canAllocatePayment'))
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
    // The dialog's rows are orderPaymentList's, filtered from the merged payment
    // list, which comes from the two Order-anchored, RLS-checked reads. Nothing
    // is fetched to make a door, because the door no longer leaves the page.
    assert.ok(page.includes('rows={paymentRows}'))
    // And the detail read may only name an id that list already contained.
    assert.ok(page.includes('rows: paymentRows'))
    assert.equal(/financePaymentHref/.test(page), false, 'no Finance route is built')
    // FINANCE'S OWN ENTRY FORM IS MOUNTED HERE, which is the opposite of going
    // to it: the only /finance string left on the page is that import.
    assert.equal(/router\.push\([^)]*finance/.test(page), false, 'and none is pushed either')
    assert.equal((page.match(/@\/app\/finance\//g) ?? []).length, 1)
    assert.ok(page.includes("import { RecordSplitPaymentModal } from '@/app/finance/received/RecordSplitPaymentModal'"))
  })

  test('the Finance list builds its Order links from the projection, not a second read', () => {
    const view = readFileSync(FINANCE_VIEW, 'utf8')
    // allocated_order_id/number come from finance_received_payments, which is
    // security_invoker — it can show nothing the base tables would not.
    assert.ok(view.includes('allocated_order_id, allocated_order_number, is_order_allocated'))
  })
})

describe('the trail runs both ways between an Order and its PI', () => {
  test('the Order no longer offers a door back to the PI it was created from', () => {
    // THE DOOR IS GONE FROM THE SCREEN, NOT FROM THE DATABASE.
    //
    // can_view_order_submission_via_order (20260924000000 §3) was added so that
    // "this submission became an Order the caller may see" is a way onto the
    // PI, and it still stands — an administrator reaches the draft from PI
    // Drafts exactly as they always could.
    //
    // WHAT CHANGED IS WHAT AN OPERATIONAL READER IS OFFERED. After conversion
    // the Order page IS the source of truth: the products, the money, the
    // documents and the PI version history are all on it. A prominent "Open
    // source PI" beside them invited people to work from a superseded draft.
    const page = readFileSync(ORDER_PAGE, 'utf8')
    assert.ok(!page.includes('Open source PI'), 'the action must not be offered')
    assert.ok(!page.includes('piSubmissionHref('), 'and no route back to the draft is built')
  })

  test('but the RELATIONSHIP and every record on both sides survive it', () => {
    // Removing an action must not remove a record. All five of these are what
    // "traceability" actually means here, and every one is still read.
    const page = readFileSync(ORDER_PAGE, 'utf8')
    assert.ok(page.includes('source_order_submission_id'), 'the relation itself')
    assert.ok(page.includes('ORDER_PI_HANDOFF_COLUMNS'), 'the PI the Order came from')
    // NAMED AND DOWNLOADABLE FROM THE DOCUMENTS BOX. The Order records section
    // that used to name it is gone; for a converted Order the PI in force IS
    // that document, and the box states its file name and signs it on demand.
    assert.ok(page.includes('<OrderDocumentsPanel'), 'named on screen')
    assert.ok(page.includes('openVersionFile'), 'and its file still downloadable')
    assert.ok(page.includes("from('order_pi_versions')"), 'and every PI version')

    // The merged chronology still interleaves the PI's own activity trail, so
    // the history of the draft is still readable from the Order.
    assert.ok(page.includes('mergeOrderHistory'))
  })

  test('and an Order with no PI is told so, rather than shown an empty section', () => {
    // An Order created from an Order Request has no source PI, and gets no
    // section about a record that does not exist — exactly as before. The
    // Order records section that used to carry the reference is gone; the two
    // absences keep their own quiet cards, and they are mutually exclusive.
    const page = readFileSync(ORDER_PAGE, 'utf8')
    assert.equal(page.includes('title="Order records"'), false, 'the section is gone')
    assert.ok(page.includes("piHandoff.kind === 'none' && (handoffReady || !order.source_order_submission_id) && <OrderPiNoSource />"))
    assert.ok(page.includes("piHandoff.kind === 'unavailable' && <OrderPiUnavailable />"))
    // The products, the commercial breakdown and the client dialog are all
    // still gated on the handoff being READY, exactly as before.
    assert.ok(page.includes("piHandoff.kind === 'ready'"))
  })

  test('the PI already offered its Order, and that is unchanged', () => {
    const piPage = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    assert.ok(piPage.includes('onOpenOrder={'))
  })
})

// ══ Recording a payment against an Order, from the Order ══════════════════════

describe('who is offered Add payment on a Confirmed Order', () => {
  const gate = (over: Partial<Parameters<typeof canRecordPaymentAgainstOrder>[0]> = {}) =>
    canRecordPaymentAgainstOrder({ canAllocatePayment: true, orderStatus: 'running', ...over })

  test('a holder of finance.allocate on an open Order is offered it', () => {
    assert.equal(gate(), true)
  })

  test('every open status is offered it — the rule is the permission, not the stage', () => {
    for (const status of ['confirmed', 'running', 'in_production', 'dispatched']) {
      assert.equal(gate({ orderStatus: status }), true, status)
    }
  })

  // ── The unauthorized reader ──
  //
  // NOT A DISABLED CONTROL. record_payment_with_allocations() would refuse
  // them, and a button that exists only to report that refusal is worse than
  // no button: the gate returns false and the page draws nothing.
  test('a reader without finance.allocate is offered NOTHING', () => {
    assert.equal(gate({ canAllocatePayment: false }), false)
  })

  test('and neither is one whose capability has not been resolved yet', () => {
    // The page starts on NO_FINANCE_CAPABILITIES and fills it after a read; a
    // control must not flash into existence on an absent answer.
    for (const unresolved of [null, undefined]) {
      assert.equal(gate({ canAllocatePayment: unresolved }), false, String(unresolved))
    }
  })

  test('module entry alone is not enough — it is folded into the capability', () => {
    // deriveFinanceCapabilities computes canAllocatePayment as
    // `canAccessFinanceModule && allowed('allocate')`, so a reader with entry
    // but no allocate arrives here as false and this gate adds nothing to it.
    const finance = readFileSync('src/lib/permissions/finance.ts', 'utf8')
    assert.ok(finance.includes("canAllocatePayment: withEntry('allocate')"))
  })

  // ── The cancelled Order ──
  test('a cancelled Order is not a target, so no control is drawn', () => {
    assert.equal(gate({ orderStatus: 'cancelled' }), false)
    // Even for somebody who holds the permission — this is the RPC's rule, not
    // the reader's.
    assert.equal(gate({ canAllocatePayment: true, orderStatus: 'cancelled' }), false)
  })

  test('and that agrees with the picker, which already declines to offer one', () => {
    const picker = readFileSync('src/app/finance/received/AllocatePaymentModal.tsx', 'utf8')
    assert.ok(picker.includes(".not('status', 'in', '(cancelled)')"),
      'searchAllocationTargets filters cancelled Orders out')
  })

  test('it decides DRAWING only, and says so', () => {
    const source = readFileSync('src/lib/finance/crossModuleLinks.ts', 'utf8')
    const at = source.indexOf('export function canRecordPaymentAgainstOrder')
    assert.ok(at > 0)
    // No write, no client, no navigation: a predicate over two booleans.
    const fn = source.slice(at, source.indexOf('\n}', at))
    for (const forbidden of ['supabase', 'rpc(', 'fetch(', 'router']) {
      assert.equal(fn.includes(forbidden), false, forbidden)
    }
  })
})

describe('the Order opens Finance’s payment form and never its own', () => {
  const page = readFileSync(ORDER_PAGE, 'utf8')

  test('the control is gated on the resolved capability', () => {
    assert.ok(page.includes('const mayRecordPayment = canRecordPaymentAgainstOrder({'))
    assert.ok(page.includes('canAllocatePayment: financeCaps.canAllocatePayment,'))
    assert.ok(page.includes('orderStatus: order.status,'))
    // Drawn only when the gate says so, and mounted only when it says so — the
    // second check means a stale open flag cannot outlive the permission.
    assert.ok(page.includes('{mayRecordPayment && ('))
    assert.ok(page.includes('{recordingPayment && mayRecordPayment && ('))
  })

  test('it opens the SAME component Finance opens, not a second form', () => {
    assert.ok(page.includes('<RecordSplitPaymentModal'))
    const finance = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    assert.ok(finance.includes('<RecordSplitPaymentModal'), 'Finance opens the same one')
  })

  test('and carries NO payment form, validation or write of its own', () => {
    // WHAT RENDERS, NOT WHAT IS EXPLAINED. The page names the RPC in prose, to
    // say whose rules these are; asserting over the comments would read that
    // sentence as an implementation. CRLF is stripped first, or a block comment
    // spanning lines survives the strip after a checkout on Windows.
    const code = page
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

    // Every one of these belongs to the shared form and to the RPC behind it.
    for (const forbidden of [
      'record_payment_with_allocations',
      'validatePiPaymentForm',
      'AddPiPaymentModal',
    ]) {
      assert.equal(code.includes(forbidden), false, forbidden + ' must not be reimplemented here')
    }

    // THE PAGE READS THE MONEY AND WRITES NONE OF IT. Both tables are selected
    // from — that is how the figures and the records table exist at all — so
    // what must be absent is a WRITE, not a mention.
    for (const table of ['finance_payment_requests', 'finance_payment_allocations']) {
      for (const write of ['insert', 'update', 'delete', 'upsert']) {
        assert.equal(
          new RegExp(`from\\('${table}'\\)[\\s\\S]{0,120}\\.${write}\\(`).test(code), false,
          `${table}.${write}() belongs to Finance, not to this page`)
      }
    }
  })

  test('THIS Order is what it is seeded with', () => {
    assert.ok(page.includes('initialTarget={{'))
    assert.ok(page.includes("kind: 'order',"))
    assert.ok(page.includes('id: order.id,'))
    assert.ok(page.includes('reference: order.display_number ?? '), 'the Order number the picker would show')
    assert.ok(page.includes('clientName: order.client_name ?? '))
  })

  test('the seed does not restrict the form to one target', () => {
    const modal = readFileSync('src/app/finance/received/RecordSplitPaymentModal.tsx', 'utf8')
    // Add another row and Remove are untouched, so a payment can still be
    // divided — which is the reason this form exists.
    assert.ok(modal.includes('setRows(prev => [...prev, EMPTY_ALLOCATION_ROW(nextRowKey())])'))
    assert.ok(modal.includes('const removeRow = (key: string) =>'))
  })

  // ── THE SEAM IS ONE OPTIONAL PROP ──
  //
  // This is the whole of what the Order asked of Finance. If it ever stops
  // being optional, every existing caller has to change and this stops being
  // reuse; if the write ever leaves the modal, the Order has grown a payment
  // system. Both are held here.
  test('Finance is reached through ONE prop that defaults to null', () => {
    const modal = readFileSync('src/app/finance/received/RecordSplitPaymentModal.tsx', 'utf8')
    assert.ok(modal.includes('initialTarget = null,'), 'defaulted, so the Finance page is unchanged')
    assert.ok(modal.includes('initialTarget?: {'), 'and optional in the type, so no caller is forced')
  })

  test('and the write stays in the modal, behind its own RPC', () => {
    const modal = readFileSync('src/app/finance/received/RecordSplitPaymentModal.tsx', 'utf8')
    assert.ok(modal.includes('record_payment_with_allocations'),
      'the transaction belongs to the form the Order opens, not to the Order')
  })

  test('afterwards the page refreshes the way it already refreshes', () => {
    const at = page.indexOf('onRecorded={summary => {')
    assert.ok(at > 0)
    const handler = page.slice(at, page.indexOf('}}', at))
    assert.ok(handler.includes('loadOrder()'), 'the page’s own full settle, not a bespoke re-read')
  })

  test('recording is not verifying, and the notice says so', () => {
    assert.ok(page.includes('Finance verification is still pending.'))
  })
})
