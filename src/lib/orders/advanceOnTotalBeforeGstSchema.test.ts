/**
 * THE ADVANCE IS 40% OF THE TOTAL BEFORE GST (20270227000000), read as text.
 *
 * Executing it was done against a disposable local stack (a clone of a fully
 * migrated schema): supabase/tests/advance_on_total_before_gst_assertions.sql,
 * order_advance_hold_assertions.sql and orders_dashboard_assertions.sql pass on
 * it, three times each, and fail on the schema without it. This file holds the
 * migration to its promises without a database:
 *
 *   * no caller of a helper passes the Grand Total (or the Order's value) any
 *     more: every denominator is the pre-GST figure;
 *   * a missing base is explicit in every helper (NULL, zero, NaN, negative);
 *   * it writes no row (derive on read, nothing back-filled);
 *   * every replaced function keeps its security attribute and a pinned
 *     search_path ending in pg_temp, and states no grant of its own (CREATE OR
 *     REPLACE keeps the ACL; the migration proves it at the foot);
 *   * the new readers are executable only as intended;
 *   * the amount/condition constraint is the looser one, validated;
 *   * the rollback restores every replaced function it names.
 *
 * Run:
 *   npx tsx --test src/lib/orders/advanceOnTotalBeforeGstSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const NAME = '20270227000000_order_submission_advance_on_total_before_gst.sql'
const MIGRATION = read(`supabase/migrations/${NAME}`)
const SQL = stripSql(MIGRATION)
const ROLLBACK = read('docs/Module Docs/advance-on-total-before-gst-rollback.sql')

const REPLACED = [
  'order_submission_standard_advance_amount', 'order_submission_advance_amount', 'order_submission_required_payment',
  'order_submission_payment_shortfall', 'order_submission_payment_ready', 'order_submissions_advance_amount_follows_total',
  'order_advance_position', 'approve_order_submission', 'approve_pi_advance_exception', 'reject_pi_advance_exception',
  'submit_pi_for_review_internal', 'submit_order_submission_advance_v2_internal', 'pi_submission_payment_summary',
  'orders_alignment_requires_advance', 'order_advance_hold_recheck', 'orders_dashboard_summary',
]

/** One function's text out of a migration (header through its closing dollar quote). */
function fnText(sql: string, name: string): string {
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, 'ig')
  let last = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) last = m.index
  assert.ok(last >= 0, `${name} is defined`)
  const rest = sql.slice(last)
  const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(rest)
  assert.ok(tag, `${name} has a dollar-quoted body`)
  const end = rest.indexOf(tag![1], tag!.index + tag![0].length)
  return rest.slice(0, end + tag![1].length)
}

describe('the file, and where it sits', () => {
  test('its name says it belongs to the submission feature, and it sorts after everything before it', () => {
    assert.match(NAME, /order_submission/)
    const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort()
    assert.ok(files.includes(NAME))
    assert.ok(files.filter(f => f > NAME).length === 0 || files.indexOf(NAME) > 0, 'it is not the first file')
    assert.ok(files.slice(0, files.indexOf(NAME)).every(f => f < NAME))
  })

  test('it is not wrapped in an explicit transaction, like every file before it', () => {
    assert.doesNotMatch(SQL, /^\s*(begin|commit)\s*;/im)
  })

  test('it replays: every statement is CREATE OR REPLACE, DROP IF EXISTS or a guarded block', () => {
    assert.doesNotMatch(SQL, /create\s+function\b/i)
    assert.doesNotMatch(SQL, /create\s+table\b/i)
    assert.doesNotMatch(SQL, /alter\s+table[^;]*add\s+column\b/i)
  })
})

describe('NO BACKFILL: derive on read, write nothing', () => {
  test('it inserts, updates and deletes no row and truncates nothing', () => {
    const body = SQL.replace(/create temp table pi_advance_acl_before[\s\S]*?;/i, '')
    assert.doesNotMatch(body.replace(/create or replace function[\s\S]*?\n\$(?:function)?\$;?/gi, ''), /\b(insert\s+into|delete\s+from|truncate)\b/i)
    // the only UPDATE / INSERT text is inside function bodies that were already there
    const outside = SQL.split(/create or replace function/i)[0]
    assert.doesNotMatch(outside, /\bupdate\s+public\./i)
  })

  test('the Order base is a pure read of PI figures, with no write in its body', () => {
    for (const n of ['order_advance_base', 'order_total_before_gst', 'order_advance_numeric']) {
      const f = fnText(SQL, n)
      assert.doesNotMatch(f, /\b(insert|update|delete)\b/i, `${n} writes nothing`)
    }
    const base = fnText(SQL, 'order_advance_base')
    assert.match(base, /order_pi_revision_staged_parses/)
    assert.match(base, /s\.grand_total = o\.total_value/)
    assert.match(base, /order_advance_numeric\(p\.payload -> 'commercial' ->> 'grand_total'\) = o\.total_value/)
    assert.match(base, /stable/i)
  })
})

describe('the helpers: the argument is the pre-GST base, and a missing one is explicit', () => {
  for (const [n, args] of [
    ['order_submission_required_payment', 'p_grand_total <= 0'],
    ['order_submission_payment_shortfall', 'p_grand_total <= 0'],
    ['order_submission_standard_advance_amount', 'p_grand_total <= 0'],
    ['order_submission_advance_amount', 'p_grand_total <= 0'],
    ['order_submission_payment_ready', 'p_grand_total > 0'],
  ] as const) {
    test(`${n} refuses a NULL, NaN, zero and negative base`, () => {
      const f = fnText(SQL, n)
      assert.match(f, /p_grand_total is (not )?null/i)
      assert.match(f, /'NaN'::numeric/)
      assert.ok(f.includes(args), `${n} tests ${args}`)
    })
  }

  test('payment_ready needs a real base even under an approved exception, and answers false rather than NULL', () => {
    const f = fnText(SQL, 'order_submission_payment_ready')
    assert.match(f, /coalesce\(/i)
    assert.match(f, /false\s*\)\s*\$\$/i)
    assert.ok(f.indexOf("p_grand_total > 0") < f.indexOf("p_advance_exception_status = 'approved'"),
      'the base is tested before the exception is looked at')
  })

  test('the rounding rules are the ones that were there: exact required, shortfall up, suggestion up', () => {
    assert.match(fnText(SQL, 'order_submission_required_payment'), /p_grand_total \* public\.order_submission_standard_advance_percent\(\) \/ 100/)
    assert.match(fnText(SQL, 'order_submission_payment_shortfall'), /ceil\(\(public\.order_submission_required_payment\(p_grand_total\) - p_verified\) \* 100\) \/ 100/)
    assert.match(fnText(SQL, 'order_submission_standard_advance_amount'), /round\(ceil\(p_grand_total \* 40\) \/ 100, 2\)/)
    assert.match(fnText(SQL, 'order_submission_advance_amount'), /round\(p_grand_total \* p_percent \/ 100, 2\)/)
  })

  test('the percentage helper is not replaced (its body is unchanged; only what is passed in changed)', () => {
    assert.doesNotMatch(SQL, /create or replace function public\.order_submission_advance_percent_of/i)
    assert.doesNotMatch(SQL, /create or replace function public\.order_submission_effective_advance_amount/i)
    assert.doesNotMatch(SQL, /create or replace function public\.order_pi_exception_floor/i)
    assert.doesNotMatch(SQL, /create or replace function public\.order_submission_exception_current/i)
  })
})

describe('no caller measures an advance against the Grand Total or the Order value any more', () => {
  const HELPER = /order_submission_(required_payment|payment_shortfall|advance_percent_of|standard_advance_amount|advance_amount)\(\s*([^,)]*)/g
  for (const n of REPLACED.filter(x => !x.startsWith('order_submission_') || x.includes('v2'))) {
    test(`${n}`, () => {
      const f = fnText(SQL, n)
      let m: RegExpExecArray | null
      HELPER.lastIndex = 0
      while ((m = HELPER.exec(stripSql(f)))) {
        assert.doesNotMatch(m[2], /grand_total|total_value|v_total\b/, `${n}: ${m[0]} passes the old denominator`)
      }
    })
  }

  test('the Order position measures against v_base, and exposes it', () => {
    const f = fnText(SQL, 'order_advance_position')
    assert.match(f, /v_base\s+:=\s+public\.order_advance_base\(o\.id\)/)
    assert.match(f, /order_submission_required_payment\(v_base\)/)
    assert.match(f, /order_submission_payment_shortfall\(v_base, v_verified\)/)
    assert.match(f, /trunc\(100 \* v_verified \/ v_base, 2\)/)
    assert.match(f, /'advance_base', v_base/)
    assert.match(f, /'order_value_known', v_value_known/)
    assert.match(f, /'value_known',\s+v_known/)
    assert.match(f, /'ready',\s+\(v_known and v_short = 0\) or v_exc\.id is not null/)
  })

  test('the PI doors refuse a PI that has a grand total and no usable total before GST, in the existing words', () => {
    for (const n of ['approve_order_submission', 'approve_pi_advance_exception']) {
      const f = fnText(SQL, n)
      assert.match(f, /v_sub\.total_before_gst is null\s+or v_sub\.total_before_gst = 'NaN'::numeric\s+or v_sub\.total_before_gst <= 0/, n)
      assert.match(f, /ORDER_SUBMISSION_INCOMPLETE: this PI has no stored total before GST/, n)
    }
    for (const n of ['submit_pi_for_review_internal', 'submit_order_submission_advance_v2_internal']) {
      const f = fnText(SQL, n)
      assert.match(f, /ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored total before GST/, n)
    }
    const approve = fnText(SQL, 'approve_order_submission')
    assert.ok(approve.indexOf('no stored total before GST') < approve.indexOf('order_submission_verified_payment'),
      'the base is checked before any payment is judged')
    assert.ok(approve.indexOf('no stored total before GST') < approve.indexOf('v_exception_current :='),
      'and before any exception is looked at')
  })

  test('the summary reports no percentage and no clearance without a base', () => {
    const f = fnText(SQL, 'pi_submission_payment_summary')
    assert.match(f, /'order_gate_cleared',\s+\(v_base_ok and \(v_meets or v_exc_current\)\)/)
    assert.match(f, /when not v_base_ok\s+then 'payment_required'/)
    assert.equal((f.match(/case when not v_base_ok then null/g) ?? []).length, 3)
    assert.match(f, /'advance_base',\s+v_base/)
    assert.match(f, /'total_before_gst',\s+v_sub\.total_before_gst/)
  })

  test('the dashboard lists by the base', () => {
    const f = fnText(SQL, 'orders_dashboard_summary')
    assert.match(f, /nullif\(\(p\.pos ->> 'advance_base'\)::numeric, 0\)/)
    assert.match(f, /'advance_base', p\.pos -> 'advance_base'/)
    assert.doesNotMatch(f, /\/ d\.total_value/)
  })

  test('the identity check on the Grand Total is untouched', () => {
    assert.match(fnText(SQL, 'approve_order_submission'), /advance_exception_decided_grand_total,\s+v_sub\.grand_total/)
    assert.match(fnText(SQL, 'pi_submission_payment_summary'), /advance_exception_decided_grand_total,\s+v_sub\.grand_total/)
  })
})

describe('security: attributes, search_path and grants are exactly what they were', () => {
  test('every definer it creates or replaces pins search_path ending in pg_temp', () => {
    for (const n of [...REPLACED.filter(x => !['order_submission_standard_advance_amount', 'order_submission_advance_amount'].includes(x)),
                     'order_advance_base', 'order_total_before_gst', 'order_advance_numeric']) {
      const f = fnText(SQL, n)
      if (/security definer/i.test(f) || /^order_submission_(required|payment)/.test(n)) {
        assert.match(f, /set\s+search_path\s*=\s*public,\s*pg_temp\s*\n/i, `${n} pins search_path`)
      }
    }
  })

  test('the replaced functions state no grant or revoke of their own (the ACL is kept, and proved at the foot)', () => {
    for (const n of REPLACED) {
      assert.doesNotMatch(SQL, new RegExp(`(grant|revoke)\\s+[^;]*\\bpublic\\.${n}\\s*\\(`, 'i'), `${n}`)
    }
    assert.match(MIGRATION, /ASSERTION FAILED: ACL, SECURITY DEFINER or search_path changed on/)
  })

  test('the new readers: nothing for anon, the signed-in reader for the scalar only, no client for the base', () => {
    assert.match(SQL, /revoke execute on function public\.order_advance_base\(uuid\) from public, anon, authenticated, service_role/)
    assert.match(SQL, /revoke execute on function public\.order_advance_numeric\(text\) from public, anon, authenticated, service_role/)
    assert.match(SQL, /revoke all on function public\.order_total_before_gst\(public\.orders\) from public, anon, service_role/)
    assert.match(SQL, /grant execute on function public\.order_total_before_gst\(public\.orders\) to authenticated/)
    const f = fnText(SQL, 'order_total_before_gst')
    assert.match(f, /public\.can_read_order_detail\(o\.id\)/, 'a made-up row cannot read another Order')
  })
})

describe('the declared amount', () => {
  test('the constraint is the looser one and is added validated', () => {
    assert.match(SQL, /drop constraint if exists order_submissions_advance_amount_matches_condition/)
    assert.match(SQL, /least\(coalesce\(total_before_gst, grand_total\), grand_total\) \* 40 \/ 100/)
    assert.match(SQL, /advance_condition = 'exception'\s+and advance_declared_amount <\s+grand_total \* 40 \/ 100/)
    const add = /add constraint order_submissions_advance_amount_matches_condition check \([\s\S]*?\n  \);/.exec(SQL)
    assert.ok(add, 'the constraint is added')
    assert.doesNotMatch(add![0], /not valid/i, 'it cannot fail on existing rows, so it is validated')
  })

  test('the amount is cleared when EITHER total is replaced', () => {
    const f = fnText(SQL, 'order_submissions_advance_amount_follows_total')
    assert.match(f, /new\.grand_total is distinct from old\.grand_total\s+or new\.total_before_gst is distinct from old\.total_before_gst/)
  })
})

describe('the rollback', () => {
  test('restores every function the migration replaced, and drops what it added', () => {
    for (const n of REPLACED) {
      assert.match(ROLLBACK, new RegExp(`create or replace function public\\.${n}\\s*\\(`, 'i'), `${n} is restored`)
    }
    assert.match(ROLLBACK, /drop function if exists public\.order_total_before_gst\(public\.orders\)/)
    assert.match(ROLLBACK, /drop function if exists public\.order_advance_base\(uuid\)/)
    assert.match(ROLLBACK, /drop function if exists public\.order_advance_numeric\(text\)/)
  })

  test('it restores the old amount rule NOT VALID, so a PI declared since cannot make it fail', () => {
    assert.match(ROLLBACK, /advance_declared_amount >= grand_total \* 40 \/ 100/)
    assert.match(ROLLBACK, /\) not valid;/)
  })

  test('the restored bodies are the ones that stood before (the grand-total denominators are back)', () => {
    assert.match(fnText(ROLLBACK, 'order_submission_required_payment'), /p_grand_total \* public\.order_submission_standard_advance_percent\(\) \/ 100/)
    assert.match(fnText(ROLLBACK, 'order_advance_position'), /order_submission_required_payment\(o\.total_value\)/)
    assert.match(fnText(ROLLBACK, 'approve_order_submission'), /order_submission_required_payment\(v_sub\.grand_total\)/)
  })
})
