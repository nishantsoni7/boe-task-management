/**
 * "Pending from <name> · 3 days" (owner, 2026-11-11): one card per payment still
 * on its way to the company, saying whose move it is. The owner's own case:
 * Mohit gave cash to Dhruv, Dhruv has not accepted it.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { CashPayment, OpenHandoverRef } from '@/lib/finance/cashJourney'
import { pendingFromCard, pendingFromCards } from './forYouPending'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const handover = (over: Partial<OpenHandoverRef> = {}): OpenHandoverRef => ({
  id: 'h1', humanId: 'H-1', status: 'pending',
  giverId: 'mohit', giverName: 'Mohit', recipientId: 'dhruv', recipientName: 'Dhruv',
  createdAt: hoursAgo(72), ...over,
})

const payment = (over: Partial<CashPayment> = {}): CashPayment => ({
  paymentId: 'p1', humanPaymentId: 'P-AA-0001', clientName: 'Northbliss', amount: 1191600,
  paymentMode: 'pnb', paymentDate: null, recordedAt: hoursAgo(300), tracked: true, state: 'waiting',
  holderId: 'mohit', holderName: 'Mohit', holderSince: hoursAgo(200), ageHours: 200,
  openHandover: handover(), canAccept: false, canHandOver: false, canReceive: false, orderException: null,
  ...over,
})

describe('handed over and not accepted', () => {
  const card = pendingFromCard(payment(), NOW)

  test('is pending from the one who has to accept it, counted from the handover', () => {
    assert.equal(card.label, 'Pending from Dhruv · 3 days')
    assert.equal(card.brief, '₹11,91,600 · Northbliss')
    assert.equal(card.detail, 'Mohit handed it to Dhruv, not accepted yet')
  })

  test('is not the age of the cash itself (200 hours with its holder before it)', () => {
    assert.ok(!card.label.includes('8 days'))
  })
})

describe('held and not handed on', () => {
  test('is pending from the holder, counted from when it reached them', () => {
    const card = pendingFromCard(payment({
      state: 'with_holder', openHandover: null, holderId: 'dhruv', holderName: 'Dhruv', ageHours: 50,
    }), NOW)
    assert.equal(card.label, 'Pending from Dhruv · 2 days')
    assert.equal(card.detail, 'Dhruv holds it, not handed on')
  })

  test('an unknown holder still reads as a sentence', () => {
    const card = pendingFromCard(payment({ openHandover: null, holderId: null, holderName: null, ageHours: 0 }), NOW)
    assert.equal(card.label, 'Pending from an unknown holder · just now')
  })
})

describe('marked not received', () => {
  test('goes back to the giver, who still has the cash', () => {
    const card = pendingFromCard(payment({ state: 'disputed', openHandover: handover({ status: 'disputed' }) }), NOW)
    assert.equal(card.label, 'Pending from Mohit · 3 days')
    assert.equal(card.detail, 'Dhruv marked it not received')
  })
})

describe('Clear all', () => {
  test('a payment handed on is new news, the same payment unchanged is not', () => {
    const before = pendingFromCard(payment(), NOW).key
    assert.equal(pendingFromCard(payment(), NOW + 3_600_000).key, before)
    assert.notEqual(pendingFromCard(payment({ openHandover: handover({ id: 'h2', recipientName: 'Nitish' }) }), NOW).key, before)
    assert.notEqual(pendingFromCard(payment({ state: 'with_holder', openHandover: null }), NOW).key, before)
  })
})

describe('the only action', () => {
  test('is the custodian recording receiving it; nobody else is offered one', () => {
    assert.equal(pendingFromCard(payment(), NOW).canReceive, false)
    assert.equal(pendingFromCard(payment({ canReceive: true }), NOW).canReceive, true)
  })
})

describe('the list', () => {
  test('oldest waiting first', () => {
    const cards = pendingFromCards([
      payment({ paymentId: 'new', openHandover: handover({ id: 'a', createdAt: hoursAgo(5) }) }),
      payment({ paymentId: 'old', openHandover: handover({ id: 'b', createdAt: hoursAgo(100) }) }),
    ], NOW)
    assert.deepEqual(cards.map(c => c.label), ['Pending from Dhruv · 4 days', 'Pending from Dhruv · 5 hours'])
  })
})
