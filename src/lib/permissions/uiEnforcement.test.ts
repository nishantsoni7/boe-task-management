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
const ORDER_REQUEST_DETAIL = 'src/app/orders/requests/[id]/page.tsx'
const ORDER_DETAIL = 'src/app/orders/[id]/page.tsx'
const ORDERS_LIST = 'src/app/orders/page.tsx'
const DELETE_ROUTE = 'src/app/api/orders/requests/delete/route.ts'
const CLEANUP_ROUTE = 'src/app/api/orders/requests/attachments/cleanup/route.ts'

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

  test('link and unlink are gated on canManageFinance', () => {
    const source = read(RECEIVED_VIEW)
    assert.ok(source.includes('canManage={caps.canManageFinance}'))
    assert.ok(source.includes("caps.canManageFinance && action === 'link'"))
    assert.ok(source.includes("caps.canManageFinance && action === 'edit'"))
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
  test('review is gated on canApproveOrder', () => {
    const source = read(ORDER_REQUEST_DETAIL)
    assert.ok(source.includes('deriveOrdersCapabilities'))
    assert.ok(source.includes('caps.canApproveOrder && request.status === \'submitted\''))
    assert.equal(
      source.includes("const canReview       = !!request && isAdmin && request.status === 'submitted'"),
      false,
      'review must no longer be role-gated',
    )
  })

  test('delete is gated on canDeleteOrder', () => {
    const source = read(ORDER_REQUEST_DETAIL)
    assert.ok(source.includes('caps.canDeleteOrder && request.status !== \'converted\''))
  })

  test('the amendment door follows canManageOrders and ignores View As', () => {
    const source = read(ORDER_DETAIL)
    assert.ok(source.includes('const mayManageOrders = ordersCaps.canManageOrders && !viewAsUserId'))
    assert.ok(source.includes('canAmendOrderDirectly(actingAsAdmin ? profile : { role: \'member\' }, order, mayManageOrders)'))
    assert.ok(source.includes('canRequestOrderChange(actingAsAdmin ? profile : { role: \'member\' }, order, mayManageOrders)'))
  })

  test('the Finance card inside Orders needs Finance view', () => {
    const source = read(ORDERS_LIST)
    assert.ok(source.includes('const canSeeFinance = financeCaps.canAccessFinanceModule'))
    assert.equal(source.includes("const canSeeFinance = profile?.role === 'admin'"), false)
  })

  test('every Orders screen starts from no capabilities', () => {
    for (const path of [ORDER_REQUEST_DETAIL, ORDER_DETAIL]) {
      assert.ok(read(path).includes('NO_ORDERS_CAPABILITIES'), `${path} must fail closed while loading`)
    }
  })

  test('ordinary editing stays on the admin-or-assigned rule', () => {
    const shared = read('src/app/orders/requests/components/shared.ts')
    assert.ok(shared.includes('export function canEditRequest(r: OrderRequest, userId: string, isAdmin: boolean): boolean'))
    assert.ok(shared.includes('return isAdmin || r.assigned_to === userId'))
    assert.equal(
      read(ORDER_REQUEST_DETAIL).includes('canEditOrder'),
      false,
      'an inert orders.edit row must not grant company-wide editing',
    )
  })
})

describe('server-side enforcement on the Orders delete route', () => {
  const source = read(DELETE_ROUTE)

  test('it resolves the permission server-side for the token user', () => {
    assert.ok(source.includes("p_module_key: 'orders'"))
    assert.ok(source.includes("p_action_key: 'delete'"))
    assert.ok(source.includes('p_user_id: user.id'), 'the actor must come from the bearer token')
  })

  test('it keeps the admin short-circuit', () => {
    assert.ok(source.includes("let mayDelete = me.role === 'admin'"))
  })

  test('it fails closed on every uncertainty', () => {
    assert.ok(source.includes("if (roleErr) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })"))
    assert.ok(source.includes("if (!me) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })"))
    assert.ok(source.includes('if (permErr) return NextResponse.json'))
    assert.ok(source.includes('mayDelete = allowed === true'), 'anything but an explicit true must deny')
  })

  test('it returns the project-standard 403', () => {
    assert.ok(source.includes('{ status: 403 }'))
  })

  test('it never reads a permission from the request body', () => {
    const body = source.slice(source.indexOf('export async function POST'))
    assert.equal(/req\.json\(\)[\s\S]{0,200}(allowed|permission|isAdmin|role)/.test(body), false)
  })
})

describe('the attachment cleanup route stays admin-only', () => {
  const source = read(CLEANUP_ROUTE)

  test('it still requires the admin role', () => {
    assert.ok(source.includes("if (!me || me.role !== 'admin')"))
    assert.equal(source.includes('resolve_permission'), false)
  })

  test('the decision is documented rather than implied', () => {
    assert.ok(source.includes('DELIBERATELY NOT moved onto orders.manage'))
  })
})

// ── Behavioural cross-check: the mapping the UI uses is the mapping the SQL
//    enforces, expressed as capabilities rather than as file contents.

const perms = (moduleKey: 'finance' | 'orders', allowedActions: string[]): EffectivePermission[] => {
  const all = moduleKey === 'finance'
    ? ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
    : ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'can_be_order_assignee']
  return all.map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: 'employee_override' as const,
  }))
}

describe('the acceptance conditions, as capabilities', () => {
  const DHRUV_FINANCE = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
  const DHRUV_ORDERS = [...DHRUV_FINANCE, 'can_be_order_assignee']

  test("Dhruv's stored grants authorize every protected Finance action", () => {
    const caps = deriveFinanceCapabilities('manager', perms('finance', DHRUV_FINANCE))
    assert.equal(caps.canApprovePayment, true)
    assert.equal(caps.canCorrectOrReversePayment, true)
    assert.equal(caps.canManageFinance, true)
    assert.equal(caps.canDeletePaymentRecord, true)
  })

  test("Dhruv's stored grants authorize every protected Orders action", () => {
    const caps = deriveOrdersCapabilities('manager', perms('orders', DHRUV_ORDERS))
    assert.equal(caps.canApproveOrder, true)
    assert.equal(caps.canManageOrders, true)
    assert.equal(caps.canDeleteOrder, true)
    assert.equal(caps.canBeOrderAssignee, true)
  })

  test('a Contributor gets no protected action in either module', () => {
    const contributor = ['view', 'create', 'edit']
    const finance = deriveFinanceCapabilities('member', perms('finance', contributor))
    assert.equal(finance.canApprovePayment, false)
    assert.equal(finance.canCorrectOrReversePayment, false)
    assert.equal(finance.canManageFinance, false)
    assert.equal(finance.canDeletePaymentRecord, false)

    const orders = deriveOrdersCapabilities('member', perms('orders', contributor))
    assert.equal(orders.canApproveOrder, false)
    assert.equal(orders.canManageOrders, false)
    assert.equal(orders.canDeleteOrder, false)
    assert.equal(orders.canBeOrderAssignee, false)
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
        : ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'can_be_order_assignee']
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
        assert.equal(caps.canApproveOrder, true)
        assert.equal(caps.canManageOrders, false)
        assert.equal(caps.canDeleteOrder, false)
        assert.equal(caps.canBeOrderAssignee, false, 'assignee authority is never implied')
      }
    }
  })

  test('admin behaviour is unchanged in both modules', () => {
    const finance = deriveFinanceCapabilities('admin', [])
    for (const value of Object.values(finance)) assert.equal(value, true)

    const orders = deriveOrdersCapabilities('admin', [])
    for (const [name, value] of Object.entries(orders)) {
      if (name === 'canBeOrderAssignee') continue
      assert.equal(value, true, `admin must keep ${name}`)
    }
  })
})
