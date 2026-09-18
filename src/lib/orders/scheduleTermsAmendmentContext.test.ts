/**
 * 20261217000000 — the PI schedule editor reaches the Order through the
 * amendment door.
 *
 * update_order_submission_schedule_terms() (20260929000000) carries a changed
 * Order Confirmation Date / Due Date onto the Confirmed Order. Those are columns
 * orders_guard_amendable_columns() freezes outside in_order_amendment(), so on
 * any approved PI with an Order the save was refused (ORDER_AMENDMENT_REQUIRED).
 * 20261120000000 fixed the two sibling paths and missed this one.
 *
 * The behaviour is EXECUTED by supabase/tests/run_schedule_terms_amendment_suite.sh
 * on a disposable database (the defect reproduces first, then 8 sections pass).
 * This file pins the source so the migration cannot drift from what was proved.
 *
 * Run:
 *   npx tsx --test src/lib/orders/scheduleTermsAmendmentContext.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join('supabase', 'migrations')
const FILE = '20261217000000_order_submission_schedule_terms_use_the_amendment_context.sql'
const ORIGINAL = '20260929000000_order_submission_schedule_terms_edit.sql'
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8').replace(/\r\n/g, '\n')

const sql = read(FILE)
const fnOf = (text: string) => text.slice(
  text.indexOf('create or replace function public.update_order_submission_schedule_terms('),
  text.indexOf('grant  execute on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) to authenticated;'))

describe('20261217000000 — schedule terms through the amendment door', () => {
  test('forward-only: it follows 20261216000000 with a unique version, and names its feature', () => {
    const files = readdirSync(MIGRATIONS).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.equal(files[i - 1], '20261216000000_received_payment_allocation_targets.sql')
    assert.match(FILE, /order_submission/, 'finalApprovalScope requires the feature name in the filename')
  })

  test('the ONLY change to the 20260929000000 body is the context around the Order UPDATE', () => {
    const before = fnOf(read(ORIGINAL)).split('\n')
    const after = fnOf(sql).split('\n')
    const added = after.filter(l => !before.includes(l)).map(l => l.trim()).filter(Boolean)
    assert.deepEqual(added, [
      '-- 20261217000000: the dates are guarded Order columns; write them through',
      '-- the amendment door, exactly one statement wide.',
      "perform set_config('boe.amendment_context', 'order_amendment', true);",
      "perform set_config('boe.amendment_context', '', true);",
    ])
    const removed = before.filter(l => !after.includes(l))
    assert.deepEqual(removed, [], 'no line of the original body is removed')
  })

  test('the context brackets the single UPDATE of public.orders', () => {
    const fn = fnOf(sql)
    const open = fn.indexOf("perform set_config('boe.amendment_context', 'order_amendment', true);")
    const upd = fn.indexOf('update public.orders')
    const close = fn.indexOf("perform set_config('boe.amendment_context', '', true);")
    assert.ok(open > 0 && upd > open && close > upd)
    assert.equal(fn.split('update public.orders').length - 1, 1)
  })

  test('it proves itself at apply time, and refuses a missing dependency', () => {
    for (const needle of ['pg_get_functiondef', 'must open and close the amendment context exactly once',
      'the context is opened after the statement it must cover', 'the context is closed before the statement it must cover',
      'writes public.orders more than once', 'the Order column guard lost a rule it had', 'lost an authorization check',
      'must stay SECURITY DEFINER', 'must pin search_path', 'anon can call', 'DEPENDENCY MISSING']) {
      assert.ok(sql.includes(needle), needle)
    }
  })

  test('it touches no table, policy, trigger, permission or grant beyond re-stating the function’s own', () => {
    const code = sql.replace(/--[^\n]*/g, '')
    assert.ok(!/\b(create|alter|drop)\s+(table|policy|trigger|index)\b/i.test(code))
    assert.ok(!/\b(insert\s+into|update\s+public\.(?!orders\b)|delete\s+from)\b/i.test(code.replace(fnOf(sql).replace(/--[^\n]*/g, ''), '')))
    assert.ok(!/permission_actions|role_permissions/.test(code))
  })

  test('an executable suite proves it on a disposable database', () => {
    const runner = readFileSync(join('supabase', 'tests', 'run_schedule_terms_amendment_suite.sh'), 'utf8')
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('FAIL: the defect did not reproduce'), 'the defect is reproduced before the fix')
    const suite = readFileSync(join('supabase', 'tests', 'schedule_terms_amendment_assertions.sql'), 'utf8')
    for (const needle of ['1. approved PI: Due Date change saved and carried onto Order 0526',
      '2. approved PI: Order Confirmation Date change carried onto the Order',
      '3. the amendment context is closed again after the call',
      '4. a direct Order date write outside the amendment door is still refused',
      '5. payment-terms change: the Order row is untouched',
      '6. draft PI without an Order: saved as before',
      '7. an admin edit after submission still needs a reason',
      '8. each change is recorded on the Order activity log']) {
      assert.ok(suite.includes(needle), needle)
    }
  })
})
