/**
 * One notification per EVENT, per recipient, per type — what the writer and the migration must keep true.
 *
 * Behaviour against a real database (the guard over existing duplicates, overlapping sends, a failed first sender) is
 * proved by supabase/tests/notifications_event_idempotency_assertions.sql and the scratch real-server run described on
 * the PR. This file pins the parts that never touch a database: how the writer reads the database's answer, what the
 * route does with it, the migration's shape, and the closed list of writers the unique key has to be true of.
 *
 * Run:
 *   node node_modules/tsx/dist/cli.mjs --test src/lib/notifications/eventIdempotency.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EVENT_ONCE_INDEX, insertUserNotifications, isEventAlreadyAnnounced,
  type NotificationInsert, type NotificationInsertClient,
} from '@/lib/notificationWrites'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = read('supabase/migrations/20270229000000_notifications_event_idempotency.sql')
const CODE = MIGRATION.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const ROUTE = read('src/app/api/notify-status-update/route.ts')

const ROW: NotificationInsert = { user_id: 'u-recipient', task_id: 't-1', type: 'task_acknowledged', title: 'x', activity_log_id: 'evt-1' }
const clientAnswering = (error: { message: string; code?: string } | null): NotificationInsertClient => ({
  from: () => ({ insert: async () => ({ error }) }),
})
const DUPLICATE = { code: '23505', message: `duplicate key value violates unique constraint "${EVENT_ONCE_INDEX}"` }

describe('the writer reads the database\'s answer', () => {
  test('a violation of THIS index — and only this one — means "already announced"', () => {
    assert.equal(isEventAlreadyAnnounced(DUPLICATE), true)
    assert.equal(isEventAlreadyAnnounced({ code: '23505', message: 'duplicate key value violates unique constraint "notifications_pkey"' }), false, 'another unique violation is a real error')
    assert.equal(isEventAlreadyAnnounced({ code: '23503', message: `foreign key ... ${EVENT_ONCE_INDEX}` }), false, 'a different SQLSTATE is not it')
    assert.equal(isEventAlreadyAnnounced({ message: `${EVENT_ONCE_INDEX}` }), false, 'no code, no match')
    assert.equal(isEventAlreadyAnnounced(null), false)
  })

  test('a duplicate is a success that says so, not an error', async () => {
    const r = await insertUserNotifications(clientAnswering(DUPLICATE), ROW, { actorId: 'u-actor' })
    assert.deepEqual(r, { inserted: 0, suppressed: 0, selfSuppressed: 0, error: null, duplicate: true })
  })

  test('every other outcome keeps its shape: success has no `duplicate` key, a real error is passed through unchanged', async () => {
    const ok = await insertUserNotifications(clientAnswering(null), ROW, { actorId: 'u-actor' })
    assert.deepEqual(ok, { inserted: 1, suppressed: 0, selfSuppressed: 0, error: null })
    assert.equal('duplicate' in ok, false)
    const pk = { code: '23505', message: 'duplicate key value violates unique constraint "notifications_pkey"' }
    const bad = await insertUserNotifications(clientAnswering(pk), ROW, { actorId: 'u-actor' })
    assert.deepEqual(bad.error, pk)
    assert.equal(bad.inserted, 0)
    assert.equal('duplicate' in bad, false)
  })

  test('sending to yourself is still suppressed BEFORE the database is asked', async () => {
    let asked = 0
    const client: NotificationInsertClient = { from: () => ({ insert: async () => { asked++; return { error: null } } }) }
    const r = await insertUserNotifications(client, { ...ROW, user_id: 'u-actor' }, { actorId: 'u-actor' })
    assert.equal(asked, 0)
    assert.equal(r.selfSuppressed, 1)
  })
})

describe('the route', () => {
  test('answers a duplicate as success BEFORE it considers anything else, and its authorisation is unchanged', () => {
    const dup = ROUTE.indexOf('if (duplicate) return NextResponse.json({ success: true, skipped: true, duplicate: true })')
    assert.ok(dup > 0, 'the duplicate branch exists')
    assert.ok(dup < ROUTE.indexOf('if (suppressed > 0)'), 'and comes first')
    assert.ok(ROUTE.indexOf('const callerIsParticipant') < ROUTE.indexOf('insertUserNotifications('), 'authorisation still precedes any write')
    assert.ok(ROUTE.includes('user.id === task.created_by || user.id === task.assigned_to'))
    assert.ok(ROUTE.includes('verifyActivityBelongsToTask'), 'the event id is still verified against the task')
  })

  test('it does not read-then-insert: the database decides', () => {
    assert.equal(/\.from\('notifications'\)\s*\.select/.test(ROUTE), false)
  })
})

describe('the migration', () => {
  test('is a guard and ONE partial unique index — nothing deleted, updated, dropped or reshaped', () => {
    assert.ok(/create unique index if not exists notifications_event_once_idx\s+on public\.notifications \(activity_log_id, user_id, type\)\s+where activity_log_id is not null;/.test(CODE))
    assert.equal((CODE.match(/create (unique )?index/gi) ?? []).length, 1)
    for (const forbidden of [/\bdelete\s+from\b/i, /\bupdate\s+public\./i, /\bdrop\s+(table|index|column|constraint)/i, /\btruncate\b/i, /alter\s+table/i, /\bconcurrently\b/i]) {
      assert.equal(forbidden.test(CODE), false, String(forbidden))
    }
  })

  test('REFUSES, changing nothing, when duplicates already exist — and says how many', () => {
    assert.ok(CODE.includes('having count(*) > 1'))
    assert.ok(CODE.includes('NOTIFICATIONS_EVENT_DUPLICATES'))
    assert.ok(CODE.includes('nothing was changed'))
    assert.ok(CODE.indexOf('NOTIFICATIONS_EVENT_DUPLICATES') < CODE.indexOf('create unique index'), 'the guard runs before the index')
  })

  test('the index name the writer looks for is the one the migration creates', () => {
    assert.ok(CODE.includes(`create unique index if not exists ${EVENT_ONCE_INDEX}`))
  })
})

describe('the closed list of writers the key has to be true of', () => {
  /** Non-test source files that BOTH write notifications and set activity_log_id (git grep: fast and tracked-files only). */
  const grep = (pattern: string, ...paths: string[]) => {
    try { return execFileSync('git', ['grep', '-l', '-E', pattern, '--', ...paths], { encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
  }
  test('every writer sets at most one row per (event, recipient, type) — so the key never refuses a legitimate notice', () => {
    const setsLink = grep('activity_log_id', 'src/*.ts', 'src/*.tsx').filter(f => !/\.test\./.test(f))
    const writers = setsLink.filter(f => grep("insertUserNotifications|from\\('notifications'\\)\\.insert", f).length > 0)
    // The routes below each announce ONE event to ONE recipient. A new writer that links an activity id must be reviewed
    // against the key before it is added here.
    assert.deepEqual(writers.sort(), [
      'src/app/api/cancel-task/route.ts',
      'src/app/api/notify-status-update/route.ts',
      'src/app/api/restore-task/route.ts',
      'src/lib/notificationWrites.ts',
    ])
    // (notifications/route.ts mentions activity_log_id only to READ it: it is not a writer and is not in the list.)
  })

  test('the SQL writer is the review function: one row, to the other party, for one event', () => {
    const sql = read('supabase/migrations/20261212000000_task_review_approval_stops_notifying.sql')
    assert.ok(sql.includes('insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id)'))
    // The statement itself, at the start of a line (the same text also appears once inside a drift-guard string).
    assert.equal((sql.match(/^\s*insert into public\.notifications/gm) ?? []).length, 1)
  })
})
