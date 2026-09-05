/**
 * Employee administration is ONE screen, Task Management is ONLY tasks, and the
 * last administrator cannot be demoted away.
 *
 * These are product decisions rather than pure functions, so they are pinned to
 * their source the way controlCenterNav.test.ts pins the sidebar. Every check
 * here is a string check against a file; none needs a DOM or a database, and
 * each fails the moment somebody re-adds what was deliberately removed or drops
 * an operation the consolidation promised to carry over.
 *
 * Run:
 *   npx tsx --test src/components/controlCenter/membersConsolidation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const workspace   = read('src/components/controlCenter/MembersWorkspace.tsx')
const ccPage      = read('src/app/admin/control-center/page.tsx')
const membersPage = read('src/app/admin/members/page.tsx')
const dashboard   = read('src/components/layout/DashboardLayout.tsx')
const mobileNav   = read('src/components/layout/MobileBottomNav.tsx')

// ── 1. Nothing was lost in the move ─────────────────────────────────────────

describe('the consolidated Members area carries every operation', () => {
  test('it calls the same seven routes the Employee Records page called', () => {
    // Not "an equivalent" — the same routes, unchanged, each of which
    // re-verifies from the bearer token that the caller is an admin.
    for (const route of [
      '/api/create-user',
      '/api/update-member',
      '/api/toggle-active',
      '/api/delete-user',
      '/api/restore-user',
      '/api/permanently-delete-user',
      '/api/reset-password',
    ]) {
      assert.ok(workspace.includes(`'${route}'`), `${route} must still be called`)
    }
  })

  test('it reads deleted accounts as well as live ones, so restore is reachable', () => {
    assert.ok(workspace.includes('useDeletedMembers'))
    assert.ok(workspace.includes("statusFilter === 'deleted'"))
  })

  test('it offers the four grouped sections, on the selected member', () => {
    for (const heading of ['Employment', 'Account', 'Access', 'Danger zone']) {
      assert.ok(workspace.includes(`>${heading}</div>`), `${heading} section`)
    }
  })

  test('Access links to the existing access-control workflow rather than restating it', () => {
    assert.ok(workspace.includes('/admin/control-center/permissions?employee='))
    // No permission editing of its own: the module matrix stays in one place.
    assert.equal(/allowedActions|presetAllowedActions|PROTECTED_ACTIONS/.test(workspace), false)
  })

  test('it edits the four separate facts, and says the level decides nothing', () => {
    for (const label of ['Department', 'Designation', 'Designation level', 'System role']) {
      assert.ok(workspace.includes(`label="${label}"`), `${label} must be editable`)
    }
    assert.ok(workspace.includes('grant nothing on their own'))
  })
})

// ── 2. There is only one of it ──────────────────────────────────────────────

describe('the old surfaces are gone, not duplicated', () => {
  test('/admin/members redirects into the Control Center and keeps its module gate', () => {
    assert.ok(membersPage.includes("router.replace('/admin/control-center/people')"))
    assert.equal(/from\(['"]users['"]\)/.test(membersPage), false, 'it no longer queries anything')
    // The gate the module registry declares for `employee_records` still sits
    // in front of it — see src/lib/permissions/moduleParentGate.test.ts.
    assert.ok(read('src/app/admin/members/layout.tsx').includes('moduleKey="employee_records"'))
  })

  test('the Control Center’s read-only employee tab is gone, and its URL redirects', () => {
    assert.ok(ccPage.includes("if (tab === 'people') router.replace"))
    assert.equal(ccPage.includes("{tab === 'people' && ("), false, 'the old table must not remain')
    // Its one action — a per-employee "Change department" dialog — is gone from
    // the employee list, because the member dialog now edits the department
    // alongside everything else. The Departments tab keeps its own inline
    // reassignment inside the "people in this department" popup, which is a
    // different job: emptying a department, not editing a person.
    assert.equal(ccPage.includes('openEditUser'), false, 'the employee-list department dialog is gone')
    assert.equal(ccPage.includes('saveUserDept'), false)
    assert.ok(ccPage.includes('startEditPerson'), 'the Departments popup keeps its own reassignment')
  })
})

// ── 3. Task Management holds tasks ──────────────────────────────────────────

describe('Task Management navigation', () => {
  test('offers no Performance entry, on desktop or mobile', () => {
    assert.equal(dashboard.includes("navTo('/performance')"), false)
    assert.equal(dashboard.includes("navTo('/performance/team')"), false)
    assert.equal(dashboard.includes('label="Performance"'), false)
    assert.equal(mobileNav.includes("go('/performance')"), false)
    assert.equal(mobileNav.includes("go('/performance/team')"), false)
    assert.equal(mobileNav.includes('label="Team Performance"'), false)
  })

  test('offers no administrative entry', () => {
    for (const gone of ['/admin/members', '/settings/roles', '/settings/positions', '/super-admin']) {
      assert.equal(dashboard.includes(gone), false, `${gone} must not be in the Task Management sidebar`)
    }
    assert.equal(mobileNav.includes("go('/settings')"), false)
  })

  test('Performance itself is untouched — the module, its route and its gate remain', () => {
    assert.ok(read('src/app/performance/layout.tsx').includes('performance'))
    assert.ok(read('src/lib/permissions/modules.ts').includes("moduleKey: 'performance'"))
    // And the launcher still offers it under its existing access rule.
    assert.ok(read('src/app/modules/page.tsx').includes("canOpenModule('performance')"))
  })

  test('the mobile bar no longer needs to know who is looking', () => {
    // Both role-derived entries left, so the profile prop went with them.
    assert.equal(/profile\?\.role/.test(mobileNav), false)
  })
})

// ── 4. The last administrator ───────────────────────────────────────────────

describe('Super Admin safety', () => {
  const route = read('src/app/api/update-member/route.ts')

  test('demoting the only remaining administrator is refused', () => {
    assert.ok(route.includes("role !== undefined && role !== 'admin'"))
    assert.ok(route.includes(".eq('role', 'admin')"))
    assert.ok(route.includes('(count ?? 0) <= 1'))
    assert.ok(route.includes('only administrator account'))
  })

  test('the guard counts accounts that can still sign in', () => {
    // A soft-deleted admin cannot sign in, so it must not be counted as the
    // administrator who would be left behind.
    assert.ok(route.includes("'is_deleted.eq.false,is_deleted.is.null'"))
  })

  test('the route still refuses every non-admin caller before any of this', () => {
    assert.ok(route.includes("callerProfile?.role !== 'admin'"))
    assert.ok(route.includes('Only admins can update members'))
  })

  test('a designation level is validated and stored, never compared against', () => {
    assert.ok(route.includes('isDesignationLevel'), 'an unknown rung is rejected with a readable error')
    // The last-administrator guard turns on `role` and on nothing else. If the
    // organisational rung ever appears inside it, the hierarchy has started
    // deciding who may administer the system.
    const guard = route.slice(
      route.indexOf('last-administrator guard'),
      route.indexOf('const { error } = await supabase'),
    )
    assert.ok(guard.length > 0, 'the guard block is findable')
    assert.equal(guard.includes('designation_level'), false, 'the guard reads role, not the rung')
    assert.ok(route.includes('designation_level: designation_level || null'), 'the level is only written')
  })
})

// ── 5. The user menu ────────────────────────────────────────────────────────

describe('the sidebar user menu', () => {
  const controls = read('src/components/layout/AdminViewModeControls.tsx')

  test('is one control with the correct menu semantics', () => {
    assert.ok(controls.includes('aria-haspopup="menu"'))
    assert.ok(controls.includes('aria-expanded={open}'))
    assert.ok(controls.includes('role="menu"'))
    assert.ok(controls.includes('role="menuitem"'))
  })

  test('closes on Escape and on a click outside, returning focus to the trigger', () => {
    assert.ok(controls.includes("if (e.key === 'Escape')"))
    assert.ok(controls.includes('triggerRef.current?.focus()'))
    assert.ok(controls.includes('onClick={() => close(false)}'))
  })

  test('holds exactly Account Settings and Sign Out — Control Center is navigation, not an account action', () => {
    assert.ok(controls.includes("label: 'Account Settings'"))
    assert.ok(controls.includes("label: 'Sign Out'"))
    assert.equal(controls.includes('control-center'), false)
  })

  test('sign out and the account route are the ones each layout already passed', () => {
    assert.ok(controls.includes('onSignOut()'))
    assert.ok(controls.includes('router.push(accountSettingsHref)'))
  })

  test('the identity line never prints the authorization role', () => {
    assert.ok(controls.includes('employeeSubtitle'))
    assert.equal(/\{profile\.role\}/.test(controls), false)
    assert.equal(/\{member\.role\}/.test(controls), false)
  })
})
