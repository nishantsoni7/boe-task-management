/**
 * The PI-to-operations handoff (20261229000000): the rules the Order page
 * draws from. Pure. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/operationsHandoff.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCEPT_FOR_PRODUCTION_LABEL,
  CANNOT_ACCEPT_LABEL,
  OPERATIONS_HANDOFF_NOT_RECORDED_LABEL,
  OPERATIONS_HANDOFF_REASON_REQUIRED,
  OPERATIONS_HANDOFF_REASON_TOO_LONG,
  OPERATIONS_HANDOFF_STATUS_LABEL,
  OPERATIONS_HANDOFF_UNASSIGNED_HINT,
  OPERATIONS_HANDOFF_UNASSIGNED_LABEL,
  OPERATIONS_REVIEW_READ_ONLY_NOTE,
  canDecideOperationsHandoff,
  describeHandoffFailure,
  describeOperationsHandoff,
  describeOperationsHandoffEvent,
  describeOperationsHandoffHistory,
  describeReviewerAssignmentFailure,
  describeReviewerSaved,
  eligibleOperationsReviewers,
  splitOperationsHandoffs,
  validateHandoffDecision,
  type PersistedOperationsHandoff,
} from './operationsHandoff'
import { orderAttentionItems } from './orderWorkspace'
import { orderDashboardCards, NO_ORDER_DASHBOARD_COUNTS } from './orderDashboard'
import { NO_ORDERS_CAPABILITIES } from '../permissions/orders'
import { NO_FINANCE_CAPABILITIES } from '../permissions/finance'
import { ORDER_EVENT_LABEL, describeOrderEvent, mergeOrderHistory } from './orderHistory'

const NISHANT = 'aaaaaaaa-0000-0000-0000-000000000001'
const NITISH  = 'aaaaaaaa-0000-0000-0000-000000000002'
const ADMIN2  = 'aaaaaaaa-0000-0000-0000-000000000003'
const NAMES = new Map([[NISHANT, 'Nishant'], [NITISH, 'Nitish'], [ADMIN2, 'Another Admin']])
const when = (iso: string | null) => (iso ? `@${iso}` : '—')

function handoff(over: Partial<PersistedOperationsHandoff> = {}): PersistedOperationsHandoff {
  return {
    id: 'h1', order_id: 'o1', pi_version_id: 'v1', submission_id: 's1', version_number: 1,
    approved_by: NISHANT, approved_at: '2026-09-20T10:00:00Z',
    assigned_to: NITISH, assigned_at: '2026-09-20T10:00:00Z',
    production_alignment_at_approval: 'not_aligned', prior_handoff_status: null,
    status: 'awaiting',
    accepted_by: null, accepted_at: null, accepted_note: null,
    clarification_by: null, clarification_at: null, clarification_reason: null,
    superseded_at: null, superseded_by_version_id: null, created_at: '2026-09-20T10:00:00Z',
    ...over,
  }
}

const base = {
  hasSourcePi: true, namesById: NAMES, formatWhen: when,
  viewerId: NITISH, viewingAs: false, orderStatus: 'running',
  productionAligned: false, productionAlignedAt: null,
}

describe('the live handoff and the history', () => {
  test('the live one is the un-superseded row; the rest are history, newest first', () => {
    const v1 = handoff({ id: 'h1', version_number: 1, superseded_at: '2026-09-21T00:00:00Z', superseded_by_version_id: 'v2', status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-20T12:00:00Z' })
    const v2 = handoff({ id: 'h2', version_number: 2, pi_version_id: 'v2' })
    const split = splitOperationsHandoffs([v1, v2])
    assert.equal(split.live?.id, 'h2')
    assert.deepEqual(split.history.map(h => h.id), ['h1'])
    assert.equal(splitOperationsHandoffs([]).live, null)
  })
})

describe('an Order approved before handoffs existed', () => {
  test('says Not recorded, and invents nothing', () => {
    const view = describeOperationsHandoff({ ...base, live: null })
    assert.equal(view.kind, 'not_recorded')
    assert.equal(view.label, OPERATIONS_HANDOFF_NOT_RECORDED_LABEL)
    assert.match(view.hint, /before operations handoffs were recorded/)
    assert.match(view.hint, /No acceptance is claimed/)
  })
  test('an Order that never came from a PI says so differently', () => {
    const view = describeOperationsHandoff({ ...base, live: null, hasSourcePi: false })
    assert.equal(view.kind, 'not_recorded')
    assert.match(view.hint, /did not come from a PI/)
  })
})

describe('the version in force, in words', () => {
  test('awaiting: names the version, the approver, the reviewer, and offers the reviewer both actions', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff() })
    assert.equal(view.kind, 'recorded')
    if (view.kind !== 'recorded') return
    assert.equal(view.versionLabel, 'PI V1')
    assert.equal(view.statusLabel, OPERATIONS_HANDOFF_STATUS_LABEL.awaiting)
    assert.equal(view.statusLabel, 'Awaiting operations review')
    assert.equal(view.tone, 'amber')
    assert.equal(view.approvedLine, 'Approved by Nishant · @2026-09-20T10:00:00Z')
    assert.equal(view.reviewerName, 'Nitish')
    assert.equal(view.unassigned, false)
    assert.deepEqual(view.actions, { accept: true, cannotAccept: true })
    assert.equal(view.readOnlyNote, null)
    assert.equal(view.decision, null)
  })

  test('accepted: names who and when; nothing more is offered, even to the reviewer', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-20T12:00:00Z', accepted_note: 'ok' }) })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.statusLabel, 'Accepted for production')
    assert.equal(view.tone, 'green')
    assert.deepEqual(view.decision, { label: 'Accepted for production', by: 'Nitish', at: '@2026-09-20T12:00:00Z', note: 'ok' })
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false })
    assert.equal(view.readOnlyNote, null)
  })

  test('flagged: shows the reason and offers acceptance after clarification, not a second flag', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ status: 'clarification_needed', clarification_by: NITISH, clarification_at: '2026-09-20T12:00:00Z', clarification_reason: 'Fabric?' }) })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.statusLabel, 'Clarification needed')
    assert.equal(view.tone, 'red')
    assert.equal(view.decision?.note, 'Fabric?')
    assert.deepEqual(view.actions, { accept: true, cannotAccept: false })
  })
})

describe('who may decide — drawn only; the database decides again', () => {
  test('the assigned reviewer, and nobody else: not an admin, not the approver', () => {
    const live = handoff()
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: live, orderStatus: 'running' }), true)
    assert.equal(canDecideOperationsHandoff({ viewerId: NISHANT, viewingAs: false, handoff: live, orderStatus: 'running' }), false, 'the approving admin')
    assert.equal(canDecideOperationsHandoff({ viewerId: ADMIN2, viewingAs: false, handoff: live, orderStatus: 'running' }), false, 'another admin')
  })
  test('never under View As, never on a cancelled Order, never on a superseded or accepted handoff', () => {
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: true, handoff: handoff(), orderStatus: 'running' }), false)
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: handoff(), orderStatus: 'cancelled' }), false)
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: handoff({ superseded_at: 'x', superseded_by_version_id: 'v2' }), orderStatus: 'running' }), false)
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: 'x' }), orderStatus: 'running' }), false)
  })
  test('a reader who cannot decide is told why in one line', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff(), viewerId: NISHANT })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false })
    assert.equal(view.readOnlyNote, OPERATIONS_REVIEW_READ_ONLY_NOTE)
    assert.match(OPERATIONS_REVIEW_READ_ONLY_NOTE, /Only the assigned operations reviewer/)
  })
})

describe('no reviewer assigned', () => {
  test('is visible, needs an administrator, and is never shown as accepted', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ assigned_to: null, assigned_at: null }), viewerId: NISHANT })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.unassigned, true)
    assert.equal(view.reviewerLine, OPERATIONS_HANDOFF_UNASSIGNED_LABEL)
    assert.equal(view.statusLabel, 'Awaiting operations review')
    assert.equal(view.readOnlyNote, OPERATIONS_HANDOFF_UNASSIGNED_HINT)
    assert.match(OPERATIONS_HANDOFF_UNASSIGNED_HINT, /Control Center/)
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false }, 'an admin is not offered acceptance in the reviewer\'s place')
  })
})

describe('a later version does not inherit an acceptance', () => {
  const v2 = handoff({ id: 'h2', version_number: 2, pi_version_id: 'v2', prior_handoff_status: 'accepted', approved_at: '2026-09-22T10:00:00Z' })

  test('V2 is awaiting and says V1 had been accepted', () => {
    const view = describeOperationsHandoff({ ...base, live: v2 })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.statusLabel, 'Awaiting operations review')
    assert.match(view.priorAcceptedNotice ?? '', /earlier version was accepted .* PI V2 has not been/)
  })

  test('production aligned before V2 is warned about — and alignment is not claimed to cover V2', () => {
    const aligned = { ...base, productionAligned: true, productionAlignedAt: '2026-09-21T00:00:00Z' }
    const view = describeOperationsHandoff({ ...aligned, live: v2 })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.match(view.alignmentWarning ?? '', /Production was aligned before PI V2/)
    // The snapshot alone is enough too.
    const snap = describeOperationsHandoff({ ...base, productionAligned: true, live: handoff({ ...v2, production_alignment_at_approval: 'aligned' }) })
    if (snap.kind !== 'recorded') throw new Error('recorded')
    assert.ok(snap.alignmentWarning)
    // Aligned AFTER this version: no warning.
    const after = describeOperationsHandoff({ ...base, productionAligned: true, productionAlignedAt: '2026-09-23T00:00:00Z', live: v2 })
    if (after.kind !== 'recorded') throw new Error('recorded')
    assert.equal(after.alignmentWarning, null)
    // Once accepted, the warning is gone.
    const accepted = describeOperationsHandoff({ ...aligned, live: handoff({ ...v2, status: 'accepted', accepted_by: NITISH, accepted_at: 'x' }) })
    if (accepted.kind !== 'recorded') throw new Error('recorded')
    assert.equal(accepted.alignmentWarning, null)
  })

  test('the history keeps V1 and its decision', () => {
    const v1 = handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-20T12:00:00Z', accepted_note: 'fine', superseded_at: '2026-09-22T10:00:00Z', superseded_by_version_id: 'v2' })
    const rows = describeOperationsHandoffHistory({ history: [v1], namesById: NAMES, formatWhen: when })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].versionLabel, 'PI V1')
    assert.equal(rows[0].statusLabel, 'Accepted for production')
    assert.equal(rows[0].note, 'fine')
    assert.match(rows[0].line, /Nitish · @2026-09-20T12:00:00Z · superseded @2026-09-22T10:00:00Z/)
    const undecided = describeOperationsHandoffHistory({ history: [handoff({ superseded_at: 'x', superseded_by_version_id: 'v2' })], namesById: NAMES, formatWhen: when })
    assert.equal(undecided[0].statusLabel, 'Not decided')
    assert.match(undecided[0].line, /without a decision/)
  })
})

describe('the decision form', () => {
  test('a flag needs a reason; an acceptance does not; both are bounded', () => {
    assert.deepEqual(validateHandoffDecision('accepted', '  '), { ok: true, reason: null })
    assert.deepEqual(validateHandoffDecision('accepted', ' ok '), { ok: true, reason: 'ok' })
    assert.deepEqual(validateHandoffDecision('clarification_needed', '  '), { ok: false, message: OPERATIONS_HANDOFF_REASON_REQUIRED })
    assert.deepEqual(validateHandoffDecision('clarification_needed', 'why'), { ok: true, reason: 'why' })
    assert.deepEqual(validateHandoffDecision('accepted', 'x'.repeat(1001)), { ok: false, message: OPERATIONS_HANDOFF_REASON_TOO_LONG })
  })
  test('the two buttons say what they do', () => {
    assert.equal(ACCEPT_FOR_PRODUCTION_LABEL, 'Accept for production')
    assert.equal(CANNOT_ACCEPT_LABEL, 'Cannot accept')
  })
  test('the database\'s refusals are sentences', () => {
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_STALE: PI V1 is no longer' }), /newer PI version/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: x' }), /newer PI version/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED' }), /already accepted/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED' }), /Control Center/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_CLOSED' }), /cancelled/)
    assert.match(describeHandoffFailure({ message: 'Only the assigned operations reviewer can decide this handoff' }), /Being an administrator does not count/)
    assert.equal(describeHandoffFailure(null), 'The decision could not be recorded.')
  })
})

describe('the reviewer assignment (Control Center)', () => {
  test('only active, undeleted people are offered, by name', () => {
    const list = eligibleOperationsReviewers([
      { id: '1', full_name: 'Zed', is_active: true },
      { id: '2', full_name: 'Amy', is_active: true, is_deleted: false },
      { id: '3', full_name: 'Gone', is_active: false },
      { id: '4', full_name: 'Deleted', is_active: true, is_deleted: true },
    ])
    assert.deepEqual(list.map(m => m.full_name), ['Amy', 'Zed'])
  })
  test('refusals and confirmations are sentences', () => {
    assert.match(describeReviewerAssignmentFailure({ message: 'ORDER_OPERATIONS_REVIEWER_INACTIVE' }), /not active/)
    assert.match(describeReviewerAssignmentFailure({ message: 'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS' }), /cannot open Orders/)
    assert.match(describeReviewerSaved({ name: 'Nitish', reassigned: 2 }), /Nitish is now the operations reviewer\. 2 waiting handoffs reassigned/)
    assert.match(describeReviewerSaved({ name: 'Nitish', reassigned: 0 }), /^Nitish is now the operations reviewer\.$/)
    assert.match(describeReviewerSaved({ name: null, reassigned: 0 }), /No operations reviewer is assigned/)
  })
})

describe('the Order history', () => {
  test('the four events are labelled and described', () => {
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_recorded, 'Sent to operations for review')
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_accepted, 'Accepted for production by operations')
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_clarification_needed, 'Operations cannot accept: clarification needed')
    assert.equal(ORDER_EVENT_LABEL.operations_reviewer_assigned, 'Operations reviewer assigned')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_recorded', { version_number: 2, assigned_to: null, superseded_handoff_status: 'accepted', superseded_version_number: 1, production_alignment: 'aligned' }),
      'PI V2 · no operations reviewer assigned · replaces accepted PI V1 · Order was already aligned for production')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_accepted', { version_number: 1, after_clarification: true, note: 'ok' }), 'PI V1 · after clarification · ok')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_clarification_needed', { version_number: 1, reason: 'Fabric?' }), 'PI V1 · Fabric?')
    assert.equal(describeOperationsHandoffEvent('something_else', {}), null)
  })
  test('they merge into the chronology through the shared describer', () => {
    const row = { id: 'a1', event_type: 'operations_handoff_accepted', payload: { version_number: 1 }, created_at: '2026-09-20T12:00:00Z', actor_name: 'Nitish' }
    assert.equal(describeOrderEvent(row), 'PI V1')
    const merged = mergeOrderHistory({ orderRows: [row], orderLabel: () => null, orderDetail: () => null, piRows: [], namesById: NAMES, formatWhen: when })
    assert.equal(merged[0].label, 'Accepted for production by operations')
    assert.equal(merged[0].tone, 'green')
  })
})

describe('the attention strip and the dashboard', () => {
  const quiet = {
    status: 'running', productionAligned: true, hasSalesperson: true, hasDueDate: true, hasLeadSource: true,
    isOverdue: false, awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
    documentsFailed: false, documentsOutdated: false,
  }
  test('an awaiting version, an unassigned one, and an alignment that predates the version are raised', () => {
    assert.deepEqual(orderAttentionItems({ ...quiet, operationsReview: { versionNumber: 2, status: 'awaiting', unassigned: false } }).map(i => i.label),
      ['PI V2 awaiting operations review'])
    assert.deepEqual(orderAttentionItems({ ...quiet, operationsReview: { versionNumber: 1, status: 'awaiting', unassigned: true } }).map(i => i.key),
      ['operations_unassigned', 'operations_review'])
    const flagged = orderAttentionItems({ ...quiet, operationsReview: { versionNumber: 1, status: 'clarification_needed', unassigned: false } })
    assert.equal(flagged[0].label, 'PI V1 flagged by operations: clarification needed')
    assert.equal(flagged[0].tone, 'red')
    assert.deepEqual(orderAttentionItems({ ...quiet, alignmentPredatesVersion: 2 }).map(i => i.label), ['Production was aligned before PI V2'])
  })
  test('nothing is raised on a closed Order, and older callers raise nothing', () => {
    assert.deepEqual(orderAttentionItems({ ...quiet, status: 'dispatched', operationsReview: { versionNumber: 1, status: 'awaiting', unassigned: true }, alignmentPredatesVersion: 1 }), [])
    assert.deepEqual(orderAttentionItems(quiet), [])
  })
  test('the dashboard offers an Operations Review card only when something waits', () => {
    const none = orderDashboardCards({ counts: NO_ORDER_DASHBOARD_COUNTS, orders: NO_ORDERS_CAPABILITIES, finance: NO_FINANCE_CAPABILITIES })
    assert.equal(none.find(c => c.key === 'operations_review'), undefined)
    const zero = orderDashboardCards({ counts: { ...NO_ORDER_DASHBOARD_COUNTS, operationsReview: 0, operationsUnassigned: 0 }, orders: NO_ORDERS_CAPABILITIES, finance: NO_FINANCE_CAPABILITIES })
    assert.equal(zero.find(c => c.key === 'operations_review'), undefined)
    const mine = orderDashboardCards({ counts: { ...NO_ORDER_DASHBOARD_COUNTS, operationsReview: 2, operationsUnassigned: 0 }, orders: NO_ORDERS_CAPABILITIES, finance: NO_FINANCE_CAPABILITIES })
      .find(c => c.key === 'operations_review')
    assert.equal(mine?.value, 2)
    assert.equal(mine?.href, '/orders/all?ops=awaiting')
    assert.equal(mine?.tone, 'attention')
    const unassigned = orderDashboardCards({ counts: { ...NO_ORDER_DASHBOARD_COUNTS, operationsReview: 0, operationsUnassigned: 1 }, orders: NO_ORDERS_CAPABILITIES, finance: NO_FINANCE_CAPABILITIES })
      .find(c => c.key === 'operations_review')
    assert.equal(unassigned?.value, 1)
    assert.match(unassigned?.sub ?? '', /no reviewer assigned/)
  })
})
