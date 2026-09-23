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
  ACCEPTANCE_MEANING,
  CANNOT_ACCEPT_LABEL,
  OPERATIONS_HANDOFF_NOT_RECORDED_LABEL,
  OPERATIONS_HANDOFF_REASON_REQUIRED,
  OPERATIONS_HANDOFF_REASON_TOO_LONG,
  OPERATIONS_HANDOFF_UNASSIGNED_HINT,
  OPERATIONS_HANDOFF_UNASSIGNED_LABEL,
  OPERATIONS_REVIEW_READ_ONLY_NOTE,
  REVISION_COMPARE_NOTE,
  WITHDRAW_ACCEPTANCE_LABEL,
  canDecideOperationsHandoff,
  describeAlignmentEventReason,
  describeHandoffAlignment,
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
    assigned_to: NITISH, assigned_at: '2026-09-20T10:00:00Z', unassigned_reason: null,
    production_alignment_at_approval: 'not_aligned', prior_handoff_status: null,
    status: 'awaiting',
    accepted_by: null, accepted_at: null, accepted_note: null,
    acceptance_withdrawn_by: null, acceptance_withdrawn_at: null, acceptance_withdrawn_reason: null,
    clarification_by: null, clarification_at: null, clarification_reason: null,
    superseded_at: null, superseded_by_version_id: null, created_at: '2026-09-20T10:00:00Z',
    ...over,
  }
}
const accepted = (over: Partial<PersistedOperationsHandoff> = {}) =>
  handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-20T12:00:00Z', accepted_note: 'ok', ...over })

const base = {
  hasSourcePi: true, namesById: NAMES, formatWhen: when,
  viewerId: NITISH, viewingAs: false, orderStatus: 'running',
  productionAligned: false, productionAlignedAt: null,
}

describe('the live handoff and the history', () => {
  test('the live one is the un-superseded row; the rest are history, newest first', () => {
    const v1 = accepted({ id: 'h1', version_number: 1, superseded_at: '2026-09-21T00:00:00Z', superseded_by_version_id: 'v2' })
    const v2 = handoff({ id: 'h2', version_number: 2, pi_version_id: 'v2' })
    const split = splitOperationsHandoffs([v1, v2])
    assert.equal(split.live?.id, 'h2')
    assert.deepEqual(split.history.map(h => h.id), ['h1'])
    assert.equal(splitOperationsHandoffs([]).live, null)
  })
})

describe('an Order approved before handoffs existed', () => {
  test('says Not recorded, invents nothing, and keeps the old alignment control', () => {
    const view = describeOperationsHandoff({ ...base, live: null })
    assert.equal(view.kind, 'not_recorded')
    assert.equal(view.label, OPERATIONS_HANDOFF_NOT_RECORDED_LABEL)
    assert.match(view.hint, /before operations handoffs were recorded/)
    assert.match(view.hint, /No acceptance is claimed/)
    assert.match(view.hint, /set the old way, from the header/)
  })
  test('an Order that never came from a PI says so differently', () => {
    const view = describeOperationsHandoff({ ...base, live: null, hasSourcePi: false })
    assert.equal(view.kind, 'not_recorded')
    assert.match(view.hint, /did not come from a PI/)
  })
})

describe('the version in force, in words — and what alignment says as a result', () => {
  test('awaiting: version, approver, reviewer, both controls; the Order is NOT aligned', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff() })
    assert.equal(view.kind, 'recorded')
    if (view.kind !== 'recorded') return
    assert.equal(view.versionLabel, 'PI V1')
    assert.equal(view.statusLabel, 'Awaiting operations review')
    assert.equal(view.tone, 'amber')
    assert.equal(view.approvedLine, 'Approved by Nishant · @2026-09-20T10:00:00Z')
    assert.equal(view.reviewerName, 'Nitish')
    assert.deepEqual(view.actions, { accept: true, cannotAccept: true, withdraw: false })
    assert.deepEqual(view.alignment, { aligned: false, label: 'Not Aligned', line: 'Awaiting operations acceptance of PI V1' })
    assert.equal(view.revisionReason, null, 'V1 was not a revision')
    assert.equal(view.readOnlyNote, null)
  })

  test('accepted: who and when; the Order IS aligned against this version; only Withdraw remains', () => {
    const view = describeOperationsHandoff({ ...base, live: accepted() })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.statusLabel, 'Accepted for production')
    assert.deepEqual(view.decision, { label: 'Accepted for production', by: 'Nitish', at: '@2026-09-20T12:00:00Z', note: 'ok' })
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false, withdraw: true })
    assert.deepEqual(view.alignment, { aligned: true, label: 'Aligned · PI V1', line: 'Accepted by Nitish · @2026-09-20T12:00:00Z' })
    assert.equal(view.withdrawn, null)
  })

  test('flagged: the reason; not aligned; only Accept remains', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ status: 'clarification_needed', clarification_by: NITISH, clarification_at: '2026-09-20T12:00:00Z', clarification_reason: 'Fabric?' }) })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.statusLabel, 'Clarification needed')
    assert.equal(view.tone, 'red')
    assert.equal(view.decision?.note, 'Fabric?')
    assert.deepEqual(view.actions, { accept: true, cannotAccept: false, withdraw: false })
    assert.deepEqual(view.alignment, { aligned: false, label: 'Not Aligned', line: 'PI V1 flagged for clarification' })
  })

  test('withdrawn: the acceptance stays on record beside the withdrawal, and the Order is not aligned', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({
      status: 'clarification_needed',
      accepted_by: NITISH, accepted_at: '2026-09-20T12:00:00Z', accepted_note: 'ok',
      acceptance_withdrawn_by: NITISH, acceptance_withdrawn_at: '2026-09-21T08:00:00Z', acceptance_withdrawn_reason: 'Qty wrong',
      clarification_by: NITISH, clarification_at: '2026-09-21T08:00:00Z', clarification_reason: 'Qty wrong',
    }) })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.deepEqual(view.withdrawn, { acceptedBy: 'Nitish', acceptedAt: '@2026-09-20T12:00:00Z', by: 'Nitish', at: '@2026-09-21T08:00:00Z', reason: 'Qty wrong' })
    assert.equal(view.alignment.aligned, false)
    assert.deepEqual(view.actions, { accept: true, cannotAccept: false, withdraw: false })
  })

  test('a revised version carries its revision reason', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ version_number: 2, pi_version_id: 'v2' }), revisionReason: '  Client changed the fabric  ' })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.revisionReason, 'Client changed the fabric')
    assert.match(REVISION_COMPARE_NOTE, /not available yet/)
  })

  test('the meaning of acceptance is stated, and says nothing about work done', () => {
    assert.match(ACCEPTANCE_MEANING, /aligns the Order for production against this version/)
    assert.match(ACCEPTANCE_MEANING, /does not say any manufacturing work is done/)
    assert.equal(describeHandoffAlignment({ live: handoff(), reviewerName: null, formatWhen: when }).aligned, false)
  })
})

describe('who may decide — drawn only; the database decides again', () => {
  test('the assigned reviewer, and nobody else: not an admin, not the approver', () => {
    const live = handoff()
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: live, orderStatus: 'running' }), true)
    assert.equal(canDecideOperationsHandoff({ viewerId: NISHANT, viewingAs: false, handoff: live, orderStatus: 'running' }), false, 'the approving admin')
    assert.equal(canDecideOperationsHandoff({ viewerId: ADMIN2, viewingAs: false, handoff: live, orderStatus: 'running' }), false, 'another admin')
  })
  test('never under View As, never on a cancelled Order, never on a superseded handoff; an accepted one can be withdrawn', () => {
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: true, handoff: handoff(), orderStatus: 'running' }), false)
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: handoff(), orderStatus: 'cancelled' }), false)
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: handoff({ superseded_at: 'x', superseded_by_version_id: 'v2' }), orderStatus: 'running' }), false)
    assert.equal(canDecideOperationsHandoff({ viewerId: NITISH, viewingAs: false, handoff: accepted(), orderStatus: 'running' }), true)
  })
  test('a reader who cannot decide is told why, in words that name the admin case', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff(), viewerId: NISHANT })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false, withdraw: false })
    assert.equal(view.readOnlyNote, OPERATIONS_REVIEW_READ_ONLY_NOTE)
    assert.match(OPERATIONS_REVIEW_READ_ONLY_NOTE, /Being an administrator does not count/)
  })
  test('a former reviewer (no longer assigned) is offered nothing', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ assigned_to: ADMIN2 }), viewerId: NITISH })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false, withdraw: false })
  })
})

describe('no reviewer assigned', () => {
  test('is visible, needs an administrator, and is never shown as accepted or aligned', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ assigned_to: null, assigned_at: null, unassigned_reason: 'no_reviewer' }), viewerId: NISHANT })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.unassigned, true)
    assert.equal(view.reviewerLine, OPERATIONS_HANDOFF_UNASSIGNED_LABEL)
    assert.equal(view.statusLabel, 'Awaiting operations review')
    assert.equal(view.alignment.aligned, false)
    assert.equal(view.readOnlyNote, OPERATIONS_HANDOFF_UNASSIGNED_HINT)
    assert.match(OPERATIONS_HANDOFF_UNASSIGNED_HINT, /Control Center/)
    assert.deepEqual(view.actions, { accept: false, cannotAccept: false, withdraw: false }, 'an admin is not offered acceptance in the reviewer\'s place')
    assert.equal(view.unassignedReason, 'no_reviewer')
  })

  test('each reason says what an administrator must fix', () => {
    const inactive = describeOperationsHandoff({ ...base, live: handoff({ assigned_to: null, assigned_at: null, unassigned_reason: 'reviewer_inactive' }), viewerId: NISHANT })
    if (inactive.kind !== 'recorded') throw new Error('recorded')
    assert.equal(inactive.reviewerLine, 'Operations reviewer is no longer active')
    assert.match(inactive.unassignedHint ?? '', /no longer an active account/)
    const cannot = describeOperationsHandoff({ ...base, live: handoff({ assigned_to: null, assigned_at: null, unassigned_reason: 'reviewer_cannot_open_order' }), viewerId: NITISH })
    if (cannot.kind !== 'recorded') throw new Error('recorded')
    assert.equal(cannot.reviewerLine, 'Operations reviewer cannot open this Order')
    assert.match(cannot.unassignedHint ?? '', /an admin, a member of the operations team, or a holder of orders\.view_all/)
    assert.deepEqual(cannot.actions, { accept: false, cannotAccept: false, withdraw: false },
      'the configured reviewer who cannot open the Order is offered nothing')
    assert.equal(cannot.readOnlyNote, cannot.unassignedHint)
  })
})

describe('a later version does not inherit an acceptance or an alignment', () => {
  const v2over: Partial<PersistedOperationsHandoff> = { id: 'h2', version_number: 2, pi_version_id: 'v2', prior_handoff_status: 'accepted', approved_at: '2026-09-22T10:00:00Z' }
  const v2 = handoff(v2over)

  test('V2 is awaiting, not aligned, and says V1 had been accepted', () => {
    const view = describeOperationsHandoff({ ...base, live: v2 })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.equal(view.statusLabel, 'Awaiting operations review')
    assert.equal(view.alignment.aligned, false)
    assert.match(view.priorAcceptedNotice ?? '', /earlier version was accepted .* PI V2 has not been/)
  })

  test('an alignment that predated V2 is warned about — as RESET, never as covering V2', () => {
    const view = describeOperationsHandoff({ ...base, live: handoff({ ...v2, production_alignment_at_approval: 'aligned' }) })
    if (view.kind !== 'recorded') throw new Error('recorded')
    assert.match(view.alignmentWarning ?? '', /Production was aligned before PI V2/)
    assert.match(view.alignmentWarning ?? '', /has been reset; it does not cover PI V2/)
    // Once V2 is accepted, the warning is gone and the Order is aligned against V2.
    const acceptedV2 = describeOperationsHandoff({ ...base, live: accepted({ ...v2over, production_alignment_at_approval: 'aligned' }) })
    if (acceptedV2.kind !== 'recorded') throw new Error('recorded')
    assert.equal(acceptedV2.alignmentWarning, null)
    assert.equal(acceptedV2.alignment.label, 'Aligned · PI V2')
  })

  test('the history keeps V1 and its decision, including a withdrawn acceptance', () => {
    const v1 = accepted({ accepted_note: 'fine', superseded_at: '2026-09-22T10:00:00Z', superseded_by_version_id: 'v2' })
    const rows = describeOperationsHandoffHistory({ history: [v1], namesById: NAMES, formatWhen: when })
    assert.equal(rows[0].versionLabel, 'PI V1')
    assert.equal(rows[0].statusLabel, 'Accepted for production')
    assert.equal(rows[0].note, 'fine')
    assert.match(rows[0].line, /Nitish · @2026-09-20T12:00:00Z · superseded @2026-09-22T10:00:00Z/)
    const withdrawn = describeOperationsHandoffHistory({ history: [handoff({
      status: 'clarification_needed', accepted_by: NITISH, accepted_at: 'x',
      acceptance_withdrawn_by: NITISH, acceptance_withdrawn_at: 'y', acceptance_withdrawn_reason: 'r',
      clarification_by: NITISH, clarification_at: 'y', clarification_reason: 'r',
      superseded_at: 'z', superseded_by_version_id: 'v2',
    })], namesById: NAMES, formatWhen: when })
    assert.equal(withdrawn[0].statusLabel, 'Clarification needed (acceptance withdrawn)')
    const undecided = describeOperationsHandoffHistory({ history: [handoff({ superseded_at: 'x', superseded_by_version_id: 'v2' })], namesById: NAMES, formatWhen: when })
    assert.equal(undecided[0].statusLabel, 'Not decided')
  })
})

describe('the decision form', () => {
  test('a flag or a withdrawal needs a reason; an acceptance does not; both are bounded', () => {
    assert.deepEqual(validateHandoffDecision('accepted', '  '), { ok: true, reason: null })
    assert.deepEqual(validateHandoffDecision('accepted', ' ok '), { ok: true, reason: 'ok' })
    assert.deepEqual(validateHandoffDecision('clarification_needed', '  '), { ok: false, message: OPERATIONS_HANDOFF_REASON_REQUIRED })
    assert.deepEqual(validateHandoffDecision('clarification_needed', 'why'), { ok: true, reason: 'why' })
    assert.deepEqual(validateHandoffDecision('accepted', 'x'.repeat(1001)), { ok: false, message: OPERATIONS_HANDOFF_REASON_TOO_LONG })
  })
  test('the three buttons say what they do', () => {
    assert.equal(ACCEPT_FOR_PRODUCTION_LABEL, 'Accept for production')
    assert.equal(CANNOT_ACCEPT_LABEL, 'Cannot accept')
    assert.equal(WITHDRAW_ACCEPTANCE_LABEL, 'Withdraw acceptance')
  })
  test('the database\'s refusals are sentences', () => {
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_STALE: PI V1 is no longer' }), /newer PI version/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: x' }), /newer PI version/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED' }), /already accepted/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED' }), /Control Center/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_CLOSED' }), /cancelled/)
    assert.match(describeHandoffFailure({ message: 'This account is not active' }), /not active/)
    assert.match(describeHandoffFailure({ message: 'You do not have access to this Order' }), /no longer have access/)
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
  test('refusals and confirmations are sentences, and clearing says what became unassigned', () => {
    assert.match(describeReviewerAssignmentFailure({ message: 'ORDER_OPERATIONS_REVIEWER_INACTIVE' }), /not active/)
    assert.match(describeReviewerAssignmentFailure({ message: 'ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS' }), /cannot open every Order.*View all Orders/)
    assert.match(describeReviewerSaved({ name: 'Nitish', reassigned: 2 }), /Nitish is now the operations reviewer\. 2 waiting or flagged handoffs reassigned/)
    assert.match(describeReviewerSaved({ name: 'Nitish', reassigned: 0 }), /^Nitish is now the operations reviewer\.$/)
    assert.match(describeReviewerSaved({ name: null, reassigned: 0, unassigned: 3 }), /3 waiting or flagged handoffs now show as unassigned/)
    assert.match(describeReviewerSaved({ name: null, reassigned: 0 }), /No operations reviewer is assigned/)
  })
})

describe('the Order history', () => {
  test('the six handoff events are labelled and described', () => {
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_recorded, 'Sent to operations for review')
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_accepted, 'Accepted for production by operations')
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_clarification_needed, 'Operations cannot accept: clarification needed')
    assert.equal(ORDER_EVENT_LABEL.operations_handoff_acceptance_withdrawn, 'Operations withdrew the acceptance')
    assert.equal(ORDER_EVENT_LABEL.operations_reviewer_assigned, 'Operations reviewer assigned')
    assert.equal(ORDER_EVENT_LABEL.operations_reviewer_unassigned, 'Operations reviewer unassigned')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_recorded', { version_number: 2, assigned_to: null, superseded_handoff_status: 'accepted', superseded_version_number: 1, production_alignment: 'aligned' }),
      'PI V2 · no operations reviewer assigned · replaces accepted PI V1 · the Order was aligned for production; that alignment was reset')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_accepted', { version_number: 1, after_withdrawal: true, note: 'ok' }), 'PI V1 · after a withdrawal · ok')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_acceptance_withdrawn', { version_number: 1, reason: 'Qty' }), 'PI V1 · Qty')
    assert.equal(describeOperationsHandoffEvent('operations_reviewer_unassigned', { version_number: 1, handoff_status: 'clarification_needed' }), 'PI V1 · flagged for clarification')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_recorded', { version_number: 1, assigned_to: 'r1', production_alignment: 'not_aligned', recorded_for_existing_approval: true }),
      'PI V1 · sent later for an approval made before operations review existed')
    assert.equal(describeOperationsHandoffEvent('something_else', {}), null)
  })
  test('the alignment event says WHY it moved when a handoff moved it', () => {
    assert.equal(describeAlignmentEventReason({ reason: 'pi_version_approved', version_number: 2, covered_version_number: 1 }),
      'reset: PI V2 approved; the alignment covered PI V1')
    assert.equal(describeAlignmentEventReason({ reason: 'pi_version_approved', version_number: 2 }),
      'reset: PI V2 approved; the alignment predated version tracking')
    assert.equal(describeAlignmentEventReason({ reason: 'operations_handoff_accepted', version_number: 2 }), 'PI V2 accepted by operations')
    assert.equal(describeAlignmentEventReason({ reason: 'operations_handoff_acceptance_withdrawn', version_number: 2 }), 'acceptance of PI V2 withdrawn')
    assert.equal(describeAlignmentEventReason({ legacy_order: true }), 'set the old way (no handoff on this Order)')
    assert.equal(describeAlignmentEventReason({}), null)
    assert.equal(describeOrderEvent({ id: 'e', event_type: 'production_alignment_changed', payload: { from: 'not_aligned', to: 'aligned', reason: 'operations_handoff_accepted', version_number: 1 }, created_at: '' }),
      'Not Aligned → Aligned · PI V1 accepted by operations')
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
  test('ONE line about production: the handoff item replaces "Production not aligned" on a handoff Order', () => {
    const items = orderAttentionItems({ ...quiet, productionAligned: false, operationsReview: { versionNumber: 1, status: 'awaiting', unassigned: false } })
    assert.deepEqual(items.map(i => i.key), ['operations_review'])
    assert.deepEqual(orderAttentionItems({ ...quiet, productionAligned: false }).map(i => i.key), ['production'], 'a legacy Order keeps the old line')
  })
  test('a dispatched Order still names its undecided review (the RPC still takes it); the alignment warning does not follow', () => {
    assert.deepEqual(orderAttentionItems({ ...quiet, status: 'dispatched', operationsReview: { versionNumber: 1, status: 'awaiting', unassigned: true }, alignmentPredatesVersion: 1 }).map(i => i.key),
      ['operations_unassigned', 'operations_review'])
    assert.deepEqual(orderAttentionItems({ ...quiet, status: 'dispatched', operationsReview: { versionNumber: 1, status: 'clarification_needed', unassigned: false } }).map(i => i.label),
      ['PI V1 flagged by operations: clarification needed'])
  })
  test('nothing is raised on a cancelled Order, and older callers raise nothing', () => {
    assert.deepEqual(orderAttentionItems({ ...quiet, status: 'cancelled', operationsReview: { versionNumber: 1, status: 'awaiting', unassigned: true }, alignmentPredatesVersion: 1 }), [])
    assert.deepEqual(orderAttentionItems(quiet), [])
  })
  test('the dashboard offers an Operations Review card only when something waits — including a flagged version', () => {
    const cards = (over: Partial<typeof NO_ORDER_DASHBOARD_COUNTS>) =>
      orderDashboardCards({ counts: { ...NO_ORDER_DASHBOARD_COUNTS, ...over }, orders: NO_ORDERS_CAPABILITIES, finance: NO_FINANCE_CAPABILITIES })
        .find(c => c.key === 'operations_review')
    assert.equal(cards({}), undefined)
    assert.equal(cards({ operationsReview: 0, operationsUnassigned: 0, operationsFlagged: 0 }), undefined)
    const mine = cards({ operationsReview: 2, operationsUnassigned: 0, operationsFlagged: 0 })
    assert.equal(mine?.value, 2)
    assert.equal(mine?.href, '/orders/all?ops=awaiting')
    assert.equal(mine?.tone, 'attention')
    const unassigned = cards({ operationsReview: 0, operationsUnassigned: 1, operationsFlagged: 0 })
    assert.equal(unassigned?.value, 1)
    assert.match(unassigned?.sub ?? '', /no reviewer assigned/)
    const flagged = cards({ operationsReview: 0, operationsUnassigned: 0, operationsFlagged: 1 })
    assert.equal(flagged?.value, 1)
    assert.match(flagged?.sub ?? '', /flagged: clarification needed/)
  })
})
