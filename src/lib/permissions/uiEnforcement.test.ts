/**
 * UI ↔ SQL agreement for the Finance and Orders cutover.
 *
 * A capability helper is only worth anything if the screen actually asks it,
 * and asks it for the same action the database will check. These are source-
 * shape assertions over the real page files: they fail if a control drifts back
 * onto users.role, and they fail if the UI starts gating on an action the
 * migration did not enforce.
 *
 * They also pin the things that must NOT have moved — ownership-based editing
 * in both modules.
 *
 * Reads repository files only. No DB, no network.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/uiEnforcement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveFinanceCapabilities } from './finance'
import { deriveOrdersCapabilities } from './orders'
import { presetAllowedActions } from './levels'
import type { EffectivePermission } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const FINANCE_PAGE = 'src/app/finance/page.tsx'
const RECEIVED_VIEW = 'src/app/finance/received/ReceivedPaymentsView.tsx'
const ORDER_DETAIL = 'src/app/orders/[id]/page.tsx'
const ORDERS_LIST = 'src/app/orders/page.tsx'
const PI_DETAIL = 'src/app/orders/drafts/[submissionId]/page.tsx'
const PI_DRAFTS = 'src/app/orders/drafts/page.tsx'
const RETIRED_NOTICE = 'src/app/orders/requests/RetiredWorkflowNotice.tsx'

describe('Finance controls ask the capability helper', () => {
  test('both Finance screens resolve capabilities for the signed-in user', () => {
    for (const path of [FINANCE_PAGE, RECEIVED_VIEW]) {
      const source = read(path)
      assert.ok(source.includes('deriveFinanceCapabilities'), `${path} must derive capabilities`)
      assert.ok(source.includes('getEffectivePermissions'), `${path} must resolve permissions`)
      assert.ok(
        source.includes('NO_FINANCE_CAPABILITIES'),
        `${path} must start from no capabilities so controls cannot flash`,
      )
    }
  })

  test('approval is gated on canApprovePayment, not the role', () => {
    const source = read(FINANCE_PAGE)
    assert.ok(source.includes('canApprove={caps.canApprovePayment}'))
    assert.ok(source.includes('{canApprove && isPending && ('))
    assert.equal(
      source.includes("if (isAdmin && r.status === 'pending_approval')"),
      false,
      'the review router must not be role-gated',
    )
    assert.ok(source.includes("if (caps.canApprovePayment && r.status === 'pending_approval')"))
  })

  test('correction is gated on canCorrectOrReversePayment', () => {
    for (const path of [FINANCE_PAGE, RECEIVED_VIEW]) {
      const source = read(path)
      assert.ok(
        source.includes('mayCorrectPayments={caps.canCorrectOrReversePayment}'),
        `${path} must pass the correction capability`,
      )
      assert.ok(source.includes('{mayCorrectPayments && supabase && onCorrected'))
    }
  })

  test('the deep-link actions are gated on the SAME capability as their buttons', () => {
    // Link and unlink are gone. What replaced ?action=link is ?action=allocate,
    // and it must be gated on the allocate capability — not on finance.manage,
    // which would let a manager open a modal their own row action would not
    // have drawn for them.
    const source = read(RECEIVED_VIEW)
    assert.ok(source.includes('canManage={caps.canManageFinance}'))
    assert.ok(source.includes('canAllocate={caps.canAllocatePayment}'))
    assert.ok(source.includes('caps.canAllocatePayment && canOfferAllocateFunds(match)'),
      'the allocate deep link re-checks permission AND allocatable balance')
    assert.ok(source.includes("caps.canManageFinance && action === 'edit'"))
    assert.equal(source.includes("action === 'unlink'"), false)
  })

  test('Export is never gated into existence — there is no protected server path', () => {
    for (const path of [FINANCE_PAGE, RECEIVED_VIEW]) {
      assert.equal(read(path).includes('canExportFinance'), false, `${path} must not offer Export yet`)
    }
  })
})

describe('Finance ownership rules are unchanged', () => {
  test('editing an unapproved request is still ownership-based', () => {
    const source = read(FINANCE_PAGE)
    assert.ok(
      source.includes('function canManageRequest(r: PaymentRequest, isAdmin: boolean, userId: string): boolean'),
      'the ownership helper must still exist',
    )
    assert.ok(
      source.includes('return !isApproved(r.status) && (isAdmin || r.submitted_by === userId)'),
      'the ownership rule must be untouched',
    )
  })

  test('the edit capability is never consulted — an inert finance.edit row grants nothing', () => {
    for (const path of [FINANCE_PAGE, RECEIVED_VIEW]) {
      assert.equal(read(path).includes('canEditPaymentRecord'), false, `${path} must not consult finance.edit`)
    }
    assert.equal(read(FINANCE_PAGE).includes('canCreatePaymentRecord'), false)
  })
})

describe('Orders controls ask the capability helper', () => {
  // THE ORDER REQUEST DETAIL PAGE IS GONE, and with it the two controls this
  // block used to pin: review gated on `caps.canApproveOrder` and delete on
  // `caps.canDeleteOrder`. Both authorized steps in the retired workflow
  // (20261007000000), the RPCs behind them are revoked from every client role,
  // and the module no longer registers `approve` at all. What replaced them is
  // the PI review path, which is asserted here in their place.

  test('PI review is gated on the capability, not the role', () => {
    const source = read(PI_DETAIL)
    assert.ok(source.includes('deriveOrdersCapabilities'))
    assert.ok(source.includes('canApproveOrderSubmission'),
      'review must resolve orders.approve_order')
  })

  test('PI deletion goes through one shared rule', () => {
    // ONE RULE, read by the list, the dialog and the route alike — so a control
    // cannot be offered on one surface and refused on another.
    const rule = read('src/lib/orders/submissionDeletion.ts')
    assert.ok(rule.includes('export function canDeleteSubmission'))
    assert.ok(read(PI_DRAFTS).includes('canDeleteSubmission'),
      'the drafts list must ask the shared deletion rule rather than its own')
  })

  test('the amendment door follows canManageOrders and ignores View As', () => {
    const source = read(ORDER_DETAIL)
    assert.ok(source.includes('const mayManageOrders = ordersCaps.canManageOrders && !viewAsUserId'))
    assert.ok(source.includes('canAmendOrderDirectly(actingAsAdmin ? profile : { role: \'member\' }, order, mayManageOrders)'))
    assert.ok(source.includes('canRequestOrderChange(actingAsAdmin ? profile : { role: \'member\' }, order, mayManageOrders)'))
  })

  test('the money cards inside Orders need Finance capabilities', () => {
    const source = read(ORDERS_LIST)
    assert.ok(source.includes('orderDashboardCards({ counts: stats, orders: ordersCaps, finance: financeCaps })'),
      'which cards are drawn must be one decision, made from capabilities')
    assert.equal(source.includes("const canSeeFinance = profile?.role === 'admin'"), false)
    const cards = read('src/lib/orders/orderDashboard.ts')
    assert.ok(cards.includes('finance.canAccessFinanceModule'))
    assert.ok(cards.includes('finance.canAllocatePayment && finance.canViewAllFinance'),
      'the available-funds card needs both the authority and a trustworthy figure')
  })

  test('every Orders screen starts from no capabilities', () => {
    for (const path of [ORDERS_LIST, ORDER_DETAIL]) {
      assert.ok(read(path).includes('NO_ORDERS_CAPABILITIES'), `${path} must fail closed while loading`)
    }
  })

  test('the primary new-Order action is Upload PI, and it needs orders.create', () => {
    const source = read(ORDERS_LIST)
    assert.ok(source.includes('ordersCaps.canCreateOrder ? ('))
    assert.ok(source.includes('NEW_ORDER_ACTION.href'))
    const action = read('src/lib/orders/orderDashboard.ts')
    assert.ok(action.includes("label: 'Upload PI'"))
    assert.ok(action.includes("href: UPLOAD_PI_PATH"))
  })
})

describe('the retired Order Request routes answer, and offer no way back in', () => {
  const notice = read(RETIRED_NOTICE)

  test('the route explains the retirement and offers PI Drafts', () => {
    assert.ok(notice.includes("export const OPEN_PI_DRAFTS_LABEL = 'Open PI Drafts'"))
    assert.ok(notice.includes("export const PI_DRAFTS_PATH = '/orders/drafts'"))
    assert.ok(notice.includes('RETIRED_HEADING'))
  })

  test('it offers no control that would restart the workflow', () => {
    for (const forbidden of ['convert_order_request_to_order', 'finalize_order_request',
                             'reject_order_request', 'resubmit_order_request',
                             'edit_order_request', 'respond_to_clarification']) {
      assert.equal(notice.includes(forbidden), false, `the notice must not call ${forbidden}`)
    }
    assert.equal(notice.includes('.insert('), false, 'the notice writes nothing at all')
  })

  test('historical provenance is shown quietly, and only where it can be opened', () => {
    // A request converted before the retirement became a Confirmed Order that
    // still exists. The lookup runs under the reader's own RLS, so it can name
    // no record they could not already open.
    assert.ok(notice.includes("from('order_requests')"))
    assert.ok(notice.includes("select('converted_order_id')"))
    assert.ok(notice.includes('{converted && ('), 'the Order link appears only when there is one')
  })

  test('both retired routes render the notice rather than 404ing', () => {
    for (const path of ['src/app/orders/requests/page.tsx',
                        'src/app/orders/requests/[id]/page.tsx']) {
      assert.ok(read(path).includes('RetiredWorkflowNotice'), `${path} must stay answerable`)
    }
  })

  test('no Orders navigation entry points at the retired workflow', () => {
    const layout = read('src/components/layout/OrdersLayout.tsx')
    const nav = layout.slice(layout.indexOf('const navItems'), layout.indexOf('return ('))
    assert.equal(nav.includes('/orders/requests'), false, 'the nav must not offer the retired route')
    assert.equal(nav.includes('Order Requests'), false)
    for (const expected of ['/orders/drafts', '/orders/all', "path: '/orders'"]) {
      assert.ok(nav.includes(expected), `the nav must still offer ${expected}`)
    }
  })
})

// ── Behavioural cross-check: the mapping the UI uses is the mapping the SQL
//    enforces, expressed as capabilities rather than as file contents.

const perms = (moduleKey: 'finance' | 'orders', allowedActions: string[]): EffectivePermission[] => {
  const all = moduleKey === 'finance'
    ? ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
    // Orders no longer registers `approve` or `can_be_order_assignee`: both
    // existed only for the retired Order Request workflow.
    : ['view', 'create', 'edit', 'delete', 'export', 'manage', 'approve_order']
  return all.map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: 'employee_override' as const,
  }))
}

describe('the acceptance conditions, as capabilities', () => {
  const DHRUV_FINANCE = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
  const DHRUV_ORDERS = ['view', 'create', 'edit', 'delete', 'export', 'manage', 'approve_order']

  test("Dhruv's stored grants authorize every protected Finance action", () => {
    const caps = deriveFinanceCapabilities('manager', perms('finance', DHRUV_FINANCE))
    assert.equal(caps.canApprovePayment, true)
    assert.equal(caps.canCorrectOrReversePayment, true)
    assert.equal(caps.canManageFinance, true)
    assert.equal(caps.canDeletePaymentRecord, true)
  })

  test("Dhruv's stored grants authorize every protected Orders action", () => {
    const caps = deriveOrdersCapabilities('manager', perms('orders', DHRUV_ORDERS))
    assert.equal(caps.canApproveOrderSubmission, true)
    assert.equal(caps.canManageOrders, true)
    assert.equal(caps.canDeleteOrder, true)
  })

  test('a Contributor gets no protected action in either module', () => {
    const contributor = ['view', 'create', 'edit']
    const finance = deriveFinanceCapabilities('member', perms('finance', contributor))
    assert.equal(finance.canApprovePayment, false)
    assert.equal(finance.canCorrectOrReversePayment, false)
    assert.equal(finance.canManageFinance, false)
    assert.equal(finance.canDeletePaymentRecord, false)

    const orders = deriveOrdersCapabilities('member', perms('orders', contributor))
    assert.equal(orders.canApproveOrderSubmission, false)
    assert.equal(orders.canManageOrders, false)
    assert.equal(orders.canDeleteOrder, false)
  })

  test('a Viewer receives no mutation control at all', () => {
    const finance = deriveFinanceCapabilities('member', perms('finance', ['view']))
    for (const [name, value] of Object.entries(finance)) {
      if (name === 'canAccessFinanceModule') continue
      assert.equal(value, false, `Viewer must not hold ${name}`)
    }
    const orders = deriveOrdersCapabilities('member', perms('orders', ['view']))
    for (const [name, value] of Object.entries(orders)) {
      if (name === 'canAccessOrdersModule') continue
      assert.equal(value, false, `Viewer must not hold ${name}`)
    }
  })

  test('the Manager preset grants no protected action in either module', () => {
    for (const moduleKey of ['finance', 'orders'] as const) {
      const registered = moduleKey === 'finance'
        ? ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
        : ['view', 'create', 'edit', 'delete', 'export', 'manage', 'approve_order']
      const map = presetAllowedActions('manager', registered)
      const granted = registered.filter(a => map[a])

      if (moduleKey === 'finance') {
        const caps = deriveFinanceCapabilities('member', perms('finance', granted))
        assert.equal(caps.canApprovePayment, true, 'approve IS a Manager action')
        assert.equal(caps.canManageFinance, false)
        assert.equal(caps.canCorrectOrReversePayment, false)
        assert.equal(caps.canDeletePaymentRecord, false)
      } else {
        const caps = deriveOrdersCapabilities('member', perms('orders', granted))
        // PI review is PROTECTED, so no preset reaches it — the retirement
        // removed the only preset-reachable approval Orders ever had.
        assert.equal(caps.canApproveOrderSubmission, false)
        assert.equal(caps.canManageOrders, false)
        assert.equal(caps.canDeleteOrder, false)
      }
    }
  })

  test('admin behaviour is unchanged in both modules', () => {
    const finance = deriveFinanceCapabilities('admin', [])
    for (const value of Object.values(finance)) assert.equal(value, true)

    const orders = deriveOrdersCapabilities('admin', [])
    for (const [name, value] of Object.entries(orders)) {
      assert.equal(value, true, `admin must keep ${name}`)
    }
  })
})
