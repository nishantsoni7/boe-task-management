/**
 * THE ORDER 0524 ONE-TIME HANDOFF (20261230000000), read as text.
 *
 * Executing it is done by supabase/tests/run_order_0524_operations_handoff_local.sh
 * against a disposable stack. This file holds the migration to its promises
 * without a database:
 *
 *   * it touches ONE Order, by pinned id, and stops on any mismatch;
 *   * it records the handoff now, for the historic approval, without changing
 *     the approval, the version, the workbook or the Order's alignment;
 *   * it decides nothing: the handoff is awaiting, nobody is named as having
 *     accepted or flagged it;
 *   * it addresses the CONFIGURED reviewer, only while eligible;
 *   * a repeat writes nothing;
 *   * its notification says the existing V1 was sent now, and names the
 *     original approval separately — never a new approval.
 *
 * Run:
 *   npx tsx --test src/lib/orders/order0524OperationsHandoffMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const FILE = 'supabase/migrations/20261230000000_order_0524_operations_handoff_for_existing_approval.sql'
const MIGRATION = read(FILE)
const SQL = stripSql(MIGRATION)
const HANDOFF = stripSql(read('supabase/migrations/20261229000000_order_operations_handoff.sql'))

describe('one Order, pinned, or nothing', () => {
  test('the expectations are the ones read from production', () => {
    for (const [name, value] of [
      ['c_display_number', "'0524'"],
      ['c_order_id', "'5ca406a4-4d9f-4a71-acd9-923d3d13c208'"],
      ['c_version_id', "'d900e411-fa3b-4f87-b3de-7dfc903aa715'"],
      ['c_submission_id', "'4df2ce51-4c39-4670-b318-883f65fdb336'"],
      ['c_approved_by', "'6507df9f-cdeb-4ebd-849f-8498c165d596'"],
      ['c_approved_at', "'2026-09-21 17:07:25.126071+00'"],
      ['c_reviewer_id', "'58ec48e3-d252-4660-b61b-4db48fb58e9e'"],
    ]) {
      const literal = value.replace(/[.+]/g, '\\$&')
      assert.match(SQL, new RegExp(`${name}\\s+constant \\w+\\s+:= ${literal};`), name)
    }
  })

  test('it is one DO block, with no DDL and no other Order', () => {
    assert.equal((SQL.match(/^do \$\$/gm) ?? []).length, 1)
    assert.doesNotMatch(SQL, /\b(create|alter|drop|grant|revoke)\s+(table|function|trigger|policy|type|index)/i)
    assert.doesNotMatch(SQL, /insert into public\.order_operations_handoffs\s*\([^;]*?\)\s*select/i, 'no INSERT … SELECT over Orders')
    assert.doesNotMatch(SQL, /from public\.orders where display_number = c_display_number\s+for update/i)
    assert.match(SQL, /select \* into v_order from public\.orders where id = c_order_id for update;/)
  })

  test('every expectation is checked, and a mismatch raises', () => {
    for (const check of [
      /v_order\.display_number is distinct from c_display_number/,
      /v_order\.status is distinct from 'running'/,
      /v_order\.source_order_submission_id is distinct from c_submission_id/,
      /v_order\.production_alignment is distinct from 'not_aligned'/,
      /v_versions <> 1/,
      /v_version\.status is distinct from 'approved'/,
      /v_version\.decided_by is distinct from c_approved_by or v_version\.decided_at is distinct from c_approved_at/,
      /v_configured is distinct from c_reviewer_id/,
      /u\.is_active and coalesce\(u\.is_deleted, false\) = false/,
      /public\.operations_reviewer_can_open_order\(v_configured, c_order_id\)/,
    ]) {
      assert.match(SQL, check)
    }
    assert.ok((SQL.match(/raise exception 'ORDER_0524_HANDOFF_MISMATCH/g) ?? []).length >= 12)
  })

  test('a database without the Order does nothing; a 0524 under another id stops', () => {
    assert.match(SQL, /if not exists \(select 1 from public\.orders where id = c_order_id\) then\s+if exists \(select 1 from public\.orders where display_number = c_display_number\) then\s+raise exception/)
    assert.match(SQL, /is not in this database; nothing to do', c_display_number, c_order_id;\s+return;/)
  })
})

describe('the handoff is new; the approval is not', () => {
  const insert = SQL.slice(SQL.indexOf('insert into public.order_operations_handoffs'), SQL.indexOf('returning id into v_handoff_id'))

  test('approved_by / approved_at are V1\'s own; created_at and assigned_at are now', () => {
    assert.match(insert, /v_version\.decided_by, v_version\.decided_at,/)
    assert.match(insert, /v_configured, v_now, null,/)
    assert.match(insert, /v_order\.production_alignment, null,\s+v_now\s+\)/)
  })

  test('it writes no PI version, no Order column, no workbook, and no decision', () => {
    assert.doesNotMatch(SQL, /insert into public\.order_pi_versions/)
    assert.doesNotMatch(SQL, /update public\.(order_pi_versions|orders|order_submissions|order_operations_handoffs)\b/)
    assert.doesNotMatch(SQL, /order_operations_handoff_set_alignment|decide_order_operations_handoff|set_order_production_alignment/)
    assert.doesNotMatch(insert, /'accepted'|accepted_by|clarification_by/)
    assert.doesNotMatch(SQL, /storage\.objects|workbook_path/)
  })

  test('the history entry has no actor and says it is late, and by which file', () => {
    assert.match(SQL, /values \(c_order_id, null, 'operations_handoff_recorded',/)
    assert.match(SQL, /'recorded_for_existing_approval', true/)
    assert.match(SQL, /'recorded_by_migration', c_migration/)
    assert.match(SQL, /c_migration\s+constant text\s+:= '20261230000000_order_0524_operations_handoff_for_existing_approval';/)
  })

  test('the notification says V1 was SENT now, and names the original approval separately', () => {
    assert.match(SQL, /v_configured, null, c_order_id, 'order_operations_review_requested'::notification_type,/)
    assert.match(SQL, /format\('Order %s: existing PI V1 sent for your operations review', v_order\.display_number\)/)
    assert.match(SQL, /'Original approval: %s, %s\. PI V1 was approved before operations review was recorded and has been sent to you now\./)
    assert.match(SQL, /coalesce\(v_approver, 'an administrator'\),\s+to_char\(v_version\.decided_at at time zone 'Asia\/Kolkata', 'FMDD FMMonth YYYY'\)/,
      'the approver and date come from V1 itself')
    // Never the trigger's new-approval wording.
    const triggerTitle = "'Order %s: PI V%s approved by %s. Awaiting your operations review.'"
    assert.ok(HANDOFF.includes(triggerTitle))
    assert.equal(SQL.includes(triggerTitle), false, 'not worded as a new approval')
    assert.equal((SQL.match(/insert into public\.notifications/g) ?? []).length, 1, 'one notification, one recipient')
  })
})

describe('repeat and concurrency', () => {
  test('an existing handoff for V1 ends the file before any write', () => {
    const guard = SQL.indexOf('select * into v_existing from public.order_operations_handoffs where pi_version_id = c_version_id;')
    assert.ok(guard > 0)
    assert.match(SQL.slice(guard), /^[^;]+;\s+if found then\s+raise notice '[^']*',[^;]+;\s+return;/)
    assert.ok(guard < SQL.indexOf('insert into public.order_operations_handoffs'))
  })

  test('the lock order is 20261229\'s: reviewer row, then the Order, then the version', () => {
    const reviewer = SQL.indexOf("where r.duty = 'pi_handoff'\n     for share;")
    const order = SQL.indexOf('from public.orders where id = c_order_id for update')
    const version = SQL.indexOf('from public.order_pi_versions where id = c_version_id for share')
    assert.ok(reviewer > 0 && order > reviewer && version > order)
  })
})
