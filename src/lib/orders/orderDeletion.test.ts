/**
 * AN ADMINISTRATOR CAN DELETE A CONFIRMED ORDER — AND NOTHING ELSE CAN.
 *
 * The authority is delete_confirmed_order() (20270317000000). These tests pin
 * what is worth showing, how refusals are worded, that the route sequences the
 * work the way the design says (database first, files after), and that the
 * migration keeps the three promises it makes: admin only, typed number, and no
 * payment is ever deleted or released to make room.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderDeletion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELETE_ORDER_PAYMENTS_NOTE,
  DELETE_ORDER_WARNING,
  ORDER_DELETION_HTTP,
  canDeleteOrder,
  classifyOrderDeletionError,
  describeOrderDeletionFailure,
  orderDeletionConfirmationMatches,
} from './orderDeletion'
import { arrangeOrderActions, type OrderActionInput } from './orderWorkspace'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('who is offered the control', () => {
  test('an administrator is', () => {
    assert.equal(canDeleteOrder({ isAdmin: true, viewingAs: false }), true)
  })
  test('nobody else is', () => {
    assert.equal(canDeleteOrder({ isAdmin: false, viewingAs: false }), false)
  })
  test('an administrator previewing somebody else’s view is not: a preview performs no action', () => {
    assert.equal(canDeleteOrder({ isAdmin: true, viewingAs: true }), false)
  })
})

describe('the typed confirmation', () => {
  test('is the Order’s own number, exactly', () => {
    assert.equal(orderDeletionConfirmationMatches('0524', '0524'), true)
    assert.equal(orderDeletionConfirmationMatches('  0524 ', '0524'), true)
  })
  test('anything else is refused, including nothing', () => {
    assert.equal(orderDeletionConfirmationMatches('0525', '0524'), false)
    assert.equal(orderDeletionConfirmationMatches('', '0524'), false)
    assert.equal(orderDeletionConfirmationMatches('524', '0524'), false)
    assert.equal(orderDeletionConfirmationMatches('', ''), false)
    assert.equal(orderDeletionConfirmationMatches('x', null), false)
  })
})

describe('refusals are stable codes, worded for the person, never database text', () => {
  const markers: [string, string][] = [
    ['ORDER_DELETE_DENIED: only an administrator', 'DENIED'],
    ['ORDER_DELETE_MISSING: this Order no longer exists', 'MISSING'],
    ['ORDER_DELETE_CONFIRMATION: type the Order number 0524', 'CONFIRMATION'],
    ['ORDER_DELETE_BLOCKED_PAYMENTS: 2 payment allocation(s)', 'BLOCKED_PAYMENTS'],
    ['ORDER_DELETE_BLOCKED_REQUESTS: a retired Order Request', 'BLOCKED_REQUESTS'],
  ]
  for (const [message, code] of markers) {
    test(`${code}`, () => assert.equal(classifyOrderDeletionError(message), code))
  }

  test('an unknown error is a generic failure, and says nothing was deleted', () => {
    assert.equal(classifyOrderDeletionError('duplicate key value violates constraint "x"'), 'FAILED')
    assert.equal(classifyOrderDeletionError(null), 'FAILED')
    const failure = describeOrderDeletionFailure('FAILED')
    assert.ok(/Nothing has been deleted/.test(failure.message))
    assert.ok(!/constraint|violates|pg_|sqlstate/i.test(failure.message))
  })

  test('a payment in the way is a block, not an error, and says nothing was deleted', () => {
    const failure = describeOrderDeletionFailure('BLOCKED_PAYMENTS')
    assert.equal(failure.blocked, true)
    assert.ok(/Finance/.test(failure.message))
    assert.ok(/nothing has been deleted/i.test(failure.message))
  })

  test('an unrecognised code falls back rather than building a sentence from it', () => {
    assert.equal(describeOrderDeletionFailure('<script>').code, 'FAILED')
    assert.equal(describeOrderDeletionFailure(undefined).code, 'FAILED')
  })

  test('every code has an HTTP status', () => {
    for (const code of Object.keys(ORDER_DELETION_HTTP)) {
      assert.ok(ORDER_DELETION_HTTP[code as keyof typeof ORDER_DELETION_HTTP] >= 400)
    }
  })

  test('the warning says what goes and that it is permanent; the note says payments are safe', () => {
    assert.ok(/permanently/.test(DELETE_ORDER_WARNING))
    assert.ok(/cannot be undone/.test(DELETE_ORDER_WARNING))
    assert.ok(/PI/.test(DELETE_ORDER_WARNING))
    assert.ok(/never deleted or changed/.test(DELETE_ORDER_PAYMENTS_NOTE))
  })
})

describe('where the action sits on the Order page', () => {
  const base: OrderActionInput = {
    alignAction: null, canAmend: false, canRequest: false,
    canReviewChangeRequests: false, canCleanUp: false,
  }

  test('it is in the overflow, last, when allowed', () => {
    const layout = arrangeOrderActions({ ...base, canCleanUp: true, canRequest: true, canDeleteOrder: true })
    assert.equal(layout.overflow[layout.overflow.length - 1], 'delete_order')
    assert.ok(!layout.secondary.includes('delete_order'))
    assert.notEqual(layout.primary, 'delete_order')
  })

  test('it is absent unless allowed', () => {
    assert.ok(!arrangeOrderActions(base).overflow.includes('delete_order'))
    assert.ok(!arrangeOrderActions({ ...base, canDeleteOrder: false }).overflow.includes('delete_order'))
  })

  test('the page draws it from canDeleteOrder, which an admin preview never satisfies', () => {
    const page = read('src/app/orders/[id]/page.tsx')
    assert.ok(page.includes("canDeleteOrder({ isAdmin: profile?.role === 'admin', viewingAs: !!viewAsUserId })"))
    assert.ok(page.includes('<DeleteOrderModal'))
  })

  test('the dialog asks for the typed number and checks it before the button works', () => {
    const modal = read('src/app/orders/[id]/DeleteOrderModal.tsx')
    assert.ok(modal.includes('orderDeletionConfirmationMatches(typed, displayNumber)'))
    assert.ok(modal.includes('disabled={!matches || blocked}'))
    assert.ok(modal.includes('destructive'))
  })
})

describe('the route: the database first, the files after, and no Finance', () => {
  const route = read('src/app/api/orders/[id]/delete/route.ts')

  test('it authenticates, refuses a preview, and validates the id', () => {
    assert.ok(route.includes('await authClient.auth.getUser()'))
    assert.ok(route.includes('isPreviewRequest(req.headers)'))
    assert.ok(route.includes('SUBMISSION_ID_RE.test(orderId)'))
  })

  test('the service role is proven available BEFORE the Order is touched', () => {
    const configured = route.indexOf('adminClient()')
    const rpc = route.indexOf("rpc('delete_confirmed_order'")
    assert.ok(configured > 0 && rpc > configured)
  })

  test('the RPC runs as the signed-in user, and the sweep follows it', () => {
    const rpc = route.indexOf("authClient.rpc('delete_confirmed_order'")
    const sweep = route.indexOf('removeAllObjectsForOrder(')
    assert.ok(rpc > 0 && sweep > rpc, 'files are removed only after the Order is gone')
    assert.ok(!route.includes('service.rpc'))
  })

  test('a failed sweep never turns a completed deletion into an error', () => {
    assert.ok(route.includes('storageLeftBehind'))
    assert.ok(route.includes('ok: true'))
  })

  test('it never reads or writes Finance, and takes no key or prefix from the browser', () => {
    assert.ok(!/finance_payment|payment_proof|allocation/i.test(route.replace(/\/\/.*$/gm, '')))
    assert.ok(!route.includes('body?.path') && !route.includes('body?.prefix'))
  })
})

describe('the migration keeps its three promises', () => {
  const sql = read('supabase/migrations/20270317000000_order_submission_admin_order_deletion.sql')
  const code = sql.split(/\r?\n/).filter(line => !line.trim().startsWith('--')).join('\n')
  const start = code.indexOf('create or replace function public.delete_confirmed_order')
  const fn = code.slice(start, code.indexOf('comment on function public.delete_confirmed_order', start))

  test('admin only: an active administrator, checked from auth.uid()', () => {
    assert.ok(fn.includes('auth.uid()'))
    assert.ok(fn.includes("u.role = 'admin'"))
    assert.ok(fn.includes('u.is_active'))
  })

  test('the typed number is checked in the database, not only on the screen', () => {
    assert.ok(fn.includes('ORDER_DELETE_CONFIRMATION'))
    assert.ok(fn.includes('display_number'))
  })

  test('money blocks it: allocations, intents and linked payment requests are all counted first', () => {
    const blocked = fn.indexOf('ORDER_DELETE_BLOCKED_PAYMENTS')
    const point = fn.indexOf("set_config('boe.cleanup_context'")
    assert.ok(blocked > 0 && point > blocked, 'every refusal comes before the guards are stood down')
    for (const table of ['finance_payment_allocations', 'finance_payment_allocation_intents', 'finance_payment_requests']) {
      assert.ok(fn.includes(`public.${table}`), `${table} must be consulted`)
    }
  })

  test('no payment or proof is ever deleted, and no payment row is released other than a leftover', () => {
    assert.ok(!/delete from public\.finance_payment_requests/.test(fn))
    assert.ok(!/delete from public\.payment_proof_attachments/.test(fn))
    assert.ok(!/update public\.finance_payment/.test(fn))
    assert.ok(fn.includes('allocation_released_by_payment_deletion'))
  })

  test('the guards are stood down only after the checks and cleared before returning', () => {
    assert.ok(fn.indexOf("set_config('boe.cleanup_context', 'test_data_cleanup', true)") > 0)
    assert.ok(fn.includes("set_config('boe.cleanup_context', '', true)"))
    assert.ok(fn.includes("set_config('boe.order_purge_id', '', true)"))
  })

  test('direct deletes stay refused: the Order guard is asserted armed, and execute is not public', () => {
    assert.ok(code.includes("tgname = 'orders_prevent_delete'"))
    assert.ok(code.includes('revoke all on function public.delete_confirmed_order(uuid, text) from public, anon'))
    assert.ok(code.includes('revoke execute on function public.order_purge_in_progress(uuid)'))
  })

  test('the log has no foreign key to the Order and is append-only', () => {
    assert.ok(!/order_id\s+uuid not null references/.test(code))
    assert.ok(code.includes('order_deletion_log_immutable'))
  })
})
