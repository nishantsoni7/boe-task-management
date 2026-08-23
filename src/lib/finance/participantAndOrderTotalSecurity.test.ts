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
import { execSync } from 'node:child_process'

const FIX = 'supabase/migrations/20261006000000_payment_participant_and_order_total_security.sql'
const ATTRIBUTION = 'supabase/migrations/20261005000000_order_linked_payment_total_counts_allocations.sql'
const SUITE = 'supabase/tests/payment_participant_security.sql'
const GRANTS = 'supabase/tests/participant_predicate_grants.sql'
const SCHEMA = 'supabase/tests/_production_shaped_schema.sql'
const RUNNER = 'supabase/tests/run_security_suite.sh'

const fix = readFileSync(FIX, 'utf8')
const attribution = readFileSync(ATTRIBUTION, 'utf8')
const suite = readFileSync(SUITE, 'utf8')
const grants = readFileSync(GRANTS, 'utf8')
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
    const grants = fix.match(
      /grant\s+execute on function public\.order_linked_payment_total\(uuid\) to ([^\n;]+)/g) ?? []
    assert.equal(grants.length, 1)
    assert.match(grants[0], /to authenticated$/)
    // The four grant questions are asked for this function by the shared loop in
    // §4f; see the "four separate ways" block below.
    assert.ok(fix.includes("'order_linked_payment_total(uuid)'"))
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


describe('exposure 3 — the EXECUTE grant that was never revoked', () => {
  const ORIGIN = 'supabase/migrations/20260919000000_pi_submission_payment_entry.sql'

  test('the applied migration really did write a grant and no revoke', () => {
    // The root cause, pinned so this test explains itself in five years.
    // PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and anon
    // is a member of PUBLIC.
    const origin = readFileSync(ORIGIN, 'utf8')
    assert.ok(origin.includes(
      'grant execute on function public.can_read_payment_as_participant(uuid) to authenticated;'))
    assert.equal(origin.match(
      /revoke execute on function public\.can_read_payment_as_participant/), null,
      'if a revoke ever appears in the applied file, this whole section is obsolete')
  })

  test('20261006000000 writes the revoke, and writes it before the grant', () => {
    const revoke = fix.indexOf(
      'revoke execute on function public.can_read_payment_as_participant(uuid) from public, anon;')
    const grant = fix.indexOf(
      'grant  execute on function public.can_read_payment_as_participant(uuid) to authenticated;')
    assert.ok(revoke > 0, 'the revoke is the fix')
    assert.ok(grant > revoke, 'a revoke after the grant would undo it')
  })

  test('the revoke follows the function body, because create or replace keeps an ACL', () => {
    // Replacing the function in §2 preserved the stray PUBLIC grant untouched.
    // That is why correcting the body was not enough.
    const body = fix.indexOf('create or replace function public.can_read_payment_as_participant(')
    const revoke = fix.indexOf(
      'revoke execute on function public.can_read_payment_as_participant(uuid) from public, anon;')
    assert.ok(body > 0 && revoke > body)
    assert.ok(fix.includes('CREATE OR REPLACE DOES NOT RESET AN ACL'))
  })

  test('service_role is NOT granted, and the migration proves the call path', () => {
    assert.equal(fix.match(/grant\s+execute on function[^\n;]*to[^\n;]*service_role/i), null,
      'bypassing RLS is not a reason to hold an RPC')
    assert.ok(fix.includes('SERVICE_ROLE IS DELIBERATELY NOT GRANTED'))
    assert.ok(fix.includes('service_role holds BYPASSRLS, so those policies are never'))
  })

  test('no code calls the predicate as an RPC, which is the other half of that argument', () => {
    // Only a comment refers to it; there is no invocation anywhere in src/.
    const hits = execSync(
      "grep -rn 'can_read_payment_as_participant' src/ 2>/dev/null || true",
      { encoding: 'utf8' })
      .split('\n')
      .filter(l => l.trim() && !/\.test\./.test(l))
      .filter(l => /\.rpc\(|rpc\(['"`]can_read_payment_as_participant/.test(l))
    assert.deepEqual(hits, [], 'a real RPC call would change the service_role analysis')
  })
})

describe('the grant assertions are made four separate ways', () => {
  test('PUBLIC, anon and authenticated are each asked on their own', () => {
    assert.ok(fix.includes("raise exception 'PUBLIC must not hold EXECUTE on %'"))
    assert.ok(fix.includes("raise exception 'anon must not hold EXECUTE on %'"))
    assert.ok(fix.includes("raise exception 'authenticated must hold EXECUTE on %'"))
  })

  test('and the fourth question — WHO holds a direct grant — is read from proacl', () => {
    // has_function_privilege answers "can this role execute", which is true for a
    // superuser and for anyone inheriting through PUBLIC. It can never answer
    // "who has been granted this".
    assert.ok(fix.includes('aclexplode(v_acl)'))
    assert.ok(fix.includes("when a.grantee = 0 then 'PUBLIC'"))
    assert.ok(fix.includes("if v_grantees is distinct from array['authenticated'] then"))
  })

  test('a NULL proacl is treated as the PUBLIC grant it is', () => {
    assert.ok(fix.includes('carries default privileges, which means PUBLIC holds EXECUTE'))
  })

  test('all three functions go through the same loop', () => {
    for (const fn of ['can_view_order_as_actor(uuid)',
                      'can_read_payment_as_participant(uuid)',
                      'order_linked_payment_total(uuid)']) {
      assert.ok(fix.includes(`'${fn}'`), `${fn} must be in the grant-assertion loop`)
    }
  })
})

describe('the production-shaped schema reproduces the REAL grant state', () => {
  test('it grants without revoking, exactly as the applied migration does', () => {
    // The bug in the harness itself: an earlier version added a revoke the
    // applied migration never had, so it reproduced a grant state that did not
    // exist. That is why 20261006000000 passed locally and failed remotely.
    assert.ok(schema.includes(
      'grant execute on function public.can_read_payment_as_participant(uuid) to authenticated;'))
    assert.equal(schema.match(
      /revoke execute on function public\.can_read_payment_as_participant/), null,
      'a revoke here would hide the very defect this file exists to reproduce')
    assert.ok(schema.includes('Reproducing the REAL grant state is the point of this file'))
  })

  test('the other two functions keep their real revokes', () => {
    assert.ok(schema.includes(
      'revoke execute on function public.order_linked_payment_total(uuid) from public, anon;'))
  })

  test('anon exists as a role, or nothing could inherit through PUBLIC', () => {
    assert.ok(schema.includes("rolname = 'anon'"))
    assert.ok(schema.includes("rolname = 'service_role'"))
  })
})

describe('the grant regression test', () => {
  test('it requires the defect to reproduce in the BEFORE phase', () => {
    assert.ok(grants.includes('BEFORE: PUBLIC does not hold EXECUTE'))
    assert.ok(grants.includes('BEFORE: anon does not inherit EXECUTE'))
  })

  test('it asserts all four grant questions after the fix', () => {
    assert.ok(grants.includes('AFTER  grants FAILED: PUBLIC still holds EXECUTE'))
    assert.ok(grants.includes('AFTER  grants FAILED: anon still holds EXECUTE'))
    assert.ok(grants.includes('AFTER  grants FAILED: authenticated lost EXECUTE'))
    assert.ok(grants.includes('EXECUTE granted to %, expected only {authenticated}'))
    assert.ok(grants.includes('AFTER  grants FAILED: service_role holds EXECUTE'))
  })

  test('it proves no policy broke because of the revoke', () => {
    // A lost grant raises "permission denied for function" rather than returning
    // zero rows, so the policies are exercised for real and the participant
    // reads are required to still return their rows.
    assert.ok(grants.includes('all four payment policies still resolve for authenticated callers'))
    assert.ok(grants.includes('Order and PI participant reads still return their rows'))
    assert.ok(grants.includes('anon is refused with insufficient_privilege'))
  })

  test('it runs in both phases and leaves nothing behind', () => {
    assert.ok(grants.includes("to_regprocedure('public.can_view_order_as_actor(uuid)') is not null"))
    assert.ok(grants.trimEnd().endsWith('rollback;'))
  })

  test('and the runner runs it in both phases', () => {
    const runs = [...runner.matchAll(/participant_predicate_grants\.sql/g)]
    assert.equal(runs.length, 2, 'once before the migrations and once after')
  })
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
