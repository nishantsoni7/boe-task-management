/**
 * THE WORDS OF THE PAYMENT POPUP.
 *
 * The popup says what a payment is for once, and says what each decision does
 * before it is pressed. These pin the sentences, in particular that the verify
 * sentence is read from the destination (so it can never claim "held until an
 * order is linked" about a payment that names an Order, a PI Draft or an old
 * order).
 *
 * Run: npm run test:file -- src/lib/finance/paymentPopupWords.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PaymentDestination } from './paymentDestination'
import {
  UNKNOWN_SENDER,
  attachPhrase,
  decisionButtonLabel,
  decisionConsequence,
  decisionFieldLabel,
  destinationCaption,
  destinationTag,
  firstName,
} from './paymentPopupWords'

function dest(over: Partial<PaymentDestination>): PaymentDestination {
  return {
    paymentId: 'p1', source: 'intent', kind: 'confirmed_order',
    orderCount: 1, submissionCount: 0, customerCount: 1,
    orderId: 'o1', orderNumber: '0524', submissionId: null, reference: '0524',
    ...over,
  }
}

const OLD_ORDER   = dest({ kind: 'old_order', orderCount: 0, orderId: null, orderNumber: null, reference: '478' })
const PI_DRAFT    = dest({ kind: 'pi_draft', orderCount: 0, submissionCount: 1, orderId: null, orderNumber: null, submissionId: 's1', reference: 'PI-4471' })
const SUSPENSE    = dest({ kind: 'suspense', source: 'none', orderCount: 0, orderId: null, orderNumber: null, reference: null })
const MIXED       = dest({ kind: 'mixed', orderCount: 2, submissionCount: 1, orderId: null, orderNumber: null, reference: null })
const NOT_VISIBLE = dest({ reference: null })

describe('the sender is named by first name, and never by a blank', () => {
  test('first name', () => {
    assert.equal(firstName('Mohit Sharma'), 'Mohit')
    assert.equal(firstName('  Mohit   Kumar Sharma '), 'Mohit')
  })
  test('nobody is named "undefined" or ""', () => {
    for (const blank of [undefined, null, '', '   ']) assert.equal(firstName(blank), UNKNOWN_SENDER)
  })
})

describe('"Paid for": the caption and the tag', () => {
  test('an old order is said to be outside BOE One; a PI Draft has no Order yet', () => {
    assert.equal(destinationCaption(OLD_ORDER), 'Not in BOE One')
    assert.equal(destinationCaption(PI_DRAFT), 'No Order yet')
    assert.equal(destinationCaption(MIXED), 'Split payment')
  })
  test('a Confirmed Order needs no caption, and nothing is said while loading', () => {
    assert.equal(destinationCaption(dest({})), null)
    assert.equal(destinationCaption(undefined), null)
  })
  test('Suspense, and a payment the projection has no row for, say nothing was chosen', () => {
    assert.equal(destinationCaption(SUSPENSE), 'Nothing was chosen on the request')
    assert.equal(destinationCaption(null), 'Nothing was chosen on the request')
  })

  test('a promise and a fact are told apart', () => {
    assert.deepEqual(destinationTag(dest({ source: 'intent' })), { tone: 'intent', label: 'Attaches when verified' })
    assert.deepEqual(destinationTag(dest({ source: 'allocation' })), { tone: 'allocated', label: 'Allocated' })
  })
  test('Suspense, a cancelled link and a payment still loading carry no tag', () => {
    assert.equal(destinationTag(SUSPENSE), null)
    assert.equal(destinationTag({ ...OLD_ORDER, cancelled: true }), null)
    assert.equal(destinationTag(undefined), null)
    assert.equal(destinationTag(null), null)
  })
})

describe('what verifying does, read from the destination', () => {
  test('it names the record the money is attached to', () => {
    assert.equal(attachPhrase(OLD_ORDER), 'attached to Old order 478')
    assert.equal(attachPhrase(PI_DRAFT), 'attached to PI Draft PI-4471')
    assert.equal(attachPhrase(dest({})), 'attached to Confirmed Order 0524')
    assert.equal(attachPhrase(MIXED), 'attached to 2 Orders · 1 PI Draft')
  })
  test('no destination means the money is held, and says until when', () => {
    assert.equal(attachPhrase(SUSPENSE), 'held unallocated until Finance allocates it')
    assert.equal(attachPhrase(null), 'held unallocated until Finance allocates it')
  })
  test('a record the reader may not open is not named', () => {
    assert.equal(attachPhrase(NOT_VISIBLE), 'attached to the record chosen on the request')
    assert.equal(attachPhrase(undefined), 'attached to the record chosen on the request')
  })

  test('a payment that names a record is NEVER said to wait for an order to be linked', () => {
    for (const d of [OLD_ORDER, PI_DRAFT, dest({}), MIXED]) {
      const text = decisionConsequence('approve', d, 'Mohit')
      assert.ok(!/until an order is linked/.test(text), text)
      assert.ok(/attached to/.test(text), text)
    }
  })
  test('the verify sentence says verified, who is told, and that it cannot be undone here', () => {
    const text = decisionConsequence('approve', OLD_ORDER, 'Mohit')
    assert.equal(text, "It will be verified as received and attached to Old order 478. Mohit is notified. This can't be undone from this page.")
  })
  test('send-back and rejection say who sees what', () => {
    assert.equal(decisionConsequence('needs_clarification', OLD_ORDER, 'Mohit'), 'Mohit is notified and sees your question.')
    assert.equal(decisionConsequence('reject', OLD_ORDER, 'Mohit'), 'Mohit is notified and sees your reason.')
  })
})

describe('the note label and the button are named for the decision', () => {
  test('which notes are required is in the label itself', () => {
    assert.equal(decisionFieldLabel('approve', 'Mohit'), 'Note for Mohit (optional)')
    assert.ok(/required/.test(decisionFieldLabel('needs_clarification', 'Mohit')))
    assert.ok(/required/.test(decisionFieldLabel('reject', 'Mohit')))
  })
  test('the button says what it does, and what it is doing', () => {
    assert.equal(decisionButtonLabel('approve', 'Mohit', false), 'Verify payment')
    assert.equal(decisionButtonLabel('approve', 'Mohit', true), 'Verifying…')
    assert.equal(decisionButtonLabel('needs_clarification', 'Mohit', false), 'Send to Mohit')
    assert.equal(decisionButtonLabel('reject', 'Mohit', false), 'Reject payment')
    assert.equal(decisionButtonLabel('reject', 'Mohit', true), 'Saving…')
  })
})
