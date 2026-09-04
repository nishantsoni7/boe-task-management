/**
 * The security contract of payment_active_allocation_totals(uuid[]).
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT CANNOT DO
 * --------------------------------------------
 * The properties that actually matter here — who may call the function, which
 * rows it answers for, what it does when the caller sees only part of the
 * allocation table — are properties of roles and RLS, and no amount of reading
 * SQL text can establish them. They are proved by execution, in
 * supabase/tests/payment_active_allocation_totals_security.sql, which builds a
 * faithful miniature of the real policy structure and runs the shipped body
 * against it as three different users.
 *
 * What THIS file does is hold the shipped migration to the shape those proofs
 * depend on, so the contract cannot be edited away in a later change without a
 * test going red. Every assertion below corresponds to a numbered item of the
 * pre-application security review.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentTotalsRpcSecurity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const MIGRATION = 'supabase/migrations/20261005000000_order_linked_payment_total_counts_allocations.sql'
const HARNESS = 'supabase/tests/payment_active_allocation_totals_security.sql'

const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n')
const harness = readFileSync(HARNESS, 'utf8').replace(/\r\n/g, '\n')

/** The helper's own definition, isolated from the rest of the migration. */
const helper = migration.slice(
  migration.indexOf('create or replace function public.payment_active_allocation_totals'),
  migration.indexOf('comment on function public.payment_active_allocation_totals'),
)

describe('item 1 — a fixed, safe search_path', () => {
  test('the helper pins it, with pg_temp LAST', () => {
    assert.match(helper, /set search_path = public, pg_temp/)
    // pg_temp last is the documented defence: a caller who can create temporary
    // objects must not be able to have one resolved ahead of a real table.
    const path = /set search_path = ([^\n]+)/.exec(helper)?.[1] ?? ''
    assert.ok(path.trim().endsWith('pg_temp'), `pg_temp must be last, got "${path}"`)
  })

  test('and the migration refuses to apply if that is ever removed', () => {
    assert.ok(migration.includes('payment_active_allocation_totals must pin its search_path'))
  })
})

describe('item 2 — everything it touches is schema-qualified', () => {
  test('both tables and both called functions carry an explicit schema', () => {
    assert.ok(helper.includes('from public.finance_payment_requests f'))
    assert.ok(helper.includes('from public.finance_payment_allocations a'))
    assert.ok(helper.includes('public.actor_has_module_permission('))
  })

  test('no bare reference to either finance table survives', () => {
    // `public.` immediately before the name, every time it is read.
    for (const table of ['finance_payment_requests', 'finance_payment_allocations']) {
      const bare = new RegExp(`(?<!public\\.)\\b${table}\\b`, 'g')
      const body = helper.split('$$')[1] ?? ''
      assert.equal(body.match(bare), null,
        `${table} is referenced without its schema, which a search_path could redirect`)
    }
  })
})

describe('items 3 and 4 — EXECUTE is revoked from PUBLIC and anon, granted only to authenticated', () => {
  test('the revoke names both, and precedes the grant', () => {
    const revoke = migration.indexOf(
      'revoke execute on function public.payment_active_allocation_totals(uuid[]) from public, anon;')
    const grant = migration.indexOf(
      'grant  execute on function public.payment_active_allocation_totals(uuid[]) to authenticated;')
    assert.ok(revoke > 0, 'EXECUTE must be revoked from PUBLIC and anon')
    assert.ok(grant > revoke, 'the grant must follow the revoke, or it is undone')
  })

  test('no other role is granted EXECUTE', () => {
    const grants = migration.match(
      /grant\s+execute on function public\.payment_active_allocation_totals\(uuid\[\]\) to ([^\n;]+)/g) ?? []
    assert.equal(grants.length, 1, 'exactly one grant')
    assert.match(grants[0], /to authenticated$/)
  })

  test('and all three are re-checked at apply time, against the live catalog', () => {
    assert.ok(migration.includes("anon must not hold EXECUTE on payment_active_allocation_totals"))
    assert.ok(migration.includes("PUBLIC must not hold EXECUTE on payment_active_allocation_totals"))
    assert.ok(migration.includes("authenticated must hold EXECUTE on payment_active_allocation_totals"))
  })
})

describe('items 5, 6 and 7 — authorization is per id, and it is RLS', () => {
  test('the row source is the payment table, so its policies filter every id', () => {
    // This is the whole gate. Every supplied uuid becomes a row of
    // finance_payment_requests or it becomes nothing, and that table's six
    // permissive SELECT policies plus its RESTRICTIVE module gate decide which.
    assert.match(helper, /from public\.finance_payment_requests f/)
    assert.match(helper, /where f\.id = any\(coalesce\(p_payment_ids/)
  })

  test('SECURITY INVOKER — the read rule is asked, never restated', () => {
    assert.match(helper, /security invoker/)
    assert.ok(!/security definer/i.test(helper),
      'a definer would evaluate that RLS for the OWNER and answer for every payment')
  })

  test('it does not gate on can_read_payment_as_participant', () => {
    // Two independent reasons, both proved in the harness: the predicate is one
    // of six read paths (and false for EVERY caller when a payment has no
    // allocations at all), and its Order branch is a bare EXISTS on public.orders
    // that degenerates to "the Order exists" inside any definer.
    assert.ok(!helper.includes('can_read_payment_as_participant'))
    assert.ok(migration.includes(
      'must not gate on can_read_payment_as_participant'),
      'and the migration refuses to apply if someone reinstates it')
  })

  test('the apply-time assertion refuses a definer outright', () => {
    assert.ok(migration.includes(
      'payment_active_allocation_totals must be SECURITY INVOKER'))
  })
})

describe('items 8 and 9 — arrays cannot be abused', () => {
  test('a NULL array is coalesced to empty, so it matches nothing', () => {
    assert.match(helper, /any\(coalesce\(p_payment_ids, '\{\}'::uuid\[\]\)\)/)
  })

  test('duplicates cannot duplicate a total: the array is a filter, not a row source', () => {
    // `= any(array)` filters one scan of the payment table, so N copies of an id
    // yield ONE row. Unnesting the array instead would have yielded N.
    assert.ok(!/unnest\s*\(\s*p_payment_ids/i.test(helper),
      'unnesting the input would emit one row per duplicate and inflate the total')
    assert.match(helper, /f\.id = any\(/)
  })

  test('the allocation sum is a correlated subquery per payment, not a join that could fan out', () => {
    assert.match(helper, /left join lateral \(\s*select sum\(a\.allocated_amount\)/)
    assert.match(helper, /where a\.payment_request_id = f\.id/)
  })

  test('and the harness exercises null, empty, duplicate and 10,000-element arrays', () => {
    assert.ok(harness.includes('ITEM 8 FAILED: a NULL array returned'))
    assert.ok(harness.includes('ITEM 8 FAILED: an empty array returned'))
    assert.ok(harness.includes('ITEM 8 FAILED: duplicated ids inflated the total'))
    assert.ok(harness.includes('ITEM 9 FAILED: a 10,000-id array leaked'))
  })
})

describe('item 10 — shadowing and a caller-controlled search_path', () => {
  test('the function pins its own path, so the caller\'s cannot reach it', () => {
    assert.match(helper, /set search_path = public, pg_temp/)
  })

  test('every object it names is qualified, so nothing in the path can substitute for one', () => {
    assert.ok(helper.includes('public.finance_payment_requests'))
    assert.ok(helper.includes('public.finance_payment_allocations'))
    assert.ok(helper.includes('public.actor_has_module_permission'))
  })

  test('the operators and aggregates it uses resolve from pg_catalog, which is searched first', () => {
    // sum(), coalesce() and the comparison operators are never qualified in this
    // codebase and do not need to be: pg_catalog is implicitly searched ahead of
    // anything named in search_path, so a public.sum() cannot capture them.
    assert.ok(helper.includes('sum(a.allocated_amount)'))
    assert.ok(helper.includes('coalesce('))
  })
})

describe('item 11 — SECURITY DEFINER is NOT necessary, and would be harmful', () => {
  test('the completeness test is auth.uid()-based, so it is sound in any context', () => {
    // Unlike RLS, actor_has_module_permission() reads the caller's identity from
    // the JWT, not from current_user, so it means the same thing wherever it is
    // called. That is what lets the function stay an invoker.
    assert.match(helper, /public\.actor_has_module_permission\('finance', 'view_all'\)/)
    assert.match(helper, /f\.submitted_by = auth\.uid\(\)/)
  })

  test('an unknowable total is NULL, never 0', () => {
    // 0 would fire the direct-link fallback in paymentAttribution.ts and restore
    // the very over-attribution this migration exists to remove. NULL makes the
    // rule withhold the fallback, which under-states instead.
    assert.match(helper, /else null::numeric/)
    assert.ok(migration.includes(
      'must return NULL, not 0, when the caller cannot see the whole allocation set'))
  })

  test('a partial but non-zero total is still returned, because it settles the rule', () => {
    assert.match(helper, /when coalesce\(v\.visible_total, 0\) > 0\s*\n\s*then v\.visible_total/)
  })

  test('the migration explains why a definer cannot be gated soundly here', () => {
    assert.ok(migration.includes('A DEFINER CANNOT ASK RLS'))
    assert.ok(migration.includes('degenerates to `the Order exists` when nested inside one'))
  })

  test('and the harness runs the definer variant as a counterfactual', () => {
    assert.ok(harness.includes('t_definer_variant'))
    assert.ok(harness.includes('the SECURITY DEFINER draft returned NO ROW for example A'))
  })
})

describe('item 12 — ownership and grants match the established protected-RPC pattern', () => {
  test('create or replace, so ownership is whoever owns the migration — never reassigned', () => {
    // The repository never writes `alter function ... owner to`; every function
    // is owned by the migration role. Reassigning one here would make this
    // function the exception, and an owner change is what turns an invoker into
    // an accidental privilege escalation the day someone flips it to a definer.
    assert.ok(helper.includes('create or replace function'))
    assert.ok(!/alter function public\.payment_active_allocation_totals[^\n]*owner to/i.test(migration))
  })

  test('revoke-then-grant, the same two lines every other protected RPC uses', () => {
    const pattern =
      /revoke execute on function public\.\w+\([^)]*\) from public, anon;\ngrant  execute on function public\.\w+\([^)]*\) to authenticated;/g
    const blocks = migration.match(pattern) ?? []
    assert.equal(blocks.length, 2,
      'both functions in this migration must carry the pattern verbatim')
  })
})

describe('the harness itself stays honest', () => {
  test('it leaves nothing behind', () => {
    assert.ok(harness.trimEnd().endsWith('rollback;'))
  })

  test('it asserts an EQUIVALENCE, not a hand-listed expectation per user', () => {
    // "answered ids === readable ids" stays true however the payment policies
    // change, which is the same reason the function asks RLS rather than
    // restating it. A hand-listed expectation would silently stop testing the
    // real property the first time a policy moved.
    assert.ok(harness.includes('the function answered for % id(s) the caller cannot read'))
    assert.ok(harness.includes('the function withheld % id(s) the caller CAN read'))
  })

  test('it proves the exclusion is real, so the equivalence is not vacuous', () => {
    assert.ok(harness.includes('exclusion is real'))
  })

  test('it isolates the definer mechanism behind exposure 1', () => {
    // Corrected by 20261006000000 §2 and proved against real roles in
    // payment_participant_security.sql; kept here because it reduces the
    // mechanism to four lines.
    assert.ok(harness.includes('MECHANISM reproduced'))
    assert.ok(harness.includes('corrected by 20261006000000'))
  })
})
