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
    assert.match(v.note, /^Approved by Asha Admin on 25 Sept 2026: Client pays on delivery\. A change to the Order's value, a new PI version, or less verified payment needs a new approval\.$/)
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

describe('Operations sees why Accept is unavailable', () => {
  test('the button is disabled with the reason; Cannot accept is not', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { OperationsReviewActions } = await import('../../app/orders/[id]/OrderStatusWorkspace')
    const view = { kind: 'recorded', status: 'awaiting', actions: { accept: true, cannotAccept: true } } as never
    const html = renderToStaticMarkup(createElement(OperationsReviewActions, {
      view, busy: false, onAccept: () => {}, onCannotAccept: () => {},
      acceptBlockedReason: 'Production blocked: advance below 40% — see Payment',
    }))
    assert.match(html, /<button[^>]*disabled=""[^>]*title="Production blocked: advance below 40% — see Payment"[^>]*>Accept for production<\/button>/)
    assert.match(html, /<button type="button" class="boe-btn boe-btn-ghost order-status-action">Cannot accept<\/button>/)
  })
})

// ── After alignment (review H2–H4): the hold, and no value on record ─────────

describe('an aligned Order that fell short is ON HOLD, and says when and why', () => {
  const held: AdvanceReadiness = {
    ...short,
    hold: {
      id: 'h1', cause: 'payment_changed', held_at: '2026-09-25T10:00:00Z', order_value: '1000000.00',
      previous_order_value: null, verified: '300000', percent: '30.00', shortfall: '100000.00',
    },
  }
  const v = advanceGateView(held, { versionNumber: 2, formatWhen: () => '25 Sep 2026' })
  test('the headline names the hold, and one sentence says why', () => {
    assert.equal(v.kind, 'blocked')
    if (v.kind !== 'blocked') return
    assert.equal(v.headline, 'Production on hold — advance below 40%')
    assert.equal(v.hold, 'Production readiness was removed on 25 Sep 2026 because verified payment against it was reduced: the verified advance fell to 30% of ₹10,00,000.00.')
    assert.match(v.action, /^Operations can align production again against PI V2 once Finance verifies the payment/)
  })
  test('each cause in words', () => {
    for (const [cause, words] of [['value_changed', "the Order's value was raised"], ['pi_revision', "a revised PI raised the Order's value"]] as const) {
      const r = advanceGateView({ ...held, hold: { ...held.hold!, cause } }, { versionNumber: 2 })
      assert.ok(r.kind === 'blocked' && r.hold?.includes(words), cause)
    }
  })
  test('the attention strip says "on hold"', () => {
    assert.equal(advanceAttentionLabel(held), 'Production on hold: advance below 40% — see Payment')
  })
})

describe('no value on record is never ready', () => {
  const unknown: AdvanceReadiness = {
    order_value: null, value_known: false, verified: '400000', awaiting: '0', required: null, shortfall: null,
    percent: null, threshold_percent: '40', below: true, ready: false, exception: null,
  }
  test('the panel says the advance cannot be measured and an approval is needed', () => {
    const v = advanceGateView(unknown, { versionNumber: 1 })
    assert.equal(v.kind, 'blocked')
    if (v.kind !== 'blocked') return
    assert.equal(v.figures, 'No Order value is on record, so the advance cannot be measured (₹4,00,000.00 verified).')
    assert.equal(v.shortfall, "An administrator's below-40% approval is needed.")
  })
  test('the database refusal is shown in its own words', () => {
    assert.equal(describeAdvanceRefusal('ORDER_ADVANCE_VALUE_UNKNOWN: Order 0006 has no value on record, so its 40% advance cannot be measured.'),
      'Order 0006 has no value on record, so its 40% advance cannot be measured.')
  })
})

describe('Operations re-aligns a held Order from the same place', () => {
  test('an accepted version on hold offers "Align production again", disabled with its reason until ready', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { OperationsReviewActions } = await import('../../app/orders/[id]/OrderStatusWorkspace')
    const view = { kind: 'recorded', status: 'accepted', actions: { accept: false, cannotAccept: false, withdraw: true } } as never
    const blocked = renderToStaticMarkup(createElement(OperationsReviewActions, {
      view, busy: false, onAccept: () => {}, onCannotAccept: () => {}, heldForAdvance: true,
      acceptBlockedReason: 'Production on hold: advance below 40% — see Payment',
    }))
    assert.match(blocked, /<button[^>]*disabled=""[^>]*title="Production on hold: advance below 40% — see Payment"[^>]*>Align production again<\/button>/)
    const ready = renderToStaticMarkup(createElement(OperationsReviewActions, {
      view, busy: false, onAccept: () => {}, onCannotAccept: () => {}, heldForAdvance: true, acceptBlockedReason: null,
    }))
    assert.match(ready, />Align production again<\/button>/)
    assert.doesNotMatch(ready, /disabled/)
    const notHeld = renderToStaticMarkup(createElement(OperationsReviewActions, {
      view, busy: false, onAccept: () => {}, onCannotAccept: () => {}, heldForAdvance: false,
    }))
    assert.equal(notHeld, '', 'an accepted version that is not on hold offers nothing here')
  })
  test('nobody but the reviewer sees it', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { OperationsReviewActions } = await import('../../app/orders/[id]/OrderStatusWorkspace')
    const view = { kind: 'recorded', status: 'accepted', actions: { accept: false, cannotAccept: false, withdraw: false } } as never
    assert.equal(renderToStaticMarkup(createElement(OperationsReviewActions, {
      view, busy: false, onAccept: () => {}, onCannotAccept: () => {}, heldForAdvance: true,
    })), '')
  })
})
