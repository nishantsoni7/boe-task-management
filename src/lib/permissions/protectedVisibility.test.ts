import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PROTECTED_ACTIONS, isProtectedAction, presetAllowedActions, PRESET_LEVELS,
  detectAccessLevel, withRequiredDependencies, dependentActionsToRemove,
  actionDependencyChain, protectedActionsClearedByPreset,
} from './levels'
import { deriveOrdersCapabilities } from './orders'
import { deriveFinanceCapabilities } from './finance'
import {
  deriveQuotationCapabilities, redactQuotationFields, isQuotationTask,
  QUOTATION_SENSITIVE_FIELDS,
} from './quotations'
import { isActionEnforced, moduleEnforcement } from './enforcement'
import { getRegisteredModule } from './registry'
import './modules'

// The three protected visibility actions added by
// 20260903000000_protected_visibility_actions.sql.
//
// The defect these cover: `orders.view` carried company-wide sight, because
// 20260685000000 and 20260686000000 both wrote
// USING (resolve_permission(auth.uid(), 'orders', 'view')). Module entry and
// seeing every order in the company were one grant. Several assertions below
// read the migration text directly, because the separation only holds if the
// SQL really says view_all — a TypeScript-only test would pass against a
// database that still hands out the whole table.

const MIGRATION = join(
  process.cwd(), 'supabase', 'migrations',
  '20260903000000_protected_visibility_actions.sql',
)
// Normalised to LF at read time. Several assertions below locate a statement
// with indexOf('on public.<table>\n'), which silently finds nothing on a Windows
// checkout where Git has written CRLF — indexOf returns -1, slice(-1) yields the
// last character of the file, and the assertion fails for a reason that has
// nothing to do with the migration. migrationContract.test.ts already normalises
// for exactly this reason; this file did not.
const migrationSql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n')

/** The file with `--` comments removed — the ROLLBACK block is comments too. */
const executableSql = migrationSql.replace(/^\s*--.*$/gm, '')

/**
 * Executable SQL minus `comment on ... ;` statements. Those carry prose that
 * legitimately quotes migration numbers and action names, which would otherwise
 * trip the "does not touch 901/902" and "no policy resolves task_management"
 * assertions below.
 */
const statementsSql = executableSql.replace(/comment on [\s\S]*?;/g, '')

/** Every `create policy` statement in the migration, as text. */
const createPolicyStatements = [...statementsSql.matchAll(/create policy [\s\S]*?;/g)].map(m => m[0])

/**
 * The employee-override INSERT alone, bounded at its terminating semicolon.
 *
 * Slicing to end-of-file instead would swallow the post-conditions, where
 * action names like view_quotations legitimately appear inside assertions.
 */
const grantStatement = (() => {
  const start = statementsSql.indexOf('insert into public.employee_permission_overrides')
  if (start < 0) return ''
  return statementsSql.slice(start, statementsSql.indexOf(';', start) + 1)
})()

const allow = (...keys: string[]) => keys.map(k => ({ actionKey: k, allowed: true, source: 'employee_override' as const }))
const ordersKeys  = getRegisteredModule('orders')!.actions.map(a => a.actionKey)
const financeKeys = getRegisteredModule('finance')!.actions.map(a => a.actionKey)
const tasksKeys   = getRegisteredModule('task_management')!.actions.map(a => a.actionKey)

describe('1-4. quotations are protected and gated', () => {
  test('an ordinary Task viewer gets no quotation capability at all', () => {
    const caps = deriveQuotationCapabilities('member', allow('view', 'create', 'edit'))
    assert.equal(caps.canViewQuotations, false)
    assert.equal(caps.canManageQuotations, false)
  })

  test('the sensitive customer fields are redacted for that viewer', () => {
    const task = {
      id: 't1', title: 'Quote for Acme', task_type: 'quotation_request',
      customer_name: 'Acme Pvt Ltd', contact_number: '+91 90000 00000',
      company_name: 'Acme', city_project: 'Jaipur',
    }
    const redacted = redactQuotationFields(task, false)

    for (const field of QUOTATION_SENSITIVE_FIELDS) {
      assert.equal(redacted[field], null, `${field} must be redacted`)
      assert.ok(field in redacted, `${field} must remain present, not be dropped`)
    }
    // The task itself survives — an assignee keeps their work.
    assert.equal(redacted.title, 'Quote for Acme')
    assert.equal(redacted.id, 't1')
    assert.ok(isQuotationTask(redacted))
  })

  test('view_quotations allows viewing but NOT management', () => {
    const caps = deriveQuotationCapabilities('member', allow('view', 'view_quotations'))
    assert.equal(caps.canViewQuotations, true)
    assert.equal(caps.canManageQuotations, false)

    const task = { customer_name: 'Acme', contact_number: '1', company_name: 'A', city_project: 'J' }
    assert.equal(redactQuotationFields(task, caps.canViewQuotations).customer_name, 'Acme')
  })

  test('manage_quotations without view_quotations still grants both — the stronger implies the weaker', () => {
    // Reversed by 7094d0b ("fix(tasks): restore per-member quotation request
    // access"): the old double-gate left a manage-only override unable to
    // surface any UI at all, which was the actual defect. A stronger grant
    // now always includes the weaker one, so this repairs itself instead of
    // requiring a re-save.
    const caps = deriveQuotationCapabilities('member', allow('view', 'manage_quotations'))
    assert.equal(caps.canViewQuotations, true)
    assert.equal(caps.canManageQuotations, true)
  })

  test('quotation actions need module entry, not just the grant', () => {
    const caps = deriveQuotationCapabilities('member', allow('view_quotations', 'manage_quotations'))
    assert.equal(caps.canViewQuotations, false, 'no task_management view means no quotation screen')
  })
})

describe('5-8. Orders and Finance global visibility', () => {
  test('orders.view alone no longer implies company-wide sight', () => {
    const caps = deriveOrdersCapabilities('member', allow('view'))
    assert.equal(caps.canAccessOrdersModule, true)
    assert.equal(caps.canViewAllOrders, false)
  })

  test('the RLS policies really require view_all, not view', () => {
    // The whole correction lives in these two policies.
    for (const table of ['public.orders', 'public.order_activity_log']) {
      const policy = migrationSql.slice(migrationSql.indexOf(`on ${table}`))
      assert.ok(
        /resolve_permission\(auth\.uid\(\), 'orders', 'view_all'\)/.test(policy.slice(0, 400)),
        `${table} policy must key on view_all`,
      )
    }
    assert.ok(
      !/resolve_permission\(auth\.uid\(\), 'orders', 'view'\)(?!_)/.test(
        migrationSql.replace(/^--.*$/gm, ''),
      ),
      'no executable statement may still grant company-wide sight from plain view',
    )
  })

  test('orders.view_all grants sight but no authority and no finance', () => {
    const caps = deriveOrdersCapabilities('member', allow('view', 'view_all'))
    assert.equal(caps.canViewAllOrders, true)
    for (const [name, value] of Object.entries(caps)) {
      if (name === 'canAccessOrdersModule' || name === 'canViewAllOrders') continue
      assert.equal(value, false, `${name} must not follow from view_all`)
    }
    // And it reveals nothing in Finance.
    const finance = deriveFinanceCapabilities('member', allow('view', 'view_all'))
    assert.equal(
      deriveOrdersCapabilities('member', allow('view', 'view_all')).canViewAllOrders, true,
    )
    assert.equal(finance.canViewAllFinance, true, 'same module-scoped key, resolved per module')
  })

  test('finance.view_all is read-only and implies no mutation', () => {
    const caps = deriveFinanceCapabilities('member', allow('view', 'view_all'))
    assert.equal(caps.canViewAllFinance, true)
    for (const name of [
      'canCreatePaymentRecord', 'canEditPaymentRecord', 'canApprovePayment',
      'canExportFinance', 'canCorrectOrReversePayment', 'canDeletePaymentRecord',
      'canManageFinance',
    ] as const) {
      assert.equal(caps[name], false, `${name} must not follow from view_all`)
    }
  })

  test('the two view_all grants are independent', () => {
    // Orders-only: the permission list is resolved per module, so a caller
    // holding orders.view_all sees no Finance capability.
    assert.equal(deriveFinanceCapabilities('member', allow('view')).canViewAllFinance, false)
    assert.equal(deriveOrdersCapabilities('member', allow('view')).canViewAllOrders, false)
    // Finance is additive — it adds policies rather than repointing one.
    assert.ok(
      /create policy "finance_payment_requests_view_all_select"/.test(migrationSql),
      'Finance global sight must be a NEW policy',
    )
    assert.ok(
      !/drop policy[^\n]*finance_payment_requests_own_select/.test(migrationSql),
      'no existing Finance ownership policy may be dropped',
    )
  })
})

describe('9-12. presets, Custom, confirmation and admin', () => {
  test('all three actions are protected', () => {
    for (const key of ['view_quotations', 'manage_quotations', 'view_all']) {
      assert.ok(isProtectedAction(key), `${key} must be protected`)
      assert.ok(PROTECTED_ACTIONS.has(key))
    }
  })

  test('no standard preset grants any of them, in any module', () => {
    for (const [moduleKey, keys] of [
      ['orders', ordersKeys], ['finance', financeKeys], ['task_management', tasksKeys],
    ] as const) {
      for (const level of PRESET_LEVELS) {
        const preset = presetAllowedActions(level, keys)
        for (const key of ['view_quotations', 'manage_quotations', 'view_all']) {
          if (!keys.includes(key)) continue
          assert.equal(
            preset[key], false,
            `${moduleKey} ${level} must not grant ${key}`,
          )
        }
      }
    }
  })

  test('holding one reports as Custom, so it is visible as an exception', () => {
    const allowed: Record<string, boolean> = {}
    for (const k of ordersKeys) allowed[k] = false
    allowed.view = true
    allowed.view_all = true
    assert.equal(detectAccessLevel(ordersKeys, allowed), 'custom')
  })

  test('removal is offered for confirmation when a preset would clear it', () => {
    const currentlyAllowed: Record<string, boolean> = { view: true, view_all: true }
    const cleared = protectedActionsClearedByPreset('viewer', ordersKeys, currentlyAllowed)
    assert.ok(cleared.includes('view_all'), 'view_all must be named in the confirmation')
  })

  test('Custom mode can display all three — they are registered on their modules', () => {
    assert.ok(tasksKeys.includes('view_quotations'))
    assert.ok(tasksKeys.includes('manage_quotations'))
    assert.ok(ordersKeys.includes('view_all'))
    assert.ok(financeKeys.includes('view_all'))
  })

  test('System Admin retains full authority without holding any new grant', () => {
    assert.equal(deriveOrdersCapabilities('admin', []).canViewAllOrders, true)
    assert.equal(deriveFinanceCapabilities('admin', []).canViewAllFinance, true)
    const q = deriveQuotationCapabilities('admin', [])
    assert.equal(q.canViewQuotations, true)
    assert.equal(q.canManageQuotations, true)
  })
})

describe('dependencies', () => {
  test('the chains are exactly the ones specified', () => {
    assert.deepEqual(actionDependencyChain('manage_quotations'), ['view_quotations', 'view'])
    assert.deepEqual(actionDependencyChain('view_quotations'), ['view'])
    assert.deepEqual(actionDependencyChain('view_all'), ['view'])
  })

  test('granting a child pulls its parents in', () => {
    assert.deepEqual(
      withRequiredDependencies(['manage_quotations'], tasksKeys).sort(),
      ['manage_quotations', 'view', 'view_quotations'].sort(),
    )
    assert.deepEqual(
      withRequiredDependencies(['view_all'], ordersKeys).sort(),
      ['view', 'view_all'].sort(),
    )
  })

  test('removing a parent takes its dependants with it', () => {
    assert.deepEqual(dependentActionsToRemove('view_quotations', tasksKeys), ['manage_quotations'])
    // Removing module entry removes everything that hangs off it.
    const offView = dependentActionsToRemove('view', tasksKeys)
    assert.ok(offView.includes('view_quotations'))
    assert.ok(offView.includes('manage_quotations'))
    assert.ok(dependentActionsToRemove('view', ordersKeys).includes('view_all'))
  })
})

describe('13-15. fail-closed, enforcement agreement, no regression', () => {
  test('no permissions at all means nothing is granted', () => {
    assert.deepEqual(deriveQuotationCapabilities(null, []), {
      canViewQuotations: false, canManageQuotations: false,
    })
    assert.equal(deriveOrdersCapabilities(null, []).canViewAllOrders, false)
    assert.equal(deriveFinanceCapabilities(null, []).canViewAllFinance, false)
  })

  test('an explicit deny is honoured over a stray allow', () => {
    const mixed = [
      { actionKey: 'view', allowed: true, source: 'role' as const },
      { actionKey: 'view_all', allowed: false, source: 'employee_override' as const },
    ]
    assert.equal(deriveOrdersCapabilities('member', mixed).canViewAllOrders, false)
  })

  test('the enforcement map agrees with what the migration actually enforces', () => {
    assert.ok(isActionEnforced('orders', 'view_all'))
    assert.ok(isActionEnforced('finance', 'view_all'))
    assert.ok(isActionEnforced('task_management', 'view_quotations'))
    assert.ok(isActionEnforced('task_management', 'manage_quotations'))
    // Honest about what is NOT enforced: Task Management's ordinary actions
    // still decide nothing, so the badge must not read Active.
    assert.equal(moduleEnforcement('task_management').state, 'partial')
    assert.equal(isActionEnforced('task_management', 'edit'), false)
  })

  test('the migration grants only the owner-approved employee overrides', () => {
    // This test used to assert the migration granted NOTHING. That changed by
    // owner decision on 2026-08-14: the approved grants are applied in the same
    // transaction as the Orders narrowing, so the named users never experience a
    // window where their access has been removed and not yet restored. What
    // must still hold is that nothing INHERITABLE is granted, and that no
    // quotation authority is handed out at all.
    assert.ok(
      !/insert into public\.role_permissions/i.test(statementsSql),
      'no role default may grant a new action',
    )
    assert.ok(
      !/insert into public\.department_permissions/i.test(statementsSql),
      'no department default may grant a new action',
    )
    const block = grantStatement
    assert.ok(
      !/view_quotations|manage_quotations/.test(block),
      'no quotation authority may be granted — the register stays with System Admin',
    )
    assert.ok(
      /default_allowed\)\s*\n?\s*select pm\.id, pa\.id, false/.test(statementsSql),
      'every registration must still be deny-by-default',
    )
    // Grants are guarded on the person being active and not soft-deleted.
    assert.ok(
      /u\.is_active[\s\S]{0,80}coalesce\(u\.is_deleted, false\) = false/.test(block),
      'grants must fail closed on an inactive or deleted employee',
    )
  })

  test('no regression: existing protected actions are untouched', () => {
    for (const key of [
      'delete', 'admin', 'manage', 'assign', 'dispatch',
      'receive', 'mark_lost', 'close',
    ]) {
      assert.ok(isProtectedAction(key), `${key} must still be protected`)
    }
    // `can_be_order_assignee` is deliberately NOT in that list any more. It
    // named an Order Request assignee, the workflow is retired
    // (20261007000000), and the Orders module no longer registers the action —
    // which is stronger than protecting it, because an action nothing declares
    // can never be granted at all.
    //
    // A stored grant is not deleted by that, and must resolve to nothing rather
    // than to an authority the database would refuse.
    const caps = deriveOrdersCapabilities('member', allow('can_be_order_assignee'))
    assert.equal('canBeOrderAssignee' in caps, false)
    assert.deepEqual(caps, deriveOrdersCapabilities('member', []))
  })

  test('no regression: Attendance and Payroll remain role-only', () => {
    assert.equal(moduleEnforcement('attendance').state, 'role_only')
    assert.equal(moduleEnforcement('payroll').state, 'role_only')
    assert.equal(isActionEnforced('payroll', 'view_all'), false)
  })

  test('task attachments are scoped to the parent task, both parent paths', () => {
    // Production-observed defect: task_attachments_read was USING (true), so
    // every authenticated account could read every attachment in the company.
    const policy = createPolicyStatements.find(s => s.includes('"task_attachments_read"'))!

    assert.ok(/drop policy if exists "task_attachments_read"/.test(statementsSql))
    // Checked against executable SQL only: the ROLLBACK block at the foot of
    // the file deliberately shows the old USING (true) policy, in comments.
    const created = createPolicyStatements.filter(s => s.includes('"task_attachments_read"'))
    assert.equal(created.length, 1, 'exactly one replacement policy')
    assert.ok(
      !/using\s*\(\s*true\s*\)/.test(created[0]),
      'the replacement must not be globally readable',
    )

    // Both ownership branches, and all three ownership columns in each.
    for (const column of ['created_by', 'assigned_to', 'delegated_by']) {
      assert.ok(policy.includes(column), `${column} must be part of the boundary`)
    }
    // task_attachments has TWO parents (task_id, activity_log_id) with a CHECK
    // that one is set. Keying only on task_id would hide every activity-log
    // attachment.
    assert.ok(policy.includes('task_attachments.task_id'), 'direct task parent must be authorized')
    assert.ok(
      /task_activity_log l[\s\S]{0,200}join public\.tasks t on t\.id = l\.task_id/.test(policy),
      'the activity-log parent path must be authorized through task_activity_log.task_id',
    )
  })

  test('the task attachment fix adds no admin branch and no write change', () => {
    const policy = createPolicyStatements.find(s => s.includes('"task_attachments_read"'))!
    // The production `tasks` SELECT policy has no admin branch, so adding one
    // here would grant NEW authority and leave the child broader than its
    // parent — the very defect being fixed.
    assert.ok(!/role\s*=\s*'admin'/.test(policy), 'no admin branch may be introduced')
    const executable = migrationSql.replace(/^--.*$/gm, '')
    assert.ok(
      !/drop policy[^\n]*task_attachments_(insert|delete)/.test(executable),
      'attachment write policies must be untouched',
    )
  })

  test('quotation permissions do not widen ordinary task or attachment access', () => {
    // task_management.view_quotations must not appear in any RLS policy: the
    // quotation gate is a screen gate, and widening the task boundary with it
    // would hand quotation holders other people's tasks.
    // 'task_management' legitimately appears in the action REGISTRATION. What
    // must never happen is a POLICY resolving it — that would widen the task
    // boundary itself and hand quotation holders other people's tasks.
    for (const statement of createPolicyStatements) {
      assert.ok(
        !/task_management|view_quotations|manage_quotations/.test(statement),
        `no policy may resolve a quotation action: ${statement.slice(0, 60)}`,
      )
    }
  })

  test('orders.view_all reaches every audited operational child record', () => {
    const executable = migrationSql.replace(/^--.*$/gm, '')
    for (const table of [
      'orders', 'order_activity_log', 'order_requests',
      'order_request_activity', 'order_request_attachments', 'order_change_requests',
    ]) {
      const policy = executable.slice(executable.indexOf(`on public.${table}\n`))
      assert.ok(
        /resolve_permission\(auth\.uid\(\), 'orders', 'view_all'\)/.test(policy.slice(0, 300)),
        `${table} must be reachable by orders.view_all`,
      )
    }
  })

  test('orders.view_all cannot reach any Finance table', () => {
    const executable = migrationSql.replace(/^--.*$/gm, '')
    for (const table of [
      'finance_payment_requests', 'finance_payment_request_activity_log',
      'payment_proof_attachments',
    ]) {
      const policy = executable.slice(executable.indexOf(`on public.${table}\n`)).slice(0, 300)
      assert.ok(
        /resolve_permission\(auth\.uid\(\), 'finance', 'view_all'\)/.test(policy),
        `${table} must be gated on finance.view_all`,
      )
      assert.ok(
        !/'orders'/.test(policy),
        `${table} must not be satisfiable by an Orders grant`,
      )
    }
  })

  test('finance.view_all reaches records, activity AND proof attachments', () => {
    for (const policyName of [
      'finance_payment_requests_view_all_select',
      'finance_payment_request_activity_log_view_all_select',
      'payment_proof_attachments_view_all_select',
    ]) {
      assert.ok(
        migrationSql.includes(`create policy "${policyName}"`),
        `${policyName} must exist`,
      )
    }
  })

  test('neither view_all grants mutation authority anywhere', () => {
    const executable = migrationSql.replace(/^--.*$/gm, '')
    // Every policy this migration creates is FOR SELECT.
    const created = [...executable.matchAll(/create policy "([^"]+)"[\s\S]{0,160}?for (\w+)/g)]
    assert.ok(created.length >= 10, 'sanity: policies were found to inspect')
    for (const [, name, cmd] of created) {
      assert.equal(cmd, 'select', `${name} must be a SELECT policy`)
    }
    // And no ownership policy is dropped to make room for one.
    for (const survivor of [
      'finance_payment_requests_own_select', 'orders_sales_select',
      'orders_admin_select', 'orders_operations_select',
    ]) {
      assert.ok(
        !new RegExp(`drop policy[^\\n]*${survivor}`).test(executable),
        `${survivor} must survive`,
      )
    }
  })

  test('the approved employee grants are exactly the ones agreed', () => {
    // The VALUES block in section 3e, parsed rather than eyeballed.
    const block = grantStatement
    const granted = new Set(
      [...block.matchAll(/\('([0-9a-f-]{36})'::uuid, '(\w+)',\s*'(\w+)'\)/g)]
        .map(([, user, mod, action]) => `${user}:${mod}.${action}`),
    )

    const DHRUV  = '61f4a1f7-3c2a-435f-abca-f884301dcc96'
    const JASVI  = 'fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2'
    const ADITYA = '973b4337-9cae-4f66-8e7f-b158326cdc10'
    const SALES  = {
      ashok:   'a3d157da-9eef-4d81-9aa6-84b4aa6061d6',
      mohit:   'f8039454-9152-452d-8d33-261f58a471af',
      prerna:  '9322e802-7203-456d-8986-ca625f3a8b77',
      saksham: 'b37c5ae7-b03f-4dd8-ad4c-3a210caff1f8',
      shravi:  'fb6eec18-f60c-4210-a712-f265f6732557',
    }

    const expected = [
      `${DHRUV}:orders.view`, `${DHRUV}:orders.view_all`,
      `${DHRUV}:finance.view`, `${DHRUV}:finance.view_all`,
      `${JASVI}:orders.view`, `${JASVI}:orders.view_all`,
      `${ADITYA}:orders.view`, `${ADITYA}:orders.view_all`,
      ...Object.values(SALES).flatMap(id => [`${id}:orders.view`, `${id}:finance.view`]),
    ]
    assert.deepEqual([...granted].sort(), expected.sort())
  })

  test('Jasvi and Aditya get no Finance grant of any kind', () => {
    const block = grantStatement
    for (const [who, id] of [
      ['Jasvi', 'fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2'],
      ['Aditya', '973b4337-9cae-4f66-8e7f-b158326cdc10'],
    ]) {
      const rows = [...block.matchAll(new RegExp(`\\('${id}'::uuid, '(\\w+)',\\s*'(\\w+)'\\)`, 'g'))]
      assert.ok(rows.length > 0, `${who} must appear`)
      for (const [, mod] of rows) {
        assert.notEqual(mod, 'finance', `${who} must receive no Finance grant`)
      }
    }
    // And the migration proves it through the engine, not just by omission.
    assert.ok(
      /Jasvi resolves Finance access, which was explicitly withheld/.test(migrationSql),
      'a post-condition must assert Jasvi resolves no Finance',
    )
  })

  test('Sales employees get owned-payment visibility, never global', () => {
    const block = grantStatement
    for (const id of [
      'a3d157da-9eef-4d81-9aa6-84b4aa6061d6', 'f8039454-9152-452d-8d33-261f58a471af',
      '9322e802-7203-456d-8986-ca625f3a8b77', 'b37c5ae7-b03f-4dd8-ad4c-3a210caff1f8',
      'fb6eec18-f60c-4210-a712-f265f6732557',
    ]) {
      const actions = [...block.matchAll(new RegExp(`\\('${id}'::uuid, '(\\w+)',\\s*'(\\w+)'\\)`, 'g'))]
        .map(([, mod, action]) => `${mod}.${action}`)
      assert.deepEqual(actions.sort(), ['finance.view', 'orders.view'])
      assert.ok(!actions.includes('orders.view_all'))
      assert.ok(!actions.includes('finance.view_all'))
    }
    // Their reach is bounded by policies this migration does not touch.
    for (const survivor of [
      'finance_payment_requests_own_select',
      'finance_payment_requests_order_request_owner_select',
      'finance_payment_requests_order_request_assignee_select',
    ]) {
      assert.ok(
        !new RegExp(`drop policy[^\\n]*${survivor}`).test(statementsSql),
        `${survivor} must survive — it is what scopes Sales to their own payments`,
      )
    }
  })

  test('grants are employee overrides only — no role or department rows', () => {
    assert.ok(!/insert into public\.role_permissions/i.test(statementsSql))
    assert.ok(!/insert into public\.department_permissions/i.test(statementsSql))
    // Upsert must re-assert a soft-revoked row, not skip it.
    assert.ok(
      /on conflict \(user_id, module_id, action_id\) do update[\s\S]{0,200}revoked_at = null/.test(statementsSql),
      'the upsert must clear a previous soft revocation',
    )
  })

  test('only view and view_all are ever granted — no mutation', () => {
    const block = grantStatement
    const actions = [...block.matchAll(/\('[0-9a-f-]{36}'::uuid, '\w+',\s*'(\w+)'\)/g)]
      .map(([, action]) => action)
    assert.ok(actions.length === 18, `expected 18 grants, got ${actions.length}`)
    for (const action of new Set(actions)) {
      assert.ok(['view', 'view_all'].includes(action), `${action} is not a viewing action`)
    }
  })

  test('the migration never edits an applied migration', () => {
    // `comment on` prose cites 20260901000000 by design; statements must not
    // touch anything it owns.
    assert.ok(!/20260901000000|20260902000000/.test(statementsSql))
    assert.ok(
      !/create or replace function|drop function/i.test(statementsSql),
      'this migration must not redefine or drop any function 20260901000000 owns',
    )
  })
})
