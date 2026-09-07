/**
 * PI versions on a Confirmed Order, as the browser reads them (20261119000000).
 *
 * The database's partial unique indexes are what make "one current PI per
 * Order" true; this file proves the browser draws that truth faithfully — the
 * current version, the pending revision, the history — and never invents a
 * current one, never drops a rejected one, and offers the three controls only
 * to the people the RPCs will admit.
 *
 * Pure. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderPiVersions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ORDER_PI_VERSION_COLUMNS,
  PI_VERSION_STATUS_LABEL,
  REVISION_DECISION_REASON_REQUIRED,
  REVISION_FILE_NOT_XLSX,
  REVISION_FILE_REQUIRED,
  REVISION_REASON_REQUIRED,
  REVISION_REASON_TOO_LONG,
  UPLOAD_REVISION_NOTE,
  canDecidePiRevision,
  canProposePiRevision,
  describePiRevisionFailure,
  describePiVersionHistory,
  piVersionLabel,
  revisionWorkbookPath,
  validateRevisionDecisionReason,
  validateRevisionFile,
  validateRevisionReason,
  versionActorIds,
  type PersistedPiVersion,
} from './orderPiVersions'
import { isWorkbookPathFor } from './submissionPayload'

const RAVI = '11111111-1111-4111-8111-111111111111'
const PRIYA = '22222222-2222-4222-8222-222222222222'
const SUBMISSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const names = new Map([[RAVI, 'Ravi Menon'], [PRIYA, 'Priya Shah']])
const when = (iso: string | null) => (iso ? `@${iso}` : '—')

const version = (over: Partial<PersistedPiVersion>): PersistedPiVersion => ({
  id: over.id ?? `v${over.version_number ?? 1}`,
  order_id: 'order-1',
  submission_id: SUBMISSION,
  version_number: 1,
  status: 'approved',
  workbook_path: `submissions/${SUBMISSION}/original/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.xlsx`,
  workbook_name: 'kalyan.xlsx',
  uploaded_by: RAVI,
  uploaded_at: '2026-09-01T09:00:00Z',
  revision_reason: null,
  decided_by: PRIYA,
  decided_at: '2026-09-01T10:00:00Z',
  decision_reason: null,
  superseded_at: null,
  ...over,
})

describe('the history, from the rows', () => {
  test('V1 approved alone: current, no pending, no history', () => {
    const h = describePiVersionHistory([version({})], names, when)
    assert.equal(h.current?.label, 'PI V1')
    assert.equal(h.current?.statusLabel, PI_VERSION_STATUS_LABEL.approved)
    assert.equal(h.current?.decisionLine, 'Approved by Priya Shah · @2026-09-01T10:00:00Z')
    assert.equal(h.pending, null)
    assert.deepEqual(h.history, [])
  })

  test('a pending revision never displaces the current version', () => {
    const h = describePiVersionHistory([
      version({}),
      version({ version_number: 2, status: 'pending', decided_by: null, decided_at: null,
                revision_reason: 'client changed line 3' }),
    ], names, when)
    assert.equal(h.current?.versionNumber, 1, 'V1 stays current')
    assert.equal(h.pending?.versionNumber, 2)
    assert.equal(h.pending?.revisionReason, 'client changed line 3')
    assert.equal(h.pending?.decisionLine, null)
    assert.deepEqual(h.history, [])
  })

  test('an approved revision becomes current and the previous one is history, still openable', () => {
    const h = describePiVersionHistory([
      version({ status: 'superseded', superseded_at: '2026-09-05T10:00:00Z' }),
      version({ version_number: 2, status: 'approved', revision_reason: 'r', decided_at: '2026-09-05T10:00:00Z' }),
    ], names, when)
    assert.equal(h.current?.versionNumber, 2)
    assert.equal(h.history.length, 1)
    assert.equal(h.history[0].versionNumber, 1)
    assert.equal(h.history[0].statusLabel, PI_VERSION_STATUS_LABEL.superseded)
    assert.ok(h.history[0].workbookPath, 'the previous version keeps its file')
  })

  test('a rejected revision does not change the current PI, and keeps its reason', () => {
    const h = describePiVersionHistory([
      version({}),
      version({ version_number: 2, status: 'rejected', revision_reason: 'r',
                decision_reason: 'wrong quantity on line 3', decided_at: '2026-09-05T10:00:00Z' }),
    ], names, when)
    assert.equal(h.current?.versionNumber, 1)
    assert.equal(h.pending, null)
    assert.equal(h.history[0].statusLabel, PI_VERSION_STATUS_LABEL.rejected)
    assert.equal(h.history[0].decisionReason, 'wrong quantity on line 3')
    assert.equal(h.history[0].decisionLine, 'Rejected by Priya Shah · @2026-09-05T10:00:00Z')
  })

  test('the history is newest first, and V3 outranks V2 whatever the row order', () => {
    const h = describePiVersionHistory([
      version({ version_number: 2, status: 'rejected', revision_reason: 'r', decision_reason: 'x' }),
      version({ version_number: 3, status: 'approved', revision_reason: 'r' }),
      version({ status: 'superseded', superseded_at: '2026-09-05T10:00:00Z' }),
    ], names, when)
    assert.equal(h.current?.versionNumber, 3)
    assert.deepEqual(h.history.map(v => v.versionNumber), [2, 1])
  })

  test('a status this build does not know is dropped, never printed raw', () => {
    const h = describePiVersionHistory([version({}), version({ version_number: 2, status: 'weird' })], names, when)
    assert.equal(h.current?.versionNumber, 1)
    assert.deepEqual(h.history, [])
  })

  test('an unresolved actor is a phrase, never an id', () => {
    const h = describePiVersionHistory([version({ uploaded_by: 'nobody', decided_by: null })], names, when)
    assert.equal(h.current?.uploadedBy, 'Unknown user')
    assert.ok(!h.current?.uploadedBy.includes('-'))
  })

  test('the ids to look up are collected once, from both actor columns', () => {
    assert.deepEqual(versionActorIds([version({}), version({ version_number: 2, uploaded_by: PRIYA, decided_by: RAVI })]).sort(),
      [RAVI, PRIYA].sort())
  })

  test('the columns are named, and the hash and the successor link are not among them', () => {
    assert.ok(ORDER_PI_VERSION_COLUMNS.includes('version_number'))
    assert.ok(!ORDER_PI_VERSION_COLUMNS.includes('sha256'))
    assert.ok(!ORDER_PI_VERSION_COLUMNS.includes('superseded_by_version_id'))
    assert.ok(!ORDER_PI_VERSION_COLUMNS.includes('*'))
  })

  test('versions are numbered one way everywhere', () => {
    assert.equal(piVersionLabel(3), 'PI V3')
  })
})

describe('who is offered what', () => {
  const target = {
    orderStatus: 'running', createdBy: RAVI, submittedBy: RAVI,
    hasCurrentVersion: true, hasPendingRevision: false,
  }

  test('the PI owner with orders.create may propose a revision', () => {
    assert.equal(canProposePiRevision({ viewerId: RAVI, isAdmin: false, canCreate: true }, target), true)
  })

  test('the owner without orders.create may not; a stranger may not; an admin may', () => {
    assert.equal(canProposePiRevision({ viewerId: RAVI, isAdmin: false, canCreate: false }, target), false)
    assert.equal(canProposePiRevision({ viewerId: PRIYA, isAdmin: false, canCreate: true }, target), false)
    assert.equal(canProposePiRevision({ viewerId: PRIYA, isAdmin: true, canCreate: false }, target), true)
  })

  test('no second open revision, no revision on a cancelled Order, none without a current PI', () => {
    const actor = { viewerId: RAVI, isAdmin: true, canCreate: true }
    assert.equal(canProposePiRevision(actor, { ...target, hasPendingRevision: true }), false)
    assert.equal(canProposePiRevision(actor, { ...target, orderStatus: 'cancelled' }), false)
    assert.equal(canProposePiRevision(actor, { ...target, hasCurrentVersion: false }), false)
  })

  test('View As lends nothing: a null viewer proposes nothing', () => {
    assert.equal(canProposePiRevision({ viewerId: null, isAdmin: true, canCreate: true }, target), false)
  })

  test('deciding a revision is an active admin\'s, and nobody else\'s', () => {
    assert.equal(canDecidePiRevision({ isAdmin: true }), true)
    assert.equal(canDecidePiRevision({ isAdmin: false }), false)
  })
})

describe('validation and words', () => {
  test('a revision needs a reason of at most 500 characters', () => {
    assert.deepEqual(validateRevisionReason('  '), { ok: false, message: REVISION_REASON_REQUIRED })
    assert.deepEqual(validateRevisionReason('x'.repeat(501)), { ok: false, message: REVISION_REASON_TOO_LONG })
    assert.deepEqual(validateRevisionReason('  client changed line 3 '), { ok: true, reason: 'client changed line 3' })
  })

  test('a rejection needs a reason too', () => {
    assert.deepEqual(validateRevisionDecisionReason(''), { ok: false, message: REVISION_DECISION_REASON_REQUIRED })
    assert.equal(validateRevisionDecisionReason('wrong quantity').ok, true)
  })

  test('the file must be an .xlsx workbook', () => {
    assert.equal(validateRevisionFile(null), REVISION_FILE_REQUIRED)
    assert.equal(validateRevisionFile({ name: 'pi.pdf', size: 1 }), REVISION_FILE_NOT_XLSX)
    assert.equal(validateRevisionFile({ name: 'PI-Kalyan.XLSX', size: 1 }), null)
  })

  test('a revised workbook is stored where every workbook is, so every parser path recognises it', () => {
    const path = revisionWorkbookPath(SUBMISSION, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.equal(isWorkbookPathFor(path, SUBMISSION), true)
  })

  test('the upload dialog says the current PI stays in force', () => {
    assert.ok(/current approved PI stays in force/i.test(UPLOAD_REVISION_NOTE))
    assert.ok(/changes nothing/i.test(UPLOAD_REVISION_NOTE))
  })

  test('every refusal the database can raise has a sentence, and no sentence leaks a code', () => {
    for (const marker of ['ORDER_PI_REVISION_PENDING', 'ORDER_PI_REVISION_SAME_FILE',
                          'ORDER_PI_REVISION_ORDER_CLOSED', 'ORDER_PI_REVISION_NOT_OWNER',
                          'ORDER_PI_REVISION_NOT_PENDING', 'ORDER_PI_REVISION_STALE',
                          'ORDER_PI_REVISION_FILE_MISMATCH']) {
      const sentence = describePiRevisionFailure({ message: `${marker}: raw database text` }, 'approve')
      assert.ok(!sentence.includes(marker), sentence)
      assert.ok(!sentence.includes('raw database text'))
    }
    assert.ok(describePiRevisionFailure({ error: 'PROCESSING_BUSY' }, 'approve').includes('already being processed'))
    assert.ok(describePiRevisionFailure(new Error('boom'), 'approve').includes('Nothing on this Order was changed'))
  })
})
