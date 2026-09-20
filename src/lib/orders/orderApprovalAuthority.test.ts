/**
 * 20261224000000 §4 — Order Approval is not implied by the admin role.
 *
 * THE DEFECT
 * ----------
 * Every decision door in Order Management asked
 * actor_has_module_permission('orders', 'approve_order'), and that helper is
 * `active admin OR the resolver` (20260901000000). The admin branch
 * short-circuits, so for anybody holding the admin role the permission was
 * decoration: the Control Centre could show it withdrawn, the resolver could
 * report false, and the database would still let them approve. The owner had
 * no way to take PI approval away from an administrator.
 *
 * THE CORRECTION, AND WHY IT NEEDS A CONTRACT TEST
 * ------------------------------------------------
 * §4 re-emits four applied functions — one of them nearly five hundred lines —
 * in order to change ONE expression in each. Restating a function that long is
 * how a business rule gets silently reverted, so this file re-extracts each
 * door from the migration that currently defines it, applies the one
 * documented substitution, and asserts the result is what §4 ships, CHARACTER
 * FOR CHARACTER. Anything else that moved fails here and says which door.
 *
 * This is the method src/lib/permissions/migrationContract.test.ts established
 * for 20260901000000, which re-authorized eleven functions the same way.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderApprovalAuthority.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migration = (f: string) => lf(readFileSync(join(MIGRATIONS, f), 'utf8'))

const FILE = '20261224000000_order_submission_approval_permanent_grant_and_auto_approval.sql'
const sql = migration(FILE)
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** The ONE expression that changes, and the one it changes to. */
const FROM = "  if not public.actor_has_module_permission('orders', 'approve_order') then"
const TO = '  if not public.actor_can_approve_order() then'

/**
 * The definition of `name` in `source` whose text contains `probe`, verbatim
 * from its header to its closing dollar tag. `probe` disambiguates overloads —
 * approve_order_submission has two, and only one of them is the conversion.
 */
function fnText(source: string, name: string, probe: string, where: string): string {
  const needle = `create or replace function public.${name}(`
  let from = 0
  for (;;) {
    const start = source.indexOf(needle, from)
    assert.ok(start >= 0, `public.${name} matching ${probe} is not defined in ${where}`)
    from = start + needle.length
    const tag = /\$[A-Za-z_]*\$/.exec(source.slice(start))
    if (!tag) continue
    const open = source.indexOf(tag[0], start)
    const close = source.indexOf(tag[0], open + tag[0].length)
    if (close < 0) continue
    const semi = source.indexOf(';', close + tag[0].length)
    const text = source.slice(start, semi + 1)
    if (text.includes(probe)) return text
  }
}

/** The four doors, and where each one was applied from. */
const DOORS = [
  {
    name: 'request_order_submission_changes',
    probe: 'p_note          text',
    applied: '20260908000000_order_pi_submissions.sql',
  },
  {
    name: 'reject_order_submission',
    probe: 'p_reason        text',
    applied: '20260910000000_order_submission_phase_a_review.sql',
  },
  {
    name: 'approve_pi_review',
    probe: 'p_submission_id uuid',
    applied: '20261119000000_order_submission_pi_review_gate_versions_and_production.sql',
  },
  {
    name: 'approve_order_submission',
    probe: 'p_lead_source',
    applied: '20261201000000_order_submission_confirmation_required_fields.sql',
  },
] as const

// ── 1. The contract: one expression, and nothing else ───────────────────────

describe('each re-emitted door differs from the applied one in exactly its authorization', () => {
  for (const door of DOORS) {
    test(`${door.name}: body preserved, authorization replaced`, () => {
      const before = fnText(migration(door.applied), door.name, door.probe, door.applied)
      const after = fnText(sql, door.name, door.probe, FILE)

      assert.equal(before.split(FROM).length - 1, 1,
        `${door.name} did not have exactly one admin-branching authorization line to replace`)
      assert.equal(after.split(TO).length - 1, 1,
        `${door.name} does not have exactly one permission-only authorization line`)

      assert.equal(before.replace(FROM, () => TO), after,
        `${door.name} differs from its applied definition somewhere other than the authorization line`)
    })
  }

  test('the substitution is the only difference in total, across all four', () => {
    // Belt and braces over the four individual comparisons: the combined
    // length may differ by exactly four substitutions and no more.
    let deltaExpected = 0
    let deltaActual = 0
    for (const door of DOORS) {
      const before = fnText(migration(door.applied), door.name, door.probe, door.applied)
      const after = fnText(sql, door.name, door.probe, FILE)
      deltaExpected += TO.length - FROM.length
      deltaActual += after.length - before.length
    }
    assert.equal(deltaActual, deltaExpected)
  })
})

// ── 2. The authority itself ─────────────────────────────────────────────────

describe('the permission-only authority', () => {
  const fn = sql.slice(
    sql.indexOf('create or replace function public.actor_can_approve_order'),
    sql.indexOf('comment on function public.actor_can_approve_order'))

  test('it resolves the permission and consults no role', () => {
    assert.ok(fn.includes("public.actor_has_permission('orders', 'approve_order')"))
    assert.ok(!fn.includes('actor_has_module_permission'),
      'the admin-branching helper is the thing this function exists to avoid')
    assert.ok(!/\brole\b/.test(fn), 'no role name appears in the authority at all')
    assert.ok(!/is_permanent_order_approver/.test(fn),
      'the owner is permanent through his unrevokable GRANT, not through a second branch here')
  })

  test('it is a definer function with a pinned search_path, and not reachable by anon', () => {
    assert.ok(fn.includes('security definer'))
    assert.ok(fn.includes('set search_path = public, pg_temp'))
    assert.ok(code.includes('revoke execute on function public.actor_can_approve_order() from public, anon;'))
    assert.ok(code.includes('grant  execute on function public.actor_can_approve_order() to authenticated;'))
  })

  test('actor_has_permission already refuses an inactive or deleted employee', () => {
    // Asserted against the migration that defines it, so this file does not
    // have to re-state the rule to depend on it.
    const helper = migration('20260901000000_finance_orders_permission_enforcement.sql')
    const body = helper.slice(helper.indexOf('create or replace function public.actor_has_permission'))
    assert.ok(body.includes('u.is_active'))
    assert.ok(body.includes('coalesce(u.is_deleted, false) = false'))
    assert.ok(body.includes('resolve_permission(auth.uid()'))
  })
})

// ── 3. The blast radius, stated as what must NOT have moved ─────────────────

describe('what the correction deliberately leaves alone', () => {
  test('every door that changed is an approval DECISION, and there are five', () => {
    // Four review doors re-emitted here, plus the submit door's auto-approval.
    assert.equal(code.split('if not public.actor_can_approve_order() then').length - 1, 4)
    assert.equal(code.split('v_can_approve := public.actor_can_approve_order();').length - 1, 1)
    // And no executable line in this file still asks the old helper about it.
    assert.equal(
      code.split("actor_has_module_permission('orders', 'approve_order')").length - 1, 0,
      'no approve_order check may still run through the admin-branching helper')
  })

  test('VISIBILITY is untouched — an administrator still sees every PI', () => {
    assert.ok(!code.includes('create or replace function public.can_view_order_submission'),
      'the visibility helper is not re-emitted')
    assert.ok(!code.includes('order_submissions_select'),
      'the select policy is not re-emitted')
    // The applied definition still carries the admin-branching helper, which
    // is what keeps an administrator able to READ a PI they cannot decide.
    const applied = migration('20260915000000_order_submission_final_approval.sql')
    assert.ok(applied.includes("public.actor_has_module_permission('orders', 'approve_order')"))
    // And the migration checks it at apply time rather than trusting this test.
    assert.ok(sql.includes('VISIBILITY: can_view_order_submission was changed'))
  })

  test('Order DOCUMENT generation is untouched', () => {
    assert.ok(!code.includes('request_order_document_generation'))
    assert.ok(!code.includes('order_document_versions'))
  })

  test('the other two protected Order actions keep their admin branch', () => {
    for (const other of ['approve_advance_exception', 'align_production']) {
      assert.ok(!code.includes(other), `${other} is not touched by this file`)
    }
  })

  test('no OTHER module and no other action is re-authorized', () => {
    // actor_has_module_permission itself is never redefined here, so every
    // other action in every other module keeps the admin branch it has today.
    assert.ok(!code.includes('create or replace function public.actor_has_module_permission'))
    assert.ok(!code.includes('create or replace function public.actor_has_permission'))
    assert.ok(!code.includes('create or replace function public.resolve_permission'))
  })

  test('the migration proves the bypass is gone against pg_proc, not against itself', () => {
    assert.ok(sql.includes('ADMIN BYPASS: % approval door(s) still resolve approve_order through the admin-branching helper'))
    assert.ok(sql.includes('ADMIN BYPASS: expected 5 doors on the permission-only authority, found %'))
    assert.ok(sql.includes('ADMIN BYPASS: actor_can_approve_order still consults the admin role'))
  })
})
