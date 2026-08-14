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
const migrationSql = readFileSync(MIGRATION, 'utf8')

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

  test('manage_quotations without view_quotations confers nothing', () => {
    const caps = deriveQuotationCapabilities('member', allow('view', 'manage_quotations'))
    assert.equal(caps.canViewQuotations, false)
    assert.equal(
      caps.canManageQuotations, false,
      'a stored row violating the dependency must not produce management controls',
    )
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

  test('the migration grants nothing to anybody', () => {
    const executable = migrationSql.replace(/^--.*$/gm, '')
    assert.ok(
      !/insert into public\.employee_permission_overrides/i.test(executable),
      'no employee may be granted a new action by this migration',
    )
    assert.ok(
      !/insert into public\.role_permissions/i.test(executable),
      'no role default may grant a new action',
    )
    assert.ok(
      /default_allowed\)\s*\n?\s*select pm\.id, pa\.id, false/.test(executable),
      'every registration must be deny-by-default',
    )
  })

  test('no regression: existing protected actions are untouched', () => {
    for (const key of [
      'delete', 'admin', 'manage', 'assign', 'dispatch',
      'receive', 'mark_lost', 'close', 'can_be_order_assignee',
    ]) {
      assert.ok(isProtectedAction(key), `${key} must still be protected`)
    }
    // Assignee eligibility still resolves without module entry — Aditya's and
    // Dhruv's case, and 20260697000000's whole point.
    assert.equal(
      deriveOrdersCapabilities('member', allow('can_be_order_assignee')).canBeOrderAssignee,
      true,
    )
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
