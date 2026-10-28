/**
 * The Access workspace (People, Modules, Authorities) as one administrator
 * workflow.
 *
 * Source-shape assertions over the real screens, plus behavioural assertions
 * on the shared catalogue they delegate to. They pin what the screens must
 * never stop doing: one control per module, Off removing everything only
 * after naming it, a level keeping authorities, the self-service row, the
 * system-Admin lockout, unsaved-change protection, and a directory that
 * shows everybody.
 *
 * Repository files only. No DB, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/accessControlUi.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import './modules'
import { getRegisteredModule } from './registry'
import { isProtectedAction } from './levels'
import {
  authoritiesClearedByOff,
  desiredForLevel,
  desiredWithAuthority,
  detectOfferedLevel,
  isModuleOfferedTo,
} from './accessCatalog'
import { moduleEnforcement } from './enforcement'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const people = read('src/app/admin/control-center/permissions/page.tsx')
const modulesPage = read('src/app/admin/control-center/permissions/modules/page.tsx')
const authoritiesPage = read('src/app/admin/control-center/permissions/authorities/page.tsx')
const edits = read('src/components/controlCenter/accessEdits.ts')
const row = read('src/components/controlCenter/AccessRow.tsx')
const keys = (m: string) => getRegisteredModule(m)!.actions.map(a => a.actionKey)

describe('a module is one control', () => {
  test('Off states every registered action false, so nothing hidden can wake up later', () => {
    const next = desiredForLevel('assets_access', keys('assets_access'), 'off', { view: true, assign: true, manage: true })
    for (const a of keys('assets_access')) assert.equal(next[a], false, a)
  })

  test('a level keeps every authority the person holds', () => {
    const held = { view: true, create: true, manage: true, assign: true }
    const next = desiredForLevel('assets_access', keys('assets_access'), 'viewer', held)
    assert.equal(next.view, true)
    assert.equal(next.create, false)
    assert.equal(next.manage, true)
    assert.equal(next.assign, true)
    assert.equal(detectOfferedLevel('assets_access', keys('assets_access'), next), 'viewer')
  })

  test('Off asks first and names the authorities it removes', () => {
    const held = { view: true, manage: true, assign: true }
    assert.deepEqual(
      authoritiesClearedByOff('assets_access', keys('assets_access'), held).sort(),
      ['Hand out assets', 'Return, transfer or write off assets'],
    )
    for (const src of [people, modulesPage]) {
      assert.ok(src.includes('authoritiesClearedByOff('), 'both screens must ask before Off')
      assert.ok(src.includes('<OffConfirm'))
    }
    assert.ok(row.includes('Turn off and remove') && row.includes('Keep as is'))
    assert.equal(/window\.confirm\(message\)/.test(people), false, 'the Off confirmation is inline, not a browser dialog')
  })

  test('giving a first authority opens the module, so a chip never sits on a closed door', () => {
    const next = desiredWithAuthority('finance', keys('finance'), 'reconcile', true, {})
    assert.equal(next.view, true)
    assert.equal(next.view_all, true)
  })

  test('the Open/Off decision is the module entry action and nothing else', () => {
    assert.ok(people.includes("const MODULE_ENTRY_ACTION = 'view'"))
    assert.ok(people.includes('entryActionForModule('))
    assert.ok(people.includes('moduleIsAccessible(mod, overrides)'))
    assert.equal(/setVisible|visibilityBoolean|moduleVisible/.test(people + modulesPage), false)
    assert.equal(/visibility_type|allowed_user_ids/.test(people + modulesPage + authoritiesPage), false,
      'the screens must not write app_modules visibility')
  })

  test('one shared write rule for all three screens', () => {
    assert.ok(people.includes('choicesForDesired('))
    assert.ok(edits.includes('choicesForDesired(') && edits.includes('changesBetween('))
    assert.ok(modulesPage.includes("from '@/components/controlCenter/accessEdits'"))
    assert.ok(authoritiesPage.includes("from '@/components/controlCenter/accessEdits'"))
  })
})

describe('Attendance & Payroll is one self-service row', () => {
  test('the two modules are separated out and rendered once, with no controls', () => {
    assert.ok(people.includes('isSelfServiceModuleKey(m.moduleKey)'))
    assert.ok(people.includes('<AttendancePayrollCard modules={selfServiceModules} />'))
    const start = people.indexOf('function AttendancePayrollCard')
    const card = people.slice(start, people.indexOf('// ── Page ──', start))
    assert.equal(/LevelControl|AuthorityChips|onChange|onClick/.test(card), false)
    assert.ok(card.includes('Self-service'))
    assert.ok(card.includes('Management access is restricted to system administrators'))
    assert.ok(card.includes('Unused permissions on record'))
  })

  test('they are never offered on any screen, and enforcement calls them not-used', () => {
    for (const m of ['attendance', 'payroll']) {
      assert.equal(isModuleOfferedTo(m, 'admin'), false)
      assert.equal(moduleEnforcement(m).state, 'role_only')
    }
    assert.ok(modulesPage.includes('isSelfServiceModuleKey(m.moduleKey)'))
  })

  test('Employee Records is withheld from non-admin grants', () => {
    assert.equal(isModuleOfferedTo('employee_records', 'member'), false)
    assert.ok(people.includes('isModuleOfferedTo(m.moduleKey, tree.employee.role)'))
  })
})

describe('unsaved changes are protected', () => {
  test('People and Modules ask before walking away from edits', () => {
    for (const src of [people, modulesPage]) {
      assert.ok(src.includes("'You have unsaved access changes. Leave without saving?'"))
      assert.ok(src.includes('window.confirm(UNSAVED_PROMPT)'))
      assert.ok(src.includes("window.addEventListener('beforeunload', warn)"))
      assert.ok(src.includes("window.removeEventListener('beforeunload', warn)"))
    }
    assert.ok(authoritiesPage.includes("window.addEventListener('beforeunload', warn)"))
  })

  test('re-selecting the same person never prompts, and the guard precedes the load', () => {
    assert.ok(people.includes('if (id === selectedEmployeeId) return'))
    const body = people.slice(people.indexOf('async function selectEmployee'), people.indexOf('async function loadTree'))
    assert.ok(body.indexOf('window.confirm(UNSAVED_PROMPT)') < body.indexOf('loadTree(id)'))
    assert.equal(body.includes("method: 'PUT'"), false, 'leaving sends nothing')
  })

  test('Save is disabled when clean and while saving, and a failure keeps the edits', () => {
    for (const src of [people, modulesPage, authoritiesPage]) assert.ok(/disabled=\{!dirty \|\| (edits\.)?saving\}/.test(src))
    const fail = people.indexOf("setSaveError(json.error ?? 'Save failed'); return")
    assert.ok(fail > 0 && fail < people.indexOf('await loadTree(selectedEmployeeId)', fail))
    assert.ok(edits.includes('if (savedEmployees.has(employeeId) || !byEmployee.has(employeeId)) next.delete(key)'),
      'only employees that saved leave the pending set')
  })

  test('the save bar lists what will change', () => {
    for (const src of [people, modulesPage, authoritiesPage]) assert.ok(src.includes('saveBarList'))
  })
})

describe('a system Administrator cannot be edited here', () => {
  test('it is decided from the SELECTED employee, and the controls lock', () => {
    assert.ok(people.includes("return tree?.employee.role === 'admin'"))
    assert.ok(people.includes('locked={adminLocked}'))
    assert.ok(row.includes('Everything · by role'))
  })

  test('the Control Center itself remains admin-only', () => {
    const layout = read('src/app/admin/control-center/layout.tsx')
    assert.ok(layout.includes('usePermissionContext()'))
    assert.ok(layout.includes("if (role !== 'admin') { router.replace('/dashboard'); return }"))
    assert.ok(layout.includes('exitViewMode()'))
    assert.equal(people.includes("from('users')"), false, 'the page must not re-read the profile the layout resolved')
  })
})

describe('only protected, enforced actions are authorities', () => {
  test('every authority is protected', () => {
    for (const a of ['view_all', 'approve_order', 'reconcile', 'assign', 'verify', 'can_be_order_assignee', 'train_customize_image']) {
      assert.ok(isProtectedAction(a), a)
    }
  })
})

describe('the Access directory shows everybody', () => {
  test('the People list is never silently truncated, and only deleted accounts are excluded', () => {
    const block = people.slice(people.indexOf('const searchResults = useMemo'), people.indexOf('}, [search, members, depts])'))
    assert.ok(!/\.slice\(0,\s*\d+\)/.test(block))
    assert.ok(block.includes('if (!q) return pool'))
    assert.ok(block.includes('members.filter(m => !m.is_deleted)'))
    assert.ok(!/is_active/.test(block), 'an inactive account must stay assignable')
    assert.ok(!/['"`]%?(test|dummy|sample)%?['"`]/i.test(block), 'no account is excluded for its name')
  })

  test('the panel says how many people it shows', () => {
    assert.ok(/results\.length === 1 \? 'employee' : 'employees'/.test(people))
  })

  test('no permission tree is fetched until an employee is opened', () => {
    const treeRoute = '/api/control-center/permissions/employees/${'
    assert.equal(people.split(treeRoute).length - 1, 2, 'one GET in loadTree, one PUT in save')
  })

  test('directory and departments come from the shared Control Center queries', () => {
    assert.ok(people.includes('const membersQuery = useAdminMembers()'))
    assert.equal(people.includes("fetch('/api/admin-members'"), false)
  })
})

describe('V1 boundaries', () => {
  test('no role templates, bulk copy or history were introduced', () => {
    for (const src of [people, modulesPage, authoritiesPage]) {
      for (const forbidden of ['RoleTemplate', 'roleTemplate', 'bulkCopy', 'copyAccessFrom', 'AccessHistory', 'exportPermissions']) {
        assert.equal(src.includes(forbidden), false, forbidden)
      }
    }
  })

  test('the three screens are tabs of the Access hub, and the old By-Module route is gone', () => {
    const model = read('src/lib/controlCenter/navModel.ts')
    for (const href of ['/permissions`', '/permissions/modules`', '/permissions/authorities`']) assert.ok(model.includes(href), href)
    assert.throws(() => read('src/app/api/control-center/permissions/modules/[key]/employees/route.ts'))
  })
})
