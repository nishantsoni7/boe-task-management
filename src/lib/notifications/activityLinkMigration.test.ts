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

/** The fragments the drift guard requires, parsed out of its array literal. */
function guardFragments(): string[] {
  const start = statements.indexOf('v_required text[] := array[')
  const end = statements.indexOf('  ];', start)
  assert.ok(start >= 0 && end > start, 'the guard array was not found')
  return [...statements.slice(start, end).matchAll(/^\s*'((?:[^']|'')*)',?\s*$/gm)]
    .map(m => m[1].replace(/''/g, "'"))
}

/** The function body, as lines, from either file. */
function fnBodyOf(text: string): string[] {
  const start = text.indexOf('create or replace function public.transition_task_review(')
  assert.ok(start >= 0, 'function not found')
  const end = text.indexOf('\n$$;', start)
  assert.ok(end > start, 'function end not found')
  return text.slice(start, end + 4).split('\n')
}

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
    assert.match(statements, /REFERENCES public\.task_activity_log\(id\)/i)
    assert.match(sql, /activity_log_id uuid/i)
    // The type is not a guess: task_attachments already declares the same FK.
    const precedent = read('supabase/migrations/20260619_create_task_attachments.sql')
    assert.match(precedent, /activity_log_id\s+uuid references task_activity_log\(id\)/i)
  })

  test('2b. ON DELETE SET NULL, so a deleted activity row cannot delete a notification', () => {
    assert.match(statements, /ON DELETE SET NULL/i)
    assert.equal(/ON DELETE CASCADE/i.test(statements), false,
      'CASCADE would let a user deletion remove other people\'s notifications')
  })

  test('3. no backfill of any kind', () => {
    // The function body legitimately inserts and updates as part of the
    // workflow it has always performed. What must not exist is a statement that
    // writes historical notifications — an UPDATE of the new column, or an
    // INSERT/DELETE against `notifications` outside the function.
    // String literals stripped first: the drift guard SEARCHES the live
    // definition for the text "insert into public.notifications ...", and that
    // search string is data, not a statement.
    const outsideFn = statements
      .slice(0, statements.indexOf('create or replace function'))
      .replace(/'(?:[^']|'')*'/g, "''")
    assert.equal(/\bUPDATE\b/i.test(outsideFn), false, 'no backfill')
    assert.equal(/\bINSERT\s+INTO\b/i.test(outsideFn), false)
    assert.equal(/\bDELETE\s+FROM\b/i.test(outsideFn), false)
    assert.equal(/update\s+public\.notifications|update\s+notifications\s+set/i.test(statements), false,
      'nothing sets activity_log_id on an existing row')
  })

  test('4. no trigger, and nothing that links by timestamp', () => {
    assert.equal(/CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(statements), false)
    // It DOES replace one function — transition_task_review, step 3 — and only
    // that one. The point was never "no functions"; it is that nothing INFERS a
    // link, which the next two assertions are about.
    const created = [...statements.matchAll(/create or replace function\s+([\w.]+)/gi)].map(m => m[1])
    assert.deepEqual(created, ['public.transition_task_review'])
    // The link is v_log_id — the id the same transaction just wrote.
    assert.match(statements, /activity_log_id\)\s*\n\s*values \([^)]*v_log_id\)/)
    assert.equal(/created_at/i.test(statements), false, 'no timestamp is consulted anywhere')
  })

  test('4b. it touches neither task_activity_log nor RLS', () => {
    assert.equal(/ALTER TABLE\s+task_activity_log/i.test(statements), false)
    // GRANT/REVOKE appear only as the function's OWN pre-existing grants,
    // restated unchanged because CREATE OR REPLACE does not alter them.
    assert.equal(/POLICY|ROW LEVEL SECURITY/i.test(statements), false)
    const grantLines = statements.split('\n').filter(l => /^\s*(grant|revoke)\b/i.test(l))
    assert.equal(grantLines.length, 2)
    for (const l of grantLines) assert.match(l, /transition_task_review\(uuid, text, text\)/)
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

  test('10. the approval RPC records the id it already holds, atomically', () => {
    // It writes the activity row and the notification in ONE transaction and
    // captures the id in v_log_id, so there is no window in which the
    // notification exists unlinked.
    assert.match(statements, /returning id into v_log_id/)
    assert.match(statements, /values \(v_recipient, p_task_id, 'task_acknowledged', v_title, v_task\.title, true, v_log_id\)/)
    // All three of its events go through that one insert.
    for (const suffix of [
      ' submitted task for approval', ' approved and completed task', ' returned task to Working',
    ]) {
      assert.ok(statements.includes(suffix), `${suffix} is still composed by this function`)
    }
  })

  test('10b. the replacement REFUSES to run against a definition it did not expect', () => {
    assert.match(statements, /pg_get_functiondef\('public\.transition_task_review\(uuid, text, text\)'::regprocedure\)/)
    assert.match(statements, /TRANSITION_TASK_REVIEW_DRIFTED/)
    assert.match(statements, /TRANSITION_TASK_REVIEW_ALREADY_LINKED/)
    assert.match(statements, /TRANSITION_TASK_REVIEW_MISSING/)
    // And the guard runs BEFORE the replacement.
    assert.ok(statements.indexOf('TRANSITION_TASK_REVIEW_DRIFTED')
      < statements.indexOf('create or replace function public.transition_task_review'))
    // The four properties a live catalog query DID corroborate are re-checked
    // at apply time, so a function that has since lost them stops the run.
    assert.match(statements, /SECURITY DEFINER' in upper\(v_current\)/)
    assert.match(statements, /'public, pg_temp' in v_current/)
  })

  test('10b-i. the guard covers EVERY protected business rule, not one substring', () => {
    // A single substring check would prove almost nothing about the rest of the
    // function. Each of these sections must be asserted by name.
    const arr = guardFragments()
    const need: [section: string, fragment: string][] = [
      ['actor identity',      'auth.uid()'],
      ['row lock',            'for update'],
      ['authorization: submit',  'Only the assignee can submit this task for approval'],
      ['authorization: approve', 'Only the task creator can approve this task'],
      ['authorization: return',  'Only the task creator can return this task'],
      ['source status: submit',  'cannot be submitted for approval'],
      ['source status: approve', 'Only a task awaiting approval can be approved'],
      ['source status: return',  'Only a task awaiting approval can be returned'],
      ['acknowledge gate',    'TASK_NOT_ACKNOWLEDGED'],
      ['scope: quotation',    'TASK_REVIEW_NOT_APPLICABLE'],
      ['scope: delegated',    'TASK_REVIEW_NOT_DELEGATED'],
      ['recipient: creator',  'v_recipient := v_task.created_by'],
      ['recipient: assignee', 'v_recipient := v_task.assigned_to'],
      ['self-notify guard',   'v_recipient <> v_uid'],
      ['return reason',       'TASK_RETURN_REASON_REQUIRED'],
      ['reason ceiling',      'length(v_note) > 1000'],
      ['the changed insert',  "insert into public.notifications (user_id, task_id, type, title, body, is_push_sent)"],
    ]
    for (const [section, fragment] of need) {
      assert.ok(arr.includes(fragment), `the guard does not cover ${section}`)
    }
    // Both context GUC writes that 20260834's enforcement trigger reads.
    assert.equal(arr.filter(f => f.includes('boe.task_review_context')).length, 2)
    // And every key of the returned jsonb.
    for (const key of [
      'id', 'status', 'completed_at', 'last_update_at', 'blocker_reason',
      'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
      'from_status', 'activity_id', 'actor_name', 'note',
    ]) {
      assert.ok(arr.includes(`'${key}',`), `the returned shape's ${key} is unguarded`)
    }
  })

  test('10b-ii. every guarded fragment really exists in the definition it guards', () => {
    // A guard that asserts a fragment the function does not contain would fail
    // against the correct function — a guard that always fails is worse than
    // none. Checked mechanically against 20260833000000's body.
    const source = read('supabase/migrations/20260833000000_task_creator_approval.sql')
    const body = fnBodyOf(source).join('\n')
    const missing = guardFragments().filter(f => !body.includes(f))
    assert.deepEqual(missing, [], 'guard fragments absent from the source function')
  })

  test('10b-iii. the migration states what the guard CANNOT detect', () => {
    // The limits are part of the deliverable: a substring guard must never be
    // presented as a complete drift check.
    assert.match(sql, /WHAT IT CANNOT DETECT/)
    assert.match(sql, /a rule ADDED in production/)
    assert.match(sql, /an inverted comparison/)
    assert.match(sql, /ACLs/)
    assert.match(sql, /WHAT IT IS NOT: a full-definition comparison/)
    // And it points at the capture that would close them.
    assert.match(sql, /docs\/proposals\/transition_task_review\.production\.sql/)
  })

  test('10b-iv. no cryptographic extension is required', () => {
    // pgcrypto is not guaranteed in this project, so the guard uses position()
    // and array membership rather than a digest of the definition.
    assert.equal(/pgcrypto|digest\(|sha256|md5\(/i.test(statements), false)
  })

  test('10c. THE MECHANICAL COMPARISON: the body differs by exactly two lines', () => {
    // Re-derived here from the two files rather than asserted from memory. If a
    // future edit changes anything else in that function, this fails and names
    // the extra lines.
    const source = read('supabase/migrations/20260833000000_task_creator_approval.sql')
    const before = fnBodyOf(source)
    const after = fnBodyOf(sql)
    assert.equal(before.length, after.length, 'no line was added or removed')

    const changed: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i)
    assert.equal(changed.length, 2,
      `expected exactly 2 changed lines, got ${changed.length}: ` +
      changed.map(i => `\n  - ${before[i]}\n  + ${after[i]}`).join(''))

    assert.equal(before[changed[0]].trim(),
      "insert into public.notifications (user_id, task_id, type, title, body, is_push_sent)")
    assert.equal(after[changed[0]].trim(),
      "insert into public.notifications (user_id, task_id, type, title, body, is_push_sent, activity_log_id)")
    assert.equal(before[changed[1]].trim(),
      "values (v_recipient, p_task_id, 'task_acknowledged', v_title, v_task.title, true);")
    assert.equal(after[changed[1]].trim(),
      "values (v_recipient, p_task_id, 'task_acknowledged', v_title, v_task.title, true, v_log_id);")
  })

  test('10d. signature, security mode, search_path and grants are unchanged', () => {
    const source = read('supabase/migrations/20260833000000_task_creator_approval.sql')
    for (const line of [
      'p_task_id uuid,', 'p_action  text,', 'p_note    text default null',
      'returns jsonb', 'language plpgsql', 'security definer',
      'set search_path = public, pg_temp',
    ]) {
      assert.ok(statements.includes(line), `${line} must be preserved`)
      assert.ok(source.includes(line))
    }
    assert.match(statements, /revoke all\s+on function public\.transition_task_review\(uuid, text, text\) from public, anon;/)
    assert.match(statements, /grant execute on function public\.transition_task_review\(uuid, text, text\) to authenticated;/)
  })

  test('10e. the steps run in the order the column requires', () => {
    // Replacing the function first fails with 42703: its body references a
    // column that does not exist yet. Column, then FK and index, then function.
    const col = statements.indexOf('ADD COLUMN IF NOT EXISTS activity_log_id')
    const fk = statements.indexOf('ADD CONSTRAINT notifications_activity_log_id_fkey')
    const idx = statements.indexOf('CREATE INDEX IF NOT EXISTS notifications_activity_log_id_idx')
    const fn = statements.indexOf('create or replace function public.transition_task_review')
    assert.ok(col >= 0 && fk > col && idx > fk && fn > idx,
      `order is wrong: column=${col} fk=${fk} index=${idx} function=${fn}`)
  })
})
