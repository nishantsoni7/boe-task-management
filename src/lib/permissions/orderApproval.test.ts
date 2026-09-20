/**
 * Order Approval — the permanent owner grant, and the refusal that protects it.
 *
 * WHAT THIS PROVES, AND WHERE EACH HALF LIVES
 * -------------------------------------------
 * The rule has three statements and they must all say the same thing, because
 * an administrator who is told "no" by the screen and "yes" by the database has
 * been told nothing:
 *
 *   the screen    both Control Centre views render an admin's row read-only
 *   the route     PUT /api/control-center/permissions/employees/[id] refuses
 *   the database  a BEFORE trigger on employee_permission_overrides refuses
 *
 * A repository test cannot execute SQL, so — as every schema suite here does —
 * it reads the migration and proves the rule is stated, stated once, and stated
 * in a form that can be true.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/orderApproval.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORDERS_MODULE_KEY,
  ORDER_APPROVAL_ACTION_KEY,
  PERMANENT_ORDER_APPROVER_CODES,
  PERMANENT_ORDER_APPROVAL_REFUSAL,
  adminEditableActions,
  isAdminEditableAction,
  isPermanentOrderApprover,
  moduleHasAdminEditableActions,
  refusePermanentOrderApprovalRemoval,
  removesOrderApproval,
  targetsOrderApproval,
} from './orderApproval'
import { isProtectedAction, presetAllowedActions } from './levels'
import { deriveOrdersCapabilities } from './orders'
import type { EffectivePermission } from './types'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')

const FILE = '20261224000000_order_submission_approval_permanent_grant_and_auto_approval.sql'
const sql = lf(readFileSync(join(MIGRATIONS, FILE), 'utf8'))
/** Executable SQL only — a comment explains, it does not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const routeSource = lf(readFileSync(
  join(ROOT, 'src/app/api/control-center/permissions/employees/[id]/route.ts'), 'utf8'))

// ── The action is the one that already existed ───────────────────────────────

describe('no second permission system was created', () => {
  test('Order Approval is orders.approve_order, the action 20260908000000 registered', () => {
    assert.equal(ORDERS_MODULE_KEY, 'orders')
    assert.equal(ORDER_APPROVAL_ACTION_KEY, 'approve_order')

    const registering = lf(readFileSync(
      join(MIGRATIONS, '20260908000000_order_pi_submissions.sql'), 'utf8'))
    assert.ok(registering.includes("values ('approve_order', 'Approve Order Submissions', false)"),
      'the action is registered by the migration this one depends on, not by this one')
  })

  test('this migration registers no new action, module or role permission', () => {
    assert.ok(!/insert\s+into\s+public\.permission_actions/i.test(code),
      'no new action key')
    assert.ok(!/insert\s+into\s+public\.permission_modules/i.test(code),
      'no new module')
    assert.ok(!/insert\s+into\s+public\.role_permissions/i.test(code),
      'a role-wide grant would broaden this to everyone holding that role')
    assert.ok(!/insert\s+into\s+public\.department_permissions/i.test(code),
      'a department-wide grant would do the same')
  })

  test('it is a PROTECTED action, so no preset can hand it out', () => {
    assert.ok(isProtectedAction(ORDER_APPROVAL_ACTION_KEY))
    for (const level of ['no_access', 'viewer', 'contributor', 'manager'] as const) {
      const granted = presetAllowedActions(level, ['view', 'create', 'edit', ORDER_APPROVAL_ACTION_KEY])
      assert.equal(granted[ORDER_APPROVAL_ACTION_KEY], false, `${level} must not grant it`)
    }
  })

  test('holding it confers no module administration and no full access', () => {
    const only = (actions: string[]): EffectivePermission[] =>
      ['view', 'create', 'edit', 'delete', 'export', 'manage', 'view_all',
       'approve_order', 'approve_advance_exception', 'align_production']
        .map(actionKey => ({
          actionKey, allowed: actions.includes(actionKey), source: 'employee_override' as const,
        }))

    const caps = deriveOrdersCapabilities('member', only(['view', ORDER_APPROVAL_ACTION_KEY]))
    assert.equal(caps.canApproveOrderSubmission, true)
    // The whole point of requirement 4: this is a reviewer, not an administrator.
    assert.equal(caps.canManageOrders, false)
    assert.equal(caps.canDeleteOrder, false)
    assert.equal(caps.canViewAllOrders, false)
    assert.equal(caps.canCreateOrder, false)
    assert.equal(caps.canEditOrder, false)
    // And it does not reach the separately-assignable commercial decisions.
    assert.equal(caps.canApproveAdvanceException, false)
    assert.equal(caps.canAlignProduction, false)
  })
})

// ── The owner, resolved the same way in both languages ───────────────────────

describe('the permanent holder is one seeded account, named the same way twice', () => {
  test('TypeScript and SQL agree on which account it is', () => {
    assert.deepEqual([...PERMANENT_ORDER_APPROVER_CODES], ['TEST-001'])

    const fn = sql.slice(sql.indexOf('create or replace function public.is_permanent_order_approver'))
    for (const employeeCode of PERMANENT_ORDER_APPROVER_CODES) {
      assert.ok(fn.includes(`u.employee_code = '${employeeCode}'`),
        `${employeeCode} must be recognised by the SQL half too`)
    }
    // And the SQL recognises nobody the TypeScript does not.
    const codesInSql = [...fn.matchAll(/employee_code\s*=\s*'([^']+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(codesInSql)].sort(), [...PERMANENT_ORDER_APPROVER_CODES].sort())
  })

  test('resolved by employee_code — never by a hard-coded uuid, never by name', () => {
    // The statements that actually identify the person: the resolver, the seed
    // and the guard. `comment on` text is prose that happens to be executable
    // and is excluded — it is where the reasoning is written down, including
    // the words "full_name" and "uuid" themselves.
    const identifying = code
      .slice(0, code.indexOf('create or replace function public.submit_pi_for_review_internal'))
      .replace(/comment on [\s\S]*?';\n/g, '')

    assert.ok(identifying.includes("u.employee_code = 'TEST-001'"))
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(identifying),
      'no uuid literal identifies the account')
    assert.ok(!/full_name/i.test(identifying), 'full_name is neither unique nor stable')
    assert.ok(!/nishant/i.test(identifying), 'a person is resolved by code, not by their name')
  })

  test('the grant is seeded as an employee override and re-asserted, not skipped', () => {
    assert.ok(code.includes('insert into public.employee_permission_overrides'))
    assert.ok(code.includes('on conflict (user_id, module_id, action_id) do update'),
      'DO NOTHING would leave an existing deny in place and then protect it')
    assert.ok(/set\s+allowed\s*=\s*true/.test(code))
    assert.ok(/revoked_by\s*=\s*null/.test(code) && /revoked_at\s*=\s*null/.test(code))
    assert.ok(code.includes("where u.employee_code = 'TEST-001'"),
      'exactly one account is seeded')
  })
})

// ── The database refuses, and it refuses the service role too ────────────────

describe('the grant cannot be removed in the database', () => {
  const guard = sql.slice(
    sql.indexOf('create or replace function public.guard_permanent_order_approval_grant'),
    sql.indexOf('$guard$;') + '$guard$;'.length)

  test('a trigger, not a policy — because the writer holds the service role', () => {
    assert.ok(code.includes('create trigger employee_permission_overrides_guard_permanent_order_approval'))
    assert.ok(/before insert or update or delete on public\.employee_permission_overrides/.test(code))
    assert.ok(/for each row execute function public\.guard_permanent_order_approval_grant\(\)/.test(code))
    assert.ok(!/create policy/i.test(code),
      'RLS would not reach the service-role route that actually writes these rows')
  })

  test('all four ways of taking it away are refused', () => {
    assert.ok(guard.includes("if tg_op = 'DELETE' then"), 'deleted')
    assert.ok(guard.includes('if v_was_protected and not v_is_protected then'),
      're-pointed at another employee, module or action — a removal wearing an update')
    assert.ok(guard.includes('if new.allowed is not true then'), 'denied')
    assert.ok(guard.includes('if new.revoked_at is not null or new.revoked_by is not null then'),
      'soft-revoked, which is what "revert to inherited" writes')

    const refusals = [...guard.matchAll(/ORDER_APPROVAL_GRANT_PERMANENT/g)]
    assert.equal(refusals.length, 4, 'one sentence per shape, none of them silent')
    assert.equal([...guard.matchAll(/errcode = '42501'/g)].length, 4)
  })

  test('the row is judged BEFORE and AFTER, which is what catches the move', () => {
    // A UNIQUE key is not an immutable one. Reading only NEW would let an
    // UPDATE carry the protected row off to another action and call it a grant.
    assert.ok(guard.includes("if tg_op in ('UPDATE', 'DELETE') then"))
    assert.ok(guard.includes("if tg_op in ('INSERT', 'UPDATE') then"))
    assert.ok(guard.includes('old.user_id, old.module_id, old.action_id'))
    assert.ok(guard.includes('new.user_id, new.module_id, new.action_id'))
  })

  test('OLD is read only where OLD exists', () => {
    // A CASE spanning both records would touch OLD on an INSERT. Each read sits
    // inside a tg_op branch that guarantees the record is there.
    const oldReads = [...guard.matchAll(/\bold\./g)]
    assert.ok(oldReads.length > 0)
    const insertBranch = guard.slice(guard.indexOf("if tg_op in ('INSERT', 'UPDATE') then"),
                                     guard.indexOf('if not v_was_protected'))
    assert.equal(/\bold\./.test(insertBranch), false)
  })

  test('it is narrow: one action, one module, one account', () => {
    const triple = sql.slice(
      sql.indexOf('create or replace function public.is_permanent_order_approval_grant'),
      sql.indexOf('comment on function public.is_permanent_order_approval_grant'))
    assert.ok(triple.includes("pm.module_key = 'orders'"))
    assert.ok(triple.includes("pa.action_key = 'approve_order'"))
    assert.ok(triple.includes('public.is_permanent_order_approver(p_user_id)'))
    // Everything else on the table returns untouched, before any refusal.
    assert.ok(guard.includes('if not v_was_protected and not v_is_protected then'))
  })

  test('a re-grant is not an error', () => {
    // `allowed is not true` is false for a re-grant, so the row passes. Stated
    // as an assertion because the opposite (refusing any write at all) would
    // make the row impossible to re-seed.
    assert.ok(!guard.includes('if new.allowed is not false'),
      'the guard must refuse removal, not every write')
  })

  test('the guard is created AFTER the seed, so the seed cannot trip it', () => {
    assert.ok(code.indexOf('insert into public.employee_permission_overrides')
      < code.indexOf('create trigger employee_permission_overrides_guard_permanent_order_approval'))
  })

  test('the migration asserts its own effect rather than assuming it', () => {
    assert.ok(sql.includes('OWNER GRANT: the resolver does not report orders.approve_order for TEST-001'),
      'the row is only a means; the resolver is what the rest of the system reads')
    assert.ok(sql.includes("GUARD: denying the owner''s orders.approve_order was allowed"),
      'the refusal is exercised, not merely installed')
  })
})

// ── The route refuses, in words ──────────────────────────────────────────────

describe('the Control Centre route refuses the same change', () => {
  test('a removal is refused, whichever shape it arrives in', () => {
    const deny = { moduleKey: 'orders', actionKey: 'approve_order', allowed: false }
    const revert = { moduleKey: 'orders', actionKey: 'approve_order', allowed: null }
    const grant = { moduleKey: 'orders', actionKey: 'approve_order', allowed: true }

    assert.equal(removesOrderApproval(deny), true)
    assert.equal(removesOrderApproval(revert), true, 'revert-to-inherited soft-revokes the row')
    assert.equal(removesOrderApproval(grant), false, 're-granting is not removal')

    assert.equal(refusePermanentOrderApprovalRemoval('TEST-001', [deny]), PERMANENT_ORDER_APPROVAL_REFUSAL)
    assert.equal(refusePermanentOrderApprovalRemoval('TEST-001', [revert]), PERMANENT_ORDER_APPROVAL_REFUSAL)
    assert.equal(refusePermanentOrderApprovalRemoval('TEST-001', [grant]), null)
  })

  test('the refusal covers a removal hidden inside a larger batch', () => {
    const batch = [
      { moduleKey: 'finance', actionKey: 'view', allowed: true },
      { moduleKey: 'orders', actionKey: 'view', allowed: true },
      { moduleKey: 'orders', actionKey: 'approve_order', allowed: null },
    ]
    assert.equal(refusePermanentOrderApprovalRemoval('TEST-001', batch), PERMANENT_ORDER_APPROVAL_REFUSAL)
  })

  test('nobody else is protected — the permission stays grantable and revocable', () => {
    const deny = { moduleKey: 'orders', actionKey: 'approve_order', allowed: false }
    assert.equal(isPermanentOrderApprover('BOE-002'), false)
    assert.equal(refusePermanentOrderApprovalRemoval('BOE-002', [deny]), null,
      "Nitish's, or anyone else's, may be withdrawn — that is the point of it being a permission")
    assert.equal(refusePermanentOrderApprovalRemoval(null, [deny]), null)
    assert.equal(refusePermanentOrderApprovalRemoval(undefined, [deny]), null)
  })

  test('the owner keeps every OTHER permission editable', () => {
    const elsewhere = [
      { moduleKey: 'orders', actionKey: 'manage', allowed: false },
      { moduleKey: 'finance', actionKey: 'approve', allowed: null },
    ]
    assert.equal(refusePermanentOrderApprovalRemoval('TEST-001', elsewhere), null)
    assert.equal(elsewhere.some(targetsOrderApproval), false)
  })

  test('an administrator\'s row is editable for THIS action and nothing else', () => {
    // The lock exists because an override on an admin decides nothing. That
    // stopped being true for orders.approve_order the moment §4 gave it a
    // permission-only door, and for nothing else.
    assert.deepEqual([...adminEditableActions('orders')], ['approve_order'])
    assert.equal(isAdminEditableAction('orders', 'approve_order'), true)
    assert.equal(moduleHasAdminEditableActions('orders'), true)

    for (const [moduleKey, actionKey] of [
      ['orders', 'manage'], ['orders', 'view_all'], ['orders', 'approve_advance_exception'],
      ['orders', 'align_production'], ['finance', 'approve'], ['payroll', 'admin'],
      ['assets_access', 'assign'], ['task_management', 'delete'],
    ] as const) {
      assert.equal(isAdminEditableAction(moduleKey, actionKey), false,
        `${moduleKey}.${actionKey} is still decided by the admin role, so a control would be a lie`)
      if (moduleKey !== 'orders') assert.equal(moduleHasAdminEditableActions(moduleKey), false)
    }
  })

  test('the By Employee screen unlocks exactly that, and still locks module access', () => {
    const page = lf(readFileSync(
      join(ROOT, 'src/app/admin/control-center/permissions/page.tsx'), 'utf8'))

    // The save loop filters per action rather than refusing the whole employee.
    assert.ok(page.includes('if (admin && !isAdminEditableAction(mod.moduleKey, action.actionKey)) continue'),
      'a bypassed UI must still be unable to send an override that decides nothing')
    assert.ok(!page.includes('if (isSystemAdmin(tree)) return'),
      'the blanket early return is what made the grant impossible')

    // The module-access switch stays locked; only the dialog opens.
    assert.ok(page.includes('changeLocked={adminLocked && !moduleHasAdminEditableActions(mod.moduleKey)}'))
    assert.ok(page.includes('locked={adminLocked}'), 'the Visible/Hidden switch is still role-driven')

    // And inside the dialog an admin is offered those actions and no levels.
    assert.ok(page.includes('adminOnlyActions={adminLocked ? adminEditableActions(changeModalModule.moduleKey) : null}'))
    assert.ok(page.includes('adminOnlyActions === null && ('), 'the level grid is hidden for an admin')
    assert.ok(page.includes('adminOnlyActions === null || adminOnlyActions.includes(a.actionKey)'))
  })

  test('the By Module screen points at where the grant is actually made', () => {
    const page = lf(readFileSync(
      join(ROOT, 'src/app/admin/control-center/permissions/modules/page.tsx'), 'utf8'))
    // That screen only ever writes LEVELS, and a protected action is never in
    // a level, so it signposts rather than growing a second editor.
    assert.ok(page.includes('moduleHasAdminEditableActions(selectedKey)'))
    assert.ok(page.includes('except Order Approval — open to set it'))
    assert.ok(page.includes("if (!emp || emp.role === 'admin') return"),
      'and it still writes nothing for an admin row')
  })

  test('the PUT handler calls it, and refuses before it writes anything', () => {
    assert.ok(routeSource.includes('refusePermanentOrderApprovalRemoval'))
    assert.ok(routeSource.includes('targetsOrderApproval'),
      'the extra employee read is paid for only when the change is about this action')

    const check = routeSource.indexOf('refusePermanentOrderApprovalRemoval(target?.employee_code, changes)')
    const upsert = routeSource.indexOf(".from('employee_permission_overrides')")
    assert.ok(check > 0 && upsert > 0 && check < upsert,
      'a refused batch must not write part of itself first')
    assert.ok(routeSource.includes('{ status: 409 }'))
  })
})
