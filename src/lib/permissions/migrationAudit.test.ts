/**
 * Independent audit assertions for 20260901000000 and 20260902000000.
 *
 * migrationContract.test.ts proves the restated FUNCTION BODIES are unchanged.
 * This file audits everything that is not a body: the helpers' identity model,
 * the policies' blast radius, the separation between the Finance decisions, and
 * the ordering relationship between the two migrations.
 *
 * Written against the SQL text so it holds without a database.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/migrationAudit.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const ENFORCEMENT = '20260901000000_finance_orders_permission_enforcement.sql'
const COMPATIBILITY = '20260902000000_access_control_v1_compatibility.sql'

const lf = (s: string) => s.replace(/\r\n/g, '\n')
const sql = lf(readFileSync(join(MIGRATIONS, ENFORCEMENT), 'utf8'))
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

function fnBody(name: string, source = code): string {
  const start = source.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is missing`)
  const tag = /\$[A-Za-z_]*\$/.exec(source.slice(start))![0]
  const open = source.indexOf(tag, start)
  const close = source.indexOf(tag, open + tag.length)
  return source.slice(start, close + tag.length)
}

function policyBody(name: string): string {
  const start = code.indexOf(`create policy "${name}"`)
  assert.notEqual(start, -1, `policy ${name} is missing`)
  return code.slice(start, code.indexOf(';', start))
}

// ── 8, 9: identity ───────────────────────────────────────────────────────────

describe('the helpers cannot be aimed at another user', () => {
  test('neither helper accepts a user id', () => {
    for (const name of ['actor_has_permission', 'actor_has_module_permission']) {
      const start = code.indexOf(`create or replace function public.${name}(`)
      const args = code.slice(start, code.indexOf(')', start))
      assert.equal(/uuid/.test(args), false, `${name} must not take a uuid argument`)
      assert.ok(/p_module_key text/.test(args) && /p_action_key text/.test(args))
    }
  })

  test('the acting identity is always auth.uid()', () => {
    const body = fnBody('actor_has_permission')
    assert.ok(body.includes('auth.uid()'))
    // resolve_permission takes a user id; it must be given auth.uid(), never
    // anything a caller supplied.
    assert.ok(body.includes('public.resolve_permission(auth.uid(), p_module_key, p_action_key)'))
  })

  test('a client-supplied permission value is never read anywhere', () => {
    assert.equal(/p_allowed|p_is_admin|p_role|p_permission/.test(code), false)
  })
})

// ── 10: fail closed ──────────────────────────────────────────────────────────

describe('inactive and deleted users fail closed', () => {
  test('the engine branch requires an active, non-deleted employee', () => {
    const body = fnBody('actor_has_permission')
    assert.ok(body.includes('u.is_active'))
    assert.ok(body.includes('coalesce(u.is_deleted, false) = false'))
  })

  test('a null resolver answer is coalesced to false', () => {
    assert.ok(fnBody('actor_has_permission').includes('coalesce('))
    assert.ok(fnBody('actor_has_permission').includes('false'))
  })

  test('an inactive or deleted ADMIN fails closed too', () => {
    // Corrected in Prompt 6. The checks this replaced tested only
    // role = 'admin', so mirroring them exactly would have let a deactivated or
    // soft-deleted admin keep Finance and Orders authority. Deactivating an
    // account does not end its Supabase session, so "they cannot log in" was
    // never a defence.
    const body = fnBody('actor_has_module_permission')
    assert.ok(body.includes("u.role = 'admin'"))
    assert.ok(body.includes('u.is_active'), 'the admin branch must require an active account')
    assert.ok(
      body.includes('coalesce(u.is_deleted, false) = false'),
      'the admin branch must exclude soft-deleted accounts',
    )
  })

  test('both branches apply the same active / not-deleted requirement', () => {
    const engine = fnBody('actor_has_permission')
    const combined = fnBody('actor_has_module_permission')
    for (const clause of ['u.is_active', 'coalesce(u.is_deleted, false) = false']) {
      assert.ok(engine.includes(clause), `engine branch missing: ${clause}`)
      assert.ok(combined.includes(clause), `admin branch missing: ${clause}`)
    }
  })

  test('assert_order_amender keeps its own admin rule rather than delegating', () => {
    // It already required is_active before this migration, and it is the one
    // admin check not routed through the helper.
    assert.ok(fnBody('assert_order_amender').includes("is_active and role = 'admin'"))
  })

  test('every deny case in the prompt is expressible from the SQL', () => {
    const engine = fnBody('actor_has_permission')
    const combined = fnBody('actor_has_module_permission')

    // null auth.uid()      -> the exists() subquery matches no row -> false.
    assert.ok(combined.includes('u.id = auth.uid()'))
    assert.ok(engine.includes('u.id = auth.uid()'))
    // missing user row     -> same exists() miss, both branches.
    // inactive member      -> engine branch requires u.is_active.
    // deleted member       -> engine branch requires not deleted.
    // inactive/deleted admin -> admin branch now requires both.
    // active admin         -> matches the admin branch, short-circuits true.
    assert.ok(combined.includes("u.role = 'admin'"))
    // Neither branch has an unguarded 'or true' style fallback.
    assert.equal(/or\s+true/.test(combined), false)
    assert.equal(/coalesce\([^)]*,\s*true\)/.test(engine), false, 'must never default to allow')
  })

  test('the resolver answer is coalesced to false, never to true', () => {
    const engine = fnBody('actor_has_permission')
    assert.ok(engine.includes('resolve_permission(auth.uid(), p_module_key, p_action_key)'))
    assert.ok(engine.includes('false'))
  })

  test('the rollback note warns that reverting re-widens the admin rule', () => {
    assert.ok(
      sql.includes('restores the older, looser rule'),
      'the rollback plan must say that step 2 restores role-only admin',
    )
  })
})

// ── 11: no recursive RLS ─────────────────────────────────────────────────────

describe('no recursive RLS dependency is introduced', () => {
  test('both helpers are SECURITY DEFINER, so reading users cannot re-enter a policy', () => {
    for (const name of ['actor_has_permission', 'actor_has_module_permission']) {
      const body = fnBody(name)
      assert.ok(body.includes('security definer'), `${name} must be SECURITY DEFINER`)
      assert.ok(body.includes('stable'), `${name} must be STABLE`)
      assert.ok(body.includes('set search_path = public, pg_temp'))
    }
  })

  test('no policy on finance_payment_requests reads finance_payment_requests', () => {
    for (const name of [
      'finance_payment_requests_approver_decide',
      'finance_payment_requests_manager_correct',
      'finance_payment_requests_permitted_delete_unapproved',
    ]) {
      assert.equal(
        policyBody(name).includes('from public.finance_payment_requests'),
        false,
        `${name} would recurse`,
      )
    }
  })
})

// ── 12: policy blast radius ──────────────────────────────────────────────────

describe('the approver may decide a pending request, not rewrite it', () => {
  // The audit finding this suite exists for: an RLS WITH CHECK sees only NEW,
  // so the policy alone cannot stop an approver editing the amount.
  const guard = fnBody('finance_payment_requests_guard_pending_decision')

  test('a trigger enforces column immutability, since a policy cannot', () => {
    assert.ok(code.includes('create trigger finance_payment_requests_guard_pending_decision'))
    assert.ok(code.includes('before update on public.finance_payment_requests'))
  })

  test('the money and identity columns are immutable for a non-submitter', () => {
    for (const column of [
      'client_name', 'amount', 'payment_date', 'payment_mode', 'received_in',
      'order_id', 'order_number', 'order_request_id', 'submitted_by',
      'approved_by', 'approved_at', 'created_at', 'request_number',
    ]) {
      assert.ok(
        guard.includes(`new.${column}`) && guard.includes(`old.${column}`),
        `${column} must be pinned by the pending-decision guard`,
      )
    }
  })

  test('the decision columns are NOT pinned, or the approver could do nothing', () => {
    assert.equal(guard.includes('new.status             is distinct from old.status'), false)
    assert.equal(/new\.admin_note\s+is distinct from old\.admin_note/.test(guard), false)
  })

  test('admins and the submitter are exempt, so nothing existing changes', () => {
    assert.ok(guard.includes("u.role = 'admin'"))
    assert.ok(guard.includes('old.submitted_by = v_actor'))
    assert.ok(guard.includes('if v_actor is null'), 'service-role paths must pass through')
  })

  test('it only engages on pending rows', () => {
    assert.ok(guard.includes("old.status is distinct from 'pending_approval'"))
  })
})

// ── 13, 14: separation of the Finance decisions ──────────────────────────────

describe('rejection, approval, correction and deletion stay separated', () => {
  test('the approver cannot write an approved status', () => {
    const p = policyBody('finance_payment_requests_approver_decide')
    assert.ok(p.includes("status = 'pending_approval'"))
    assert.ok(p.includes("with check (\n    status in ('rejected', 'needs_clarification')\n  )"))
    assert.equal(p.includes('approved_'), false)
  })

  test('approval itself remains inside the RPC', () => {
    assert.ok(fnBody('approve_finance_payment_request').includes("actor_has_module_permission('finance', 'approve')"))
  })

  test('the corrector only touches already-approved rows', () => {
    const p = policyBody('finance_payment_requests_manager_correct')
    assert.ok(p.includes("status in ('approved_linked', 'approved_unlinked')"))
    assert.equal(p.includes('pending_approval'), false)
  })

  test('an APPROVED payment can never be deleted through finance.delete', () => {
    const p = policyBody('finance_payment_requests_permitted_delete_unapproved')
    assert.ok(p.includes("status in ('pending_approval', 'needs_clarification', 'rejected')"))
    assert.equal(p.includes('approved_linked'), false)
    assert.equal(p.includes('approved_unlinked'), false)
  })

  test('the two update policies operate on disjoint status windows', () => {
    const approver = policyBody('finance_payment_requests_approver_decide')
    const corrector = policyBody('finance_payment_requests_manager_correct')
    assert.equal(approver.includes('approved_'), false)
    assert.equal(corrector.includes("'pending_approval'"), false)
  })

  test('the new policies never re-state the admin branch', () => {
    for (const name of [
      'finance_payment_requests_approver_decide',
      'finance_payment_requests_manager_correct',
      'finance_payment_requests_permitted_delete_unapproved',
    ]) {
      assert.equal(policyBody(name).includes('actor_has_module_permission'), false)
      assert.ok(policyBody(name).includes('actor_has_permission'))
    }
  })
})

// ── 15, 16 ───────────────────────────────────────────────────────────────────

describe('scope limits', () => {
  test('orders.manage never implies can_be_order_assignee', () => {
    assert.equal(code.includes("actor_has_permission('orders', 'can_be_order_assignee')"), false)
    assert.equal(code.includes("actor_has_module_permission('orders', 'can_be_order_assignee')"), false)
  })

  test('Attendance and Payroll are not referenced at all', () => {
    assert.equal(/actor_has_(module_)?permission\('(attendance|payroll)'/.test(code), false)
  })

  test('finance and orders view/create/edit are not broadened', () => {
    for (const moduleKey of ['finance', 'orders']) {
      for (const action of ['view', 'create', 'edit']) {
        assert.equal(code.includes(`actor_has_permission('${moduleKey}', '${action}')`), false)
        assert.equal(code.includes(`actor_has_module_permission('${moduleKey}', '${action}')`), false)
      }
    }
  })

  test('the migration writes no permission row', () => {
    for (const table of ['employee_permission_overrides', 'role_permissions', 'department_permissions']) {
      assert.equal(new RegExp(`insert into public\\.${table}`).test(code), false)
      assert.equal(new RegExp(`delete from public\\.${table}`).test(code), false)
    }
  })
})

// ── ordering ─────────────────────────────────────────────────────────────────

describe('the two migrations are ordered so enforcement cannot precede cleanup', () => {
  test('the compatibility migration exists and sorts immediately after enforcement', () => {
    assert.ok(existsSync(join(MIGRATIONS, COMPATIBILITY)), 'the cleanup migration must exist')
    const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const i = all.indexOf(ENFORCEMENT)
    assert.notEqual(i, -1)
    assert.equal(
      all[i + 1],
      COMPATIBILITY,
      'no migration may be introduced between enforcement and the cleanup it depends on',
    )
  })

  test('enforcement sorts after every previously unapplied migration', () => {
    for (const stamp of ['20260831000000', '20260832000000', '20260833000000', '20260834000000']) {
      assert.ok(ENFORCEMENT > stamp)
    }
  })
})
