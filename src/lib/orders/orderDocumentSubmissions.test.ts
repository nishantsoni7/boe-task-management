/**
 * Order document submissions (20270112000000): the rules the Order page and the
 * queue draw from. Pure. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderDocumentSubmissions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISION_REASON_REQUIRED,
  currentAcceptedFiles,
  currentOwnerLabel,
  describeDocumentFailure,
  documentObjectPath,
  nextActionLabel,
  openSubmissionFor,
  splitDocumentQueue,
  submissionActions,
  uncorrectedRejections,
  validateDecisionReason,
  validateDocumentFile,
  absenceLine,
  missingSupporting,
  missingSupportingQuestion,
  piDocumentObjectPath,
  type DocumentViewer,
  type PersistedDocumentSubmission,
} from './orderDocumentSubmissions'

const SALES = 'sales-1'
const ADMIN = 'admin-1'
const OPS = 'ops-1'

let seq = 0
function sub(over: Partial<PersistedDocumentSubmission>): PersistedDocumentSubmission {
  seq += 1
  const id = over.id ?? `s${seq}`
  return {
    id, stage: 'amendment', order_id: 'o1', pi_submission_id: null, includes_design_files: false, includes_client_po: true, design_mode: null, note: null,
    status: 'pending_admin', snapshot_sha256: 'a'.repeat(64), file_count: 1, resubmission_of: null,
    submitted_by: SALES, submitted_at: `2026-09-2${seq % 10}T10:00:00Z`,
    admin_decided_by: null, admin_decided_at: null, admin_reason: null,
    operations_reviewer: null, operations_decided_by: null, operations_decided_at: null, operations_reason: null,
    files: [{ id: `${id}-f`, category: over.includes_design_files ? 'design_files' : 'client_po',
              storage_path: `p/${id}`, file_name: `${id}.pdf`, mime_type: 'application/pdf', size_bytes: 10 }],
    ...over,
  }
}

const viewer = (over: Partial<DocumentViewer>): DocumentViewer => ({
  viewerId: SALES, isAdmin: false, canSubmit: true, viewingAs: false, ...over,
})

describe('the current accepted set', () => {
  test('nothing pending, awaiting or rejected is ever current', () => {
    const rows = [
      sub({ status: 'pending_admin' }),
      sub({ status: 'awaiting_operations', admin_decided_at: 't' }),
      sub({ status: 'rejected_admin', admin_reason: 'no' }),
      sub({ status: 'rejected_operations', operations_reason: 'no' }),
    ]
    assert.equal(currentAcceptedFiles(rows, 'client_po').files.length, 0)
  })

  test('Client PO: the latest accepted submission', () => {
    const a = sub({ status: 'accepted', operations_decided_at: '2026-09-01T00:00:00Z' })
    const b = sub({ status: 'accepted', operations_decided_at: '2026-09-05T00:00:00Z' })
    const pending = sub({ status: 'awaiting_operations' })
    const got = currentAcceptedFiles([b, pending, a], 'client_po')
    assert.deepEqual(got.submissionIds, [b.id])
    assert.equal(got.acceptedAt, '2026-09-05T00:00:00Z')
  })

  test('Design Files: an add extends, a replace starts again, history is kept', () => {
    const d = (mode: 'add' | 'replace', at: string) => sub({
      includes_design_files: true, includes_client_po: false, design_mode: mode, status: 'accepted', operations_decided_at: at,
    })
    const first = d('add', '2026-09-01T00:00:00Z')
    const replace = d('replace', '2026-09-02T00:00:00Z')
    const add = d('add', '2026-09-03T00:00:00Z')
    const got = currentAcceptedFiles([add, first, replace], 'design_files')
    assert.deepEqual(got.submissionIds, [replace.id, add.id])
    assert.equal(got.files.length, 2)
  })
})

describe('who acts now', () => {
  test('admin decides only a pending_admin submission', () => {
    const s = sub({ status: 'pending_admin' })
    assert.equal(submissionActions(s, viewer({ viewerId: ADMIN, isAdmin: true })).adminDecide, true)
    assert.equal(submissionActions(s, viewer({})).adminDecide, false, 'Sales cannot')
    assert.equal(submissionActions(s, viewer({ viewerId: OPS })).operationsDecide, false, 'Operations not yet')
  })

  test('operations decides only as the reviewer, only at its own stage, never under View As', () => {
    const s = sub({ status: 'awaiting_operations', operations_reviewer: OPS, admin_decided_at: 't' })
    assert.equal(submissionActions(s, viewer({ viewerId: OPS })).operationsDecide, true)
    assert.equal(submissionActions(s, viewer({ viewerId: ADMIN, isAdmin: true })).operationsDecide, false,
      'an admin is not substituted')
    assert.equal(submissionActions(s, viewer({ viewerId: OPS, viewingAs: true })).operationsDecide, false)
    assert.equal(submissionActions(s, viewer({ viewerId: ADMIN, isAdmin: true })).adminDecide, false, 'admin stage is over')
  })

  test('REASSIGNMENT: the row names the reviewer, and only that person is offered the decision', () => {
    // The database readdresses operations_reviewer inside the reassignment
    // (20270112000000 §12). After it, the row names the NEW reviewer.
    const after = sub({ status: 'awaiting_operations', operations_reviewer: OPS, admin_decided_at: 't' })
    assert.equal(submissionActions(after, viewer({ viewerId: OPS })).operationsDecide, true, 'the new reviewer')
    assert.equal(submissionActions(after, viewer({ viewerId: 'old-ops' })).operationsDecide, false, 'the former reviewer loses it')
    const rows = [{ submission: after, orderNumber: '0001' }]
    assert.equal(splitDocumentQueue(rows, viewer({ viewerId: OPS })).needsYou.length, 1, 'the new reviewer sees it queued')
    assert.equal(splitDocumentQueue(rows, viewer({ viewerId: 'old-ops' })).needsYou.length, 0, 'the former reviewer does not')
  })

  test('INITIAL documents have no decision of their own and no queue row', () => {
    const initial = sub({ stage: 'initial', pi_submission_id: 'pi1', status: 'awaiting_operations', operations_reviewer: OPS, admin_decided_at: 't' })
    assert.deepEqual(submissionActions(initial, viewer({ viewerId: OPS })), { adminDecide: false, operationsDecide: false, resubmit: false })
    const pendingInitial = sub({ stage: 'initial', order_id: null, pi_submission_id: 'pi1', status: 'pending_admin' })
    assert.equal(submissionActions(pendingInitial, viewer({ viewerId: ADMIN, isAdmin: true })).adminDecide, false)
    const q = splitDocumentQueue([initial, pendingInitial].map(s => ({ submission: s, orderNumber: '0001' })), viewer({ viewerId: OPS }))
    assert.equal(q.needsYou.length + q.waitingOnOthers.length, 0)
    const name = (id: string | null) => (id === OPS ? 'Ravi' : null)
    assert.equal(currentOwnerLabel(initial, name), "Operations — Ravi, with PI V1's operations review")
    assert.equal(nextActionLabel(initial), 'Operations to Accept for production PI V1')
    assert.equal(currentOwnerLabel(pendingInitial, name), 'Admin — decided with the PI approval')
  })

  test('owner and next action say who holds it', () => {
    const name = (id: string | null) => (id === OPS ? 'Ravi' : id === SALES ? 'Asha' : null)
    assert.equal(currentOwnerLabel(sub({ status: 'pending_admin' }), name), 'Admin')
    assert.equal(currentOwnerLabel(sub({ status: 'awaiting_operations', operations_reviewer: OPS }), name), 'Operations — Ravi')
    assert.equal(currentOwnerLabel(sub({ status: 'awaiting_operations' }), name), 'Operations — no reviewer assigned')
    assert.equal(currentOwnerLabel(sub({ status: 'rejected_operations', operations_reason: 'x' }), name), 'Sales — Asha')
    assert.equal(nextActionLabel(sub({ status: 'rejected_admin', admin_reason: 'x' })), 'Sales to correct and resubmit')
  })

  test('one open submission per category is found', () => {
    const po = sub({ status: 'awaiting_operations' })
    const design = sub({ includes_design_files: true, includes_client_po: false, design_mode: 'add', status: 'accepted' })
    assert.equal(openSubmissionFor([po, design], 'client_po')?.id, po.id)
    assert.equal(openSubmissionFor([po, design], 'design_files'), null)
  })
})

describe('the queue, per role', () => {
  const rows = () => {
    const pending = sub({ status: 'pending_admin' })
    const awaiting = sub({ status: 'awaiting_operations', operations_reviewer: OPS })
    const rejected = sub({ status: 'rejected_admin', admin_reason: 'wrong PO' })
    const corrected = sub({ status: 'rejected_operations', operations_reason: 'old' })
    const correction = sub({ status: 'pending_admin', resubmission_of: corrected.id })
    const accepted = sub({ status: 'accepted' })
    return [pending, awaiting, rejected, corrected, correction, accepted].map(s => ({ submission: s, orderNumber: '0001' }))
  }

  test('Admin sees what awaits the admin decision', () => {
    const q = splitDocumentQueue(rows(), viewer({ viewerId: ADMIN, isAdmin: true }))
    assert.deepEqual(q.needsYou.map(r => r.submission.status), ['pending_admin', 'pending_admin'])
  })

  test('Operations sees only what admin approved for them', () => {
    const q = splitDocumentQueue(rows(), viewer({ viewerId: OPS }))
    assert.deepEqual(q.needsYou.map(r => r.submission.status), ['awaiting_operations'])
  })

  test('Sales sees uncorrected rejections to fix, and separately what awaits others', () => {
    const q = splitDocumentQueue(rows(), viewer({}))
    assert.deepEqual(q.needsYou.map(r => r.submission.status), ['rejected_admin'])
    assert.equal(q.waitingOnOthers.length, 3)
    assert.equal(uncorrectedRejections(rows().map(r => r.submission)).length, 1)
  })

  test('View As shows no queue', () => {
    const q = splitDocumentQueue(rows(), viewer({ viewerId: ADMIN, isAdmin: true, viewingAs: true }))
    assert.equal(q.needsYou.length + q.waitingOnOthers.length, 0)
  })
})

describe('sending the PI with its documents', () => {
  test('the one question names exactly what is missing', () => {
    assert.equal(missingSupportingQuestion(['design_files', 'client_po']), 'No design files or client PO are attached to this submission. Submit without them?')
    assert.equal(missingSupportingQuestion(['client_po']), 'No client PO is attached to this submission. Submit without it?')
    assert.equal(missingSupportingQuestion(['design_files']), 'No design files are attached to this submission. Submit without them?')
    assert.equal(missingSupportingQuestion([]), '')
    assert.deepEqual(missingSupporting({ designCount: 2, clientPoCount: 0 }), ['client_po'])
    assert.deepEqual(missingSupporting({ designCount: 1, clientPoCount: 1 }), [])
  })

  test('an acknowledged absence is said as an absence, never as attached', () => {
    const a = { missing: ['client_po'], acknowledged_by: SALES, acknowledged_at: '2026-09-20T10:00:00Z' }
    const line = absenceLine(a, 'client_po', () => 'Asha', iso => (iso ?? '').slice(0, 10))
    assert.equal(line, 'Not provided — Asha confirmed sending the PI without a client PO on 2026-09-20.')
    assert.equal(absenceLine(a, 'design_files', () => 'Asha', () => ''), null)
    assert.equal(/attached/i.test(line ?? ''), false)
  })

  test('files sent with a PI are stored under the PI, sealed by its submission', () => {
    assert.equal(piDocumentObjectPath({ piSubmissionId: 'p', submissionId: 's', category: 'design_files', fileId: 'f', mime: 'image/png' }),
      'pi-documents/p/s/design_files/f.png')
  })
})

describe('validation and failures', () => {
  test('files: type and size', () => {
    assert.equal(validateDocumentFile({ name: 'a.pdf', size: 10, type: 'application/pdf' }), null)
    assert.match(validateDocumentFile({ name: 'a.xlsx', size: 10, type: 'application/vnd.ms-excel' }) ?? '', /only PDF/)
    assert.match(validateDocumentFile({ name: 'a.png', size: 11 * 1024 * 1024, type: 'image/png' }) ?? '', /10 MB/)
  })

  test('the storage key is the one the policy admits', () => {
    assert.equal(
      documentObjectPath({ orderId: 'o', submissionId: 's', category: 'client_po', fileId: 'f', mime: 'image/jpeg' }),
      'order-documents/o/s/client_po/f.jpg')
    assert.throws(() => documentObjectPath({ orderId: 'o', submissionId: 's', category: 'client_po', fileId: 'f', mime: 'text/plain' }))
  })

  test('a rejection needs a reason; an approval does not', () => {
    assert.deepEqual(validateDecisionReason('  ', true), { ok: false, message: DECISION_REASON_REQUIRED })
    assert.deepEqual(validateDecisionReason('  ', false), { ok: true, reason: null })
    assert.deepEqual(validateDecisionReason(' wrong ', true), { ok: true, reason: 'wrong' })
  })

  test('database refusals become sentences', () => {
    assert.equal(
      describeDocumentFailure({ message: 'ORDER_DOCUMENT_CATEGORY_PENDING: The Client PO on Order 0001 already has a submission under review.' }),
      'The Client PO on Order 0001 already has a submission under review.')
    assert.equal(
      describeDocumentFailure({ message: 'ORDER_DOCUMENT_ALREADY_DECIDED: this submission has already been decided (it is now accepted). Refresh to see its current state.' }),
      'this submission has already been decided (it is now accepted). Refresh to see its current state.')
    assert.equal(describeDocumentFailure({ message: 'Only an administrator can make the admin decision on a document submission' }),
      'Only an administrator can make the admin decision on a document submission')
  })
})
