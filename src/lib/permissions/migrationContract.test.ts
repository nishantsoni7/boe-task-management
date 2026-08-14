/**
 * Migration contract — 20260901000000_finance_orders_permission_enforcement.sql
 *
 * The migration restates eleven existing SECURITY DEFINER functions in order to
 * change one authorization expression in each. Restating a 250-line function is
 * how a business rule gets silently reverted, so this suite proves the only
 * thing that changed is the authorization: it re-extracts each function from the
 * migration that currently defines it, applies the one documented substitution,
 * and asserts the result appears in the new migration verbatim.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/migrationContract.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const NEW_MIGRATION = '20260901000000_finance_orders_permission_enforcement.sql'

const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migrationText = lf(readFileSync(join(MIGRATIONS, NEW_MIGRATION), 'utf8'))
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') && f !== NEW_MIGRATION).sort()

/** The last definition of `fnName` in the migration history before ours. */
function latestDefinition(fnName: string): { text: string; file: string } {
  const needle = `create or replace function public.${fnName}(`
  let best: { text: string; file: string } | null = null
  for (const file of files) {
    const source = lf(readFileSync(join(MIGRATIONS, file), 'utf8'))
    const lower = source.toLowerCase()
    let from = 0
    for (;;) {
      const start = lower.indexOf(needle, from)
      if (start === -1) break
      from = start + needle.length
      const tag = /\$[A-Za-z_]*\$/.exec(source.slice(start))?.[0]
      if (!tag) continue
      const bodyOpen = source.indexOf(tag, start)
      const bodyClose = source.indexOf(tag, bodyOpen + tag.length)
      if (bodyClose === -1) continue
      const semi = source.indexOf(';', bodyClose + tag.length)
      if (semi === -1) continue
      best = { text: source.slice(start, semi + 1), file }
    }
  }
  assert.ok(best, `no prior definition found for ${fnName}`)
  return best
}

const ADMIN_GATE = (verb: string) => `  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception '${verb}'
      using errcode = '42501';
  end if;`

const PERMISSION_GATE = (module: string, action: string, verb: string) =>
  `  if not public.actor_has_module_permission('${module}', '${action}') then
    raise exception '${verb}'
      using errcode = '42501';
  end if;`

const ADMIN_FLAG = `  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  );`

const GUARD_EXEMPTION = `  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;`

type Contract = { fn: string; find: string; replace: string }

const CONTRACTS: Contract[] = [
  {
    fn: 'approve_finance_payment_request',
    find: ADMIN_GATE('Only an admin may approve a payment request'),
    replace: PERMISSION_GATE('finance', 'approve', 'Only an admin may approve a payment request'),
  },
  {
    fn: 'link_finance_payment_to_order',
    find: ADMIN_GATE('Only an admin may link a payment to an order'),
    replace: PERMISSION_GATE('finance', 'manage', 'Only an admin may link a payment to an order'),
  },
  {
    fn: 'unlink_finance_payment_from_order',
    find: ADMIN_GATE('Only an admin may unlink a payment from an order'),
    replace: PERMISSION_GATE('finance', 'manage', 'Only an admin may unlink a payment from an order'),
  },
  {
    fn: 'link_finance_payment_to_order_request',
    find: ADMIN_FLAG,
    replace: `  v_is_admin := public.actor_has_module_permission('finance', 'manage');`,
  },
  {
    fn: 'unlink_finance_payment_from_order_request',
    find: ADMIN_FLAG,
    replace: `  v_is_admin := public.actor_has_module_permission('finance', 'manage');`,
  },
  {
    fn: 'finance_payment_requests_guard_approved',
    find: GUARD_EXEMPTION,
    replace: `  if public.actor_has_module_permission('finance', 'manage') then
    return new;
  end if;`,
  },
  {
    fn: 'convert_order_request_to_order',
    find: ADMIN_GATE('Only an admin may convert an order request'),
    replace: PERMISSION_GATE('orders', 'approve', 'Only an admin may convert an order request'),
  },
  {
    fn: 'reject_order_request',
    find: ADMIN_GATE('Only an admin may reject an order request'),
    replace: PERMISSION_GATE('orders', 'approve', 'Only an admin may reject an order request'),
  },
  {
    fn: 'request_order_request_clarification',
    find: ADMIN_GATE('Only an admin may request clarification on an order request'),
    replace: PERMISSION_GATE('orders', 'approve', 'Only an admin may request clarification on an order request'),
  },
  {
    fn: 'admin_delete_order_request',
    find: ADMIN_GATE('Only an admin may delete an order request'),
    replace: PERMISSION_GATE('orders', 'delete', 'Only an admin may delete an order request'),
  },
]

describe('each restated function differs only in its authorization', () => {
  for (const contract of CONTRACTS) {
    test(`${contract.fn}: body preserved, authorization replaced`, () => {
      const prior = latestDefinition(contract.fn)

      assert.equal(
        prior.text.split(contract.find).length - 1,
        1,
        `${contract.fn}: expected exactly one authorization block in ${prior.file}`,
      )

      // Strip the explanatory comment lines the migration adds directly above
      // the new gate; they are documentation, not behaviour.
      const expected = prior.text.replace(contract.find, contract.replace)
      const withoutAddedComments = migrationText.replace(/^ *-- .*\n/gm, '')
      const expectedWithoutComments = expected.replace(/^ *-- .*\n/gm, '')

      assert.ok(
        withoutAddedComments.includes(expectedWithoutComments),
        `${contract.fn}: the restated body does not match ${prior.file} plus the documented substitution`,
      )
    })
  }
})

/**
 * The migration minus every verbatim-restated function body.
 *
 * The bodies are proved unchanged by the contract suite above, and they
 * legitimately contain things this migration must not ADD — admin_delete_order_request
 * runs `delete from`, and the order-request RPCs mention can_be_order_assignee.
 * Assertions about what the migration introduces must therefore look at what is
 * left once the copied code is removed.
 */
function migrationResidue(): string {
  let residue = migrationText
  for (const contract of CONTRACTS) {
    const prior = latestDefinition(contract.fn)
    const rewritten = prior.text.replace(contract.find, contract.replace)
    // The migration interleaves explanatory comments into the gate, so remove
    // the body by its span rather than by exact string match.
    const header = rewritten.slice(0, rewritten.indexOf('\n'))
    const start = residue.indexOf(header)
    if (start === -1) continue
    const tag = /\$[A-Za-z_]*\$/.exec(residue.slice(start))?.[0]
    if (!tag) continue
    const bodyOpen = residue.indexOf(tag, start)
    const bodyClose = residue.indexOf(tag, bodyOpen + tag.length)
    const semi = residue.indexOf(';', bodyClose + tag.length)
    residue = residue.slice(0, start) + residue.slice(semi + 1)
  }
  // assert_order_amender is handled by its own suite and is not in CONTRACTS.
  const amenderStart = residue.indexOf('create or replace function public.assert_order_amender()')
  if (amenderStart !== -1) {
    const end = residue.indexOf('$$;', amenderStart)
    residue = residue.slice(0, amenderStart) + residue.slice(end + 3)
  }
  return residue
}

describe('assert_order_amender keeps its stricter admin rule', () => {
  test('the is_active requirement on the admin branch survives', () => {
    assert.ok(
      migrationText.includes(
        "select 1 from public.users where id = v_uid and is_active and role = 'admin'",
      ),
      'the original admin+is_active rule must be preserved verbatim',
    )
  })

  test('it uses the permission-only helper, so an inactive admin is not admitted', () => {
    const start = migrationText.indexOf('create or replace function public.assert_order_amender()')
    // Comments are stripped: the block explains why the other helper is NOT
    // used, so it names it. Only executable SQL is asserted on.
    const body = migrationText
      .slice(start, migrationText.indexOf('$$;', start))
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')

    assert.ok(
      body.includes("public.actor_has_permission('orders', 'manage')"),
      'assert_order_amender must use actor_has_permission, not actor_has_module_permission',
    )
    assert.equal(
      body.includes('actor_has_module_permission'),
      false,
      'actor_has_module_permission would re-admit an inactive admin here',
    )
  })
})

describe('the helpers fail closed and never trust the client', () => {
  test('both resolve the actor from auth.uid(), not from an argument', () => {
    const start = migrationText.indexOf('create or replace function public.actor_has_permission(')
    const end = migrationText.indexOf('create or replace function public.approve_finance_payment_request(')
    const helpers = migrationText.slice(start, end)

    assert.ok(helpers.includes('auth.uid()'))
    assert.equal(
      /p_user_id|p_actor|p_caller/.test(helpers),
      false,
      'a caller-supplied actor id would let the client choose whose permissions apply',
    )
  })

  test('the permission branch requires an active, non-deleted employee', () => {
    const start = migrationText.indexOf('create or replace function public.actor_has_permission(')
    const body = migrationText.slice(start, start + 900)
    assert.ok(body.includes('u.is_active'))
    assert.ok(body.includes('coalesce(u.is_deleted, false) = false'))
  })

  test('a null resolver answer is coalesced to false', () => {
    assert.ok(migrationText.includes('coalesce(\n      public.resolve_permission(auth.uid(), p_module_key, p_action_key),\n      false\n    )'))
  })

  test('both helpers are SECURITY DEFINER with a pinned search_path', () => {
    const start = migrationText.indexOf('create or replace function public.actor_has_permission(')
    const end = migrationText.indexOf('-- ─── 2. Restated functions')
    const helpers = migrationText.slice(start, end)
    assert.equal((helpers.match(/security definer/g) ?? []).length, 2)
    assert.equal((helpers.match(/set search_path = public, pg_temp/g) ?? []).length, 2)
    assert.equal((helpers.match(/\bstable\b/g) ?? []).length, 2)
  })
})

describe('the added Finance policies cannot perform each others actions', () => {
  const policy = (name: string) => {
    const start = migrationText.indexOf(`create policy "${name}"`)
    assert.notEqual(start, -1, `policy ${name} is missing`)
    return migrationText.slice(start, migrationText.indexOf(';', start))
  }

  test('the approver policy acts only on pending rows and cannot write an approved status', () => {
    const text = policy('finance_payment_requests_approver_decide')
    assert.ok(text.includes("status = 'pending_approval'"))
    assert.ok(text.includes("public.actor_has_permission('finance', 'approve')"))
    assert.ok(text.includes("with check (\n    status in ('rejected', 'needs_clarification')\n  )"))
    assert.equal(text.includes('approved_linked'), false, 'approve must stay inside the RPC')
  })

  test('the correction policy acts only on approved rows', () => {
    const text = policy('finance_payment_requests_manager_correct')
    assert.ok(text.includes("status in ('approved_linked', 'approved_unlinked')"))
    assert.ok(text.includes("public.actor_has_permission('finance', 'manage')"))
    assert.equal(text.includes('pending_approval'), false)
  })

  test('the delete policy keeps the unapproved-only record-keeping rule', () => {
    const text = policy('finance_payment_requests_permitted_delete_unapproved')
    assert.ok(text.includes("status in ('pending_approval', 'needs_clarification', 'rejected')"))
    assert.ok(text.includes("public.actor_has_permission('finance', 'delete')"))
    assert.equal(text.includes('approved_'), false, 'an approved payment must never be deletable')
  })

  test('the new policies use the permission-only helper, so admins keep their own policies', () => {
    for (const name of [
      'finance_payment_requests_approver_decide',
      'finance_payment_requests_manager_correct',
      'finance_payment_requests_permitted_delete_unapproved',
    ]) {
      assert.equal(
        policy(name).includes('actor_has_module_permission'),
        false,
        `${name} should not re-state the admin branch`,
      )
    }
  })
})

describe('what the migration deliberately leaves alone', () => {
  test('no table, column, policy or permission row is dropped', () => {
    const statements = migrationResidue()
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')
      .toLowerCase()

    assert.equal(/drop table/.test(statements), false)
    assert.equal(/drop column/.test(statements), false)
    assert.equal(/drop function/.test(statements), false)
    assert.equal(/delete from/.test(statements), false)
    assert.equal(/truncate/.test(statements), false)
    // The only drops are the idempotent `drop policy if exists` guards that
    // immediately precede each new policy of the same name.
    const dropPolicies = statements.match(/drop policy if exists "([a-z_]+)"/g) ?? []
    assert.equal(dropPolicies.length, 3)
    for (const drop of dropPolicies) {
      const name = /"([a-z_]+)"/.exec(drop)![1]
      assert.ok(statements.includes(`create policy "${name}"`), `${name} is dropped but not recreated`)
    }
  })

  test('no permission row is written', () => {
    const statements = migrationText.toLowerCase()
    for (const table of [
      'employee_permission_overrides',
      'role_permissions',
      'department_permissions',
      'module_permission_actions',
    ]) {
      assert.equal(
        new RegExp(`insert into public\\.${table}|update public\\.${table}`).test(statements),
        false,
        `${table} must not be written by an enforcement migration`,
      )
    }
  })

  test('finance edit, create and view are not broadened', () => {
    for (const action of ["'edit'", "'create'", "'view'"]) {
      assert.equal(
        migrationText.includes(`actor_has_permission('finance', ${action})`),
        false,
        `finance ${action} must not be enforced in this migration`,
      )
      assert.equal(
        migrationText.includes(`actor_has_module_permission('finance', ${action})`),
        false,
      )
    }
  })

  test('orders edit, create and view are not broadened', () => {
    for (const action of ["'edit'", "'create'", "'view'"]) {
      assert.equal(migrationText.includes(`actor_has_permission('orders', ${action})`), false)
      assert.equal(migrationText.includes(`actor_has_module_permission('orders', ${action})`), false)
    }
  })

  test('can_be_order_assignee is never newly referenced — it stays where it already works', () => {
    // The restated bodies mention it because they always did; what matters is
    // that this migration adds no new check against it.
    assert.equal(migrationResidue().includes("actor_has_permission('orders', 'can_be_order_assignee')"), false)
    assert.equal(migrationResidue().includes("actor_has_module_permission('orders', 'can_be_order_assignee')"), false)
  })

  test('Attendance and Payroll are untouched', () => {
    assert.equal(/actor_has_(module_)?permission\('(attendance|payroll)'/.test(migrationText), false)
  })

  test('it sorts after every currently unapplied migration', () => {
    const unapplied = ['20260831000000', '20260832000000', '20260833000000', '20260834000000']
    for (const stamp of unapplied) {
      assert.ok(
        NEW_MIGRATION > stamp,
        `${NEW_MIGRATION} must sort after the unapplied ${stamp}`,
      )
    }
  })

  test('a rollback plan is documented in the file itself', () => {
    assert.ok(migrationText.includes('ROLLBACK PLAN'))
    assert.ok(migrationText.includes('drop policy if exists "finance_payment_requests_approver_decide"\n--     on public.finance_payment_requests;'))
  })
})
