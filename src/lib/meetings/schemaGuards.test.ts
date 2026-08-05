/**
 * Repository check: the Meetings migration keeps the guarantees the whole
 * module is built on.
 *
 * Why a repo check and not a review habit
 * ---------------------------------------
 * Three of this module's promises live only in SQL, and each fails SILENTLY if
 * someone later "fixes" the schema by adding the obvious missing policy:
 *
 *   1. Update history is append-only. An UPDATE or DELETE policy on
 *      meeting_update_history would make it editable, and nothing in the app
 *      would look any different.
 *   2. Every SKU update is recorded. That holds only because
 *      meeting_order_items has NO direct UPDATE policy — one added "for
 *      convenience" would let a value move with no trail, and every screen
 *      would keep working.
 *   3. No policy is `USING (true)`. These are confidential management reviews.
 *
 * TypeScript cannot see any of this, and the tests that exercise the pure logic
 * would all still pass. This check reads the migration itself.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/schemaGuards.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** The Meetings migration, located by content rather than by a pinned filename. */
function meetingsMigration(): { file: string; sql: string } {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(file => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }))
    .filter(({ sql }) => /CREATE TABLE public\.meeting_update_history/.test(sql))

  assert.equal(candidates.length, 1, 'expected exactly one migration creating the Meetings tables')
  return candidates[0]
}

const { sql } = meetingsMigration()

/**
 * The migration with `--` comments removed.
 *
 * Needed because this file's own subject matter appears in the migration's
 * prose: the header says "no policy is `USING (true)`", and a check that
 * scanned the raw text would fail on the sentence promising the thing it is
 * verifying. Comments are documentation, not schema.
 */
const code = sql.replace(/--[^\n]*/g, '')

/** Policies declared in the migration, as `{ name, command, table }`. */
function policies(): { name: string; command: string; table: string }[] {
  const out: { name: string; command: string; table: string }[] = []
  const re = /CREATE POLICY\s+"([^"]+)"\s+ON\s+public\.(\w+)\s+FOR\s+(\w+)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    out.push({ name: match[1], table: match[2], command: match[3].toUpperCase() })
  }
  return out
}

const MEETING_TABLES = [
  'meetings', 'meeting_attendees', 'meeting_orders',
  'meeting_order_items', 'meeting_update_history', 'meeting_activity_log',
]

/** The body of one function, for assertions about what it does and in what order. */
function fnBody(name: string): string {
  const match = code.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`),
  )
  assert.ok(match, `${name} not found in the migration`)
  return match[0]
}

describe('Meetings schema guards', () => {
  test('every meeting table has RLS enabled', () => {
    for (const table of MEETING_TABLES) {
      assert.match(
        code,
        new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`),
        `${table} must have RLS enabled`,
      )
    }
  })

  test('no policy is USING (true)', () => {
    // A permissive policy here would expose confidential order reviews to
    // everyone with a login.
    const permissive = code.match(/USING\s*\(\s*true\s*\)/gi) ?? []
    assert.deepEqual(permissive, [], 'a USING (true) policy would make meetings readable by anyone')
  })

  test('update history has no UPDATE and no DELETE policy — for anyone', () => {
    const historyPolicies = policies().filter(p => p.table === 'meeting_update_history')
    assert.deepEqual(
      historyPolicies.map(p => p.command).sort(),
      ['SELECT'],
      'meeting_update_history must be readable and nothing else; history is append-only',
    )
  })

  test('update history has no INSERT policy either — rows arrive only from the definer functions', () => {
    const inserts = policies().filter(p => p.table === 'meeting_update_history' && p.command === 'INSERT')
    assert.deepEqual(inserts, [], 'a client-writable history could be forged')
  })

  test('orders and SKU lines are SELECT-only, so every write carries its history', () => {
    for (const table of ['meeting_orders', 'meeting_order_items']) {
      const commands = policies().filter(p => p.table === table).map(p => p.command).sort()
      assert.deepEqual(
        commands, ['SELECT'],
        `${table} must have no INSERT/UPDATE/DELETE policy — all writes go through the `
        + 'SECURITY DEFINER functions, which is what makes the history entry non-optional',
      )
    }
  })

  test('the meetings UPDATE policy cannot reach the completed state in either direction', () => {
    // This is what makes a completed meeting read-only from a client UPDATE and
    // forces completion/reopening through set_meeting_status().
    const policy = code.match(/CREATE POLICY\s+"meetings_update"[\s\S]*?;/)
    assert.ok(policy, 'meetings_update policy not found')
    const body = policy[0]
    const guards = body.match(/status <> 'completed'/g) ?? []
    assert.equal(guards.length, 2, 'both USING and WITH CHECK must exclude completed meetings')
  })

  test('the history writer is not executable by any client role', () => {
    assert.match(
      code,
      /REVOKE EXECUTE ON FUNCTION public\.record_meeting_history\([^)]*\)\s*\n?\s*FROM public, anon, authenticated;/,
      'record_meeting_history must not be callable directly',
    )
  })

  test('every client-facing function is revoked from public and anon before being granted', () => {
    const granted = [...code.matchAll(/GRANT\s+EXECUTE ON FUNCTION public\.(\w+)\(/g)].map(m => m[1])
    assert.ok(granted.length >= 8, `expected the module's RPCs to be granted, found ${granted.length}`)
    for (const fn of new Set(granted)) {
      assert.match(
        code,
        new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(`),
        `${fn} is granted to authenticated but never revoked from public/anon`,
      )
    }
  })

  test('history rows survive the removal of the line they describe', () => {
    // The snapshots are what keep an orphaned entry readable, and SET NULL is
    // what stops a removal from cascading the record away.
    assert.match(code, /meeting_order_id\s+uuid REFERENCES public\.meeting_orders\(id\)\s+ON DELETE SET NULL/)
    assert.match(code, /meeting_order_item_id uuid REFERENCES public\.meeting_order_items\(id\) ON DELETE SET NULL/)
    assert.match(code, /order_number text NOT NULL/)
  })

  test('a linked task being deleted never deletes the SKU discussion', () => {
    assert.match(
      code,
      /linked_task_id\s+uuid\s+REFERENCES public\.tasks\(id\) ON DELETE SET NULL/,
      'a deleted task must not take the meeting record with it',
    )
  })

  test('the follow-up index matches the query the Follow-ups screen actually runs', () => {
    // Partial on (dated AND not resolved) — the same predicate as
    // followUpDue(). An index on a different predicate would simply not be used.
    assert.match(
      code,
      /CREATE INDEX meeting_order_items_follow_up_idx[\s\S]*?WHERE next_follow_up_date IS NOT NULL AND status <> 'resolved'/,
    )
  })

  test('the indexes the module’s common queries need are all present', () => {
    for (const index of [
      'meetings_status_date_idx',
      'meeting_attendees_user_idx',
      'meeting_orders_meeting_idx',
      'meeting_orders_number_key_idx',
      'meeting_order_items_order_idx',
      'meeting_order_items_follow_up_idx',
      'meeting_order_items_task_idx',
      'meeting_update_history_item_idx',
    ]) {
      assert.match(code, new RegExp(`CREATE INDEX ${index}\\b`), `${index} is missing`)
    }
  })

  test('every security-definer function pins pg_temp last', () => {
    // Without pg_temp listed explicitly Postgres searches it FIRST for relation
    // names, so one unqualified reference added later would be a temp-table
    // shadowing hole. The convention this repo settled on in 20260806000000.
    const fns  = (code.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length
    const pins = (code.match(/SET search_path = public, pg_temp/g) ?? []).length
    assert.equal(pins, fns, `${fns} functions but ${pins} pinned search_paths`)
    assert.equal((code.match(/SET search_path = public\n/g) ?? []).length, 0,
      'a function still pins search_path without pg_temp')
  })

  test('the module is registered deny-by-default in the permission engine', () => {
    // System Default = false for every action. A `true` here would hand module
    // entry to the whole company the moment the migration runs.
    assert.match(
      code,
      /INSERT INTO public\.module_permission_actions \(module_id, action_id, default_allowed\)\s*\nSELECT pm\.id, pa\.id, false/,
    )
  })

  test('task linking requires a relationship to the task, not just its id', () => {
    // link_meeting_item_task is SECURITY DEFINER, so it reads public.tasks with
    // RLS bypassed. Without this predicate a meeting editor could link any task
    // in the company by guessing an id, and the history entry — which they may
    // then read — would disclose that task's title.
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.link_meeting_item_task[\s\S]*?\n\$\$;/)
    assert.ok(fn, 'link_meeting_item_task not found')
    const body = fn[0]
    assert.match(body, /t\.created_by\s*=\s*v_uid/)
    assert.match(body, /t\.assigned_to\s*=\s*v_uid/)
    // One message for "no such task" and "not your task", so ids cannot be probed.
    assert.match(body, /MEETING_TASK_NOT_LINKABLE/)
  })

  test('removing an order is refused once any update text was recorded against it', () => {
    // entry_type alone is not the question: an 'import' entry carries a real
    // update typed by a real person, so keying only on the manual types let an
    // imported discussion be removed.
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.remove_meeting_order[\s\S]*?\n\$\$;/)
    assert.ok(fn, 'remove_meeting_order not found')
    assert.match(fn[0], /btrim\(COALESCE\(new_update, ''\)\) <> ''/)
  })

  test('the import never deletes, and never touches a linked task', () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.import_meeting_rows[\s\S]*?\n\$\$;/)
    assert.ok(fn, 'import_meeting_rows not found')
    const body = fn[0]
    assert.ok(!/DELETE FROM/i.test(body), 'an import must never delete a row')
    assert.ok(
      !/linked_task_id\s*=/.test(body),
      'an import must never write linked_task_id — a re-import cannot detach a task',
    )
  })
})

// ─── Meeting lifecycle trail ──────────────────────────────────────────────────
//
// These assert the SQL's STRUCTURE, not its runtime behaviour: no database was
// available (Docker/Podman absent), so nothing below was executed. Each test
// names the runtime guarantee it stands in for.

describe('meeting lifecycle history', () => {
  test('the log records the five lifecycle events and both statuses', () => {
    assert.match(code, /CREATE TABLE public\.meeting_activity_log/)
    for (const event of ['created', 'started', 'completed', 'reopened', 'returned_to_draft']) {
      assert.match(code, new RegExp(`'${event}'`), `event type ${event} missing`)
    }
    // meeting id, previous status, new status, actor, timestamp, detail.
    const table = code.match(/CREATE TABLE public\.meeting_activity_log[\s\S]*?\n\);/)
    assert.ok(table)
    for (const column of ['meeting_id', 'event_type', 'previous_status', 'new_status', 'actor_id', 'created_at', 'detail']) {
      assert.match(table[0], new RegExp(`\\b${column}\\b`), `column ${column} missing`)
    }
    assert.match(table[0], /actor_id\s+uuid\s+NOT NULL/, 'an audit row must always name its actor')
  })

  test('it is append-only: readable, and nothing else', () => {
    // Stands in for: "history cannot be updated or deleted."
    const policies_ = policies().filter(p => p.table === 'meeting_activity_log')
    assert.deepEqual(policies_.map(p => p.command).sort(), ['SELECT'])
  })

  test('no client role holds a write grant on either history table', () => {
    // The policies above are already the control; these revokes mean a policy
    // added by mistake later still could not write, and that TRUNCATE — which
    // no policy governs and no row trigger fires on — cannot erase a trail.
    for (const table of ['meeting_activity_log', 'meeting_update_history']) {
      assert.match(
        code,
        new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\\.${table}\\s+FROM authenticated, anon;`),
        `${table} keeps a standing write grant`,
      )
    }
  })

  test('nothing anywhere updates or deletes a lifecycle row', () => {
    assert.ok(!/UPDATE public\.meeting_activity_log/.test(code))
    assert.ok(!/DELETE FROM public\.meeting_activity_log/.test(code))
  })

  test('the writer is not callable by any client role', () => {
    // Stands in for: "entries are generated through the status-transition
    // function, not directly from the browser."
    assert.match(
      code,
      /REVOKE EXECUTE ON FUNCTION public\.record_meeting_activity\([^)]*\)\s*\n?\s*FROM public, anon, authenticated;/,
    )
  })

  test('creating a meeting writes the opening entry, in the same transaction', () => {
    // Stands in for: "Draft created". A trigger, so it cannot be skipped.
    const body = fnBody('meetings_log_creation')
    assert.match(body, /record_meeting_activity\(\s*\n?\s*NEW\.id, 'created', NULL, NEW\.status, NEW\.created_by/)
    assert.match(code, /CREATE TRIGGER meetings_log_creation_trg\s+AFTER INSERT ON public\.meetings/)
  })

  test('every status transition is recorded, and named from what actually happened', () => {
    // Stands in for: draft→in_progress writes 'started'; →completed writes
    // 'completed'; completed→in_progress writes 'reopened'.
    const body = fnBody('set_meeting_status')
    assert.match(body, /PERFORM public\.record_meeting_activity\(/)
    assert.match(body, /WHEN p_status = 'completed'\s+THEN 'completed'/)
    assert.match(body, /v_before\.status = 'completed' AND p_status = 'in_progress' THEN 'reopened'/)
    assert.match(body, /WHEN p_status = 'in_progress'\s+THEN 'started'/)
    assert.match(body, /ELSE 'returned_to_draft'/)
    // Derived from the before/after pair, never taken as a parameter — the
    // trail cannot be told a different story from the one the row tells.
    assert.ok(!/p_event_type\s+text/.test(body))
  })

  test('re-completion appends rather than replacing', () => {
    // Stands in for: "a meeting completed, reopened and completed again keeps
    // both completion records." The writer only ever INSERTs, and completed_at
    // on public.meetings is explicitly current state, not history.
    const writer = fnBody('record_meeting_activity')
    assert.match(writer, /INSERT INTO public\.meeting_activity_log/)
    assert.ok(!/ON CONFLICT/i.test(writer), 'an upsert would collapse two completions into one')
    assert.ok(!/UPDATE/i.test(writer))
  })

  test('an unauthorized status change writes no history', () => {
    // assert_meeting_editor raises before anything is written, and it is the
    // FIRST thing in the body — so the transaction aborts with no row and no
    // trail entry. Position is asserted, not just presence.
    const body = fnBody('set_meeting_status')
    const guardAt  = body.indexOf('assert_meeting_editor')
    const updateAt = body.indexOf('UPDATE public.meetings')
    const logAt    = body.indexOf('record_meeting_activity')
    assert.ok(guardAt > -1 && updateAt > guardAt, 'the write must follow the authorization check')
    assert.ok(logAt > guardAt, 'the trail entry must follow the authorization check')
  })

  test('the status change and its trail entry are one transaction', () => {
    // Same plpgsql function, so atomic by construction. No COMMIT anywhere
    // would split them, and no exception handler swallows a failed insert.
    const body = fnBody('set_meeting_status')
    assert.ok(!/\bCOMMIT\b/i.test(body), 'a COMMIT would let the status move without its trail')
    assert.ok(!/EXCEPTION\s+WHEN/i.test(body), 'a handler could swallow the trail insert')
  })

  test('status is unreachable from a client UPDATE — privileges, not just policy', () => {
    // Without this, meetings_update lets the lead PATCH { status } straight from
    // the browser, bypassing set_meeting_status and producing a status change
    // with NO lifecycle history. A policy cannot express which COLUMNS; a grant
    // can, and Postgres checks it before RLS.
    assert.match(code, /REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public\.meetings FROM authenticated, anon;/)
    const grant = code.match(/GRANT UPDATE \(([^)]*)\)\s*\n?\s*ON public\.meetings TO authenticated;/)
    assert.ok(grant, 'no column-scoped UPDATE grant on public.meetings')
    const columns = grant[1].split(',').map(c => c.trim())
    for (const forbidden of ['status', 'completed_at', 'completed_by', 'created_by', 'created_at', 'id']) {
      assert.ok(!columns.includes(forbidden), `${forbidden} must not be client-writable`)
    }
    assert.deepEqual(columns.sort(), ['lead_id', 'meeting_date', 'meeting_type', 'note', 'title', 'updated_at'])
  })

  test('the lifecycle log is indexed for the one query it serves', () => {
    assert.match(code, /CREATE INDEX meeting_activity_log_meeting_idx\b/)
  })
})
