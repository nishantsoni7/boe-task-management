/**
 * AN ADMINISTRATOR CAN GIVE A CONFIRMED ORDER A DIFFERENT, UNUSED NUMBER.
 *
 * The authority is change_confirmed_order_number() (20270502000000). These
 * tests pin what is worth showing, how refusals are worded, that the route asks
 * the database as the signed-in user, and that the migration keeps the Order
 * number lock everywhere except inside that one door, for that one Order.
 * What the SQL actually does is proven by executing it on a scratch database:
 *   node supabase/tests/order_number_rename_pglite.mjs <dir with @electric-sql/pglite>
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderNumberChange.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORDER_NUMBER_CHANGE_HTTP,
  canChangeOrderNumber,
  classifyOrderNumberChangeError,
  describeOrderNumberChange,
  describeOrderNumberChangeFailure,
  normalizeNewOrderNumber,
} from './orderNumberChange'
import { arrangeOrderActions, type OrderActionInput } from './orderWorkspace'
import { describeOrderEvent, ORDER_EVENT_LABEL } from './orderHistory'
import { isMainActivityEvent } from './orderActivityImportance'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = 'supabase/migrations/20270502000000_order_number_rename.sql'

describe('who sees the control', () => {
  test('an administrator, not previewing', () => {
    assert.equal(canChangeOrderNumber({ isAdmin: true, viewingAs: false }), true)
    assert.equal(canChangeOrderNumber({ isAdmin: false, viewingAs: false }), false)
    assert.equal(canChangeOrderNumber({ isAdmin: true, viewingAs: true }), false)
  })
})

describe('what may be typed', () => {
  test('1 to 4 digits, stored four-digit', () => {
    assert.equal(normalizeNewOrderNumber('508'), '0508')
    assert.equal(normalizeNewOrderNumber(' 0508 '), '0508')
    assert.equal(normalizeNewOrderNumber('1'), '0001')
    assert.equal(normalizeNewOrderNumber('9999'), '9999')
  })

  test('anything else is refused before the database is asked', () => {
    for (const bad of ['', ' ', '0', '0000', '10000', 'abc', '5a', '-5', '5.0', '50 8', 'BOE-508']) {
      assert.equal(normalizeNewOrderNumber(bad), null, bad)
    }
  })
})

describe('refusals', () => {
  test('every database marker maps to a stable code', () => {
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_DENIED: x'), 'DENIED')
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_MISSING: x'), 'MISSING')
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_INVALID: x'), 'INVALID')
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_SAME: x'), 'SAME')
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_IN_USE: x'), 'IN_USE')
    assert.equal(classifyOrderNumberChangeError('duplicate key value violates unique constraint "orders_display_number_key"'), 'IN_USE')
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_RESERVED: x'), 'RESERVED')
    assert.equal(classifyOrderNumberChangeError('ORDER_NUMBER_CHANGE_TOO_HIGH: x'), 'TOO_HIGH')
    assert.equal(classifyOrderNumberChangeError('something else'), 'FAILED')
    assert.equal(classifyOrderNumberChangeError(null), 'FAILED')
  })

  test('an unknown code reads as FAILED, and every code has a status', () => {
    assert.equal(describeOrderNumberChangeFailure('nope').code, 'FAILED')
    assert.equal(describeOrderNumberChangeFailure(undefined).code, 'FAILED')
    assert.equal(ORDER_NUMBER_CHANGE_HTTP.IN_USE, 409)
    assert.equal(ORDER_NUMBER_CHANGE_HTTP.DENIED, 403)
    assert.match(describeOrderNumberChangeFailure('IN_USE').message, /another Order/)
  })
})

describe('what the administrator is told afterwards', () => {
  test('the newest number goes to the next Order', () => {
    assert.equal(
      describeOrderNumberChange({ previousNumber: '0541', displayNumber: '0508', nextNumber: '0541', oldNumberIsNext: true }),
      'Order 541 is now Order 508. The next Order will be given 541.')
  })

  test('any other number is left unused, and says so', () => {
    assert.equal(
      describeOrderNumberChange({ previousNumber: '0538', displayNumber: '0535', nextNumber: '0542', oldNumberIsNext: false }),
      'Order 538 is now Order 535. 538 is left unused: it was not the newest Order number.')
  })
})

describe('where the action sits on the Order page', () => {
  const base: OrderActionInput = {
    alignAction: null, canAmend: false, canRequest: false,
    canReviewChangeRequests: false, canCleanUp: false,
  }

  test('in the overflow, just before Delete Order, only when allowed', () => {
    const layout = arrangeOrderActions({ ...base, canChangeOrderNumber: true, canDeleteOrder: true })
    assert.deepEqual(layout.overflow.slice(-2), ['change_number', 'delete_order'])
    assert.ok(!layout.secondary.includes('change_number'))
    assert.ok(!arrangeOrderActions(base).overflow.includes('change_number'))
  })

  test('the page draws it from canChangeOrderNumber and reloads the Order after', () => {
    const page = read('src/app/orders/[id]/page.tsx')
    assert.ok(page.includes("canChangeOrderNumber: canChangeOrderNumber({ isAdmin: profile?.role === 'admin', viewingAs: !!viewAsUserId })"))
    assert.ok(page.includes('<ChangeOrderNumberModal'))
    assert.ok(page.includes("case 'change_number':        setChangeNumberOpen(true); return"))
    assert.ok(page.includes('onChanged={() => { loadOrder() }}'))
  })

  test('the dialog posts the typed number to the route and checks it first', () => {
    const modal = read('src/app/orders/[id]/ChangeOrderNumberModal.tsx')
    assert.ok(modal.includes('normalizeNewOrderNumber(typed)'))
    assert.ok(modal.includes('/number`'))
    assert.ok(modal.includes('disabled={normalized === null || same}'))
  })
})

describe('the Activity trail', () => {
  test('the event is labelled, described and shown as a main event', () => {
    assert.equal(ORDER_EVENT_LABEL.order_number_changed, 'Order number changed')
    assert.equal(
      describeOrderEvent({ id: '1', event_type: 'order_number_changed', created_at: '',
        payload: { from: '0541', to: '0508', old_number_is_next: true } }),
      '541 → 508 · 541 goes to the next Order')
    assert.equal(
      describeOrderEvent({ id: '1', event_type: 'order_number_changed', created_at: '',
        payload: { from: '0538', to: '0535', old_number_is_next: false } }),
      '538 → 535')
    assert.equal(isMainActivityEvent({ source: 'order', label: 'Order number changed', eventType: 'order_number_changed' }), true)
  })
})

describe('the route asks the database as the signed-in user', () => {
  const route = read('src/app/api/orders/[id]/number/route.ts')

  test('it authenticates, refuses a preview, validates the id and the number', () => {
    assert.ok(route.includes('await authClient.auth.getUser()'))
    assert.ok(route.includes('isPreviewRequest(req.headers)'))
    assert.ok(route.includes('SUBMISSION_ID_RE.test(orderId)'))
    assert.ok(route.includes("normalizeNewOrderNumber(typed) === null) return fail('INVALID')"))
  })

  test('it calls the one RPC with the user session and never the service role', () => {
    assert.ok(route.includes("authClient.rpc('change_confirmed_order_number'"))
    assert.ok(!route.includes('adminClient'))
    assert.ok(!/\.from\('orders'\)/.test(route))
  })
})

describe('the migration', () => {
  const sql = read(MIGRATION)

  test('the Order number lock opens only for the one Order being renamed', () => {
    assert.ok(sql.includes("coalesce(current_setting('boe.order_number_rename', true), '') <> old.id::text"))
    assert.ok(sql.includes("'ORDER_NUMBER_IMMUTABLE: An Order number cannot be changed once the Order exists'"))
    assert.ok(sql.includes("coalesce(current_setting('boe.order_number_rename', true), '') <> old.order_id::text"))
    assert.ok(sql.includes("'PI_PDF_ORDER_NUMBER_IMMUTABLE: the Order number printed on PI version % cannot be changed'"))
  })

  test('the PI version INSERT branch is carried over unchanged from 20270201000000', () => {
    const original = read('supabase/migrations/20270201000000_order_pi_version_pdf_order_number.sql')
    const branch = (text: string) => {
      const start = text.indexOf("  if tg_op = 'INSERT' then", text.lastIndexOf('create or replace function public.order_pi_versions_pdf_order_number()'))
      return text.slice(start, text.indexOf('  end if;\n', text.indexOf('return new;', start)))
    }
    assert.equal(branch(sql), branch(original))
  })

  test('the door: active admin, lock order, uniqueness, reservations, below the next number', () => {
    assert.ok(sql.includes("u.role = 'admin'\n      and u.is_active is true and u.is_deleted is false"))
    const cycle = sql.indexOf('from public.order_number_cycle c where c.id = true for update')
    const order = sql.indexOf('from public.orders o where o.id = p_order_id for update')
    assert.ok(cycle > 0 && order > cycle, 'the cycle row is locked before the Order, like allocation')
    assert.ok(sql.includes('ORDER_NUMBER_CHANGE_IN_USE'))
    assert.ok(sql.includes('from public.order_reserved_number_ledger l'))
    assert.ok(sql.includes('if v_new_n >= v_next then'))
    assert.ok(sql.includes("perform set_config('boe.order_number_rename', p_order_id::text, true);"))
    assert.ok(sql.includes("perform set_config('boe.order_number_rename', '', true);"))
  })

  test('the old number goes back only when it was the newest', () => {
    assert.ok(sql.includes('if v_next = v_old_n + 1'))
    assert.ok(sql.includes('update public.order_number_cycle set next_number = v_old_n where id = true;'))
  })

  test('only authenticated callers may execute it', () => {
    assert.ok(sql.includes('revoke execute on function public.change_confirmed_order_number(uuid, text)\n  from public, anon, service_role;'))
    assert.ok(sql.includes('grant execute on function public.change_confirmed_order_number(uuid, text)\n  to authenticated;'))
  })

  test('it writes no data on apply', () => {
    const outsideFunctions = sql.replace(/as \$\$[\s\S]*?\n\$\$;/g, '').replace(/do \$\$[\s\S]*?end \$\$;/g, '')
    assert.ok(!/^\s*(insert|update|delete)\s/im.test(outsideFunctions))
  })
})
