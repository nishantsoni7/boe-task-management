/**
 * THE BILLING PERCENTAGE FOLLOWS THE PI ONTO THE ORDER — and nothing else about
 * approval moved with it.
 *
 * approve_order_submission() is re-emitted by migration 20260923000000 so the
 * Order it creates can carry the submission's billing_percentage. Re-emitting a
 * 440-line SECURITY DEFINER function that allocates order numbers and moves
 * money is the risky part of this change, not the two lines that motivated it:
 * a dropped `security definer`, a changed `search_path`, a lost row lock or a
 * quietly altered payment gate would all still compile and still pass every
 * behavioural test, while widening what the function can do.
 *
 * So this diffs the re-emitted text against the applied one — 20260922000000's,
 * which is the definition in force — and requires the ONLY differences to be the
 * billing_percentage column, its value, and the comment introducing them.
 *
 * Offline and pure: reads two migration files and compares them.
 *
 * Run:
 *   npx tsx --test src/lib/orders/billingContinuity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = 'supabase/migrations'
const APPLIED = '20260922000000_order_submission_due_date.sql'
const BILLING = '20260923000000_order_submission_billing_percentage.sql'

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
const reemitted = approveFn(BILLING)

/** A function's executable text: comments and blank lines removed. */
const executable = (sql: string) => sql
  .split('\n')
  .map(l => l.trim())
  .filter(l => l !== '' && !l.startsWith('--'))

describe('the re-emitted approval function differs by billing_percentage and nothing else', () => {
  test('removing the billing additions restores the applied function exactly', () => {
    // The claim stated as an operation: take the re-emitted function, undo the
    // two edits, and what is left must be the applied function line-for-line.
    // Anything else that was touched — a dropped lock, a changed gate, a stray
    // edit — survives the undo and shows up as a difference.
    const undone = executable(reemitted)
      .filter(l => l !== 'billing_percentage,')
      .filter(l => l !== 'v_sub.billing_percentage,')

    assert.deepEqual(undone, executable(applied),
      'undoing the billing_percentage edits must leave the applied function untouched')
  })

  test('and the additions really are there', () => {
    const diff = executable(reemitted).length - executable(applied).length
    assert.equal(diff, 2, 'exactly two executable lines added: the column and its value')
    assert.ok(executable(reemitted).includes('billing_percentage,'))
    assert.ok(executable(reemitted).includes('v_sub.billing_percentage,'))
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
    // The verified-payment gate and the allocation move are what Phase 3 added;
    // counting them proves neither was dropped nor duplicated.
    for (const phrase of ['order_submission_payment_ready', 'update public.finance_payment_allocations']) {
      assert.equal(
        (reemitted.match(new RegExp(phrase, 'g')) ?? []).length,
        (applied.match(new RegExp(phrase, 'g')) ?? []).length,
        `${phrase} appears a different number of times after re-emission`)
    }
    // And the due date this same function started carrying one migration ago is
    // still carried — a re-emission that lost it would be a silent regression.
    assert.ok(reemitted.includes('v_sub.due_date,'))
  })

  test('the Order takes the submission’s own column, and never a default', () => {
    assert.match(reemitted, /billing_percentage,\s*\n\s*created_by/,
      'billing_percentage is in the INSERT column list')
    assert.match(reemitted, /v_sub\.billing_percentage,/,
      'and the submission’s value is what is inserted')
    const code = executable(reemitted).join('\n')
    assert.ok(!/coalesce\([^)]*billing_percentage/i.test(code),
      'an undeclared PI produces an undeclared Order — no fallback, no substitute')
    for (const forbidden of [/billing_percentage\s*\*/, /billing_percentage\s*\//]) {
      assert.ok(!forbidden.test(code), `approval must not compute with it (${forbidden})`)
    }
  })

  test('the grant is restated for the signature that did not change', () => {
    const sql = read(BILLING)
    assert.match(sql, /grant execute on function public\.approve_order_submission\(uuid\) to authenticated/)
    assert.match(sql, /revoke all on function public\.approve_order_submission\(uuid\) from public/)
  })

  test('approval gained no new reason to refuse', () => {
    // The field is optional. If approval could fail on an undeclared PI, every
    // historical record would become unapprovable.
    const code = executable(reemitted).join('\n')
    const raises = [...code.matchAll(/raise exception[\s\S]{0,200}?;/g)].map(m => m[0])
    for (const raise of raises) {
      assert.ok(!/billing/i.test(raise), 'no approval path may refuse over the billing percentage')
    }
  })
})
