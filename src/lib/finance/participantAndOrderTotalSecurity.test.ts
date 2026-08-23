/**
 * The contract of 20261006000000 — the two financial-data exposures, closed.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The behaviour is proved by execution, as real roles, in
 * supabase/tests/payment_participant_security.sql, driven by
 * supabase/tests/run_security_suite.sh: it builds a production-shaped schema,
 * demonstrates both exposures on the applied definitions, applies the three
 * unapplied migrations in order, and requires the whole matrix to hold.
 *
 * This file holds the shipped migration to the shape those proofs depend on, so
 * the fix cannot be edited away without a test going red. In particular it
 * pins the two things that would silently reopen an exposure: a bare read of the
 * orders table inside a definer, and an ungated total.
 *
 * Run:
 *   npx tsx --test src/lib/finance/participantAndOrderTotalSecurity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FIX = 'supabase/migrations/20261006000000_payment_participant_and_order_total_security.sql'
const ATTRIBUTION = 'supabase/migrations/20261005000000_order_linked_payment_total_counts_allocations.sql'
const SUITE = 'supabase/tests/payment_participant_security.sql'
const SCHEMA = 'supabase/tests/_production_shaped_schema.sql'
const RUNNER = 'supabase/tests/run_security_suite.sh'

const fix = readFileSync(FIX, 'utf8')
const attribution = readFileSync(ATTRIBUTION, 'utf8')
const suite = readFileSync(SUITE, 'utf8')
const schema = readFileSync(SCHEMA, 'utf8')
const runner = readFileSync(RUNNER, 'utf8')

/** One function's definition, isolated from the rest of the migration. */
function body(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  assert.ok(start > 0, `${name} must be defined`)
  const end = sql.indexOf(`comment on function public.${name}(`, start)
  assert.ok(end > start, `${name} must be commented`)
  return sql.slice(start, end)
}

const participant = body(fix, 'can_read_payment_as_participant')
const viewOrder = body(fix, 'can_view_order_as_actor')
const total = body(fix, 'order_linked_payment_total')

describe('it edits no applied migration', () => {
  test('the correction is a new forward-only file after 20261005000000', () => {
    assert.ok(FIX.includes('20261006000000'))
    assert.ok(fix.includes('FORWARD-ONLY. Edits no applied file.'))
  })

  test('it creates, drops and alters no policy', () => {
    // Both fixes are function replacements at existing signatures. A policy edit
    // here would change visibility for callers this migration never analysed.
    for (const forbidden of [/\bcreate policy\b/i, /\bdrop policy\b/i, /\balter policy\b/i]) {
      assert.equal(fix.match(forbidden), null,
        `20261006000000 must not ${String(forbidden)} — it replaces functions only`)
    }
  })

  test('and it moves no table grant', () => {
    assert.equal(fix.match(/grant .* on (table )?public\.\w+ to/i), null)
  })
})

describe('exposure 1 — the participant predicate', () => {
  test('the Order branch no longer reads the orders table at all', () => {
    // THE WHOLE FIX. `exists (select 1 from public.orders ...)` inside a
    // SECURITY DEFINER is evaluated for the OWNER, who is exempt from that
    // table's RLS, so it meant "the Order exists" for every caller.
    assert.equal(participant.match(/from public\.orders/), null,
      'a direct read of the orders table inside this definer means "the Order exists"')
    assert.match(participant, /public\.can_view_order_as_actor\(a\.order_id\)/)
  })

  test('the PI branch is untouched, gate and all', () => {
    assert.match(participant, /public\.module_entry_open\('orders'\)/)
    assert.match(participant, /public\.can_view_order_submission\(a\.order_submission_id\)/)
  })

  test('it stays a definer, and the migration says why an invoker is impossible', () => {
    // Reading finance_payment_allocations as the invoker is a policy cycle:
    // its payment_owner policy reads finance_payment_requests, whose policies
    // call this function. PostgreSQL refuses the cycle outright.
    assert.match(participant, /security definer/)
    assert.ok(fix.includes('WHY THE FUNCTION CANNOT SIMPLY BECOME AN INVOKER'))
    assert.ok(fix.includes('infinite recursion detected in policy for relation'))
  })

  test('signature, return type and volatility are unchanged, so all four policies keep working', () => {
    assert.match(participant, /can_read_payment_as_participant\(p_payment_id uuid\)/)
    assert.match(participant, /returns boolean/)
    assert.match(participant, /\bstable\b/)
  })

  test('the migration re-checks all four dependent policies at apply time', () => {
    assert.ok(fix.includes('expected 4 policies to consult the participant predicate'))
    assert.ok(fix.includes('participant visibility must NEVER appear in a WITH CHECK'))
  })
})

describe('the definer-safe Order predicate', () => {
  test('every branch is auth.uid()-based, so nesting cannot change its meaning', () => {
    assert.match(viewOrder, /u\.role = 'admin'/)
    assert.match(viewOrder, /u\.team = 'operations'/)
    assert.match(viewOrder, /o\.requested_by = auth\.uid\(\)/)
    assert.match(viewOrder, /o\.assigned_to  = auth\.uid\(\)/)
    assert.match(viewOrder, /public\.resolve_permission\(auth\.uid\(\), 'orders', 'view_all'\)/)
  })

  test('the RESTRICTIVE module gate is ANDed, not ORed', () => {
    // A restrictive policy is reached before any ownership or view_all branch.
    const gate = viewOrder.indexOf("public.module_entry_open('orders')")
    const firstBranch = viewOrder.indexOf("u.role = 'admin'")
    assert.ok(gate > 0 && gate < firstBranch,
      'module entry must be required before any permissive branch is consulted')
    assert.match(viewOrder, /and public\.module_entry_open\('orders'\)/)
  })

  test('it pins search_path and schema-qualifies everything', () => {
    assert.match(viewOrder, /set search_path = public, pg_temp/)
    assert.match(viewOrder, /from public\.orders o/)
    assert.match(viewOrder, /from public\.users u/)
  })

  test('EXECUTE is revoked from PUBLIC and anon, granted only to authenticated', () => {
    assert.ok(fix.includes(
      'revoke execute on function public.can_view_order_as_actor(uuid) from public, anon;'))
    const grants = fix.match(
      /grant\s+execute on function public\.can_view_order_as_actor\(uuid\) to ([^\n;]+)/g) ?? []
    assert.equal(grants.length, 1)
    assert.match(grants[0], /to authenticated$/)
  })

  test('it does NOT replace can_view_order, which stays the invoker answer', () => {
    // can_view_order asks the orders policies and can never drift from them. It
    // remains correct — and preferable — everywhere the call chain is invoker.
    assert.equal(fix.match(/create or replace function public\.can_view_order\(/), null)
    assert.ok(fix.includes('can_view_order() stays the right tool for policies'))
  })

  test('being a restatement, it is guarded by an apply-time drift check', () => {
    assert.ok(fix.includes('orders_admin_select'))
    assert.ok(fix.includes('orders_operations_select'))
    assert.ok(fix.includes('orders_sales_select'))
    assert.ok(fix.includes('orders_permission_engine_select'))
    assert.ok(fix.includes('and that set has changed to %; update §1 before applying'))
    assert.ok(fix.includes('the RESTRICTIVE orders_module_entry_gate is missing'))
  })

  test('and the repository still contains exactly those four SELECT policies', () => {
    // The CI half of the same guard: the apply-time assertion cannot run until
    // someone applies the migration, but this runs on every commit.
    const all = readFileSync('supabase/migrations/20260655_create_orders.sql', 'utf8')
      + readFileSync('supabase/migrations/20260666_convert_users_team_to_text.sql', 'utf8')
      + readFileSync('supabase/migrations/20260685000000_orders_permission_engine_select.sql', 'utf8')
      + readFileSync('supabase/migrations/20260903000000_protected_visibility_actions.sql', 'utf8')
    const names = new Set(
      [...all.matchAll(/create policy "(orders_[a-z_]*select)" on public\.orders/gi)]
        .map(m => m[1].toLowerCase()))
    assert.deepEqual([...names].sort(), [
      'orders_admin_select', 'orders_operations_select',
      'orders_permission_engine_select', 'orders_sales_select',
    ])
  })
})

describe('exposure 2 — the Order total', () => {
  test('it is gated on Order visibility', () => {
    assert.match(total, /public\.can_view_order_as_actor\(p_order_id\)/)
  })

  test('an unauthorised caller gets NULL — not 0, and not an error', () => {
    // 0 is a financial claim; an error distinguishes rows that exist from rows
    // that do not. NULL is the same answer for both, so neither is an oracle.
    assert.match(total, /select case when \(select ok from authorized\) then coalesce\(sum\(/)
    assert.equal(total.match(/raise exception/), null,
      'refusing by exception would distinguish an unreadable Order from an unknown one')
  })

  test('the canonical attribution rule is preserved exactly', () => {
    assert.match(total, /when s\.active_total > 0\s+then s\.own_total/)
    assert.match(total, /when s\.order_id = p_order_id\s+then s\.amount/)
    const allocation = total.indexOf('active_total > 0')
    const link = total.indexOf('s.order_id = p_order_id   then s.amount')
    assert.ok(allocation > 0 && link > allocation,
      'allocations must still be tested before the direct link')
  })

  test('the attribution body is the one 20261005000000 shipped, not a rewrite', () => {
    // The gate is a wrapper. Every line that decides money is character-for-
    // character the previous migration's, so a transcription slip here cannot
    // quietly change what an Order is owed. Compared on the `shares` CTE, which
    // is where all of the arithmetic lives.
    const shares = (fn: string) => {
      const from = fn.indexOf('  shares as (')
      const to = fn.indexOf('  from candidates c')
      assert.ok(from > 0 && to > from, 'the shares CTE must be present')
      return fn.slice(from, to)
    }
    assert.equal(shares(total), shares(body(attribution, 'order_linked_payment_total')))
  })

  test('and the migration re-asserts that shape at apply time', () => {
    assert.ok(fix.includes('must prefer active allocations over the direct link'))
    assert.ok(fix.includes('must use the shared verified predicate'))
  })

  test('grants are unchanged: anon and PUBLIC out, authenticated in', () => {
    assert.ok(fix.includes(
      'revoke execute on function public.order_linked_payment_total(uuid) from public, anon;'))
    assert.ok(fix.includes('anon must not hold EXECUTE on order_linked_payment_total'))
    assert.ok(fix.includes('authenticated must retain EXECUTE on order_linked_payment_total'))
  })

  test('a null auth.uid() is admitted, and the migration justifies it', () => {
    // Not an end user: the service role or direct psql. anon holds no EXECUTE,
    // and the service role bypasses RLS anyway, so it grants nothing new — while
    // refusing it would blank the received figure in operational scripts.
    assert.match(total, /or auth\.uid\(\) is null as ok/)
    assert.ok(fix.includes('WHY auth.uid() IS NULL IS ALLOWED THROUGH'))
    assert.ok(fix.includes('which is the service role and direct psql'))
  })
})

describe('all three functions meet the protected-RPC rules', () => {
  for (const [name, sql] of [
    ['can_view_order_as_actor', viewOrder],
    ['can_read_payment_as_participant', participant],
    ['order_linked_payment_total', total],
  ] as const) {
    test(`${name}: pinned search_path, pg_temp last`, () => {
      const path = /set search_path = ([^\n]+)/.exec(sql)?.[1] ?? ''
      assert.ok(path.trim().endsWith('pg_temp'), `${name}: pg_temp must be last, got "${path}"`)
    })

    test(`${name}: no unqualified reference to a public table`, () => {
      // String literals are stripped first: module_entry_open('orders') names a
      // MODULE KEY, not the orders table, and a search_path cannot redirect a
      // quoted constant.
      const inner = (sql.split('$$')[1] ?? '').replace(/'[^']*'/g, "''")
      for (const table of ['orders', 'users', 'finance_payment_requests',
                           'finance_payment_allocations', 'order_submissions']) {
        const bare = new RegExp(`(?<!public\\.)(?<!_)\\b${table}\\b(?!_)`, 'g')
        assert.equal(inner.match(bare), null,
          `${name} references ${table} without its schema`)
      }
    })

    test(`${name}: ownership is never reassigned`, () => {
      assert.equal(fix.match(new RegExp(`alter function public\\.${name}[^\\n]*owner to`, 'i')), null)
    })
  }
})

describe('the executable suite exists and covers the whole matrix', () => {
  test('it runs the same file twice — before the fix and after it', () => {
    assert.ok(runner.includes('BEFORE: the exposures, demonstrated'))
    assert.ok(runner.includes('AFTER: the same matrix, now required to hold'))
    assert.ok(suite.includes("to_regprocedure('public.can_view_order_as_actor(uuid)') is not null"),
      'the file must detect for itself which phase it is in')
  })

  test('it applies all three unapplied migrations, in order', () => {
    const order = ['20261004000000', '20261005000000', '20261006000000']
      .map(m => runner.indexOf(m))
    assert.ok(order.every(i => i > 0), 'all three must be applied by the runner')
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'and in ascending order')
  })

  test('every case A–P is asserted', () => {
    for (const letter of 'ABCDEFGHIJKLMNOP') {
      assert.ok(new RegExp(`% ${letter} pass|AFTER  ${letter} pass|% ${letter} FAILED|AFTER  ${letter} FAILED`)
        .test(suite), `case ${letter} must be asserted in ${SUITE}`)
    }
  })

  test('the BEFORE phase requires the exposures to actually reproduce', () => {
    // A test that only checks the fixed state cannot tell a fix from a fixture
    // that never exercised the bug.
    assert.ok(suite.includes('BEFORE G: the exposure did not reproduce'))
    assert.ok(suite.includes('BEFORE L: the exposure did not reproduce'))
  })

  test('the schema carries the pre-correction definitions, so BEFORE is real', () => {
    assert.ok(schema.includes('THE TWO DEFECTIVE DEFINITIONS, AS THEY ARE IN THE APPLIED SCHEMA'))
    assert.ok(schema.includes('exists (select 1 from public.orders o where o.id = a.order_id)'))
  })

  test('the schema is a test fixture and says so', () => {
    assert.ok(schema.includes('must never be added to supabase/migrations'))
  })

  test('both SQL files leave nothing behind', () => {
    assert.ok(suite.trimEnd().endsWith('rollback;'))
    assert.ok(runner.includes('drop database'))
  })
})
