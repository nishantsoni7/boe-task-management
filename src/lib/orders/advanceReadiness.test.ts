/**
 * THE 40% ADVANCE ON THE AMENDED ORDER VALUE (20270104000000) — the words.
 *
 * The rule itself is the database's (orders_alignment_requires_advance, proved
 * in supabase/tests/order_pi_revision_in_force_at_admin_approval_assertions.sql
 * §7). This proves what a person reads.
 *
 * Run:
 *   npx tsx --test src/lib/orders/advanceReadiness.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { advanceAttentionLabel, advanceGateView, describeAdvanceRefusal, type AdvanceReadiness } from './advanceReadiness'
import { describeHandoffFailure } from './operationsHandoff'
import { orderAttentionItems } from './orderWorkspace'

const short: AdvanceReadiness = {
  order_value: '389400.00', verified: '126496', awaiting: '20000', required: '155760', shortfall: '29264.00',
  percent: '32.48', threshold_percent: '40', below: true, ready: false, exception: null,
}

describe('below 40% on the amended value', () => {
  const v = advanceGateView(short, { versionNumber: 3 })
  test('says the percentage, the figures and the rupee shortfall', () => {
    assert.equal(v.kind, 'blocked')
    if (v.kind !== 'blocked') return
    assert.equal(v.headline, 'Advance below 40% — production cannot be aligned')
    assert.equal(v.figures, '32.48% verified — ₹1,26,496.00 of the Order value ₹3,89,400.00.')
    assert.equal(v.shortfall, '₹29,264.00 more verified payment is needed.')
  })
  test('money awaiting Finance is named, and does not count', () => {
    if (v.kind !== 'blocked') return
    assert.equal(v.awaiting, '₹20,000.00 is awaiting Finance verification and does not count yet.')
  })
  test('and says what must happen, for which version', () => {
    if (v.kind !== 'blocked') return
    assert.match(v.action, /^Operations can accept PI V3 for production once Finance verifies the payment, or an administrator approves production below 40%\.$/)
  })
  test('the attention strip carries it in red', () => {
    const label = advanceAttentionLabel(short)
    assert.equal(label, 'Production blocked: advance below 40% — see Payment')
    const items = orderAttentionItems({
      status: 'running', productionAligned: false, hasSalesperson: true, hasDueDate: true, hasLeadSource: true,
      isOverdue: false, awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
      documentsFailed: false, documentsOutdated: false, advanceBelowLabel: label,
    })
    assert.deepEqual(items.find(i => i.key === 'advance_below'), { key: 'advance_below', label, tone: 'red' })
  })
})

describe('met, or excepted', () => {
  test('nothing is drawn once 40% is verified', () => {
    assert.deepEqual(advanceGateView({ ...short, below: false, shortfall: '0', ready: true }, { versionNumber: 3 }), { kind: 'none' })
    assert.equal(advanceAttentionLabel({ ...short, below: false, shortfall: '0', ready: true }), null)
  })
  test('an administrator\'s approval is a quiet note, tied to the value', () => {
    const v = advanceGateView({ ...short, ready: true, exception: { source: 'order', approved_by: 'a', approved_at: '2026-09-25T00:00:00Z', reason: 'Client pays on delivery' } },
      { versionNumber: 3, approverName: 'Asha Admin', formatWhen: () => '25 Sept 2026' })
    assert.equal(v.kind, 'excepted')
    if (v.kind !== 'excepted') return
    assert.match(v.note, /^Approved by Asha Admin on 25 Sept 2026: Client pays on delivery\. A change to the Order's value needs a new approval\.$/)
    assert.equal(advanceAttentionLabel({ ...short, ready: true }), null)
  })
})

describe('the database\'s refusal, read', () => {
  const raw = 'ORDER_ADVANCE_BELOW_THRESHOLD: Order 0005 has ₹126496.00 verified — 32.48% of its ₹389400.00 value. ₹29264.00 more verified payment, or an administrator\'s below-40% approval, is needed before production can be aligned.'
  test('Operations accepting a version is refused in the database\'s own sentence', () => {
    assert.match(describeHandoffFailure({ message: raw }), /^Order 0005 has ₹126496\.00 verified — 32\.48% of its ₹389400\.00 value\./)
  })
  test('the exception door\'s refusals', () => {
    assert.match(describeAdvanceRefusal('ORDER_ADVANCE_EXCEPTION_NOT_NEEDED: …') ?? '', /already verified/)
    assert.match(describeAdvanceRefusal('ORDER_ADVANCE_EXCEPTION_REASON_REQUIRED: …') ?? '', /at least 10 characters/)
  })
})
