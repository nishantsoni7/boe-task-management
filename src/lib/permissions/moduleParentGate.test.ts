/**
 * THE PARENT GATE — regression coverage for the Access Control V1 defect.
 *
 * The defect: Jasvi had Sample Tracking module access unticked. Access Control
 * stored an explicit `view = false` override and reported "Hidden". She could
 * still see the launcher card and still open /samples, because the launcher and
 * the (absent) route guard read app_modules.visibility_type — a table Access
 * Control does not write — while `view` was read by nothing.
 *
 * Two halves are tested here:
 *
 *   BEHAVIOUR   the rule itself, against canAccessManagementModule.
 *   SOURCE      that every affected module is actually WIRED to that rule, in
 *               both places. A rule nothing calls is what caused this defect,
 *               so asserting the wiring is the point, not a formality. Same
 *               technique as enforcement.test.ts.
 *
 * Reads files only. No DB, no network, no writes.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/moduleParentGate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canAccessManagementModule, ENGINE_GATED_MODULE_KEYS, isEngineGatedModule } from './moduleVisibility'
import type { EffectivePermission } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const perms = (allowed: string[], denied: string[] = []): EffectivePermission[] => [
  ...allowed.map(actionKey => ({ actionKey, allowed: true, source: 'employee_override' as const })),
  ...denied.map(actionKey => ({ actionKey, allowed: false, source: 'employee_override' as const })),
]

const canOpen = (role: string | null, moduleKey: string, permissions: EffectivePermission[]) =>
  canAccessManagementModule({ role, moduleKey, isModuleActive: true, permissions })

// The seven modules that were gated by app_modules, and the two that were
// already on the engine and serve as working controls.
const MIGRATED = [
  'task_management', 'sample_tracking', 'assets_access', 'showroom_qr',
  'employee_records', 'performance', 'finance',
] as const
const CONTROLS = ['orders', 'meetings'] as const

// Every engine-gated module's route root and the layout that guards it.
const MODULE_ROUTES: Record<string, { layout: string; guardedBy: 'ModuleGuard' | 'hasPermission' }> = {
  task_management:  { layout: 'src/app/dashboard/layout.tsx',      guardedBy: 'ModuleGuard' },
  sample_tracking:  { layout: 'src/app/samples/layout.tsx',        guardedBy: 'ModuleGuard' },
  assets_access:    { layout: 'src/app/assets-access/layout.tsx',  guardedBy: 'ModuleGuard' },
  showroom_qr:      { layout: 'src/app/showroom-admin/layout.tsx', guardedBy: 'ModuleGuard' },
  employee_records: { layout: 'src/app/admin/members/layout.tsx',  guardedBy: 'ModuleGuard' },
  performance:      { layout: 'src/app/performance/layout.tsx',    guardedBy: 'ModuleGuard' },
  finance:          { layout: 'src/app/finance/layout.tsx',        guardedBy: 'ModuleGuard' },
  orders:           { layout: 'src/app/orders/layout.tsx',         guardedBy: 'hasPermission' },
  meetings:         { layout: 'src/app/meetings/layout.tsx',       guardedBy: 'hasPermission' },
}

// ── The rule ────────────────────────────────────────────────────────────────

describe('the Jasvi case: view = false closes the module', () => {
  test('a denied view hides Sample Tracking, whatever else is stored', () => {
    assert.equal(canOpen('member', 'sample_tracking', perms([], ['view'])), false)
  })

  test('no permission rows at all is also closed', () => {
    assert.equal(canOpen('member', 'sample_tracking', []), false)
  })

  test('view = true opens it again — nothing else had to change', () => {
    assert.equal(canOpen('member', 'sample_tracking', perms(['view'])), true)
  })

  test('an admin is never affected', () => {
    assert.equal(canOpen('admin', 'sample_tracking', perms([], ['view'])), true)
  })
})

describe('the Aditya case: child actions are dormant, not an entry ticket', () => {
  test('dispatch + receive + mark_lost with view = false stays closed', () => {
    const aditya = perms(['dispatch', 'receive', 'mark_lost'], ['view'])
    assert.equal(canOpen('member', 'sample_tracking', aditya), false)
  })

  test('every single non-view action, alone, fails to open the module', () => {
    for (const action of [
      'create', 'edit', 'delete', 'approve', 'export', 'manage',
      'dispatch', 'receive', 'mark_lost', 'close',
    ]) {
      assert.equal(
        canOpen('member', 'sample_tracking', perms([action], ['view'])),
        false,
        `${action} must not open a module whose view is denied`,
      )
    }
  })

  test('restoring view lights the stored child actions back up', () => {
    const restored = perms(['view', 'dispatch', 'receive', 'mark_lost'])
    assert.equal(canOpen('member', 'sample_tracking', restored), true)
  })

  test('the same holds for every engine-gated module, not just Sample Tracking', () => {
    for (const moduleKey of [...MIGRATED, ...CONTROLS]) {
      assert.equal(
        canOpen('member', moduleKey, perms(['manage', 'edit', 'create'], ['view'])),
        false,
        `${moduleKey} must not open on child actions alone`,
      )
      assert.equal(
        canOpen('member', moduleKey, perms(['view'])),
        true,
        `${moduleKey} must open on view`,
      )
    }
  })
})

describe('the gated registry', () => {
  test('covers the seven migrated modules and the two controls', () => {
    for (const key of [...MIGRATED, ...CONTROLS]) {
      assert.ok(isEngineGatedModule(key), `${key} must be engine-gated`)
    }
    assert.equal(ENGINE_GATED_MODULE_KEYS.length, 9)
  })

  test('Attendance and Payroll are deliberately excluded', () => {
    assert.equal(isEngineGatedModule('attendance'), false)
    assert.equal(isEngineGatedModule('payroll'), false)
  })

  test('a stray view grant still cannot open Attendance or Payroll management', () => {
    assert.equal(canOpen('member', 'attendance', perms(['view'])), false)
    assert.equal(canOpen('member', 'payroll', perms(['view', 'manage'])), false)
  })
})

// ── The wiring ──────────────────────────────────────────────────────────────

describe('every engine-gated module has a route guard', () => {
  for (const [moduleKey, route] of Object.entries(MODULE_ROUTES)) {
    test(`${moduleKey} — ${route.layout} exists and resolves the engine`, () => {
      assert.ok(existsSync(join(ROOT, route.layout)), `${route.layout} is missing — the module has no route guard`)
      const source = read(route.layout)

      if (route.guardedBy === 'ModuleGuard') {
        assert.ok(source.includes('ModuleGuard'), `${route.layout} must guard with ModuleGuard`)
        assert.ok(
          source.includes(`moduleKey="${moduleKey}"`),
          `${route.layout} must guard on ${moduleKey}`,
        )
      } else {
        // Orders and Meetings keep their own hand-written guards. They are the
        // controls: if either stops resolving the engine, this fails.
        assert.ok(
          source.includes('hasPermission') && source.includes(`'${moduleKey}', 'view'`),
          `${route.layout} must still resolve ${moduleKey}:view`,
        )
      }
    })
  }

  // Matches the QUERY and the CALL, not the words: a layout is free to explain
  // in a comment why it no longer reads that table.
  test('no guarded layout reads app_modules for its authorization decision', () => {
    for (const route of Object.values(MODULE_ROUTES)) {
      const source = read(route.layout)
      assert.ok(
        !source.includes("from('app_modules')"),
        `${route.layout} still queries app_modules — that table is not what Access Control writes`,
      )
      assert.ok(
        !source.includes('resolveModuleAccess('),
        `${route.layout} still calls resolveModuleAccess — module entry must come from the engine`,
      )
    }
  })
})

describe('ModuleGuard cannot leak the page or its data', () => {
  const guard = read('src/components/layout/ModuleGuard.tsx')

  test('children render only in the allowed state', () => {
    assert.ok(
      guard.includes("if (state !== 'allowed') return <LoadingScreen />"),
      'children must not render while checking or denied — that is the content flash, ' +
      'and it is also what would let a child start fetching before authorization',
    )
  })

  test('a denial redirects rather than rendering the protected tree', () => {
    assert.ok(guard.includes("setState('denied')"))
    assert.ok(guard.includes('router.replace(deniedRoute)'))
  })

  test('the decision comes from the shared rule, not a local reimplementation', () => {
    assert.ok(guard.includes('canAccessManagementModule'))
    assert.ok(guard.includes('getEffectivePermissions'))
  })

  test('it reads the signed-in user, never a View As target', () => {
    assert.ok(
      !guard.includes('useViewAs') && !guard.includes('viewAsUserId'),
      'View As is a preview and must not lend or remove authority in a guard',
    )
  })
})

describe('the launcher agrees with the guards', () => {
  const launcher = read('src/app/modules/page.tsx')

  test('every engine-gated module is gated by canOpenModule', () => {
    for (const moduleKey of Object.keys(MODULE_ROUTES)) {
      assert.ok(
        launcher.includes(`canOpenModule('${moduleKey}')`),
        `${moduleKey}'s launcher card must use the parent gate`,
      )
    }
  })

  test('canOpenModule is the shared rule', () => {
    assert.ok(launcher.includes('canAccessManagementModule'))
    assert.ok(launcher.includes('getEffectivePermissionsForUser'))
  })

  test('no engine-gated module is still gated by app_modules', () => {
    for (const moduleKey of Object.keys(MODULE_ROUTES)) {
      assert.ok(
        !launcher.includes(`canSeeModule('${moduleKey}'`),
        `${moduleKey} must no longer read app_modules.visibility_type for authorization`,
      )
    }
  })

  test('Attendance and Payroll still use app_modules, unchanged', () => {
    assert.ok(launcher.includes("canSeeModule('attendance'"))
    assert.ok(launcher.includes("canSeeModule('payroll'"))
  })
})

describe('a disabled module never starts its count request', () => {
  const launcher = read('src/app/modules/page.tsx')

  // The four module-specific endpoints the launcher used to call for everyone,
  // paired with the module whose gate must now decide them.
  const COUNT_ENDPOINTS: [string, string][] = [
    ['task_management', '/api/notifications?count=1&category=task'],
    ['sample_tracking', '/api/samples/notifications?count=1'],
    ['finance',         '/api/notifications?count=1&category=finance'],
    ['orders',          '/api/notifications?count=1&category=order'],
  ]

  test('every module endpoint is requested only through countIfAllowed', () => {
    for (const [moduleKey, url] of COUNT_ENDPOINTS) {
      assert.ok(
        launcher.includes(`countIfAllowed('${moduleKey}', '${url}')`),
        `${url} must be gated on ${moduleKey}`,
      )
    }
  })

  test('there is exactly ONE fetch call site, and it is inside the gate', () => {
    // The strongest form of "does not fetch": there is no second place a
    // request could be issued from. If someone adds a bare fetch() back to this
    // page, this fails regardless of what they name it.
    const fetchSites = launcher.match(/fetch\(/g) ?? []
    assert.equal(fetchSites.length, 1, 'the launcher must have a single fetch call site')

    const gate = launcher.slice(
      launcher.indexOf('const countIfAllowed'),
      launcher.indexOf('const [taskNotifsRes'),
    )
    assert.ok(gate.includes('fetch(url)'), 'the one fetch must live inside countIfAllowed')
    assert.ok(
      gate.includes('mayOpen(moduleKey)') && gate.includes('Promise.resolve(null)'),
      'a disallowed module must short-circuit to null without issuing a request',
    )
  })

  test('the gate is the shared rule, not a second opinion', () => {
    const mayOpen = launcher.slice(
      launcher.indexOf('const mayOpen'),
      launcher.indexOf('if (profileData) setProfile'),
    )
    assert.ok(mayOpen.includes('canAccessManagementModule'))
    assert.ok(mayOpen.includes("permissions: effectivePermissions.get(moduleKey) ?? []"))
  })

  test('permissions resolve BEFORE any count is requested', () => {
    const permsAt = launcher.indexOf('getEffectivePermissionsForUser(supabase, uid)')
    const gateAt  = launcher.indexOf('const mayOpen')
    const fetchAt = launcher.indexOf('const countIfAllowed')
    assert.ok(permsAt > -1 && gateAt > -1 && fetchAt > -1)
    assert.ok(permsAt < gateAt, 'the permission fetch must precede the gate')
    assert.ok(gateAt < fetchAt, 'the gate must precede the count requests')
  })

  // The behavioural half: the predicate countIfAllowed branches on. A module
  // with view = false returns false, so the ternary takes the Promise.resolve
  // branch and no request is made — for the Jasvi shape and the Aditya shape
  // alike.
  test('the predicate says no for view = false, with or without child actions', () => {
    for (const [moduleKey] of COUNT_ENDPOINTS) {
      assert.equal(canOpen('member', moduleKey, perms([], ['view'])), false, moduleKey)
      assert.equal(canOpen('member', moduleKey, perms(['manage', 'edit'], ['view'])), false, moduleKey)
      assert.equal(canOpen('member', moduleKey, []), false, `${moduleKey} with no rows at all`)
    }
  })

  test('an admin still gets every count, and a permissions failure does not stop them', () => {
    for (const [moduleKey] of COUNT_ENDPOINTS) {
      // An RPC failure yields an empty map, i.e. no permissions at all.
      assert.equal(canOpen('admin', moduleKey, []), true, moduleKey)
    }
  })

  test('a permissions failure is fail-closed for a non-admin', () => {
    for (const [moduleKey] of COUNT_ENDPOINTS) {
      assert.equal(canOpen('member', moduleKey, []), false, moduleKey)
      assert.equal(canOpen(null, moduleKey, perms(['view'])), false, `${moduleKey} with no role`)
    }
  })
})

describe('the launcher shows no visibility or readiness badge', () => {
  const launcher = read('src/app/modules/page.tsx')

  test('the badge maps are gone', () => {
    assert.ok(!launcher.includes('VIS_BADGE'), 'app_modules visibility badges must not return')
    assert.ok(!launcher.includes('STATUS_LABEL'), 'product-readiness labels must not return')
    assert.ok(!launcher.includes('ModuleStatus'))
  })

  test('none of the obsolete labels can be rendered', () => {
    for (const label of ["'Live'", "'Hidden'", "'Custom'", "'Admin Only'", 'Dept Only', "'Active'", "'Foundation'", "'Planned'"]) {
      assert.ok(!launcher.includes(label), `${label} must no longer appear on a launcher card`)
    }
  })

  test('a card carries no visibility fields at all', () => {
    for (const field of ['visibilityType', 'allowedDepartment', 'adminOnly']) {
      assert.ok(!launcher.includes(`${field}:`), `ModuleDef must not carry ${field}`)
    }
  })

  test('the notification line and Open affordance are kept', () => {
    assert.ok(launcher.includes('notificationCount'))
    assert.ok(launcher.includes("'No notifications'"))
  })

  test('Attendance/Payroll still resolves through app_modules, unchanged', () => {
    assert.ok(launcher.includes("canSeeModule('attendance'"))
    assert.ok(launcher.includes("canSeeModule('payroll'"))
  })
})

describe('Sample Tracking no longer fetches before authorization', () => {
  test('/samples is behind the guard', () => {
    const layout = read('src/app/samples/layout.tsx')
    assert.ok(layout.includes('moduleKey="sample_tracking"'))
  })

  test('the page itself still queries sample_dispatches — the guard is what defers it', () => {
    // If this ever stops being true the test above is guarding nothing, and the
    // "no fetch before authorization" claim needs re-deriving from scratch.
    const page = read('src/app/samples/page.tsx')
    assert.ok(
      page.includes("from('sample_dispatches')"),
      'the premise of the guard test has changed',
    )
  })
})

// ── Control Center ──────────────────────────────────────────────────────────

describe('Control Center employee cards', () => {
  const page = read('src/app/admin/control-center/permissions/page.tsx')

  test('Visible/Hidden is derived from view alone', () => {
    assert.ok(page.includes("const MODULE_ENTRY_ACTION = 'view'"))
    assert.ok(page.includes('function moduleIsAccessible('))
    assert.ok(
      page.includes('const accessible = moduleIsAccessible(mod, overrides)'),
      'the card must not derive Visible from "any action is allowed"',
    )
  })

  test('no card computes access from an arbitrary allowed action any more', () => {
    assert.ok(
      !page.includes('mod.actions.some(a => effective[a.actionKey])'),
      'a leftover child grant must not make a disabled module read as Visible',
    )
    assert.ok(
      !page.includes('modules.filter(mod => mod.actions.some(a => a.allowed))'),
      'the accessible counter must key on view too',
    )
  })

  test('readiness badges are gone from employee cards', () => {
    assert.ok(
      !page.includes('<EnforcementBadge'),
      'Partly active / Prepared / Not used / Active describe the product, not the employee',
    )
    assert.ok(!page.includes('ENFORCEMENT_BADGE_LABEL'))
    assert.ok(!page.includes('ENFORCEMENT_BADGE_STYLE'))
  })

  test('action-enforcement information is kept inside the modal', () => {
    assert.ok(
      page.includes('ENFORCEMENT_BANNER_VARIANT[moduleEnforcement(mod.moduleKey).state]'),
      'the Change Access modal must still say whether an action does anything',
    )
    assert.ok(page.includes('moduleEnforcement(mod.moduleKey).detail'))
  })

  test('the protected-permission warning is untouched', () => {
    assert.ok(page.includes('protectedActionsClearedByPreset'))
    assert.ok(page.includes('protectedActionWords'))
  })

  test('turning a module off still writes no_access across every action', () => {
    assert.ok(page.includes("applyAccessLevel(mod, 'no_access')"))
  })
})

// ── The database half ───────────────────────────────────────────────────────

describe('the Sample Tracking RLS parent gate', () => {
  const MIGRATION = 'supabase/migrations/20260904000000_sample_tracking_view_parent_gate.sql'
  const sql = read(MIGRATION)

  test('the gate resolves view, and admins keep access', () => {
    assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.sample_tracking_module_open()'))
    assert.ok(sql.includes("public.resolve_permission(auth.uid(), 'sample_tracking', 'view')"))
    assert.ok(sql.includes("u.role = 'admin'"))
  })

  test('the gate function is STABLE, so Postgres forbids it from writing', () => {
    const body = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.sample_tracking_module_open()'),
      sql.indexOf('COMMENT ON FUNCTION'),
    )
    assert.ok(body.includes('STABLE'))
  })

  test('SELECT evaluates the gate before ownership and before lifecycle grants', () => {
    const policy = sql.slice(
      sql.indexOf('CREATE POLICY "sample_dispatches_select"'),
      sql.indexOf('-- ── 3.'),
    )
    const gateAt  = policy.indexOf('sample_tracking_module_open()')
    const ownerAt = policy.indexOf('requested_by = auth.uid()')
    const childAt = policy.indexOf("'dispatch'")
    assert.ok(gateAt > -1 && ownerAt > -1 && childAt > -1)
    assert.ok(gateAt < ownerAt, 'the gate must precede the ownership branch')
    assert.ok(gateAt < childAt, 'the gate must precede the lifecycle branches')
  })

  test('INSERT requires the gate before requested_by', () => {
    const policy = sql.slice(
      sql.indexOf('CREATE POLICY "sample_dispatches_insert"'),
      sql.indexOf('-- ── 4.'),
    )
    assert.ok(policy.indexOf('sample_tracking_module_open()') < policy.indexOf('requested_by = auth.uid()'))
  })

  test('no lifecycle action can bypass the gate', () => {
    for (const policyName of ['sd_update_perm_dispatch', 'sd_update_perm_receive', 'sd_update_perm_lost']) {
      const start = sql.indexOf(`CREATE POLICY "${policyName}"`)
      assert.ok(start > -1, `${policyName} must be re-created`)
      const policy = sql.slice(start, sql.indexOf(';', start))
      // Both halves — USING decides which rows, WITH CHECK decides the result.
      assert.equal(
        (policy.match(/sample_tracking_module_open\(\)/g) ?? []).length, 2,
        `${policyName} must gate USING and WITH CHECK`,
      )
    }
  })

  test('it grants nothing and alters no stored permission', () => {
    for (const forbidden of [
      'employee_permission_overrides',
      'role_permissions',
      'department_permissions',
      'app_modules',
    ]) {
      assert.ok(!sql.includes(`INTO ${forbidden}`), `must not write ${forbidden}`)
      assert.ok(!sql.includes(`UPDATE public.${forbidden}`), `must not update ${forbidden}`)
      assert.ok(!sql.includes(`DELETE FROM public.${forbidden}`), `must not delete from ${forbidden}`)
    }
    assert.ok(!/\binsert\s+into\b/i.test(sql), 'the migration must not insert any row')
  })

  test("Aditya's grants are not backfilled and System Admin is untouched", () => {
    assert.ok(!sql.includes('973b4337-9cae-4f66-8e7f-b158326cdc10'), 'no employee is named, let alone granted')
    assert.ok(
      !sql.includes('CREATE POLICY "sample_dispatches_update_admin"'),
      'the admin UPDATE policy must be left exactly as it was',
    )
    assert.ok(sql.includes("p.polname = 'sample_dispatches_update_admin'"), 'and asserted unchanged')
  })

  test('it is the next unused timestamp and does not touch 903', () => {
    assert.ok(existsSync(join(ROOT, MIGRATION)))
    assert.ok(
      !existsSync(join(ROOT, 'supabase/migrations/20260905000000_sample_tracking_view_parent_gate.sql')),
      'no duplicate at a later stamp',
    )
    assert.ok(!sql.includes('20260903000000'), 'migration 903 must not be re-run or modified')
  })
})
