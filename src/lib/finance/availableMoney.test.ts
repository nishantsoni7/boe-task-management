/**
 * Payments counted once, Step 1 (20270505000000): the four words, money already
 * received from this client, and the approver's Close / Return choice.
 *
 * The database half is proven against the real functions in
 * supabase/tests/payments_counted_once_pglite.mjs (21 checks); this file holds
 * the browser half and pins the migration's few load-bearing lines.
 *
 * Run: npm run test:file -- src/lib/finance/availableMoney.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyAvailableMoney,
  availableMoneyErrorMessage,
  availableMoneyUsedNotice,
  canSearchAvailableMoney,
  describeAvailablePayment,
  formatShortDate,
  piDecisionMoneyNote,
  searchAvailableMoney,
  type AvailablePayment,
} from './availableMoney'
import { PAYMENT_STATUS_WORD, paymentStatusWord, paymentStepTone } from './paymentWords'
import { PI_PAYMENT_STATUS_LABEL, piPaymentStatusLabel } from './piPaymentView'
import { PAYMENT_DISPLAY_STATE_META } from './paymentDestination'
import { REJECT_BUTTON_LABEL, REQUEST_CHANGES_BUTTON_LABEL } from '@/lib/orders/submissionWorkflow'
import { PI_DRAFT_STATUS_LABEL } from '@/lib/orders/draftsView'

const MIGRATION = readFileSync(join('supabase', 'migrations', '20270505000000_order_submission_close_returns_payments.sql'), 'utf8')

function fakeClient(answer: { data: unknown; error: { message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      return Promise.resolve(answer)
    },
  }
}

const row = (over: Partial<AvailablePayment> = {}): AvailablePayment => ({
  payment_id: 'p1', payment_number: 'P-AB-0123', amount: 50000, available: 50000,
  payment_date: '2026-10-12', payment_mode: 'hdfc', status: 'approved_linked', verified: true,
  closed_pi_reference: 'PID-00231', ...over,
})

describe('the four words', () => {
  test('every stored status prints one of four words', () => {
    assert.deepEqual([...new Set(Object.values(PAYMENT_STATUS_WORD))].sort(),
      ['Needs Clarification', 'Rejected', 'Verified', 'Waiting for Finance'])
    assert.equal(paymentStatusWord('pending_approval'), 'Waiting for Finance')
    assert.equal(paymentStatusWord('approved_unlinked'), 'Verified')
    assert.equal(paymentStatusWord('approved_linked'), 'Verified')
  })

  test('the PI card, the Order page and Finance say the same thing', () => {
    assert.equal(PI_PAYMENT_STATUS_LABEL, PAYMENT_STATUS_WORD)
    assert.equal(piPaymentStatusLabel('pending_approval'), 'Waiting for Finance')
    assert.equal(PAYMENT_DISPLAY_STATE_META.pending.label, 'Waiting for Finance')
    assert.equal(PAYMENT_DISPLAY_STATE_META.received.label, 'Verified')
    assert.match(PAYMENT_DISPLAY_STATE_META.received_unallocated.label, /^Verified/)
    for (const meta of Object.values(PAYMENT_DISPLAY_STATE_META)) {
      assert.doesNotMatch(meta.label, /Pending|Received|Awaiting/)
    }
  })

  test('the tracker reads green for verified, amber while waiting, red when rejected', () => {
    assert.equal(paymentStepTone('approved_linked'), 'done')
    assert.equal(paymentStepTone('pending_approval'), 'waiting')
    assert.equal(paymentStepTone('needs_clarification'), 'waiting')
    assert.equal(paymentStepTone('rejected'), 'problem')
  })
})

describe("the approver's two choices", () => {
  test('Return to Sales and Close: deal lost, and the PI status says the same', () => {
    assert.equal(REQUEST_CHANGES_BUTTON_LABEL, 'Return to Sales')
    assert.equal(REJECT_BUTTON_LABEL, 'Close: deal lost')
    assert.equal(PI_DRAFT_STATUS_LABEL.needs_changes, 'Returned to Sales')
    assert.equal(PI_DRAFT_STATUS_LABEL.rejected, 'Closed (deal lost)')
  })

  test('the window says what happens to the money on the PI', () => {
    assert.equal(piDecisionMoneyNote('reject', '50000'),
      '₹50,000.00 is recorded on this PI. Closing hands it back to the client’s money, ready for their next PI or Order.')
    assert.equal(piDecisionMoneyNote('needs_changes', 50000), '₹50,000.00 is recorded on this PI and stays on it.')
    assert.equal(piDecisionMoneyNote('reject', 0), null)
    assert.equal(piDecisionMoneyNote('reject', null), null)
    assert.equal(piDecisionMoneyNote('reject_exception', 50000), null)
  })
})

describe('money already received from this client', () => {
  test('the search runs only once there is a valid amount and a date', () => {
    assert.equal(canSearchAvailableMoney('50000', '2026-10-21'), true)
    assert.equal(canSearchAvailableMoney('50000.5', '2026-10-21'), true)
    assert.equal(canSearchAvailableMoney('', '2026-10-21'), false)
    assert.equal(canSearchAvailableMoney('0', '2026-10-21'), false)
    assert.equal(canSearchAvailableMoney('50,000', '2026-10-21'), false)
    assert.equal(canSearchAvailableMoney('50000', ''), false)
  })

  test('it asks the database door with exactly one target and nothing else', async () => {
    const client = fakeClient({ data: [row()], error: null })
    const rows = await searchAvailableMoney(client, { submissionId: 'pi-1' }, ' 50000 ', '2026-10-21')
    assert.equal(rows.length, 1)
    assert.deepEqual(client.calls, [{ fn: 'client_available_payments', args: {
      p_submission_id: 'pi-1', p_order_id: null, p_amount: 50000, p_payment_date: '2026-10-21',
    } }])
  })

  test('an unfinished form never asks, and a refusal shows nothing', async () => {
    const client = fakeClient({ data: [row()], error: null })
    assert.deepEqual(await searchAvailableMoney(client, { orderId: 'o-1' }, '', '2026-10-21'), [])
    assert.equal(client.calls.length, 0)
    const refused = fakeClient({ data: null, error: { message: 'PI_PAYMENT_NOT_PERMITTED: no' } })
    assert.deepEqual(await searchAvailableMoney(refused, { submissionId: 'pi-1' }, '1', '2026-10-21'), [])
  })

  test('each match says what it is, where it was and whether it is all free', () => {
    const d = describeAvailablePayment(row())
    assert.equal(d.number, 'P-AB-0123')
    assert.equal(d.amount, '₹50,000.00')
    assert.equal(d.status, 'Verified')
    assert.equal(d.where, 'Was on PID-00231, which was closed')
    assert.match(d.facts, /^12 Oct 2026 · HDFC/)
    const partly = describeAvailablePayment(row({ amount: 100000, available: 40000, closed_pi_reference: null, status: 'pending_approval', verified: false }))
    assert.equal(partly.where, 'Not on any PI or Order yet')
    assert.match(partly.facts, /₹40,000.00 free of ₹1,00,000.00/)
    assert.equal(partly.status, 'Waiting for Finance')
    assert.equal(formatShortDate('2026-01-05'), '5 Jan 2026')
  })

  test('Use this money calls the door, and the notice says whether it counts at once', async () => {
    const client = fakeClient({ data: { payment_number: 'P-AB-0123', request_number: 'PAY-REQ-2026-0001', allocated_amount: 50000, status: 'approved_linked' }, error: null })
    const result = await applyAvailableMoney(client, 'p1', { submissionId: 'pi-2' })
    assert.deepEqual(client.calls[0], { fn: 'use_available_payment', args: { p_payment_id: 'p1', p_submission_id: 'pi-2', p_order_id: null } })
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(availableMoneyUsedNotice(result, 'PI'), 'P-AB-0123 (₹50,000.00) is now on this PI. It stays Verified, so it counts at once.')
      assert.equal(availableMoneyUsedNotice({ ...result, verified: false }, 'Order'), 'P-AB-0123 (₹50,000.00) is now on this Order. It is still waiting for Finance.')
    }
  })

  test('every refusal becomes a fixed sentence; no database text reaches the screen', async () => {
    const refused = fakeClient({ data: null, error: { message: 'PAYMENT_CLIENT_MISMATCH: payment P-AB-0130 belongs to another client.' } })
    const result = await applyAvailableMoney(refused, 'p9', { orderId: 'o-1' })
    assert.deepEqual(result, { ok: false, message: 'This payment belongs to another client, so it cannot be used here.' })
    assert.equal(availableMoneyErrorMessage('ALLOCATION_DUPLICATE: x'), 'This payment is already on this record.')
    assert.equal(availableMoneyErrorMessage('relation "x" does not exist'), 'Could not use this payment. Please try again.')
  })
})

describe('the migration keeps its load-bearing lines', () => {
  test('both new functions open with the payment forms’ own doors', () => {
    const searchFn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.client_available_payments('))
    const useFn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.use_available_payment('))
    for (const body of [searchFn, useFn]) {
      assert.match(body, /assert_finance_payment_door\('record_pi_submission_payment', p_submission_id\)/)
      assert.match(body, /assert_finance_payment_door\('record_payment_with_allocations'\)/)
    }
  })

  test('the search cannot be used to browse: same client, same amount, a date window, three rows', () => {
    const body = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.client_available_payments('),
      MIGRATION.indexOf('create or replace function public.use_available_payment('))
    assert.match(body, /client_name_key\(p\.client_name\) = v_key/)
    assert.match(body, /p\.amount = p_amount or f\.free = p_amount/)
    assert.match(body, /between p_payment_date - 30 and p_payment_date \+ 30/)
    assert.match(body, /limit 3/)
  })

  test('closing a PI reverses its allocations and cancels its pending intents, never touching the payment', () => {
    const body = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.reject_order_submission('),
      MIGRATION.indexOf('create or replace function public.client_available_payments('))
    assert.match(body, /set status\s+= 'reversed'/)
    assert.match(body, /update public\.finance_payment_allocation_intents/)
    assert.doesNotMatch(body, /update public\.finance_payment_requests/)
  })
})
