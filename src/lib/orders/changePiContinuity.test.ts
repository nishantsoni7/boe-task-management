/**
 * CHANGE PI — the workbook replacement re-emitted, and nothing else moved.
 *
 * 20261003000000 restates replace_order_submission_parse in full so an active
 * admin can correct a PI after it has left draft. Re-emitting a 250-line
 * SECURITY DEFINER function that holds a processing lease, replaces every
 * product line and rewrites the whole commercial snapshot is the risky part of
 * that change — not the two edits that motivated it. A dropped lease check, a
 * lost row lock, a changed `search_path` or a quietly widened header write
 * would all still compile, still apply, and still pass every behavioural
 * assertion, while widening what the function can do.
 *
 * So this diffs the re-emitted text against the applied one — 20260922000000's,
 * which is the definition in force — and requires the ONLY differences to be:
 *
 *   1. six declarations and the authority line, which now calls
 *      assert_order_submission_workbook_editor and reads the reason;
 *   2. the block that runs only once the PI has left draft;
 *   3. three keys added to the returned object.
 *
 * Offline and pure: reads two migration files and compares them.
 *
 * Run:
 *   npx tsx --test src/lib/orders/changePiContinuity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = 'supabase/migrations'
const APPLIED   = '20260922000000_order_submission_due_date.sql'
const CHANGE_PI = '20261003000000_order_submission_change_pi.sql'

const read = (file: string) => readFileSync(join(process.cwd(), MIGRATIONS, file), 'utf8')

/** One function's full text, from its CREATE OR REPLACE to its closing tag. */
function replaceFn(file: string): string {
  const sql = read(file)
  const start = sql.search(
    /create\s+or\s+replace\s+function\s+public\.replace_order_submission_parse\s*\(/i)
  assert.ok(start >= 0, `replace_order_submission_parse is not defined in ${file}`)
  const ends = ['\n$$;', '\n$function$;']
    .map(tag => ({ tag, at: sql.indexOf(tag, start) }))
    .filter(e => e.at > start)
    .sort((a, b) => a.at - b.at)
  assert.ok(ends.length > 0, `no closing dollar tag in ${file}`)
  return sql.slice(start, ends[0].at + ends[0].tag.length)
}

/** A function's executable text: comments and blank lines removed. */
const executable = (sql: string) => sql
  .split('\n')
  .map(l => l.trim())
  .filter(l => l !== '' && !l.startsWith('--'))

const applied   = replaceFn(APPLIED)
const reemitted = replaceFn(CHANGE_PI)

/** The six declarations the amendment needs. */
const DECLARATIONS = [
  'v_amend       jsonb;',
  'v_after       boolean;',
  'v_reason      text;',
  'v_order       uuid;',
  'v_superseded  integer := 0;',
  'v_cleared     boolean := false;',
]

/** The authority line, before and after. */
const OLD_AUTHORITY = 'perform public.assert_order_submission_editor(p_submission_id, p_actor_id);'
const NEW_AUTHORITY = [
  'v_amend := public.assert_order_submission_workbook_editor(',
  "p_submission_id, p_actor_id,",
  "nullif(btrim(coalesce(p_payload ->> 'change_reason', '')), ''));",
]

/** The three keys the returned object gained. */
const NEW_RETURN_KEYS = [
  "'after_submission', coalesce(v_after, false),",
  "'finance_verification_cleared', v_cleared,",
  "'superseded_documents', v_superseded,",
]

describe('the re-emitted workbook replacement differs by the amendment and nothing else', () => {
  test('undoing the three edits restores the applied function exactly', () => {
    // The claim stated as an operation: take the re-emitted function, remove the
    // declarations, restore the old authority line, drop the after-submission
    // block and the three return keys — and what is left must be the applied
    // function line for line. Anything else that was touched survives the undo
    // and shows up as a difference.
    const lines = executable(reemitted)

    // The amendment block is delimited by its guard and the `end if;` that
    // closes it, located by depth rather than by counting lines, so an edit
    // inside it cannot shift the boundary without being noticed elsewhere.
    const blockStart = lines.indexOf('if v_after and not v_unchanged then')
    assert.ok(blockStart > 0, 'the after-submission guard is missing')
    let depth = 0
    let blockEnd = -1
    for (let i = blockStart; i < lines.length; i++) {
      const l = lines[i]
      if (/^if .* then$/.test(l)) depth++
      if (l === 'end if;') { depth--; if (depth === 0) { blockEnd = i; break } }
    }
    assert.ok(blockEnd > blockStart, 'the after-submission block is not closed')

    const undone = lines
      .filter((_, i) => i < blockStart || i > blockEnd)
      .filter(l => !DECLARATIONS.includes(l))
      .filter(l => !NEW_RETURN_KEYS.includes(l))
      .filter(l => !NEW_AUTHORITY.includes(l))
      .flatMap(l => (l === "v_after  := coalesce((v_amend ->> 'after_submission')::boolean, false);"
                     || l === "v_reason := v_amend ->> 'reason';")
        ? [] : [l])

    // The old authority line goes back where the new one was.
    const at = undone.indexOf('v_unchanged := v_fingerprint is not null and v_previous is not null and v_fingerprint = v_previous;')
    assert.ok(at > 0, 'the fingerprint comparison moved')
    undone.splice(at, 0, OLD_AUTHORITY)

    assert.deepEqual(undone, executable(applied),
      'undoing the amendment edits must leave the applied function untouched')
  })

  test('and the additions really are there', () => {
    for (const d of DECLARATIONS) {
      assert.ok(executable(reemitted).includes(d), `missing declaration: ${d}`)
      assert.ok(!executable(applied).includes(d), `${d} was already in the applied function`)
    }
    assert.ok(applied.includes(OLD_AUTHORITY), 'the applied function should call the old assert')
    assert.ok(!reemitted.includes(OLD_AUTHORITY),
      'the re-emission must not still call the stage-before-actor assert')
    assert.ok(reemitted.includes('assert_order_submission_workbook_editor'),
      'the re-emission must call the new workbook editor')
  })

  test('the security properties are the ones already in force', () => {
    for (const property of [
      /create or replace function public\.replace_order_submission_parse\(/,
      /returns jsonb/,
      /language plpgsql/,
      /security definer/,
      /set search_path = public, pg_temp/,
    ]) {
      assert.match(applied, property, `the applied function should have ${property}`)
      assert.match(reemitted, property, `the re-emission must keep ${property}`)
    }
  })

  test('the lease, the lock and the atomic replacement are unmoved', () => {
    for (const invariant of [
      'for update',                                    // the row lock, taken first
      'ORDER_SUBMISSION_PROCESSING_NOT_HELD',          // the lease check
      'delete from public.order_submission_items',     // the atomic item swap
      'ORDER_SUBMISSION_IMAGE_ITEM_UNKNOWN',           // images must name this PI
    ]) {
      assert.ok(applied.includes(invariant), `${invariant} should be in the applied function`)
      assert.ok(reemitted.includes(invariant), `${invariant} must survive the re-emission`)
    }
    // Counted rather than merely present: a duplicated lock or a second delete
    // would pass an includes() check and change what the function does.
    for (const phrase of ['for update', 'delete from public\\.order_submission_items',
                          'jsonb_array_elements\\(v_items\\)']) {
      assert.equal(
        (reemitted.match(new RegExp(phrase, 'g')) ?? []).length,
        (applied.match(new RegExp(phrase, 'g')) ?? []).length,
        `${phrase} appears a different number of times after re-emission`)
    }
  })

  test('the amendment work is skipped entirely for a draft re-upload', () => {
    // Everything the amendment does sits inside one guard. If any of it ever
    // moved outside, an ordinary import would start superseding documents and
    // clearing finance verifications.
    const lines = executable(reemitted)
    const blockStart = lines.indexOf('if v_after and not v_unchanged then')
    for (const inside of [
      'supersede_order_documents',
      'finance_verified_by',
      'order_activity_log',
      'workbook_replaced_by_admin',
      'update public.orders o',
    ]) {
      const first = lines.findIndex(l => l.includes(inside))
      assert.ok(first > blockStart,
        `${inside} runs outside the after-submission guard`)
    }
  })

  test('the Order’s identity is never assigned', () => {
    // The same claim the migration proves against the installed source, checked
    // here against the text so it fails in CI rather than only on apply.
    const code = executable(reemitted).join('\n')
    for (const column of ['display_number', 'source_order_submission_id', 'requested_by']) {
      assert.ok(!new RegExp(`^\\s*(set\\s+)?${column}\\s*=`, 'm').test(code),
        `orders.${column} must never be assigned by a workbook replacement`)
    }
    // `status` is assigned nowhere in this function, on either table.
    assert.ok(!/^\s*(set\s+)?status\s*=/m.test(code),
      'a workbook replacement must not move any status')
  })

  test('payments and allocations are never named', () => {
    for (const table of ['finance_payment_allocations', 'finance_payments']) {
      assert.ok(!reemitted.includes(table),
        `${table} must be moved only by the functions that own it`)
    }
  })

  test('the grant is restated for the signature that did not change', () => {
    const sql = read(CHANGE_PI)
    assert.match(sql, /revoke execute on function public\.replace_order_submission_parse\(uuid, uuid, jsonb\)\s*\n\s*from public, anon, authenticated;/)
    assert.match(sql, /grant\s+execute on function public\.replace_order_submission_parse\(uuid, uuid, jsonb\)\s*\n\s*to service_role;/)
  })

  test('the new authority is not reachable by a browser role', () => {
    const sql = read(CHANGE_PI)
    assert.match(sql,
      /revoke execute on function public\.assert_order_submission_workbook_editor\(uuid, uuid, text, boolean\)\s*\n\s*from public, anon, authenticated, service_role;/)
    assert.ok(!/grant\s+execute on function public\.assert_order_submission_workbook_editor/.test(sql),
      'the workbook editor must not be granted to anybody')
  })
})

/**
 * THE LEASE IS THE GATE BEFORE THE GATE.
 *
 * begin_order_submission_processing asked the same stage-before-actor predicate,
 * so leaving it alone would have made the new authority unreachable: an admin
 * would be refused a lease and never arrive at the replacement. It is re-emitted
 * too, and the same continuity argument applies — the TTL, the takeover rule and
 * the 55P03 busy signal are what a careless restatement would lose.
 */
describe('the re-emitted lease differs by its authority line and nothing else', () => {
  const LEASE_SOURCE = '20260909000000_order_submission_item_images.sql'

  function leaseFn(file: string): string {
    const sql = read(file)
    const start = sql.search(
      /create\s+or\s+replace\s+function\s+public\.begin_order_submission_processing\s*\(/i)
    assert.ok(start >= 0, `begin_order_submission_processing is not defined in ${file}`)
    const at = sql.indexOf('\n$$;', start)
    assert.ok(at > start, `no closing dollar tag in ${file}`)
    return sql.slice(start, at + 4)
  }

  const appliedLease   = leaseFn(LEASE_SOURCE)
  const reemittedLease = leaseFn(CHANGE_PI)

  test('swapping the authority line back restores the applied function exactly', () => {
    const undone = executable(reemittedLease)
      .filter(l => l !== 'v_amend := public.assert_order_submission_workbook_editor(')
      .map(l => l === 'perform public.assert_order_submission_workbook_editor('
        ? 'perform public.assert_order_submission_editor(p_submission_id, p_actor_id);'
        : l)
      .filter(l => l !== 'p_submission_id, p_actor_id, null, false);')

    assert.deepEqual(undone, executable(appliedLease),
      'the lease must differ from the applied one only in which assert it calls')
  })

  test('the lease still refuses, still expires and still reports busy', () => {
    for (const invariant of [
      'for update',                                  // the lock, before any judgement
      'ORDER_SUBMISSION_PROCESSING_BUSY',            // the retryable signal
      "using errcode = '55P03'",                     // ...with the code the route reads
      'order_submission_processing_ttl()',           // the takeover boundary
      'processing_started_at',
    ]) {
      assert.ok(appliedLease.includes(invariant), `${invariant} should be in the applied lease`)
      assert.ok(reemittedLease.includes(invariant), `${invariant} must survive the re-emission`)
    }
    assert.ok(!reemittedLease.includes('assert_order_submission_editor('),
      'the lease must no longer call the stage-before-actor assert')
  })

  test('the lease asks WITHOUT the reason, and the replacement asks WITH it', () => {
    // A lease grants nothing on its own. If it ever started requiring a reason,
    // an admin would have to justify a correction before finding out whether the
    // file even parses; if the replacement ever stopped requiring one, an
    // amendment would land unexplained.
    assert.match(reemittedLease, /assert_order_submission_workbook_editor\(\s*p_submission_id, p_actor_id, null, false\)/)
    assert.match(reemitted, /assert_order_submission_workbook_editor\(\s*p_submission_id, p_actor_id,\s*nullif\(btrim\(coalesce\(p_payload ->> 'change_reason'/)
  })

  test('its privileges are restated unchanged', () => {
    const sql = read(CHANGE_PI)
    assert.match(sql, /revoke execute on function public\.begin_order_submission_processing\(uuid, uuid, uuid\)\s*\n\s*from public, anon, authenticated;/)
    assert.match(sql, /grant\s+execute on function public\.begin_order_submission_processing\(uuid, uuid, uuid\)\s*\n\s*to service_role;/)
  })
})
