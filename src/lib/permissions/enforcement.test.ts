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
import { readScreenSource } from '@/lib/testing/readScreenSource'

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
    // Corrected 2026-10-29 against the migrations and source (see the entry's
    // comment): every per-person Orders authority the database reads is listed,
    // and `delete` is not — its only reader was the retired Order Request
    // function. `approve` is not registered any more; `can_be_order_assignee`
    // is registered again under its honest meaning (sales-candidate standing,
    // is_eligible_order_assignee) and IS read by the database.
    for (const action of [
      'view', 'create', 'view_all', 'approve_order', 'approve_advance_exception', 'align_production',
      'view_pi_commission', 'manage', 'train_customize_image', 'view_payment_plan', 'edit_payment_plan',
      'can_be_order_assignee',
    ]) {
      assert.equal(isActionEnforced('orders', action), true, `orders.${action} is enforced`)
    }
    for (const action of ['edit', 'export', 'delete', 'approve']) {
      assert.equal(isActionEnforced('orders', action), false, `orders.${action} is not enforced`)
    }
  })

  test('Finance enforces module entry, recording, and every money authority', () => {
    // 'view' joined this list when src/app/finance/layout.tsx stopped reading
    // app_modules.visibility_type. Read it precisely: it is MODULE ENTRY, and
    // it says nothing about which payment records a person can then see —
    // that is still the ownership policies plus 'view_all'. `create` is read by
    // the expense and bank-credit doors (20270205120000, 20270419000000); the
    // five protected money authorities by their own functions.
    for (const action of [
      'view', 'create', 'approve', 'manage', 'delete', 'view_all',
      'allocate', 'allocate_correct', 'verify_own_payment', 'reconcile', 'reimburse',
    ]) {
      assert.equal(isActionEnforced('finance', action), true, `finance.${action} is enforced`)
    }
    for (const action of ['edit', 'export']) {
      assert.equal(isActionEnforced('finance', action), false, `finance.${action} decides nothing`)
    }
  })

  test('a fully enforced module enforces every action', () => {
    for (const action of ['view', 'create', 'edit', 'delete', 'manage', 'assign']) {
      assert.equal(isActionEnforced('assets_access', action), true)
    }
    // Meetings is partial since 2026-10-29: `export` is read by nothing.
    for (const action of ['view', 'create', 'edit', 'delete', 'manage']) {
      assert.equal(isActionEnforced('meetings', action), true)
    }
    assert.equal(isActionEnforced('meetings', 'export'), false)
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
    const source = readScreenSource('src/app/finance/page.tsx')
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

  test('Meetings is "partial": its layout and capabilities resolve, but nothing reads export', () => {
    const guard = read('src/app/meetings/layout.tsx')
    assert.ok(guard.includes('hasPermission'), 'the Meetings guard no longer resolves permissions')
    const caps = read('src/lib/permissions/meetings.ts')
    assert.ok(caps.includes('deriveMeetingsCapabilities'))
    assert.equal(caps.includes("'export'"), false, 'if Meetings starts reading export, promote the entry to enforced')
    assert.equal(moduleEnforcement('meetings').state, 'partial')
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
    // Performance is deliberately absent: 20261109000000 gave it two more
    // enforced actions, so "entry and no more" stopped being true of it. Its
    // own claim is asserted below, and against the routes that back it in
    // src/lib/permissions/performanceAccessEnforcement.test.ts.
    for (const moduleKey of ['showroom_qr', 'employee_records']) {
      assert.equal(moduleEnforcement(moduleKey).state, 'partial', moduleKey)
      assert.deepEqual(moduleEnforcement(moduleKey).enforcedActions, ['view'], moduleKey)
      assert.equal(isActionEnforced(moduleKey, 'view'), true, moduleKey)
      assert.equal(isActionEnforced(moduleKey, 'manage'), false, moduleKey)
    }
  })

  test('Performance claims entry plus the two access actions, and nothing else', () => {
    assert.equal(moduleEnforcement('performance').state, 'partial')
    assert.deepEqual(moduleEnforcement('performance').enforcedActions,
      ['view', 'view_team', 'view_all'])

    // Each of the three has a guard behind it.
    const moduleLayout = read('src/app/performance/layout.tsx')
    assert.ok(moduleLayout.includes('ModuleGuard') && moduleLayout.includes('moduleKey="performance"'),
      'the Personal Performance claim needs the module route guard')
    const teamLayout = read('src/app/performance/team/layout.tsx')
    assert.ok(teamLayout.includes('canAccessTeamPerformance'),
      'the Team Performance claim needs the team route guard')
    const teamRoute = read('src/app/api/performance-metrics/team/route.ts')
    assert.ok(teamRoute.includes('isWithinTeamPerformanceScope'),
      'the View All Employees claim needs the server-side scope filter')

    // create/edit/export/manage remain saved and unused, and the entry says so.
    for (const action of ['create', 'edit', 'export', 'manage']) {
      assert.equal(isActionEnforced('performance', action), false, action)
    }
    assert.equal(isActionEnforced('performance', 'view'), true)
    assert.equal(isActionEnforced('performance', 'view_team'), true)
    assert.equal(isActionEnforced('performance', 'view_all'), true)
  })

  test('the Access Control screen reads this file, not a local set', () => {
    const page = read('src/app/admin/control-center/permissions/page.tsx')
    const catalog = read('src/lib/permissions/accessCatalog.ts')
    assert.ok(
      catalog.includes("from './enforcement'") && page.includes("from '@/lib/permissions/accessCatalog'"),
      'the permissions page must read enforcement through the catalogue, not keep its own list',
    )
    assert.equal(
      page.includes('ENFORCED_MODULE_KEYS = new Set'),
      false,
      'the stale local ENFORCED_MODULE_KEYS set is back',
    )
  })
})
