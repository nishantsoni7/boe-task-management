/**
 * THE ORDER AND FINANCE WRITE GUARDS RUN AS THEIR OWNER (20270105000000), read
 * as text.
 *
 * Executing it was done against a disposable local stack (the #209 chain plus
 * this file): before it, a signed-in Sales user filing an Order change request
 * and an admin changing an Order's status both failed with "permission denied
 * for function in_test_data_cleanup"; after it, both succeed, and both are
 * still refused with ORDER_FINANCE_RESET_IN_PROGRESS while a reset is open.
 * This file holds the migration to its promises without a database:
 *
 *   * it changes the security mode and search_path of the guards and nothing
 *     else — no CREATE FUNCTION, no table, no policy, no trigger, no DML;
 *   * it grants nothing, and the internal helpers stay internal;
 *   * every guard it names is revoked from every client role and service_role;
 *   * it proves at apply time that each is a definer with that search_path,
 *     and that no trigger of this shape is left anywhere in public;
 *   * the client writes it exists for are real.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderFinanceGuardsRunAsOwner.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const NAME = '20270105000000_order_finance_guards_run_as_owner.sql'
const FILE = `supabase/migrations/${NAME}`
const MIGRATION = read(FILE)
const SQL = stripSql(MIGRATION)

/** Live in production on 2026-09-25, every one SECURITY INVOKER. */
const GUARDS = [
  'order_finance_reset_write_guard',
  'orders_guard_cleanup_claim',
  'order_submissions_guard_cleanup_claim',
  'prevent_order_source_request_change',
  'prevent_order_source_submission_change',
  'finance_payment_allocations_guard_pi_deletion',
  'order_submission_corrections_guard_deletion',
  'order_submissions_guard_delete',
  'order_submission_activity_guard_delete',
  'order_submission_child_guard_deletion_claim',
  'order_submissions_guard_deletion_claim',
]

/** Created by 20270104000000 (#209); altered only if present. */
const LATER_GUARDS = [
  'order_advance_exceptions_immutable',
  'order_advance_holds_guard',
  'order_reserved_number_ledger_guard',
]

const HELPERS = [
  'in_test_data_cleanup',
  'open_order_finance_reset_scope',
  'order_submission_purge_in_progress',
  'test_data_cleanup_claim_open',
]

describe('the file, and where it sits', () => {
  test('it sorts after the five unapplied Orders migrations of #202 / #205 / #206 / #209', () => {
    assert.ok(NAME > '20270104000000_order_pi_revision_in_force_at_admin_approval.sql')
  })

  test('it names its hard dependencies and checks each one exists', () => {
    for (const fn of [...GUARDS, ...HELPERS]) {
      assert.match(SQL, new RegExp(`'public\\.${fn}\\([^']*\\)'`), `${fn} is checked before anything runs`)
    }
    assert.ok(SQL.includes("raise exception 'DEPENDENCY MISSING: % does not exist', v_fn;"))
  })
})

describe('it changes who the guards run as, and nothing else', () => {
  test('each production guard is altered to SECURITY DEFINER with search_path = public, pg_temp', () => {
    for (const fn of GUARDS) {
      assert.match(SQL,
        new RegExp(`alter function public\\.${fn}\\(\\)\\s+security definer set search_path = public, pg_temp;`),
        `${fn} must run as its owner`)
    }
  })

  test('the three 20270104 guards are altered only when they exist', () => {
    for (const fn of LATER_GUARDS) {
      assert.ok(SQL.includes(`'public.${fn}()'`), `${fn} is named, not discovered`)
    }
    assert.ok(SQL.includes('if to_regprocedure(v_fn) is not null then'))
    assert.ok(SQL.includes("execute format('alter function %s security definer set search_path = public, pg_temp', v_fn);"))
  })

  test('no body is redefined, and nothing else in the schema changes', () => {
    assert.doesNotMatch(SQL, /create\s+(or\s+replace\s+)?function/i, 'ALTER only: production keeps its bytes')
    assert.doesNotMatch(SQL, /\b(create|drop)\s+(table|trigger|policy|index|type|view)\b/i)
    assert.doesNotMatch(SQL, /\balter\s+(table|policy|trigger)\b/i)
    assert.doesNotMatch(SQL, /\b(insert\s+into|update\s+public\.|delete\s+from)\b/i, 'no DML')
  })

  test('it grants nothing — the helpers stay internal', () => {
    assert.doesNotMatch(SQL, /\bgrant\b/i)
    for (const fn of HELPERS) {
      assert.doesNotMatch(SQL, new RegExp(`(grant|revoke)[^;]*function public\\.${fn}\\b`, 'i'),
        `${fn}'s own privileges are not this file's business`)
    }
  })

  test('every guard it touches is revoked from every client role and service_role', () => {
    for (const fn of GUARDS) {
      assert.match(SQL,
        new RegExp(`revoke execute on function public\\.${fn}\\(\\)\\s+from public, anon, authenticated, service_role;`),
        `${fn} must be internal`)
    }
    assert.ok(SQL.includes("execute format('revoke execute on function %s from public, anon, authenticated, service_role', v_fn);"))
  })
})

describe('it proves itself at apply time', () => {
  test('each guard is a definer, with exactly that search_path, callable by no role', () => {
    for (const message of [
      "'guard definer: % is still SECURITY INVOKER'",
      "'guard definer: % must set exactly search_path = public, pg_temp, has %'",
      "'guard definer: % is executable by %'",
      "'guard definer: % no longer has the body this migration was written against'",
    ]) {
      assert.ok(SQL.includes(message), message)
    }
    assert.ok(SQL.includes("is distinct from array['search_path=public, pg_temp']"))
  })

  test('the helpers are asserted still NOT executable by a client', () => {
    assert.ok(SQL.includes("'guard definer: internal helper % became executable by %'"))
  })

  test('and no invoker trigger that calls an internal helper is left anywhere in public', () => {
    assert.ok(SQL.includes("'guard definer: trigger functions still run as the caller and call an internal helper: %'"))
    assert.ok(SQL.includes("p.prorettype = 'trigger'::regtype"))
    assert.ok(SQL.includes('and not p.prosecdef'))
    assert.ok(SQL.includes("and not has_function_privilege('authenticated', h.oid, 'EXECUTE')"))
    for (const fn of HELPERS) assert.ok(SQL.includes(`'${fn}'`), `${fn} is in the sweep`)
  })
})

describe('assert_order_amender gets pg_temp back (§3)', () => {
  test('it is altered to search_path = public, pg_temp, and nothing else about it changes', () => {
    assert.match(SQL, /alter function public\.assert_order_amender\(\)\s+set search_path = public, pg_temp;/)
    assert.doesNotMatch(SQL, /alter function public\.assert_order_amender\(\)\s+security/i,
      'it is already a definer; its security mode is not this file\'s business')
    assert.doesNotMatch(SQL, /(grant|revoke)[^;]*assert_order_amender/i,
      'its EXECUTE grant to authenticated is kept, not restated')
  })

  test('the regression it repairs is the one on disk: 20260818 pinned pg_temp, 20260901 dropped it', () => {
    assert.match(read('supabase/migrations/20260818000000_order_amendment_hardening.sql'),
      /alter function public\.assert_order_amender\(\)\s+set search_path = public, pg_temp;/)
    const permission = read('supabase/migrations/20260901000000_finance_orders_permission_enforcement.sql')
    const def = permission.slice(permission.indexOf('create or replace function public.assert_order_amender()'))
    assert.match(def.slice(0, 200), /security definer\nset search_path = public\n/)
  })

  test('it proves at apply time that the door stays open and the body is unchanged', () => {
    for (const message of [
      "'assert_order_amender: must set exactly search_path = public, pg_temp, has %'",
      "'assert_order_amender: is no longer SECURITY DEFINER'",
      "'assert_order_amender: authenticated LOST execute; amending an Order would be refused to everyone'",
      "'assert_order_amender: anon can execute it'",
      "'assert_order_amender: no longer has the body this migration was written against'",
    ]) {
      assert.ok(SQL.includes(message), message)
    }
  })
})

describe('the writes it exists for are real', () => {
  test('the Order page files a change request with a direct insert', () => {
    const modals = read('src/app/orders/[id]/OrderAmendmentModals.tsx')
    assert.ok(modals.includes("supabase.from('order_change_requests').insert("))
  })

  test('the Order page changes status with a direct update, then logs it', () => {
    const page = read('src/app/orders/[id]/page.tsx')
    assert.match(page, /\.from\('orders'\)\s*\.update\(\{ status: newStatus \}\)/)
    assert.ok(page.includes("supabase.from('order_activity_log').insert("))
  })

  test('both tables carry the reset write guard, and orders carries the three invoker siblings', () => {
    const reset = read('supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql')
    assert.ok(reset.includes("'order_change_requests',"))
    assert.ok(reset.includes("'orders',"))
    assert.ok(reset.includes("'order_activity_log',"))
    // Fixing the reset guard alone would leave the Order status change failing
    // with the same message: these fire on the same UPDATE and call the same
    // helper first.
    assert.ok(read('supabase/migrations/20260916000000_order_submission_test_cleanup.sql')
      .includes('create trigger orders_guard_cleanup_claim\n  before update on public.orders'))
  })
})
