/**
 * THE DUE DATE FOLLOWS THE PI ONTO THE ORDER — and nothing else about approval
 * moved with it.
 *
 * approve_order_submission() is re-emitted by migration 20260922000000 so the
 * Order it creates can carry the submission's due_date. Re-emitting a 435-line
 * SECURITY DEFINER function that allocates order numbers and moves money is the
 * risky part of this change, not the two lines that motivated it: a dropped
 * `security definer`, a changed `search_path`, a lost row lock or a quietly
 * altered payment gate would all still compile and still pass every behavioural
 * test, while widening what the function can do.
 *
 * So this diffs the re-emitted text against the applied one — 20260921000000's,
 * which is the definition in force — and requires the ONLY differences to be the
 * due_date column, the due_date value, and the comment introducing them.
 *
 * Offline and pure: reads two migration files and compares them.
 *
 * Run:
 *   npx tsx --test src/lib/orders/dueDateContinuity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = 'supabase/migrations'
const APPLIED = '20260921000000_order_submission_verified_payment_gate.sql'
const DUE_DATE = '20260922000000_order_submission_due_date.sql'

const read = (file: string) => readFileSync(join(process.cwd(), MIGRATIONS, file), 'utf8')

/** One function's full text, from its CREATE OR REPLACE to its closing tag. */
function approveFn(file: string): string {
  const sql = read(file)
  const start = sql.search(
    /create\s+or\s+replace\s+function\s+public\.approve_order_submission\s*\(/i)
  assert.ok(start >= 0, `approve_order_submission is not defined in ${file}`)
  const ends = ['\n$$;', '\n$function$;']
    .map(tag => ({ tag, at: sql.indexOf(tag, start) }))
    .filter(e => e.at > start)
    .sort((a, b) => a.at - b.at)
  assert.ok(ends.length > 0, `no closing dollar tag in ${file}`)
  return sql.slice(start, ends[0].at + ends[0].tag.length)
}

const applied = approveFn(APPLIED)
const reemitted = approveFn(DUE_DATE)

/** A function's executable text: comments and blank lines removed. */
const executable = (sql: string) => sql
  .split('\n')
  .map(l => l.trim())
  .filter(l => l !== '' && !l.startsWith('--'))

describe('the re-emitted approval function differs by due_date and nothing else', () => {
  test('removing the due_date additions restores the applied function exactly', () => {
    // The claim stated as an operation: take the re-emitted function, undo the
    // two due_date edits, and what is left must be the applied function
    // line-for-line. Anything else that was touched — a dropped lock, a changed
    // gate, a stray edit — survives the undo and shows up as a difference.
    const undone = executable(reemitted)
      .filter(l => l !== 'v_sub.due_date,')
      .map(l => l.replace('confirm_date, due_date, total_value', 'confirm_date, total_value'))

    assert.deepEqual(undone, executable(applied),
      'undoing the due_date edits must leave the applied function untouched')
  })

  test('and the additions really are there', () => {
    const diff = executable(reemitted).length - executable(applied).length
    assert.equal(diff, 1, 'exactly one executable line added: the inserted value')
    assert.ok(executable(reemitted).includes('v_sub.due_date,'))
  })

  test('the security properties are the ones already in force', () => {
    // Each of these is a capability boundary. A re-emission that dropped any of
    // them would still run, and would still pass a behavioural test.
    for (const property of [
      /create or replace function public\.approve_order_submission\(p_submission_id uuid\)/,
      /returns jsonb/,
      /language plpgsql/,
      /security definer/,
      /set search_path = public, pg_temp/,
    ]) {
      assert.match(applied, property, `the applied function should have ${property}`)
      assert.match(reemitted, property, `the re-emission must keep ${property}`)
    }
  })

  test('the actor assertion, the gate, the numbering and the locks are unmoved', () => {
    for (const invariant of [
      'public.assert_order_submission_actor()',   // who may approve at all
      'for update',                               // the row lock on the submission
    ]) {
      assert.ok(applied.includes(invariant), `${invariant} should be in the applied function`)
      assert.ok(reemitted.includes(invariant), `${invariant} must survive the re-emission`)
    }
    // The verified-payment gate and the allocation move are the two things Phase
    // 3 added; counting them proves neither was dropped or duplicated.
    for (const phrase of ['order_submission_payment_ready', 'update public.finance_payment_allocations']) {
      assert.equal(
        (reemitted.match(new RegExp(phrase, 'g')) ?? []).length,
        (applied.match(new RegExp(phrase, 'g')) ?? []).length,
        `${phrase} appears a different number of times after re-emission`)
    }
  })

  test('the Order takes the submission’s own column, and never the prose', () => {
    assert.match(reemitted, /due_date,\s*total_value/, 'due_date is in the INSERT column list')
    assert.match(reemitted, /v_sub\.due_date,/, 'and the submission’s value is what is inserted')
    // Nothing derives, reinterprets or falls back to the commitment text.
    const code = executable(reemitted).join('\n')
    assert.ok(!code.includes('dispatch_commitment'),
      'approval must not read the commitment text at all')
    assert.ok(!/coalesce\([^)]*due_date/i.test(code),
      'a NULL due date stays NULL — no fallback, no substitute')
    for (const forbidden of [/make_interval/i, /date_trunc/i]) {
      assert.ok(!forbidden.test(code), `approval must not compute a date (${forbidden})`)
    }
  })

  test('the grant is restated for the signature that did not change', () => {
    const sql = read(DUE_DATE)
    assert.match(sql, /grant execute on function public\.approve_order_submission\(uuid\) to authenticated/)
    assert.match(sql, /revoke all on function public\.approve_order_submission\(uuid\) from public/)
  })
})
