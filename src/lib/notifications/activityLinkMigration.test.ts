// MIGRATION 116 AND THE WRITE PATHS THAT FILL ITS COLUMN.
//
// Run:
//   npx tsx --test src/lib/notifications/activityLinkMigration.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const MIGRATION = 'supabase/migrations/20261016000000_notifications_link_activity_log.sql'
const sql = read(MIGRATION)
/**
 * The migration with its commentary removed.
 *
 * The header explains at length why ON DELETE CASCADE is wrong here and why no
 * timestamp is used, so a whole-file regex for "CASCADE" or "created_at" finds
 * the explanation and calls it a violation. Assertions about what the migration
 * DOES read this; assertions about what it SAYS read `sql`.
 */
const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
/** Just the ALTER TABLE, so the partial index's `IS NOT NULL` cannot be misread. */
const alterStatement = /ALTER TABLE[\s\S]*?;/i.exec(statements)![0]

// ── 1–6. The migration ───────────────────────────────────────────────────────

describe('1-6. the migration is additive and links nothing by guesswork', () => {
  test('1. the column is nullable — no NOT NULL, no default', () => {
    assert.match(alterStatement, /ADD COLUMN IF NOT EXISTS activity_log_id uuid/i)
    assert.equal(/NOT NULL/i.test(alterStatement), false, 'the column is nullable')
    assert.equal(/DEFAULT/i.test(alterStatement), false, 'and has no default')
    // The partial index DOES say IS NOT NULL — on purpose, and not on the column.
    assert.match(statements, /WHERE activity_log_id IS NOT NULL/i)
  })

  test('2. the FK matches task_activity_log\'s uuid primary key', () => {
    assert.match(sql, /REFERENCES task_activity_log\(id\)/i)
    assert.match(sql, /activity_log_id uuid/i)
    // The type is not a guess: task_attachments already declares the same FK.
    const precedent = read('supabase/migrations/20260619_create_task_attachments.sql')
    assert.match(precedent, /activity_log_id\s+uuid references task_activity_log\(id\)/i)
  })

  test('2b. ON DELETE SET NULL, so a deleted activity row cannot delete a notification', () => {
    assert.match(alterStatement, /ON DELETE SET NULL/i)
    assert.equal(/ON DELETE CASCADE/i.test(statements), false,
      'CASCADE would let a user deletion remove other people\'s notifications')
  })

  test('3. no backfill of any kind', () => {
    assert.equal(/\bUPDATE\s+notifications/i.test(sql), false)
    assert.equal(/\bINSERT\s+INTO/i.test(sql), false)
    assert.equal(/\bDELETE\s+FROM/i.test(sql), false)
  })

  test('4. no trigger, and nothing that links by timestamp', () => {
    assert.equal(/CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(sql), false)
    assert.equal(/CREATE\s+(OR REPLACE\s+)?FUNCTION/i.test(sql), false)
    // The only mentions of created_at are prose explaining why it is NOT used.
    assert.equal(/created_at/i.test(statements), false)
  })

  test('4b. it touches neither task_activity_log nor RLS', () => {
    assert.equal(/ALTER TABLE\s+task_activity_log/i.test(statements), false)
    assert.equal(/POLICY|ROW LEVEL SECURITY|GRANT|REVOKE/i.test(statements), false)
  })

  test('4c. the one index is partial, and named by the repository convention', () => {
    assert.match(sql, /CREATE INDEX IF NOT EXISTS notifications_activity_log_id_idx/i)
    assert.match(sql, /WHERE activity_log_id IS NOT NULL/i)
  })

  test('5. no existing migration file is edited by this change', () => {
    // Every other migration is untouched — asserted for the applied one that
    // matters most below, and structurally here: this file is the only one the
    // branch adds, and it is the newest.
    const files = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.length - 1], '20261016000000_notifications_link_activity_log.sql')
    assert.equal(files[files.length - 2], '20261015000000_task_health_check_stops_notifying.sql')
  })

  test('6. migration 115 still hashes to its pinned value', () => {
    const text = read('supabase/migrations/20261015000000_task_health_check_stops_notifying.sql')
    assert.equal(createHash('sha256').update(text).digest('hex'),
      'f05f7ffffb964ea2a6e0a70a214ca6001b6321a9767fc315c3001fbf22736349')
  })

  test('6b. and it is registered as NOT APPLIED', () => {
    assert.match(sql, /^-- 116\. NOT APPLIED\./m)
  })
})

// ── 7–12. The writers ────────────────────────────────────────────────────────

describe('7-12. every future notification records the id it already holds', () => {
  test('7. the comment path hands over its own activity row', () => {
    const detail = read('src/app/tasks/[id]/page.tsx')
    // The insert reads the id back, and the same variable is sent.
    assert.ok(detail.includes(".select('id, action, note, from_status, to_status"))
    assert.ok(detail.includes("action: 'comment_added', actorName: profile?.full_name, activityLogId: logRow.id"))
  })

  test('7b. and the route VERIFIES it before storing it', () => {
    const route = read('src/app/api/notify-status-update/route.ts')
    assert.ok(route.includes('verifyActivityBelongsToTask(supabase, activityLogId, taskId)'))
    assert.ok(route.includes('isValidUUID(activityLogId)'))
    assert.ok(route.includes('activity_log_id: linkedActivityId'))
    // A client-supplied id is never written unchecked.
    assert.equal(/activity_log_id:\s*activityLogId\b/.test(route), false)
  })

  test('7c. the verification is scoped to the task the notification is about', () => {
    const link = read('src/lib/notifications/activityLink.ts')
    assert.ok(link.includes(".eq('id', activityLogId)"))
    assert.ok(link.includes(".eq('task_id', taskId)"))
  })

  test('8. cancel and restore read their status row back and link it', () => {
    for (const [path, name] of [
      ['src/app/api/cancel-task/route.ts', 'cancelLog'],
      ['src/app/api/restore-task/route.ts', 'restoreLog'],
    ] as const) {
      const src = read(path)
      assert.ok(src.includes(".select('id')"), `${path} reads the id back`)
      assert.ok(src.includes(`activity_log_id: ${name}?.id ?? null`), `${path} links it`)
    }
  })

  test('9. the assignment notification links the task\'s creation row', () => {
    const writer = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
    assert.ok(writer.includes('store.findCreationActivityId(task.id)'))
    assert.ok(writer.includes('activityLogId,'))
    const builder = read('src/lib/tasks/assignmentNotification.ts')
    assert.ok(builder.includes('activity_log_id: activityLogId ?? null'))
  })

  test('11. RETRY re-derives the id — it never creates a second activity row', () => {
    const writer = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
    // The id is LOOKED UP from the task, so a retry finds the same row. What
    // must never appear is a write to the activity table from this path — the
    // notifications insert below it is a different table and is expected.
    assert.equal(/from\(['"]task_activity_log['"]\)[\s\S]{0,80}\.insert\(/.test(writer), false,
      'the assignment writer must never create an activity row')
    assert.ok(writer.includes('findCreationActivityId'))
    const link = read('src/lib/notifications/activityLink.ts')
    assert.ok(link.includes("eq('action', 'created')"), 'identified by meaning, not by time')
    assert.equal(/gte\(|lte\(|created_at['"]\s*,\s*[^{]/.test(link.replace(/order\([^)]*\)/g, '')), false,
      'no timestamp range matching anywhere')
  })

  test('11b. the ordering present is for determinism, not for choosing between events', () => {
    const link = read('src/lib/notifications/activityLink.ts')
    // Ordering exists so two calls return the SAME row; the row is selected by
    // task + action, which names exactly one.
    assert.ok(link.includes("order('created_at', { ascending: true })"))
    assert.ok(link.includes("order('id', { ascending: true })"))
    assert.ok(link.includes('DETERMINISM ACROSS RETRIES'))
  })

  test('12. the five suppressed system types are untouched by this work', () => {
    const notifications = read('src/lib/notifications.ts')
    for (const t of ['escalation', 'overdue', 'stale_flag', 'morning_digest', 'evening_digest']) {
      assert.ok(notifications.includes(`'${t}'`), `${t} is still listed`)
    }
    // Nothing in the new code paths writes or un-suppresses one.
    for (const path of [
      'src/lib/notifications/activityLink.ts',
      'src/lib/notifications/pageEnrichment.ts',
      MIGRATION,
    ]) {
      const src = read(path)
      for (const t of ['escalation', 'overdue', 'stale_flag', 'morning_digest', 'evening_digest']) {
        assert.equal(src.includes(t), false, `${path} must not mention ${t}`)
      }
    }
  })

  test('the approval RPC is deliberately NOT replaced here', () => {
    // transition_task_review() writes both rows in one transaction and already
    // holds v_log_id, so linking it is one line — but replacing a live function
    // from the repository's copy rather than its verified production definition
    // is the mistake this project has already paid for once.
    assert.equal(/transition_task_review/i.test(statements), false)
    assert.match(sql, /NO CHANGE TO `transition_task_review\(\)`/)
  })
})
