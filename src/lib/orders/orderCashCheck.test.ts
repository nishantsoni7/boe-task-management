/**
 * APPROVING AN ORDER BEFORE ITS CASH REACHED THE COMPANY (20270414000000) — the
 * pure half, and the source contracts that keep the rule in the database.
 *
 * The rule itself (an Order with uncovered cash is refused; the approver's
 * reason covers it) is proven on a real engine by the PGlite harness.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderCashCheck.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EMPTY_ORDER_CASH_ACK,
  orderCashAckError,
  orderCashFailureMessage,
  readOrderCashCheck,
} from './orderCashCheck'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SQL = read('supabase/migrations/20270414000000_order_submission_cash_exceptions.sql')
const code = (s: string) => s.replace(/--.*$/gm, '')

const cashRow = (over: Record<string, unknown> = {}) => ({
  payment_id: 'p1', human_payment_id: 'P-AA-0001', amount: 5000, payment_mode: 'paytm', state: 'with_holder',
  holder_id: 'u1', holder_name: 'Ashok', holder_since: 'x', age_hours: 50, tracked: true, ...over,
})

describe('reading the check', () => {
  test('uncovered payments and recorded exceptions are read', () => {
    const c = readOrderCashCheck({
      uncovered: [cashRow(), { nonsense: true }],
      covered: [{ reason: 'Nishant is out of town', by_name: 'Nitish Bansal', at: 't', payment_count: 1 }, { reason: '' }],
    })
    assert.equal(c?.uncovered.length, 1)
    assert.equal(c?.uncovered[0].holderName, 'Ashok')
    assert.deepEqual(c?.covered.map(x => x.byName), ['Nitish Bansal'])
    assert.equal(readOrderCashCheck(null), null)
  })

  test('a payment carries the exception its Order was approved with', () => {
    const c = readOrderCashCheck({ uncovered: [cashRow({ order_exception: { reason: 'Out of town', by_name: 'Nitish Bansal', at: 't' } })], covered: [] })
    assert.equal(c?.uncovered[0].orderException?.reason, 'Out of town')
    const plain = readOrderCashCheck({ uncovered: [cashRow({ order_exception: null })], covered: [] })
    assert.equal(plain?.uncovered[0].orderException, null)
  })
})

describe('what the approver must do', () => {
  const pending = readOrderCashCheck({ uncovered: [cashRow()], covered: [] })
  const clear = readOrderCashCheck({ uncovered: [], covered: [] })

  test('nothing is asked when no cash is outstanding', () => {
    assert.equal(orderCashAckError(clear, EMPTY_ORDER_CASH_ACK), null)
    assert.equal(orderCashAckError(null, EMPTY_ORDER_CASH_ACK), null)
  })

  test('outstanding cash needs the tick and a reason of at least 10 characters', () => {
    assert.match(orderCashAckError(pending, EMPTY_ORDER_CASH_ACK) ?? '', /Tick "Approve without this cash"/)
    assert.match(orderCashAckError(pending, { ticked: true, reason: 'away' }) ?? '', /at least 10/)
    assert.equal(orderCashAckError(pending, { ticked: true, reason: 'Nishant is out of town' }), null)
    assert.match(orderCashAckError(pending, { ticked: true, reason: 'x'.repeat(501) }) ?? '', /under 500/)
  })

  test('only the database\'s own cash refusals are claimed', () => {
    assert.equal(
      orderCashFailureMessage({ message: 'ORDER_SUBMISSION_CASH_NOT_RECEIVED: the cash of P-AA-0001 has not reached the company yet.' }),
      'the cash of P-AA-0001 has not reached the company yet.')
    assert.equal(orderCashFailureMessage({ message: 'ORDER_CONFIRMATION_DUE_DATE_REQUIRED: x' }), null)
    assert.equal(orderCashFailureMessage(null), null)
  })
})

describe('source contracts', () => {
  const c = code(SQL)

  test('the rule lives on orders, before insert, and approve_order_submission is not touched', () => {
    assert.match(c, /create trigger orders_require_cash_or_exception_trg\s+before insert on public\.orders/)
    assert.doesNotMatch(c, /create or replace function public\.approve_order_submission/)
  })

  test('only verified, tracked, unclosed cash actively allocated to the PI counts', () => {
    const fn = c.slice(c.indexOf('function public.order_submission_unreceived_cash('), c.indexOf('function public.order_submission_uncovered_cash('))
    for (const part of ["a.status = 'active'", 'f.deleted_at is null', 'finance_payment_status_is_verified(f.status)',
                        'payment_mode_requires_custody(f.payment_mode)', 'not public.finance_payment_is_closed(f.id)']) {
      assert.ok(fn.includes(part), part)
    }
  })

  test('only an order approver records an exception, with a 10–500 character reason', () => {
    assert.match(c, /not public\.actor_can_approve_order\(\) then\s+raise exception 'ORDER_SUBMISSION_CASH_EXCEPTION_NOT_ALLOWED/)
    assert.match(c, /char_length\(v_reason\) < 10 or char_length\(v_reason\) > 500/)
  })

  test('exceptions are permanent and only the RPC writes them', () => {
    assert.match(c, /before update on public\.order_submission_cash_exceptions/)
    assert.match(c, /revoke all on public\.order_submission_cash_exceptions from public, anon, authenticated;/)
    for (const fn of ['order_submission_unreceived_cash(uuid)', 'order_submission_uncovered_cash(uuid)', 'orders_require_cash_or_exception()']) {
      assert.ok(SQL.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn)
    }
  })

  test('not financial: no payment, total or allocation is written', () => {
    assert.doesNotMatch(c, /update\s+public\.finance_payment_(requests|allocations)/i)
    assert.doesNotMatch(c, /insert\s+into\s+public\.finance_payment_(requests|allocations)/i)
  })

  test('every security definer function pins its search_path', () => {
    const defs = SQL.match(/security definer\s+set search_path = public, pg_temp/g) ?? []
    const all = SQL.match(/security definer/g) ?? []
    assert.equal(defs.length, all.length)
  })

  test('the page asks for the reason before it sends anything, and records it before approving', () => {
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    const approve = page.slice(page.indexOf('const approveSubmission = useCallback'), page.indexOf('const approvePiReview'))
    assert.ok(approve.indexOf('orderCashAckError(') < approve.indexOf('runAction('))
    assert.ok(approve.indexOf('recordOrderCashException(') < approve.indexOf("supabase.rpc('approve_order_submission'"))
  })
})
