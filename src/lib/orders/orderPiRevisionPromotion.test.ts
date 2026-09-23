/**
 * Revised PI promotion (20270101000000): what the screen draws from the
 * version rows. Pure. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderPiRevisionPromotion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PI_VERSION_STATUS_LABEL,
  canDecideRevisionOperations,
  describePiVersionHistory,
  describeRevisionOperationsFailure,
  revisionStage,
  splitRevisionQueue,
  type PersistedPiVersion,
  type RevisionQueueRow,
} from './orderPiVersions'
import { mainPiCard } from './orderMainPi'

const NAMES = new Map([['sales', 'Rohan'], ['admin', 'Meera'], ['ops', 'Kavya']])
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')
const row = (over: Partial<PersistedPiVersion>): PersistedPiVersion => ({
  id: 'v1', order_id: 'o', submission_id: 's', version_number: 1, status: 'approved',
  workbook_path: 'k1', workbook_name: 'v1.xlsx', uploaded_by: 'sales', uploaded_at: '2026-09-01T00:00:00Z',
  revision_reason: null, decided_by: 'admin', decided_at: '2026-09-02T00:00:00Z', decision_reason: null, superseded_at: null,
  operations_reviewer: null, operations_decided_by: null, operations_decided_at: null, operations_reason: null,
  ...over,
})
const v1 = row({})
const v2 = row({ id: 'v2', version_number: 2, status: 'admin_approved', workbook_path: 'k2', revision_reason: 'client changed qty',
  decided_at: '2026-09-20T00:00:00Z', operations_reviewer: 'ops' })

describe('an admin-approved revision is a proposal, never the PI in force', () => {
  test('V1 stays current; V2 is the open revision with its own words', () => {
    const h = describePiVersionHistory([v2, v1], NAMES, when)
    assert.equal(h.current?.versionNumber, 1)
    assert.equal(h.pending?.versionNumber, 2)
    assert.equal(h.pending?.statusLabel, 'Approved by Admin — awaiting Operations')
    assert.equal(h.pending?.decisionLine, 'Approved by Admin by Meera · 2026-09-20')
    assert.equal(h.pending?.operationsReviewer, 'Kavya')
  })

  test('the Main PI card headlines V1 and carries V2 as the proposal', () => {
    const card = mainPiCard(describePiVersionHistory([v2, v1], NAMES, when))
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.reference, 'PI V1')
    assert.equal(card.proposal?.label, 'PI V2')
  })

  test('the stage says who holds it and what happens next', () => {
    const h = describePiVersionHistory([v2, v1], NAMES, when)
    assert.deepEqual(revisionStage(h.pending!), { owner: 'Operations — Kavya', next: 'Operations to accept or reject' })
    const pending = describePiVersionHistory([row({ id: 'p', version_number: 2, status: 'pending', decided_by: null, decided_at: null }), v1], NAMES, when)
    assert.deepEqual(revisionStage(pending.pending!), { owner: 'Admin', next: 'Admin to approve or reject' })
    const unassigned = describePiVersionHistory([row({ ...v2, operations_reviewer: null }), v1], NAMES, when)
    assert.equal(revisionStage(unassigned.pending!)?.owner, 'Operations — no reviewer assigned')
  })

  test('only the addressed reviewer is offered the decision, never under View As', () => {
    const p = describePiVersionHistory([v2, v1], NAMES, when).pending
    assert.equal(canDecideRevisionOperations(p, 'ops', false), true)
    assert.equal(canDecideRevisionOperations(p, 'admin', false), false, 'an admin is not the reviewer')
    assert.equal(canDecideRevisionOperations(p, 'ops', true), false)
    const pending = describePiVersionHistory([row({ id: 'p', version_number: 2, status: 'pending', decided_by: null, decided_at: null, operations_reviewer: 'ops' }), v1], NAMES, when).pending
    assert.equal(canDecideRevisionOperations(pending, 'ops', false), false, 'not before the admin approved it')
  })

  test('an operations rejection is recorded with who and why', () => {
    const rejected = row({ id: 'r', version_number: 2, status: 'rejected', decision_reason: 'Operations: old rate',
      operations_decided_by: 'ops', operations_decided_at: '2026-09-21T00:00:00Z', operations_reason: 'old rate' })
    const h = describePiVersionHistory([rejected, v1], NAMES, when)
    assert.equal(h.current?.versionNumber, 1)
    assert.equal(h.pending, null)
    assert.equal(h.history[0].operationsLine, 'Rejected by Operations — Kavya · 2026-09-21')
    assert.equal(h.history[0].operationsReason, 'old rate')
  })

  test('every status has words', () => {
    assert.equal(PI_VERSION_STATUS_LABEL.admin_approved, 'Approved by Admin — awaiting Operations')
  })
})

describe('the queue', () => {
  const r = (over: Partial<RevisionQueueRow>): RevisionQueueRow => ({
    id: 'x', orderId: 'o', orderNumber: '0001', versionNumber: 2, status: 'pending',
    uploadedBy: 'sales', uploadedAt: '2026-09-20T00:00:00Z', operationsReviewer: null, ...over,
  })
  const rows = [r({ id: 'a' }), r({ id: 'b', status: 'admin_approved', operationsReviewer: 'ops' }), r({ id: 'c', status: 'admin_approved', operationsReviewer: 'old' })]
  test('Admin: pending; Operations: addressed to them; Sales: their own, waiting on others', () => {
    assert.deepEqual(splitRevisionQueue(rows, { viewerId: 'admin', isAdmin: true, viewingAs: false }).needsYou.map(x => x.id), ['a'])
    assert.deepEqual(splitRevisionQueue(rows, { viewerId: 'ops', isAdmin: false, viewingAs: false }).needsYou.map(x => x.id), ['b'])
    const sales = splitRevisionQueue(rows, { viewerId: 'sales', isAdmin: false, viewingAs: false })
    assert.equal(sales.needsYou.length, 0)
    assert.equal(sales.waitingOnOthers.length, 3)
    assert.equal(splitRevisionQueue(rows, { viewerId: 'ops', isAdmin: false, viewingAs: true }).needsYou.length, 0)
  })
})

describe('refusals, in sentences', () => {
  test('the amendment rule reaches the reviewer in words', () => {
    assert.match(describeRevisionOperationsFailure({ message: 'ORDER_PI_REVISION_AMENDMENT_REQUIRED: PI V2 changes the Order\'s commercial data (Order value: Order has 600000, PI V2 has 750000). Amend the Order to these values first' }),
      /^PI V2 changes the Order's commercial data/)
    assert.match(describeRevisionOperationsFailure({ message: 'duplicate key value violates unique constraint "order_pi_versions_one_pending_per_order"' }),
      /already open/)
    assert.equal(describeRevisionOperationsFailure({ message: 'Only the assigned operations reviewer can accept or reject a revised PI' }),
      'Only the assigned operations reviewer can accept or reject a revised PI')
  })
})
