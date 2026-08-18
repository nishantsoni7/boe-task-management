/**
 * The submission history, as a person reads it.
 *
 * Two things are being defended here, and both are about what does NOT reach the
 * screen:
 *
 *   1. No internal value is ever rendered. Not a raw action key, not a status
 *      enum, not an id, not the metadata counts the server keeps for its own
 *      diagnosis. A business history that prints "parse_replaced" or a uuid is
 *      one somebody will screenshot into a support thread.
 *   2. No name is guessed. An actor that cannot be resolved says so; it does not
 *      become an id, a blank, or somebody else.
 *
 * The ordering matters for a different reason: the trail is append-only, so it
 * is the record of what actually happened, and a history that reorders itself
 * between two renders is not a record.
 *
 * Pure functions only. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionActivity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PI_ACTIVITY_COLUMNS,
  PI_ADVANCE_ACTIONS,
  PI_ACTIVITY_LABEL,
  PI_ACTIVITY_TONE,
  UNKNOWN_ACTOR,
  activityActorIds,
  describeActivityEntries,
  type PersistedActivity,
} from './submissionActivity'
import { formatSavedAt } from './draftsView'

const RAVI = '11111111-1111-4111-8111-111111111111'
const PRIYA = '22222222-2222-4222-8222-222222222222'

const names = new Map([[RAVI, 'Ravi Menon'], [PRIYA, 'Priya Shah']])

const row = (over: Partial<PersistedActivity> = {}): PersistedActivity => ({
  id: 'a1',
  action: 'submitted',
  actor_id: RAVI,
  note: null,
  created_at: '2026-08-16T09:00:00.000Z',
  ...over,
})

const describe_ = (rows: PersistedActivity[]) => describeActivityEntries(rows, names, formatSavedAt)

// ── Words, not enums ──────────────────────────────────────────────────────────

describe('every action reads as English', () => {
  test('the five actions the migrations admit each have words', () => {
    for (const action of [
      'submission_created', 'parse_replaced', 'submitted', 'changes_requested', 'rejected',
    ]) {
      const label = PI_ACTIVITY_LABEL[action]
      assert.ok(label, `${action} has no label`)
      assert.ok(!label.includes('_'), `${action} must not be shown as a database value`)
    }
  })

  test('the three advance actions read as English too', () => {
    for (const action of [
      'advance_exception_requested', 'advance_exception_approved', 'advance_exception_rejected',
    ]) {
      const label = PI_ACTIVITY_LABEL[action]
      assert.ok(label, `${action} has no label`)
      assert.ok(!label.includes('_'), `${action} must not be shown as a database value`)
      assert.ok(PI_ADVANCE_ACTIONS.has(action), `${action} must carry its figures`)
    }
  })

  test('the advance set is exactly the three events that carry figures', () => {
    assert.deepEqual([...PI_ADVANCE_ACTIONS].sort(), [
      'advance_exception_approved',
      'advance_exception_rejected',
      'advance_exception_requested',
    ])
    for (const action of PI_ADVANCE_ACTIONS) {
      assert.ok(PI_ACTIVITY_LABEL[action], `${action} must also be nameable`)
    }
  })

  test('the labels match the action set the migrations define', () => {
    // The CONSTRAINT is the authority; this keeps the two from drifting apart
    // silently, which is exactly how a raw enum ends up on screen. The set is
    // closed and grows only in a migration, so the newest one that rewrites it
    // is the one to read.
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const phaseB = readFileSync(
      join(dir, '20260913000000_order_submission_advance_exceptions.sql'), 'utf8')
    const start = phaseB.indexOf('add constraint order_submission_activity_action_check')
    assert.ok(start > 0, 'Phase B must restate the action constraint')
    const constraint = phaseB.slice(start, phaseB.indexOf(';', start))

    for (const action of Object.keys(PI_ACTIVITY_LABEL)) {
      assert.ok(constraint.includes(`'${action}'`), `${action} is labelled but not in the constraint`)
    }
    // And the other way round: an action the database admits but the screen
    // cannot name would be dropped from the history silently.
    const admitted = [...constraint.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    for (const action of admitted) {
      assert.ok(PI_ACTIVITY_LABEL[action], `${action} is admitted but has no words`)
    }
    assert.equal(Object.keys(PI_ACTIVITY_LABEL).length, 8,
      'eight actions exist after Phase B; a ninth needs its own migration and its own words')
  })

  test('an action this build does not know is dropped, not printed raw', () => {
    const entries = describe_([row(), row({ id: 'a2', action: 'approved' })])
    assert.equal(entries.length, 1, 'a later phase’s action must not appear as an enum')
    assert.equal(entries[0].label, 'Submitted for approval')
  })

  test('nothing about PI approval is claimed by this phase’s vocabulary', () => {
    const words = Object.values(PI_ACTIVITY_LABEL).join(' ').toLowerCase()
    // "Advance exception approved" is a real event and says so. What must never
    // appear is a word claiming the PI itself, or an order, was approved or
    // numbered — so the check is on the PHRASES that would say that, not on the
    // word "approved", which now legitimately appears.
    for (const forbidden of ['pi approved', 'order approved', 'approved for order',
                             'order number', 'order created', 'payment']) {
      assert.ok(!words.includes(forbidden), `no label may say "${forbidden}"`)
    }
    assert.equal(PI_ACTIVITY_LABEL['advance_exception_approved'], 'Advance exception approved')
    assert.equal(PI_ACTIVITY_LABEL['rejected'], 'Rejected',
      'and the PI’s own rejection stays distinct from the advance exception’s')
    // The two rejections are told apart by their LABELS and by nothing else.
    // There used to be a fixed sentence under each advance event saying what it
    // did and did not mean; it repeated under every occurrence and has been
    // dropped, so the words above have to carry the distinction on their own.
    assert.equal(PI_ACTIVITY_LABEL['advance_exception_rejected'], 'Advance exception rejected')
  })
})

// ── Order ─────────────────────────────────────────────────────────────────────

describe('the history is newest first, and stays that way', () => {
  test('later events come first', () => {
    const entries = describe_([
      row({ id: 'a', action: 'submission_created', created_at: '2026-08-01T09:00:00.000Z' }),
      row({ id: 'c', action: 'rejected', created_at: '2026-08-20T09:00:00.000Z' }),
      row({ id: 'b', action: 'submitted', created_at: '2026-08-10T09:00:00.000Z' }),
    ])
    assert.deepEqual(entries.map(e => e.label),
      ['Rejected', 'Submitted for approval', 'Draft created'])
  })

  test('two events written in the same transaction keep a stable order', () => {
    const at = '2026-08-16T09:00:00.000Z'
    const first = describe_([
      row({ id: 'a', created_at: at }),
      row({ id: 'b', action: 'changes_requested', created_at: at }),
    ])
    const again = describe_([
      row({ id: 'b', action: 'changes_requested', created_at: at }),
      row({ id: 'a', created_at: at }),
    ])
    assert.deepEqual(first.map(e => e.key), again.map(e => e.key),
      'the same rows must render in the same order however they arrive')
  })

  test('the input array is not mutated', () => {
    const rows = [
      row({ id: 'a', created_at: '2026-08-01T09:00:00.000Z' }),
      row({ id: 'b', created_at: '2026-08-20T09:00:00.000Z' }),
    ]
    describe_(rows)
    assert.deepEqual(rows.map(r => r.id), ['a', 'b'])
  })
})

// ── Names ─────────────────────────────────────────────────────────────────────

describe('actors are named, or honestly not', () => {
  test('a resolved actor is their name', () => {
    assert.equal(describe_([row({ actor_id: PRIYA, action: 'rejected' })])[0].actor, 'Priya Shah')
  })

  test('an unresolved actor is a phrase, never an id', () => {
    const entries = describe_([row({ actor_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })])
    assert.equal(entries[0].actor, UNKNOWN_ACTOR)
    assert.ok(!entries[0].actor.includes('ffff'))
  })

  test('a deleted account leaves a null actor, which is still not blank', () => {
    assert.equal(describe_([row({ actor_id: null })])[0].actor, UNKNOWN_ACTOR)
  })

  test('the ids to look up are collected once, deduplicated, with the extras', () => {
    const ids = activityActorIds(
      [row({ id: 'a', actor_id: RAVI }), row({ id: 'b', actor_id: RAVI }), row({ id: 'c', actor_id: null })],
      [PRIYA, null, undefined, RAVI],
    )
    assert.deepEqual(ids.sort(), [RAVI, PRIYA].sort())
    assert.equal(ids.length, 2, 'one read for every name, not one per row')
  })

  test('no ids means no read at all', () => {
    assert.deepEqual(activityActorIds([], []), [])
    assert.deepEqual(activityActorIds([row({ actor_id: null })], [null]), [])
  })
})

// ── What is not shown ─────────────────────────────────────────────────────────

describe('internal bookkeeping stays internal', () => {
  test('the status columns are never even selected', () => {
    assert.equal(PI_ACTIVITY_COLUMNS, 'id, action, actor_id, note, created_at, metadata')
    for (const column of ['previous_status', 'new_status', 'submission_id']) {
      assert.ok(!PI_ACTIVITY_COLUMNS.includes(column),
        `${column} is not rendered, so it is not read`)
    }
    assert.ok(!PI_ACTIVITY_COLUMNS.includes('*'), 'a named list, never a star select')
  })

  test('an entry carries only what is displayed', () => {
    const [entry] = describe_([row({ note: '  Fabric on line 3 is wrong.  ' })])
    // `tone` IS displayed: it is the colour of the marker beside the event in
    // the audit trail, and it is decided HERE — beside the labels — because a
    // marker colour is a statement about what an event means. A screen free to
    // pick its own would be free to decide that a rejection is amber. The raw
    // action still never leaves this module.
    assert.deepEqual(Object.keys(entry).sort(),
      ['actor', 'at', 'figures', 'key', 'label', 'note', 'tone'])
    assert.equal(entry.note, 'Fabric on line 3 is wrong.', 'the note is trimmed, not reworded')
    assert.equal(entry.tone, 'blue', 'a submission is marked with the state it moved to')
  })

  test('colour is spent only where an event carries state', () => {
    const tone = (action: string) => describe_([row({ action })])[0].tone
    // Two neutral, so the trail is not a rainbow: creating and replacing a
    // document are bookkeeping, not decisions.
    assert.equal(tone('submission_created'), 'neutral')
    assert.equal(tone('parse_replaced'), 'neutral')
    assert.equal(tone('submitted'), 'blue')
    assert.equal(tone('changes_requested'), 'amber')
    assert.equal(tone('advance_exception_requested'), 'amber')
    assert.equal(tone('advance_exception_approved'), 'green')
    // The PI's rejection and the refusal of one of its terms are both red, and
    // their LABELS are what keep them apart — as they always have.
    assert.equal(tone('rejected'), 'red')
    assert.equal(tone('advance_exception_rejected'), 'red')
  })

  test('every action the trail admits has a colour, and no other does', () => {
    assert.deepEqual(
      Object.keys(PI_ACTIVITY_TONE).sort(),
      Object.keys(PI_ACTIVITY_LABEL).sort(),
      'an action that can be named must be markable, and nothing else is')
  })

  test('metadata is read, and exactly two of its keys ever reach the screen', () => {
    // The object the server records also holds item_count, resubmitted,
    // standard_percent, grand_total and exception_status. None of those is a
    // question anybody is asking on this screen.
    const [entry] = describe_([row({
      action: 'advance_exception_requested',
      metadata: {
        advance_percent: 12.5,
        advance_amount: 147500,
        grand_total: 1180000,
        standard_percent: 40,
        exception_status: 'pending',
        item_count: 9,
      },
    })])
    assert.equal(entry.figures, '12.5% · ₹1,47,500')
    const rendered = `${entry.label} ${entry.actor} ${entry.figures} ${entry.note}`
    for (const leaked of ['1180000', 'standard_percent', 'exception_status', 'item_count', '9']) {
      assert.ok(!rendered.includes(leaked), `${leaked} must not reach the screen`)
    }
  })

  test('an ordinary event has no figures of its own to borrow', () => {
    for (const action of ['submitted', 'changes_requested', 'rejected',
                          'submission_created', 'parse_replaced']) {
      const [entry] = describe_([row({ action, metadata: { advance_percent: 12.5 } })])
      assert.equal(entry.figures, null, `${action} must not borrow advance figures`)
      assert.ok(!PI_ADVANCE_ACTIONS.has(action))
    }
  })

  test('no entry carries a generated explanatory sentence any more', () => {
    for (const action of Object.keys(PI_ACTIVITY_LABEL)) {
      const [entry] = describe_([row({ action })])
      assert.ok(!('detail' in entry), `${action} must not carry generated prose`)
    }
  })

  test('a missing or malformed metadata object renders a plain event', () => {
    for (const metadata of [undefined, null, {}, { advance_percent: null },
                            { advance_percent: 'not a number' }]) {
      const [entry] = describe_([row({ action: 'advance_exception_approved', metadata })])
      assert.equal(entry.figures, null)
      assert.equal(entry.label, 'Advance exception approved', 'the event itself is still shown')
    }
  })

  test('a percentage arriving as a string is still a percentage', () => {
    // PostgREST renders `numeric` as a STRING to keep its precision.
    const [entry] = describe_([row({
      action: 'advance_exception_rejected',
      metadata: { advance_percent: '0', advance_amount: '0' },
    })])
    assert.equal(entry.figures, '0% · ₹0')
  })

  test('a zero-percent proposal shows ₹0 rather than nothing', () => {
    const [entry] = describe_([row({
      action: 'advance_exception_requested',
      metadata: { advance_percent: 0, advance_amount: 0 },
    })])
    assert.equal(entry.figures, '0% · ₹0')
  })

  test('an amount the server did not record leaves the percentage alone on the line', () => {
    const [entry] = describe_([row({
      action: 'advance_exception_approved',
      metadata: { advance_percent: 7.25 },
    })])
    assert.equal(entry.figures, '7.25%')
  })

  test('a blank note is nothing rather than an empty line', () => {
    for (const note of ['', '   ', null]) {
      assert.equal(describe_([row({ note })])[0].note, null)
    }
  })

  test('the time is written by the caller’s own formatter', () => {
    const [entry] = describe_([row({ created_at: '2026-08-16T09:00:00.000Z' })])
    assert.equal(entry.at, formatSavedAt('2026-08-16T09:00:00.000Z'))
    assert.ok(entry.at.includes('2026'), 'so every "when" in Orders is written the same way')
  })
})
