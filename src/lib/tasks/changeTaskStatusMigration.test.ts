/**
 * 20270230000000_task_change_status_rpc.sql — what the migration is allowed to be.
 *
 * The behaviour is proved against a database by supabase/tests/task_change_status_assertions.sql. This file holds the
 * SHAPE that no SQL suite notices drifting: the function is a SECURITY DEFINER door, so it must stay narrow, pinned
 * and additive, and it must stay out of the places other code owns.
 *
 * Run:
 *   node node_modules/tsx/dist/cli.mjs --test src/lib/tasks/changeTaskStatusMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const FILE = 'supabase/migrations/20270230000000_task_change_status_rpc.sql'
const SQL = read(FILE)
/** Comments explain what the migration refuses to do — code checks read statements only. */
const CODE = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const SIG = 'public.change_task_status(uuid, text, text, text, text, uuid, text)'

describe('change_task_status migration', () => {
  test('is ONE function plus its grants and comment — no table, column, policy, trigger or other function', () => {
    assert.equal((CODE.match(/create or replace function/gi) ?? []).length, 1)
    for (const forbidden of [/create\s+table/i, /alter\s+table/i, /drop\s+(table|column|policy|trigger|function)/i,
      /create\s+(policy|trigger|type|index)/i, /alter\s+type/i, /\bdelete\s+from\b/i, /\btruncate\b/i]) {
      assert.equal(forbidden.test(CODE), false, String(forbidden))
    }
    assert.equal(/\binsert\s+into\s+public\.notifications\b/i.test(CODE), false, 'it writes no notification')
  })

  test('is a pinned SECURITY DEFINER function and its grants are authenticated only', () => {
    assert.ok(/language plpgsql\s+security definer\s+set search_path = public, pg_temp/.test(CODE))
    assert.ok(CODE.includes(`revoke all    on function ${SIG} from public, anon;`))
    assert.ok(CODE.includes(`grant execute on function ${SIG} to authenticated;`))
  })

  test('takes the actor from auth.uid(), never from an argument', () => {
    assert.ok(CODE.includes('v_uid       uuid := auth.uid();'))
    assert.equal(/p_(actor|user|uid)\b/i.test(CODE), false, 'no argument names who is acting')
  })

  test('only the assignee may call it, and it reads the task row under a lock', () => {
    assert.ok(CODE.includes('from public.tasks where id = p_task_id for update'))
    assert.ok(CODE.includes('if v_uid is distinct from v_task.assigned_to then'))
  })

  test('refuses the moves other code owns, and a repeat, and an unacknowledged task', () => {
    for (const code of ['TASK_STATUS_NOT_HERE', 'TASK_STATUS_USE_REVIEW', 'TASK_STATUS_IN_REVIEW', 'TASK_STATUS_FINISHED',
      'TASK_STATUS_UNCHANGED', 'TASK_NOT_ACKNOWLEDGED', 'TASK_STATUS_FORBIDDEN', 'TASK_WAITING_DETAIL_REQUIRED']) {
      assert.ok(CODE.includes(code), code)
    }
    assert.ok(/if p_status = 'cancelled' then/.test(CODE))
    assert.ok(/if p_status = 'pending_approval' then/.test(CODE))
    assert.ok(/if v_delegated and p_status = 'completed' then/.test(CODE), 'a delegated completion is the review path\'s alone')
    assert.ok(/if p_status = v_from then/.test(CODE))
  })

  test('the status, the stale-field resets and the activity row are written by the same function body', () => {
    const update = CODE.indexOf('update public.tasks')
    const insert = CODE.indexOf('insert into public.task_activity_log')
    assert.ok(update > 0 && insert > update, 'update, then the history row, inside one function = one transaction')
    assert.ok(CODE.includes("'status_changed'"))
    assert.ok(CODE.includes("'activity_log_id',    v_log_id"), 'the row id is returned so the notification route can link it')
    assert.ok(/blocker_reason = case when p_status = 'blocked' then v_reason\s+when v_from\s+= 'blocked' then null/.test(CODE))
    assert.ok(/waiting_on_type = case when p_status = 'waiting' then p_waiting_on_type\s+when v_from\s+= 'waiting' then null/.test(CODE))
  })

  test('does not touch the review function or its trigger context', () => {
    // String literals (messages, the function comment) may NAME the review function; statements may not use it.
    const STATEMENTS = CODE.replace(/'(?:[^']|'')*'/g, "''")
    assert.equal(/transition_task_review|boe\.task_review_context|tasks_enforce_review_path/.test(STATEMENTS), false)
  })

  test('is the newest migration here and sorts after the review-path files it relies on', () => {
    assert.ok(FILE.endsWith('20270230000000_task_change_status_rpc.sql'))
    assert.ok(SQL.includes('apply 20260832000000 (pending_approval) first'), 'it states its prerequisite and checks it')
  })
})

describe('SECURITY DEFINER hygiene', () => {
  /**
   * The FUNCTION BODY only (the prerequisite DO block above it reads pg_catalog tables, which resolve through pg_catalog
   * first and cannot be shadowed), with comments and string literals (messages) removed.
   */
  const BODY = CODE.slice(CODE.indexOf('create or replace function public.change_task_status'), CODE.indexOf('revoke all'))
  const STATEMENTS = BODY.replace(/'(?:[^']|'')*'/g, "''")

  test('every relation it reads or writes is schema-qualified', () => {
    const refs = [...STATEMENTS.matchAll(/(?<!distinct\s)\b(from|update|join|insert\s+into)\s+([a-z_][a-z0-9_.]*)/gi)].map(m => m[2])
    assert.ok(refs.length >= 4, 'found the statements to check')
    for (const r of refs) assert.ok(/^(public|auth)\./.test(r), `${r} must be schema-qualified`)
    assert.ok(STATEMENTS.includes('auth.uid()') && !/[^.]\buid\(\)/.test(STATEMENTS), 'auth.uid() is qualified')
    assert.ok(STATEMENTS.includes('::public.task_status'), 'the enum cast is qualified')
  })

  test('search_path is pinned with pg_temp LAST, and nothing runs dynamic SQL or switches role', () => {
    assert.ok(/set search_path = public, pg_temp\s+as \$\$/.test(CODE))
    assert.equal(/\bexecute\b/i.test(STATEMENTS), false, 'no dynamic SQL')
    assert.equal(/\bset\s+(local\s+)?(role|session\s+authorization)\b|set_config\s*\(/i.test(STATEMENTS), false, 'no role switch, no GUC writes')
  })

  test('the task is LOCKED before any rule is judged, and every rule reads the locked row', () => {
    const lock = CODE.indexOf('for update')
    const firstRule = CODE.indexOf('v_uid is distinct from v_task.assigned_to')
    const write = CODE.indexOf('update public.tasks')
    assert.ok(lock > 0 && lock < firstRule && firstRule < write, 'lock, then the rules, then the write')
    // Everything the rules compare against comes from v_task / auth.uid(), never from a caller-supplied field:
    // the only caller-supplied inputs that influence a decision are the target status, reason and waiting detail.
    for (const fact of ['v_task.assigned_to', 'v_task.created_by', 'v_task.acknowledged_at', 'v_task.task_type', 'v_task.status']) {
      assert.ok(CODE.includes(fact), `${fact} is read from the locked row`)
    }
  })

  test('a caller cannot name the actor, the author of the history row, or the task owner', () => {
    assert.ok(/values \(p_task_id, v_uid, 'status_changed'/.test(CODE), 'the history row is authored by auth.uid()')
    assert.equal(/set\s+(created_by|assigned_to|delegated_by)\s*=/i.test(STATEMENTS), false, 'ownership is never written')
  })
})
