/**
 * Enforcement claims — behavioural tests plus repository assertions.
 *
 * The Access Control screen tells an administrator whether a permission they
 * are about to save will do anything. MODULE_ENFORCEMENT is that claim, and a
 * claim about code rots the moment the code moves. So the second half of this
 * file reads the actual source: if somebody cuts Finance over to the engine, or
 * removes the last role check from Orders, the claim here fails until it is
 * updated.
 *
 * That is the failure this project already paid for once — see
 * supabase/migrations/20260723000000, which exists to undo ten grants that
 * looked real and decided nothing.
 *
 * Reads files only. No DB, no network.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/enforcement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODULE_ENFORCEMENT,
  moduleEnforcement,
  isActionEnforced,
  ENFORCEMENT_BADGE_LABEL,
} from './enforcement'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('the enforcement claims themselves', () => {
  test('an unknown module is prepared, never enforced', () => {
    assert.equal(moduleEnforcement('a_module_that_does_not_exist').state, 'prepared')
    assert.equal(isActionEnforced('a_module_that_does_not_exist', 'view'), false)
  })

  test('every partial module lists which actions are actually enforced', () => {
    for (const [moduleKey, enforcement] of Object.entries(MODULE_ENFORCEMENT)) {
      if (enforcement.state !== 'partial') continue
      assert.ok(
        (enforcement.enforcedActions?.length ?? 0) > 0,
        `${moduleKey} is partial but names no enforced action`,
      )
    }
  })

  test('only a fully enforced module is labelled "Active"', () => {
    assert.equal(ENFORCEMENT_BADGE_LABEL.enforced, 'Active')
    for (const state of ['partial', 'prepared', 'role_only'] as const) {
      assert.notEqual(ENFORCEMENT_BADGE_LABEL[state], 'Active')
    }
  })

  test('isActionEnforced is per-action on a partial module', () => {
    for (const action of ['view', 'view_all', 'approve_order', 'manage', 'delete']) {
      assert.equal(isActionEnforced('orders', action), true, `orders.${action} is enforced`)
    }
    // Edit stays on the ownership rules, and the module has no protected export
    // path. `approve` and `can_be_order_assignee` are not enforced because they
    // are not REGISTERED any more — the Order Request workflow they authorized
    // is retired (20261007000000), so claiming enforcement would be describing
    // an authority nobody can exercise.
    for (const action of ['edit', 'export', 'approve', 'can_be_order_assignee']) {
      assert.equal(isActionEnforced('orders', action), false, `orders.${action} is not enforced`)
    }
  })

  test('Finance enforces module entry plus the three protected actions', () => {
    // 'view' joined this list when src/app/finance/layout.tsx stopped reading
    // app_modules.visibility_type. Read it precisely: it is MODULE ENTRY, and
    // it says nothing about which payment records a person can then see —
    // that is still the ownership policies plus 'view_all'.
    for (const action of ['view', 'approve', 'manage', 'delete', 'view_all']) {
      assert.equal(isActionEnforced('finance', action), true, `finance.${action} is enforced`)
    }
    for (const action of ['create', 'edit', 'export']) {
      assert.equal(isActionEnforced('finance', action), false, `finance.${action} must stay ownership-based`)
    }
  })

  test('a fully enforced module enforces every action', () => {
    for (const action of ['view', 'create', 'edit', 'delete', 'manage', 'assign']) {
      assert.equal(isActionEnforced('assets_access', action), true)
    }
    for (const action of ['view', 'create', 'edit', 'delete', 'export', 'manage']) {
      assert.equal(isActionEnforced('meetings', action), true)
    }
  })

  test('Attendance and Payroll are reported as not used, not as prepared', () => {
    // "Prepared" implies a future where these grants start working. They will
    // not: management Attendance and Payroll are admin-only by decision.
    assert.equal(moduleEnforcement('attendance').state, 'role_only')
    assert.equal(moduleEnforcement('payroll').state, 'role_only')
    assert.equal(isActionEnforced('payroll', 'manage'), false)
    assert.equal(isActionEnforced('attendance', 'edit'), false)
  })
})

describe('the claims still match the code', () => {
  test('Finance is "partial" because its protected actions now resolve', () => {
    for (const path of ['src/app/finance/page.tsx', 'src/app/finance/received/ReceivedPaymentsView.tsx']) {
      assert.ok(
        read(path).includes('deriveFinanceCapabilities'),
        `${path} must derive Finance capabilities — otherwise MODULE_ENFORCEMENT.finance overstates coverage`,
      )
    }
    assert.equal(moduleEnforcement('finance').state, 'partial')
  })

  test('the migration that makes the Finance claim true exists', () => {
    // The screens resolve these capabilities already, so the claim is only
    // honest if the SQL half is in the repository and ships with it.
    const migration = read('supabase/migrations/20260901000000_finance_orders_permission_enforcement.sql')
    assert.ok(migration.includes("actor_has_module_permission('finance', 'approve')"))
    assert.ok(migration.includes("actor_has_module_permission('finance', 'manage')"))
    assert.ok(migration.includes("actor_has_permission('finance', 'delete')"))
  })

  test('Finance view, create and edit are still ownership-based, as claimed', () => {
    const source = read('src/app/finance/page.tsx')
    assert.ok(
      source.includes('return !isApproved(r.status) && (isAdmin || r.submitted_by === userId)'),
      'the ownership rule backs the "still follow record ownership" wording',
    )
    assert.equal(isActionEnforced('finance', 'edit'), false)
  })

  test('Orders is "partial" — entry, PI review, manage and delete resolve; edit does not', () => {
    const guard = read('src/app/orders/layout.tsx')
    assert.ok(
      guard.includes("hasPermission(supabase, session.user.id, 'orders', 'view')"),
      'the Orders guard no longer resolves view — update MODULE_ENFORCEMENT.orders',
    )

    // The PI Draft detail page is where the review decisions live now that Order
    // Request conversion is retired.
    const detail = read('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(detail.includes('canApproveOrderSubmission'), 'review must resolve orders.approve_order')

    // Deletion is still capability-driven, in the shared rule both the list and
    // the dialog read.
    const deletion = read('src/lib/orders/submissionDeletion.ts')
    assert.ok(deletion.includes('canDeleteSubmission'), 'delete must resolve through one rule')

    assert.equal(isActionEnforced('orders', 'edit'), false)
  })

  test('Meetings is "enforced" because its layout and capabilities both resolve', () => {
    const guard = read('src/app/meetings/layout.tsx')
    assert.ok(guard.includes('hasPermission'), 'the Meetings guard no longer resolves permissions')
    const caps = read('src/lib/permissions/meetings.ts')
    assert.ok(caps.includes('deriveMeetingsCapabilities'))
    assert.equal(moduleEnforcement('meetings').state, 'enforced')
  })

  test('Assets is "enforced" because the module gates on derived capabilities', () => {
    const caps = read('src/lib/permissions/assetsAccess.ts')
    assert.ok(caps.includes('deriveAssetsAccessCapabilities'))
    const hook = read('src/hooks/useAssetsAccess.ts')
    assert.ok(hook.includes('getEffectivePermissions'))
    assert.equal(moduleEnforcement('assets_access').state, 'enforced')
  })

  // THE ASSERTION THAT WAS MISSING.
  //
  // Orders, Finance, Meetings and Assets each had their claim checked against
  // real source above. Sample Tracking did not — and its claim ("the Sample
  // Tracking screen resolves 'view'") was false for as long as it existed:
  // /samples had no guard at all. An untested claim is how a screen came to
  // tell administrators that switching a module off did something.
  test("Sample Tracking's 'view' claim is backed by a real guard", () => {
    const layout = read('src/app/samples/layout.tsx')
    assert.ok(
      layout.includes('ModuleGuard') && layout.includes('moduleKey="sample_tracking"'),
      'MODULE_ENFORCEMENT.sample_tracking claims view is enforced — the route guard must exist',
    )
    assert.ok(isActionEnforced('sample_tracking', 'view'))
    assert.ok(isActionEnforced('sample_tracking', 'dispatch'))
    assert.equal(isActionEnforced('sample_tracking', 'create'), false)
  })

  test('the modules newly gated on entry claim exactly that and no more', () => {
    for (const moduleKey of ['showroom_qr', 'employee_records', 'performance']) {
      assert.equal(moduleEnforcement(moduleKey).state, 'partial', moduleKey)
      assert.deepEqual(moduleEnforcement(moduleKey).enforcedActions, ['view'], moduleKey)
      assert.equal(isActionEnforced(moduleKey, 'view'), true, moduleKey)
      assert.equal(isActionEnforced(moduleKey, 'manage'), false, moduleKey)
    }
  })

  test('the Access Control screen reads this file, not a local set', () => {
    const page = read('src/app/admin/control-center/permissions/page.tsx')
    assert.ok(
      page.includes("from '@/lib/permissions/enforcement'"),
      'the permissions page must not keep its own enforcement list',
    )
    assert.equal(
      page.includes('ENFORCED_MODULE_KEYS = new Set'),
      false,
      'the stale local ENFORCED_MODULE_KEYS set is back',
    )
  })
})
