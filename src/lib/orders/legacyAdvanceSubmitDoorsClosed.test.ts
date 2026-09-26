/**
 * THE LEGACY ADVANCE SUBMIT DOORS ARE CLOSED (20270124000000), read as text.
 *
 * Executing it was done against a disposable local stack (main's chain plus
 * this file, then the #209 chain on top, then this file again). Before it,
 * changing an approved exception through either legacy door failed with a
 * CHECK violation on order_submissions_exception_basis_scope, and moving an
 * approved exception back to the standard route left a stale decision basis on
 * the row. After it, both succeed and the basis is cleared, and
 * supabase/tests/order_submission_advance_exception_assertions.sql passes.
 * This file holds the migration to its promises without a database:
 *
 *   * the implementation is 20260917000000's body with only the decision-basis
 *     clearing added, in exactly the two branches that leave 'approved';
 *   * the two legacy advance doors are revoked from authenticated, and nothing
 *     is granted;
 *   * the application's door and the non-advance legacy doors are untouched;
 *   * the application calls neither legacy advance door.
 *
 * Run:
 *   npx tsx --test src/lib/orders/legacyAdvanceSubmitDoorsClosed.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const NAME = '20270124000000_order_submission_legacy_advance_doors_closed.sql'
const MIGRATION = read(`supabase/migrations/${NAME}`)
const SQL = stripSql(MIGRATION)
const PREVIOUS = read('supabase/migrations/20260917000000_order_submission_advance_amount.sql')

const V2 = 'submit_order_submission_advance_v2_internal'
const DOORS = [
  'submit_order_submission_with_advance(uuid, text, text, numeric, text)',
  'submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)',
]
const BASIS_CLEARED = [
  'advance_exception_decided_grand_total     = null',
  'advance_exception_decided_workbook_sha256 = null',
  'advance_exception_decided_payment_terms   = null',
  'advance_exception_decided_billing_terms   = null',
]

/** The one `create or replace function … $$;` block for `name` in `sql`. */
function definition(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} is not created`)
  const end = sql.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} has no end`)
  return sql.slice(start, end + 4)
}

describe('the file, and where it sits', () => {
  test('it sorts after the newest applied migration (20270122000000)', () => {
    assert.ok(NAME > '20270122000000_order_submission_internal_details.sql')
  })

  test('it re-emits exactly one function, the implementation', () => {
    const created = [...SQL.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1])
    assert.deepEqual(created, [V2])
  })

  test('it touches no table, policy, trigger or row', () => {
    const outside = SQL.replace(/create or replace function[\s\S]*?\n\$\$;/g, '')
    assert.ok(!/\b(alter|create|drop)\s+(table|policy|trigger|index)\b/i.test(outside))
    assert.ok(!/^\s*(insert|update|delete)\s/mi.test(outside))
    assert.ok(!/\bgrant\b/i.test(outside), 'it grants nothing')
  })
})

describe('§1. the implementation clears the decision basis, and changes nothing else', () => {
  const before = definition(PREVIOUS, V2)
  const after = definition(MIGRATION, V2)

  test('the body is 20260917000000\'s, plus the clearing lines', () => {
    const added = after.split('\n').filter(l => !before.split('\n').includes(l))
    const expected = new Set([
      ...BASIS_CLEARED.map(s => s + ','),
      BASIS_CLEARED[3],
      'advance_exception_rejection_reason = null,',
      '-- the decision basis goes with the decision (20270124000000): it may only',
      '-- stand on an approved exception (order_submissions_exception_basis_scope)',
    ])
    for (const line of added) {
      assert.ok(expected.has(line.trim()), `unexpected new line: ${line.trim()}`)
    }
    const removed = before.split('\n').filter(l => !after.split('\n').includes(l))
    for (const line of removed) {
      assert.equal(line.trim(), 'advance_exception_rejection_reason = null',
        `unexpected removed line: ${line.trim()}`)
    }
  })

  test('both branches that leave \'approved\' clear all four basis columns', () => {
    for (const col of BASIS_CLEARED) {
      assert.equal(after.split(col).length - 1, 2, `${col} must appear in exactly two branches`)
    }
    // The standard branch and the fresh-pending branch, not the branch that
    // keeps an unchanged approved exception.
    const keep = after.slice(after.indexOf('if v_keep then'), after.indexOf('else', after.indexOf('if v_keep then')))
    assert.ok(!keep.includes('advance_exception_decided_grand_total'),
      'an unchanged approved exception keeps its basis')
  })

  test('it stays a definer with a pinned search_path, reachable by no role', () => {
    assert.match(after, /security definer\nset search_path = public, pg_temp\nas \$\$/)
    assert.ok(MIGRATION.includes(
      `revoke execute on function public.${V2}(uuid, text, text, text, numeric, text)\n  from public, anon, authenticated, service_role;`))
  })
})

describe('§2. the legacy advance doors are closed to clients', () => {
  test('both are revoked from public, anon and authenticated', () => {
    for (const door of DOORS) {
      assert.ok(MIGRATION.includes(
        `revoke execute on function public.${door}\n  from public, anon, authenticated;`), door)
    }
  })

  test('the application\'s door and the non-advance legacy doors are not touched', () => {
    for (const fn of ['submit_pi_for_review', 'submit_pi_for_review_internal',
                      'submit_order_submission', 'submit_order_submission_with_note']) {
      assert.ok(!new RegExp(`(revoke|grant)[^;]*public\\.${fn}\\(`, 'i').test(SQL), fn)
    }
  })

  test('the application calls neither door', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const p = `${dir}/${e}`
        if (statSync(join(ROOT, p)).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p)
      }
    }
    walk('src')
    for (const f of files) {
      assert.ok(!/rpc\(\s*['"]submit_order_submission_with_advance/.test(read(f)),
        `${f} calls a legacy advance door`)
    }
  })

  test('it proves all of this at apply time', () => {
    for (const msg of [
      'does not clear the decision basis in exactly two branches',
      'order_submissions_exception_basis_scope is missing or not validated',
      'is still executable by %',
      'is no longer callable by authenticated',
    ]) {
      assert.ok(SQL.includes(msg), msg)
    }
  })
})
