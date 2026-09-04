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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const BINARY_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|pdf)$/i

/**
 * A pure-JS stand-in for `grep -rn`, portable across shells. The previous
 * `execSync('grep ... 2>/dev/null || true')` depended on a POSIX shell;
 * Windows' default cmd.exe (what execSync spawns there) has neither `grep`
 * nor `/dev/null`, so the command silently produced empty output instead of
 * throwing — turning both call sites below into permanently-empty greps that
 * happened to pass one of the two by coincidence (its assertion expected
 * nothing found).
 */
function grepLines(dirs: string[], needle: string): Array<{ file: string; line: string }> {
  const hits: Array<{ file: string; line: string }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (BINARY_EXT.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      const rel = full.split('\\').join('/')
      for (const line of text.split('\n')) {
        if (line.includes(needle)) hits.push({ file: rel, line })
      }
    }
  }
  for (const dir of dirs) walk(dir)
  return hits
}

/** Distinct files (not `.test.` files) containing at least one match. */
function grepFiles(dirs: string[], needle: string): string[] {
  return [...new Set(grepLines(dirs, needle).map(h => h.file))].filter(f => !/\.test\./.test(f))
}

const FIX = 'supabase/migrations/20261006000000_payment_participant_and_order_total_security.sql'
const ATTRIBUTION = 'supabase/migrations/20261005000000_order_linked_payment_total_counts_allocations.sql'
const SUITE = 'supabase/tests/payment_participant_security.sql'
const GRANTS = 'supabase/tests/participant_predicate_grants.sql'
const SCHEMA = 'supabase/tests/_production_shaped_schema.sql'
const RUNNER = 'supabase/tests/run_security_suite.sh'

const readText = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const fix = readText(FIX)
const attribution = readText(ATTRIBUTION)
const suite = readText(SUITE)
const grants = readText(GRANTS)
const schema = readText(SCHEMA)
const runner = readText(RUNNER)

/** One function's definition, isolated from the rest of the migration. */
function body(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  assert.ok(start > 0, `${name} must be defined`)
  const end = sql.indexOf(`comment on function public.${name}(`, start)
  assert.ok(end > start, `${name} must be commented`)
  return sql.slice(start, end)
}


/**
 * Every function's ACL must be set by explicit statements, never inherited.
 *
 * THREE REVOKES, NOT ONE. A hosted Supabase database gives every new function in
 * schema public four grants: PostgreSQL's built-in EXECUTE to PUBLIC, plus
 * DIRECT entries for anon, authenticated and service_role from the platform's
 * `alter default privileges`. `revoke ... from public, anon` clears the first
 * and one of the second and leaves service_role standing — which is exactly how
 * this migration was rejected on the linked database the second time.
 */
function assertDeterministicAcl(sig: string) {
  for (const role of ['public', 'anon', 'service_role']) {
    assert.ok(fix.includes(`revoke all on function public.${sig} from ${role};`),
      `${sig} must explicitly revoke ALL from ${role}`)
  }
  const grants = fix.match(
    new RegExp(`grant execute on function public\\.${sig.replace(/[()[\]]/g, '\\$&')} to ([^\n;]+)`, 'g')) ?? []
  assert.equal(grants.length, 1, `${sig} must carry exactly one grant`)
  assert.match(grants[0], /to authenticated$/)

  // Order matters: a revoke after the grant would undo it.
  const lastRevoke = Math.max(...['public', 'anon', 'service_role']
    .map(r => fix.indexOf(`revoke all on function public.${sig} from ${r};`)))
  const grantAt = fix.indexOf(`grant execute on function public.${sig} to authenticated;`)
  assert.ok(grantAt > lastRevoke, `${sig}: the grant must follow every revoke`)
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

  test('its ACL is set deterministically, not left to database defaults', () => {
    assertDeterministicAcl('can_view_order_as_actor(uuid)')
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

  test('its ACL is set deterministically, not left to database defaults', () => {
    assertDeterministicAcl('order_linked_payment_total(uuid)')
  })

  test('the browser caller is the reason authenticated keeps EXECUTE', () => {
    // src/app/orders/[id]/OrderAmendmentModals.tsx calls it through a session
    // client, so the role is `authenticated`. If that call ever disappears, the
    // grant should be revisited — so the test reads the real call site.
    const modal = readFileSync('src/app/orders/[id]/OrderAmendmentModals.tsx', 'utf8')
    assert.match(modal, /supabase\.rpc\('order_linked_payment_total'/)
    assert.ok(fix.includes('OrderAmendmentModals.tsx:351'))
  })

  test('and no service-role caller exists anywhere in the repository', () => {
    const hits = grepFiles(['src', 'scripts'], "rpc('order_linked_payment_total'")
    // One call site, and it is the browser modal. A server route using a
    // service-role client would appear here and would change the ACL decision.
    assert.deepEqual(hits, ['src/app/orders/[id]/OrderAmendmentModals.tsx'])
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

  test('20261006000000 writes the revokes, and writes them before the grant', () => {
    assertDeterministicAcl('can_read_payment_as_participant(uuid)')
  })

  test('the revokes follow the function body, because create or replace keeps an ACL', () => {
    // Replacing the function in §2 preserved the stray PUBLIC grant untouched.
    // That is why correcting the body was not enough.
    const body = fix.indexOf('create or replace function public.can_read_payment_as_participant(')
    const revoke = fix.indexOf(
      'revoke all on function public.can_read_payment_as_participant(uuid) from public;')
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
    const hits = grepLines(['src'], 'can_read_payment_as_participant')
      .filter(h => !/\.test\./.test(h.file))
      .filter(h => /\.rpc\(|rpc\(['"`]can_read_payment_as_participant/.test(h.line))
    assert.deepEqual(hits, [], 'a real RPC call would change the service_role analysis')
  })
})

describe('the apply-time ACL assertion is per function, and reads the real ACL', () => {
  test('EFFECTIVE privilege is asked for PUBLIC and anon', () => {
    // A PUBLIC entry makes anon effective without anon appearing in the ACL at
    // all, so both have to be asked this way as well as read out of proacl.
    assert.ok(fix.includes("raise exception 'PUBLIC must not hold EXECUTE on %', v_fn"))
    assert.ok(fix.includes("raise exception 'anon must not hold EXECUTE on %', v_fn"))
    assert.ok(fix.includes("'% must hold EXECUTE on %, and does not'"))
  })

  test('DIRECT grantees are read from proacl, which privilege checks cannot answer', () => {
    assert.ok(fix.includes('aclexplode(v_acl)'))
    assert.ok(fix.includes("when a.grantee = 0 then 'PUBLIC'"))
    assert.ok(fix.includes('if v_grantees is distinct from v_expected then'))
    assert.ok(fix.includes('expected exactly % beside the owner %'))
  })

  test('each function has its OWN expected list, not a shared one', () => {
    // Three separate case arms. They agree today; a change to one must not be
    // waved through because the other two still match.
    for (const fn of ['can_view_order_as_actor(uuid)',
                      'can_read_payment_as_participant(uuid)',
                      'order_linked_payment_total(uuid)']) {
      assert.ok(new RegExp(`when '${fn.replace(/[()]/g, '\\$&')}'\\s+then array\\['authenticated'\\]`).test(fix),
        `${fn} must have its own expected-grantee arm`)
    }
    assert.ok(fix.includes('every function must have its own'),
      'and an unspecified function must fail rather than default to something')
  })

  test('a NULL proacl is treated as the default privileges it represents', () => {
    assert.ok(fix.includes('carries default privileges, which include EXECUTE to PUBLIC'))
  })

  test('and the owner is required to keep EXECUTE', () => {
    // Every SECURITY DEFINER in this migration reaches its helpers as the owner.
    assert.ok(fix.includes("raise exception 'the owner % lost EXECUTE on %'"))
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

  test('it applies the platform default privileges, or nothing below is real', () => {
    // This single line is what the first two attempts at 20261006000000 were
    // missing: it is why a new function is born with a direct service_role grant.
    assert.match(schema,
      /alter default privileges in schema public\n\s*grant all on functions to postgres, anon, authenticated, service_role;/)
  })

  test('the pre-correction order_linked_payment_total keeps its real, narrower revoke', () => {
    // 20260816000000 wrote `from public, anon`, so under the platform defaults it
    // reaches 20261006000000 still holding a direct service_role grant — exactly
    // the state the linked database is in.
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


describe('the ACL regression reproduces the linked database before it proves the fix', () => {
  test('it asserts the harness gives a NEW function the linked database\'s privileges', () => {
    // If this stops matching, every grant assertion downstream is meaningless —
    // which is precisely what happened twice.
    assert.ok(grants.includes(
      "array['PUBLIC','anon','authenticated','service_role']"))
    assert.ok(grants.includes('HARNESS DOES NOT MATCH THE LINKED DATABASE'))
  })

  test('it reproduces remote failure 1 — inherited PUBLIC / anon', () => {
    assert.ok(grants.includes('REMOTE FAILURE 1 did not reproduce: PUBLIC does not hold EXECUTE'))
    assert.ok(grants.includes('REMOTE FAILURE 1 did not reproduce: anon cannot execute'))
  })

  test('it reproduces remote failure 2 — the direct service_role grant', () => {
    assert.ok(grants.includes('REMOTE FAILURE 2 did not reproduce'))
    assert.ok(grants.includes("array['authenticated','service_role']"),
      'the probe must end in the exact ACL the linked database rejected')
  })

  test('and shows the deterministic form fixing the same probe', () => {
    for (const role of ['public', 'anon', 'service_role']) {
      assert.ok(grants.includes(`revoke all on function public.t_acl_probe() from ${role};`))
    }
    assert.ok(grants.includes('the deterministic revoke form cost the owner its EXECUTE'),
      'and that the owner survives it')
  })

  test('it checks each function\'s own exact ACL after the migration', () => {
    assert.ok(grants.includes('AFTER  ACL FAILED: % is granted to %, expected exactly %'))
    for (const fn of ['can_view_order_as_actor(uuid)',
                      'can_read_payment_as_participant(uuid)',
                      'order_linked_payment_total(uuid)']) {
      assert.ok(grants.includes(`'${fn}'`), `${fn} must have its own ACL assertion`)
    }
  })

  test('it proves direct service-role execution is refused, function by function', () => {
    for (const fn of ['can_view_order_as_actor',
                      'can_read_payment_as_participant',
                      'order_linked_payment_total']) {
      assert.ok(grants.includes(`AFTER  service_role FAILED: executed ${fn}`),
        `${fn} must be probed as service_role`)
    }
    // And that service_role keeps what it actually needs.
    assert.ok(grants.includes('still reads the finance tables directly, bypassing RLS'))
  })
})

describe('the applied migrations are frozen', () => {
  /**
   * Every migration the linked database has run, and the SHA-256 of the exact
   * bytes it ran.
   *
   * Applied means immutable. A forward-only correction that edited one of these
   * would put the repository and the database permanently out of step, and
   * nothing would say so — `supabase db push` records that a version was
   * applied, not what it contained, so the migration history cannot tell you
   * afterwards whether the file still matches what ran. These hashes are the
   * only thing that can, and they protect the repository side going forward.
   * They are not evidence about the bytes already in the database.
   *
   * 106 was applied before this branch existed; 107 and 108 were applied on
   * 2026-08-23, and `supabase migration list --linked` shows Local and Remote
   * matching through 108.
   *
   * TO CORRECT A DATABASE AFTER THIS POINT: add migration 109 or later. Do not
   * edit a file below.
   */
  //
  // 20261009000000 is deliberately NOT in this list. It is not applied, so its
  // bytes are still the repository's to change; it joins this list on the day
  // `supabase db push` runs it and not before. A hash pinned for an unapplied
  // file would assert the wrong thing entirely — that the file may not be
  // corrected, which until it is applied is exactly what it may be.
  const FROZEN: ReadonlyArray<readonly [file: string, sha256: string]> = [
    // Allocation state on the received-payments projection (PR #49).
    ['supabase/migrations/20261004000000_finance_received_payments_allocation_state.sql',
     'b17c7f931424fe952135d42a5d20a4366225353c131ebeaed36bd5fd6067fd5d'],
    // Order-linked payment totals from allocations (PR #49).
    ['supabase/migrations/20261005000000_order_linked_payment_total_counts_allocations.sql',
     'c0f4a27e5f28aa32b00c690bb9a97b7aadbd820a8d3d4797c1f6947e6d994dcf'],
    // Retiring the Order Request workflow: four guards, two dropped permissive
    // write policies, ten revoked RPCs. Deletes nothing.
    ['supabase/migrations/20261007000000_retire_order_requests.sql',
     '0ff189e3ea7a0bcde8e1c98286e21c25ebca3e5846c7badd8117169b7e9ff373'],
    // The canonical payment classification, as columns on the existing
    // projection. Creates no table and stores nothing.
    ['supabase/migrations/20261008000000_finance_payment_classification.sql',
     'e2494ca54ae65fa4d155b3b9ff7e9eae27663fd455757c882a6d10d8c9aa2fbb'],
    // 115. APPLIED. `supabase db push` ran it and `supabase migration list
    // --linked` reports Local and Remote both at 20261015000000. It stops
    // run_task_health_check() from inserting notifications; the activity-log
    // writes it leaves behind are the whole point of the change.
    //
    // ITS HEADER STILL SAYS "NOT APPLIED". That line is stale and is left
    // alone on purpose — 20261007000000 and 20261008000000 carry the same
    // stale line for the same reason. Editing an applied migration is what
    // this list exists to prevent, and a comment-only edit is not exempt: the
    // hash below is a claim about the exact bytes the database ran, and it
    // stops being true the moment the file is touched for any reason. THIS
    // LIST, not the file header, is where applied status is recorded.
    ['supabase/migrations/20261015000000_task_health_check_stops_notifying.sql',
     'f05f7ffffb964ea2a6e0a70a214ca6001b6321a9767fc315c3001fbf22736349'],
    // 116. APPLIED. `supabase db push` ran it against the linked database and
    // the remote ledger reports it. Verified on the remote AFTER it ran, not
    // assumed from the file: notifications.activity_log_id is a nullable uuid;
    // its foreign key references task_activity_log(id) ON DELETE SET NULL; the
    // partial index is present; and transition_task_review() is still SECURITY
    // DEFINER, still pins search_path to public, pg_temp, is still owned by
    // postgres, still grants EXECUTE to postgres, authenticated and
    // service_role only, and now references activity_log_id and v_log_id.
    //
    // ITS HEADER STILL SAYS "NOT APPLIED", for exactly the reason spelled out
    // for 115 above: the hash below is a claim about the bytes the database
    // ran, and a comment-only edit would break it just as surely as a DDL one.
    // The file is not touched. This list is where applied status lives.
    ['supabase/migrations/20261016000000_notifications_link_activity_log.sql',
     '9d586c1e27cb00ad4ad3724a125d5f454e222ce8729efe7a0a6dafab29338fa8'],
    // Half-day company holidays. APPLIED: `supabase migration list` confirms
    // Local and Remote both carry 20261105000000. holiday_type/half_session
    // are added to payroll_holidays as nullable/defaulted columns, so every
    // existing row (including full-day holidays) is unaffected.
    ['supabase/migrations/20261105000000_holiday_half_day.sql',
     '0f2fe234b336b8f574ba5b148b2b2f2a907331544c6b8c33f8fb5c0b1d100265'],
  ]

  test('each applied migration still hashes to the bytes that were applied', () => {
    // Hashed from the file on disk, against a literal. No git object is
    // consulted: the previous form of this test read `git show 3d57fb2:<file>`,
    // and 3d57fb2 is a PRE-SQUASH commit that exists only while the merged
    // branch survives on the remote. In a clone that lacked it, `git show`
    // failed, the pipe carried nothing, and `sha256sum` of an empty stream
    // (e3b0c442…b7852b855) became the "expected" value — so the test failed for
    // a reason that had nothing to do with the migrations. A pinned literal
    // cannot rot that way.
    for (const [file, expected] of FROZEN) {
      // Text-normalized, not the raw disk bytes: `supabase db push` applies
      // the git-tracked (LF) content, but a Windows checkout with
      // core.autocrlf=true rewrites these files to CRLF on disk. Hashing the
      // raw bytes would make this test fail on every such checkout even
      // though nothing about the migration changed — exactly the false
      // positive this list exists to avoid.
      const actual = createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
      assert.equal(actual, expected,
        `${file} must not change: it is applied. Correct the database with a new migration instead.`)
    }
  })

  test('the two PR #49 migrations match the squash commit on main', () => {
    // Provenance for the first two literals, and a second opinion on them: main
    // is where those files live permanently, so this is the durable reference
    // the pre-squash commit never was. Skipped rather than failed where the
    // commit is not in the clone — a shallow checkout is not a defect in the
    // migrations, which the literals above have already checked.
    const SQUASH = '39825a2ed3dc1021523f578bbf60457220c0fc23'
    let reachable = true
    try {
      execSync(`git cat-file -e ${SQUASH}^{commit}`, { stdio: 'ignore' })
    } catch {
      reachable = false
    }
    if (!reachable) return

    for (const [file, expected] of FROZEN.slice(0, 2)) {
      const onMain = createHash('sha256')
        .update(execSync(`git show ${SQUASH}:${file}`, { maxBuffer: 32 * 1024 * 1024 }))
        .digest('hex')
      assert.equal(onMain, expected, `${file} on main disagrees with its pinned hash`)
    }
  })

  test('no migration has been added after 108 without being accounted for', () => {
    // The list is asserted EXACTLY rather than as a count, so adding a migration
    // is a decision somebody makes on purpose and has to record here.
    //
    // This says nothing about whether any of them is applied — 106, 107 and 108
    // all are, and a future 109 may be by the time it is read. What it protects
    // is that a new file cannot appear unnoticed beside four frozen ones.
    const later = execSync('ls supabase/migrations', { encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter(f => /^\d{14}_/.test(f) && f.slice(0, 14) > '20261005000000')
      .sort()
    assert.deepEqual(later, [
      '20261006000000_payment_participant_and_order_total_security.sql',
      '20261007000000_retire_order_requests.sql',
      '20261008000000_finance_payment_classification.sql',
      // 109. NOT APPLIED. Split payment entry, and a reservable Order number.
      // Recorded here on purpose: this list is asserted exactly, so a new
      // migration cannot appear unnoticed beside the frozen ones — and its
      // absence from FROZEN above is the statement that it has not been pushed.
      '20261009000000_split_payment_entry_and_order_submission_number_reservation.sql',
      // 110. NOT APPLIED either, and it must be pushed AFTER 109 — it carries
      // the higher number and depends on nothing in 109, but a file that lands
      // in front of a lower-numbered one leaves that one permanently out of
      // order behind the last applied remote migration. Both live on this
      // branch precisely so they cannot be shipped in the wrong order.
      '20261010000000_order_submission_and_finance_test_data_reset.sql',
      // 111. NOT APPLIED. Payment ID, admin-only payment deletion (extending
      // 110's durable claim protocol to Confirmed Payments), and the
      // multi-target allocation door. Recorded here for the same reason as
      // 109 and 110: this list is exact, so its arrival is a decision on
      // record rather than a file nobody noticed.
      '20261011000000_admin_payment_deletion_and_payment_id.sql',
      // 112. Removes the direct-link fallback from order_linked_payment_total()
      // and finance_received_payments, so active allocation rows are the only
      // financial source in the database as well as in the application, and
      // drops the four obsolete Link/Unlink RPCs. Recorded here for the same
      // reason as 109-111: the list is exact.
      '20261012000000_allocation_ledger_as_single_source.sql',
      // 113. NOT APPLIED. The payment-entry destination model: client_name
      // becomes nullable, a pending Payment Request records an allocation
      // INTENT rather than an allocation, approval converts it, and both entry
      // forms derive the customer server-side. Recorded here for the same
      // reason as the four above: this list is exact, so a new migration
      // cannot appear unnoticed.
      '20261013000000_payment_entry_destination_model.sql',
      // 114. NOT APPLIED. The destination a payment SHOWS (derived from the
      // allocation ledger and the pending intent, never from the provenance
      // columns), the four current payment modes with the five legacy values
      // kept storable for history, and the PNB/Paytm custody event log.
      // Recorded here for the same reason as the five above: this list is exact.
      '20261014000000_payment_destination_display_modes_and_custody.sql',
      // 115. APPLIED (see FROZEN above). run_task_health_check() stops writing
      // notifications nobody can act on: four `overdue`/`escalation` inserts
      // go, the 24h and 48h branches go with them (they had no other effect),
      // and the three activity-log writes, both CONTINUEs, the stale
      // calculation and every threshold are preserved byte for byte. Recorded
      // here for the same reason as 109-114: this list is exact, so a new
      // migration cannot appear unnoticed. Unlike them it IS pushed, which is
      // why it also appears in FROZEN and no longer in the pending list below.
      '20261015000000_task_health_check_stops_notifying.sql',
      // 116. APPLIED (see FROZEN above). notifications.activity_log_id — one
      // nullable FK to task_activity_log(id) ON DELETE SET NULL, plus a partial
      // index for the referential action, and transition_task_review() now
      // records the id. A notification can carry the id of the activity row
      // that caused it, so the feed can show a real comment preview and a real
      // previous status instead of matching timestamps. Additive: no backfill,
      // no trigger, no NOT NULL, no default, no change to task_activity_log,
      // no RLS change — so every pre-existing row still reads null and renders
      // its fallback. Recorded here for the same reason as 109-115: this list
      // is exact. Like 115 it IS pushed, which is why it also appears in
      // FROZEN and no longer in the pending list below.
      '20261016000000_notifications_link_activity_log.sql',
      // 117. NOT APPLIED. Customer Review Outreach: three new tables, a private
      // photo bucket, five SECURITY DEFINER functions and two permission-engine
      // actions (`use`, `verify`). It touches NOTHING that exists — no ALTER on
      // another module's table, no policy dropped, no function replaced outside
      // its own namespace.
      '20261017000000_customer_review_outreach.sql',
      // 118. NOT APPLIED. A task submitted for approval, completed or
      // cancelled loses its personal Top 3 Focus pin: the existing
      // cleanup_top_tasks_on_completion() gains 'pending_approval', and a
      // one-time delete clears the rows the trigger could never have reached
      // because it only fires on a future status change.
      //
      // BOTH are recorded here for the same reason as 109-116: this list is
      // exact, so a new migration cannot appear unnoticed beside the frozen
      // ones, and their absence from FROZEN is the statement that neither has
      // been pushed. 117 and 118 were authored on separate branches and are
      // numbered apart on purpose — two files sharing a version is the
      // migration-history collision this repository has already had to repair
      // once.
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      // 120. NOT APPLIED. Registers the Image Editor module and its two actions
      // in the permission engine. Like 117 and 118 it only adds, and like them
      // its absence from FROZEN is the statement that it has not been pushed.
      '20261020000000_register_image_editor_module.sql',
      '20261021000000_seed_customer_review_test_cards.sql',
      // 122. NOT APPLIED. The Image Editor's private per-user result history:
      // one private bucket, one table, five table policies and three storage
      // policies, all its own. Like 117, 118 and 120 it only adds, and like
      // them its absence from FROZEN is the statement that it has not been
      // pushed. It is numbered 122 because 121 was taken by the seed above —
      // the collision this list exists to catch, caught.
      '20261022000000_image_editor_result_history.sql',
      '20261023000000_review_workflow_ai_drafts.sql',
      // The batch-approval pair, in the order they must apply. The deletion
      // migration runs FIRST so the schema one lands on an empty card table
      // and can enforce its approval invariants without a legacy exemption.
      '20261025000000_review_workflow_remove_legacy_test_data.sql',
      '20261026000000_review_workflow_batch_approval.sql',
      // Provider-call idempotency: a request key is CLAIMED before the model
      // is called, so two simultaneous requests cannot both be billed for.
      '20261027000000_review_workflow_generation_claims.sql',
      // Assets & Access, from a separate branch: the delegated Access Register
      // permission and the asset handover acknowledgement. Neither touches
      // this work's tables, policies or functions.
      '20261028000000_assets_access_manage_access_records.sql',
      '20261029000000_asset_handover_acknowledgement.sql',
      // Verifier deletion, and the Add-versus-Replace choice at approval.
      '20261030000000_review_workflow_deletion_and_replacement.sql',
      // Twelve drafts a batch, editing a pending draft before approval, and up
      // to four review images. Touches only the Review Workflow's own tables.
      '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
      // BOE Credits Phase 1A: the append-only credit ledger, its derived balance
      // view, the settings table and the service-role posting functions. Two new
      // tables of its own; it touches nothing any other module creates.
      '20261101000000_boe_credits_foundation.sql',
      // BOE Credits Phase 1B: re-creates transition_customer_review_test_card() so a
      // verified review posts its review_reward in the same transaction. One
      // function, no table, no data.
      '20261102000000_boe_credits_review_reward.sql',
      // BOE Credits Phase 1C: the attendance redemption record table and the
      // service-role function that covers one attendance day with credits. One
      // new table of its own; it touches nothing any other module creates.
      '20261103000000_boe_credits_attendance_redemption.sql',
      // BOE Credits Phase 1D: configurable settings, monthly review qualification
      // and the payroll salary addition. Three new credits tables of its own; it
      // touches nothing any other module creates.
      '20261104000000_boe_credits_phase_1d.sql',
      // Half-day company holidays: adds holiday_type/half_session to
      // payroll_holidays. Touches nothing this list already accounts for.
      '20261105000000_holiday_half_day.sql',
    ])
  })

  test('109 to 114 and 118 are in ascending order, and none is pinned as applied', () => {
    // The whole reason the module reset lives on this branch rather than on
    // PR #50: unapplied migrations in one tree apply in filename order
    // whatever sequence the branches merge in.
    const frozenFiles = new Set(FROZEN.map(([file]) => file.split('/').pop()))
    const pending = execSync('ls supabase/migrations', { encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter(f => /^\d{14}_/.test(f) && f.slice(0, 14) > '20261008000000')
      .filter(f => !frozenFiles.has(f))
      .sort()
    assert.deepEqual(pending, [
      '20261009000000_split_payment_entry_and_order_submission_number_reservation.sql',
      '20261010000000_order_submission_and_finance_test_data_reset.sql',
      '20261011000000_admin_payment_deletion_and_payment_id.sql',
      '20261012000000_allocation_ledger_as_single_source.sql',
      '20261013000000_payment_entry_destination_model.sql',
      '20261014000000_payment_destination_display_modes_and_custody.sql',
      // 117 and 118 are pending like the six above them, and like them neither
      // is pinned as frozen. They are last in filename order, so whatever
      // sequence these branches merge in they still apply after every one of
      // them — which is what this assertion exists to protect.
      '20261017000000_customer_review_outreach.sql',
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      '20261020000000_register_image_editor_module.sql',
      '20261021000000_seed_customer_review_test_cards.sql',
      // 122 is pending too, and is now the last file in filename order, so it
      // applies after every one of them whatever sequence the branches merge in.
      '20261022000000_image_editor_result_history.sql',
      '20261023000000_review_workflow_ai_drafts.sql',
      // The batch-approval pair, in the order they must apply. The deletion
      // migration runs FIRST so the schema one lands on an empty card table
      // and can enforce its approval invariants without a legacy exemption.
      '20261025000000_review_workflow_remove_legacy_test_data.sql',
      '20261026000000_review_workflow_batch_approval.sql',
      // Provider-call idempotency: a request key is CLAIMED before the model
      // is called, so two simultaneous requests cannot both be billed for.
      '20261027000000_review_workflow_generation_claims.sql',
      // Assets & Access, from a separate branch: the delegated Access Register
      // permission and the asset handover acknowledgement. Neither touches
      // this work's tables, policies or functions.
      '20261028000000_assets_access_manage_access_records.sql',
      '20261029000000_asset_handover_acknowledgement.sql',
      // Verifier deletion, and the Add-versus-Replace choice at approval.
      '20261030000000_review_workflow_deletion_and_replacement.sql',
      // Twelve drafts a batch, editing a pending draft before approval, and up
      // to four review images. Touches only the Review Workflow's own tables.
      '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
      // BOE Credits Phase 1A: the append-only credit ledger, its derived balance
      // view, the settings table and the service-role posting functions. Two new
      // tables of its own; it touches nothing any other module creates.
      '20261101000000_boe_credits_foundation.sql',
      // BOE Credits Phase 1B: re-creates transition_customer_review_test_card() so a
      // verified review posts its review_reward in the same transaction. One
      // function, no table, no data.
      '20261102000000_boe_credits_review_reward.sql',
      // BOE Credits Phase 1C: the attendance redemption record table and the
      // service-role function that covers one attendance day with credits. One
      // new table of its own; it touches nothing any other module creates.
      '20261103000000_boe_credits_attendance_redemption.sql',
      // BOE Credits Phase 1D: configurable settings, monthly review qualification
      // and the payroll salary addition. Three new credits tables of its own; it
      // touches nothing any other module creates.
      '20261104000000_boe_credits_phase_1d.sql',
    ])
    // 115 and 116 are deliberately absent: both have been pushed, so they
    // belong in FROZEN and not here. 2026101500 and 2026101600 are therefore
    // NOT in the guard below.
    for (const [file] of FROZEN) {
      assert.ok(file.slice(-70).slice(0, 14) <= '20261008000000'
        || !/2026100900|2026101000|2026101100|2026101200|2026101300|2026101400/.test(file),
        `${file} is unapplied and must not be pinned as frozen`)
    }
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
