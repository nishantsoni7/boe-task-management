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
  PI_ACTIVITY_LABEL,
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

  test('the labels match the action set the migrations define', () => {
    // The constraint is the authority; this keeps the two from drifting apart
    // silently, which is exactly how a raw enum ends up on screen.
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const phaseA = readFileSync(join(dir, '20260910000000_order_submission_phase_a_review.sql'), 'utf8')
    const constraint = phaseA.slice(phaseA.indexOf('order_submission_activity_action_check'))
    for (const action of Object.keys(PI_ACTIVITY_LABEL)) {
      assert.ok(constraint.includes(`'${action}'`), `${action} is labelled but not in the constraint`)
    }
    assert.equal(Object.keys(PI_ACTIVITY_LABEL).length, 5,
      'five actions exist in this phase; a sixth needs its own migration and its own words')
  })

  test('an action this build does not know is dropped, not printed raw', () => {
    const entries = describe_([row(), row({ id: 'a2', action: 'approved' })])
    assert.equal(entries.length, 1, 'a later phase’s action must not appear as an enum')
    assert.equal(entries[0].label, 'Submitted for approval')
  })

  test('nothing about approval is claimed by this phase’s vocabulary', () => {
    const words = Object.values(PI_ACTIVITY_LABEL).join(' ').toLowerCase()
    assert.ok(!words.includes('approved'))
    assert.ok(!words.includes('order number'))
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
  test('metadata and the status columns are never even selected', () => {
    assert.equal(PI_ACTIVITY_COLUMNS, 'id, action, actor_id, note, created_at')
    for (const column of ['metadata', 'previous_status', 'new_status', 'submission_id']) {
      assert.ok(!PI_ACTIVITY_COLUMNS.includes(column),
        `${column} is not rendered, so it is not read`)
    }
    assert.ok(!PI_ACTIVITY_COLUMNS.includes('*'), 'a named list, never a star select')
  })

  test('an entry carries only what is displayed', () => {
    const [entry] = describe_([row({ note: '  Fabric on line 3 is wrong.  ' })])
    assert.deepEqual(Object.keys(entry).sort(), ['actor', 'at', 'key', 'label', 'note'])
    assert.equal(entry.note, 'Fabric on line 3 is wrong.', 'the note is trimmed, not reworded')
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
