/**
 * The cards for records waiting on the viewer: the words, where each one goes,
 * and that Clear all treats a changed record as new.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  changeRequestCard,
  isOpenForOperations,
  operationsCard,
  paymentRequestCard,
  piApprovalCard,
  sentBackCard,
  type OperationsRow,
  type PaymentRequestRow,
} from './forYouWork'

const NOW = new Date().toISOString()

const payment: PaymentRequestRow = {
  id: 'p1',
  client_name: 'Sample Client',
  amount: '120000.00',
  payment_mode: 'cash',
  created_at: NOW,
  updated_at: NOW,
  submitted_by_user: { full_name: 'Dhruv' },
}

const handoff: OperationsRow = {
  id: 'h1',
  order_id: 'o1',
  version_number: 2,
  approved_at: NOW,
  created_at: NOW,
  order: { client_name: 'Sample Client', display_number: '0539', status: 'in_production' },
}

describe('a new payment request', () => {
  test('says how much, from whom and who sent it, and opens that payment', () => {
    const card = paymentRequestCard(payment)
    assert.equal(card.label, 'Payment request · just now')
    assert.equal(card.brief, '₹1,20,000 · Sample Client')
    assert.match(card.detail, /^Sent by Dhruv · /)
    assert.equal(card.action, 'Review')
    assert.equal(card.href, '/finance?tab=pending&request=p1')
  })

  test('a payment naming no customer still reads as a sentence', () => {
    assert.ok(!paymentRequestCard({ ...payment, client_name: null }).brief.endsWith('· '))
  })

  test('an unknown sender and mode leave no dangling separator', () => {
    assert.equal(paymentRequestCard({ ...payment, submitted_by_user: null, payment_mode: null }).detail, '')
  })

  test('resubmitted after Clear all, it is a new item', () => {
    const later = paymentRequestCard({ ...payment, updated_at: '2030-01-01T00:00:00Z' })
    assert.notEqual(paymentRequestCard(payment).key, later.key)
  })
})

describe('a payment sent back', () => {
  test('names the payment and opens the clarification tab', () => {
    const card = sentBackCard({
      id: 'p2', human_payment_id: 'P-AB-0142', request_number: 'PAY-REQ-9', client_name: 'Sample Client',
      amount: 45000, clarification_requested_at: NOW, updated_at: NOW,
    })
    assert.equal(card.label, 'Sent back to you · just now')
    assert.equal(card.detail, 'P-AB-0142 · Finance has a question')
    assert.equal(card.href, '/finance?tab=clarification&request=p2')
  })
})

describe('a PI waiting for approval', () => {
  test('opens the PI, and a PI with no client name is still labelled', () => {
    const card = piApprovalCard({
      id: 's1', client_name: null, bill_to_name: null, draft_reference: 'PID-00021',
      submitted_at: NOW, created_at: NOW, submitted_by_user: { full_name: 'Mohit' },
    })
    assert.equal(card.brief, 'Unnamed client')
    assert.equal(card.detail, 'PID-00021 · Submitted by Mohit')
    assert.equal(card.href, '/orders/drafts/s1')
  })
})

describe('an Order change request', () => {
  const row = {
    id: 'c1', order_id: 'o1', order_number_snapshot: '0539', request_type: 'edit' as const, created_at: NOW,
    order: { client_name: 'Sample Client' }, requested_by_user: { full_name: 'Mohit' },
  }

  test('opens the Order, with the number written as everywhere else', () => {
    const card = changeRequestCard(row)
    assert.equal(card.brief, 'Order 539 · Sample Client')
    assert.equal(card.href, '/orders/o1')
  })

  test('a cancellation says so', () => {
    assert.match(changeRequestCard({ ...row, request_type: 'cancel' }).label, /^Cancellation request · /)
  })
})

describe('a PI waiting for Operations', () => {
  test('opens the review card on the Order', () => {
    const card = operationsCard(handoff)
    assert.equal(card.detail, 'PI V2 needs your review')
    assert.equal(card.href, '/orders/o1#operations-review')
  })

  test('a cancelled Order has nothing left to accept', () => {
    assert.equal(isOpenForOperations(handoff), true)
    assert.equal(isOpenForOperations({ ...handoff, order: { ...handoff.order!, status: 'cancelled' } }), false)
  })
})
