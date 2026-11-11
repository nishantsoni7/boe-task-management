/**
 * The cards for records waiting on the viewer: the words, where each one goes,
 * and that Clear all treats a changed record as new.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  changeRequestCard,
  flaggedCard,
  isOpenForOperations,
  operationsCard,
  paymentRequestCard,
  piApprovalCard,
  sentBackCard,
  verifyCardApplies,
  type OperationsRow,
  type PaymentRequestRow,
  type VerifyContext,
} from './forYouWork'

const NOW = new Date().toISOString()

const payment: PaymentRequestRow = {
  id: 'p1',
  client_name: 'Sample Client',
  amount: '120000.00',
  payment_mode: 'cash',
  created_at: NOW,
  updated_at: NOW,
  submitted_by: 'dhruv',
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

// Whether a pending payment gets a verify card at all (owner, 2026-11-11): the
// owner is an admin who verifies, but is in no cash chain, so money on its way
// to the company is not his to verify.
describe('who is told to verify a payment', () => {
  const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
    userId: 'owner', decidesOwnPayments: false, viewerIsCustodian: false, inTransit: new Set<string>(), ...over,
  })
  const pnb = { id: 'p1', payment_mode: 'pnb', submitted_by: 'mohit' }
  const hdfc = { id: 'p2', payment_mode: 'hdfc', submitted_by: 'mohit' }

  test('a cash-route payment still on its way is not for a verifier: it is news, not a task', () => {
    assert.equal(verifyCardApplies(pnb, ctx({ inTransit: new Set(['p1']), viewerIsCustodian: true })), false)
  })

  test('until the list of payments on their way is known, a cash-route payment is not judged', () => {
    assert.equal(verifyCardApplies(pnb, ctx({ inTransit: null, viewerIsCustodian: true })), false)
  })

  test('once its cash reached the company, a custodian is told', () => {
    assert.equal(verifyCardApplies(pnb, ctx({ viewerIsCustodian: true })), true)
  })

  test('an admin in no chain, who did not record it, is not told', () => {
    assert.equal(verifyCardApplies(pnb, ctx()), false)
  })

  test('the one who recorded it is told, if they may decide their own', () => {
    const own = { ...pnb, submitted_by: 'owner' }
    assert.equal(verifyCardApplies(own, ctx({ decidesOwnPayments: true })), true)
    assert.equal(verifyCardApplies(own, ctx({ decidesOwnPayments: false })), false)
  })

  test('a bank payment has no chain: every verifier is told, whether or not the list is known', () => {
    assert.equal(verifyCardApplies(hdfc, ctx({ inTransit: null })), true)
    assert.equal(verifyCardApplies({ ...hdfc, payment_mode: 'cash' }, ctx()), true)
  })

  test('a bank payment they recorded themselves still needs the right to decide it', () => {
    assert.equal(verifyCardApplies({ ...hdfc, submitted_by: 'owner' }, ctx()), false)
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

describe('a PI flagged by Operations', () => {
  const flagged = {
    handoffId: 'h9', orderId: 'o546', orderNumber: '546', clientName: 'Qavaali', versionNumber: 1,
    reason: 'As per mohit... client wanted a visit from our side before aligning the order', byName: 'Nitish Bansal',
    since: NOW, waitingSeconds: 0,
  }

  test('names the Order and client, says what Operations could not accept, and opens the Order to answer', () => {
    const card = flaggedCard(flagged)
    assert.match(card.label, /^PI flagged by Operations · /)
    assert.equal(card.brief, 'Order 546 · Qavaali')
    assert.match(card.detail, /^Operations cannot accept PI V1 · “As per mohit/)
    assert.equal(card.action, 'Respond')
    assert.equal(card.href, '/orders/o546')
  })

  test('is drawn urgent: the Order waits until somebody answers', () => {
    assert.equal(flaggedCard(flagged).urgent, true)
  })

  test('flagged again later is a new item, shown at once after Clear all', () => {
    assert.notEqual(flaggedCard(flagged).key, flaggedCard({ ...flagged, since: '2030-01-01T00:00:00.000Z' }).key)
  })

  test('a long reason is cut to one line on the card', () => {
    assert.ok(flaggedCard({ ...flagged, reason: 'x'.repeat(900) }).detail.length < 220)
  })
})
