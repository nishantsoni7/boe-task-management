/**
 * WHICH PI IS IN FORCE, and what the history says about every version behind it.
 *
 * THE FAILURE THESE EXIST TO PREVENT is a card that reads "Main PI" off the
 * newest row. An Order runs on the APPROVED document; a pending revision is a
 * proposal and a rejected one never ran on anything. Putting an unapproved
 * figure under that heading would misinform the person planning production.
 *
 * Pure functions over rows describePiVersionHistory has already shaped. No
 * database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderMainPi.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAIN_PI_AWAITING,
  MAIN_PI_NONE,
  REMARK_INITIAL,
  REMARK_NOT_RECORDED,
  mainPiCard,
  piVersionTimeline,
  remarkIsBlank,
  revisionRemarkRequired,
} from './orderMainPi'
import {
  describePiVersionHistory,
  type PersistedPiVersion,
} from './orderPiVersions'

const NAMES = new Map([['u1', 'Nishant Soni'], ['u2', 'Ravi Menon']])
const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

function row(over: Partial<PersistedPiVersion> = {}): PersistedPiVersion {
  return {
    id: 'v1', order_id: 'o1', submission_id: 's1', version_number: 1, status: 'approved',
    workbook_path: 'submissions/s1/original/pi.xlsx', workbook_name: 'PI.xlsx',
    uploaded_by: 'u1', uploaded_at: '2026-09-02T05:34:00Z', revision_reason: null,
    decided_by: 'u2', decided_at: '2026-09-08T06:00:00Z', decision_reason: null,
    superseded_at: null,
    ...over,
  }
}

const history = (rows: PersistedPiVersion[]) => describePiVersionHistory(rows, NAMES, when)

// ── The Main PI ───────────────────────────────────────────────────────────────

describe('the Main PI is the latest APPROVED version', () => {
  test('a single approved V1 is the Main PI', () => {
    const card = mainPiCard(history([row()]))
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.reference, 'PI V1')
    assert.equal(card.statusLabel, 'Approved')
    assert.equal(card.uploadedAt, '2026-09-02')
    assert.equal(card.approvedAt, '2026-09-08')
    assert.equal(card.pendingRevision, false)
  })

  test('A NEWER PENDING VERSION DOES NOT BECOME THE MAIN PI', () => {
    // The whole point. V2 is uploaded and waiting; the Order still runs on V1.
    const card = mainPiCard(history([
      row(),
      row({
        id: 'v2', version_number: 2, status: 'pending',
        uploaded_at: '2026-09-20T05:00:00Z', revision_reason: 'Client added 6 chairs',
        decided_by: null, decided_at: null,
      }),
    ]))
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.reference, 'PI V1', 'the approved version stays in force')
    assert.equal(card.pendingRevision, true, 'and the card says a decision is outstanding')
  })

  test('a newer REJECTED version does not become the Main PI either', () => {
    const card = mainPiCard(history([
      row(),
      row({
        id: 'v2', version_number: 2, status: 'rejected',
        revision_reason: 'Wrong workbook', decision_reason: 'Figures did not match',
        uploaded_at: '2026-09-20T05:00:00Z', decided_at: '2026-09-21T05:00:00Z',
      }),
    ]))
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.reference, 'PI V1')
    assert.equal(card.pendingRevision, false)
  })

  test('AN APPROVED REVISION BECOMES THE MAIN PI, and the old one supersedes', () => {
    const card = mainPiCard(history([
      row({ status: 'superseded', superseded_at: '2026-09-22T05:00:00Z' }),
      row({
        id: 'v2', version_number: 2, status: 'approved',
        revision_reason: 'Fabric cost added after approval',
        uploaded_at: '2026-09-20T05:00:00Z', decided_at: '2026-09-22T05:00:00Z',
      }),
    ]))
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.reference, 'PI V2')
    assert.equal(card.uploadedAt, '2026-09-20')
    assert.equal(card.approvedAt, '2026-09-22')
  })

  test('an Order with no versions at all says so, and substitutes nothing', () => {
    const card = mainPiCard(history([]))
    assert.equal(card.kind, 'none')
    if (card.kind !== 'none') return
    assert.equal(card.message, MAIN_PI_NONE)
  })

  test('an Order whose ONLY version is pending says a decision is outstanding', () => {
    // It must not print the pending version as though it were in force.
    const card = mainPiCard(history([
      row({ status: 'pending', version_number: 1, decided_by: null, decided_at: null }),
    ]))
    assert.equal(card.kind, 'awaiting')
    if (card.kind !== 'awaiting') return
    assert.equal(card.message, MAIN_PI_AWAITING)
  })

  test('a version with no stored file is reported, not offered', () => {
    const card = mainPiCard(history([row({ workbook_path: null })]))
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.hasFile, false, 'the card disables its file actions')
  })

  test('an approval date is never filled in from the upload date', () => {
    // decided_at is NOT NULL for an approved row in practice; this pins that a
    // record without one says nothing rather than repeating the upload stamp.
    const rows = [row()]
    const built = history(rows)
    const stripped = { ...built, current: built.current && { ...built.current, decidedAt: null } }
    const card = mainPiCard(stripped)
    assert.equal(card.kind, 'ready')
    if (card.kind !== 'ready') return
    assert.equal(card.approvedAt, null)
    assert.notEqual(card.approvedAt, card.uploadedAt)
  })
})

// ── The history ───────────────────────────────────────────────────────────────

describe('the PI history lists every version, newest first', () => {
  const four = () => history([
    row({ status: 'superseded', superseded_at: '2026-09-10T05:00:00Z' }),
    row({
      id: 'v2', version_number: 2, status: 'rejected',
      revision_reason: 'Wrong file', decision_reason: 'Figures did not match',
    }),
    row({
      id: 'v3', version_number: 3, status: 'approved',
      revision_reason: 'Client changed chair quantity from 30 to 36',
    }),
    row({
      id: 'v4', version_number: 4, status: 'pending',
      revision_reason: 'Delivery address updated', decided_by: null, decided_at: null,
    }),
  ])

  test('every version appears, in descending version order', () => {
    assert.deepEqual(piVersionTimeline(four()).map(e => e.version.versionNumber), [4, 3, 2, 1])
  })

  test('exactly one entry is marked current, and it is the approved one', () => {
    const marked = piVersionTimeline(four()).filter(e => e.isCurrent)
    assert.equal(marked.length, 1)
    assert.equal(marked[0].version.versionNumber, 3)
    assert.equal(marked[0].version.status, 'approved')
  })

  test('nothing is marked current when nothing is approved', () => {
    const entries = piVersionTimeline(history([
      row({ status: 'pending', decided_by: null, decided_at: null }),
    ]))
    assert.ok(entries.every(e => !e.isCurrent))
  })

  test('a recorded remark is printed verbatim', () => {
    const v3 = piVersionTimeline(four()).find(e => e.version.versionNumber === 3)
    assert.equal(v3?.remark, 'Client changed chair quantity from 30 to 36')
    assert.equal(v3?.remarkMissing, false)
  })

  test('THE INITIAL PI IS NOT ASKED FOR ONE, and is not marked as missing it', () => {
    const v1 = piVersionTimeline(four()).find(e => e.version.versionNumber === 1)
    assert.equal(v1?.remark, REMARK_INITIAL)
    assert.equal(v1?.remarkMissing, false)
  })

  test('A HISTORICAL REVISION WITH NO REMARK SAYS `Not recorded` — never invented', () => {
    // Rows written before the remark was required legitimately carry none.
    const entries = piVersionTimeline(history([
      row(),
      row({ id: 'v2', version_number: 2, status: 'approved', revision_reason: null }),
    ]))
    const v2 = entries.find(e => e.version.versionNumber === 2)
    assert.equal(v2?.remark, REMARK_NOT_RECORDED)
    assert.equal(v2?.remarkMissing, true, 'so the row can mute it')
  })

  test('a whitespace-only stored remark is treated as no remark', () => {
    const entries = piVersionTimeline(history([
      row(),
      row({ id: 'v2', version_number: 2, status: 'approved', revision_reason: '   ' }),
    ]))
    assert.equal(entries.find(e => e.version.versionNumber === 2)?.remark, REMARK_NOT_RECORDED)
  })

  test('the file path travels with every entry, so old versions stay reachable', () => {
    for (const entry of piVersionTimeline(four())) {
      assert.equal(entry.version.workbookPath, 'submissions/s1/original/pi.xlsx', entry.version.label)
    }
  })

  test('an empty Order has an empty timeline rather than an invented row', () => {
    assert.deepEqual(piVersionTimeline(history([])), [])
  })
})

// ── The remark rule, as the dialog states it ──────────────────────────────────

describe('the mandatory change remark', () => {
  test('the initial PI is exempt; every later version is not', () => {
    assert.equal(revisionRemarkRequired(1), false)
    for (const n of [2, 3, 9]) assert.equal(revisionRemarkRequired(n), true, String(n))
  })

  test('whitespace is not a remark', () => {
    for (const blank of ['', ' ', '\t', '\n  \n', null, undefined]) {
      assert.equal(remarkIsBlank(blank), true, JSON.stringify(blank))
    }
    assert.equal(remarkIsBlank('Client added 6 chairs'), false)
  })

  test('THE DATABASE HOLDS THE SAME RULE, and this only mirrors it', () => {
    // The UI check is a courtesy. These two are the enforcement, and they are
    // read out of the migration so the mirror cannot drift from the glass.
    const sql = readFileSync(join(process.cwd(),
      'supabase/migrations/20261119000000_order_submission_pi_review_gate_versions_and_production.sql'), 'utf8')
    assert.match(sql, /constraint order_pi_versions_revision_needs_reason check \(\s*\n\s*version_number = 1 or nullif\(btrim\(coalesce\(revision_reason, ''\)\), ''\) is not null/)
    assert.ok(sql.includes("ORDER_PI_REVISION_REASON_REQUIRED"),
      'and propose_order_pi_revision refuses a blank reason under a row lock')
  })
})
