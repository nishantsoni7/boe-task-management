import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Control Center's visible navigation, pinned to its source.
//
// The sidebar is the map of what an administrator can manage, so what it
// offers — and what it deliberately withholds — is a product decision worth a
// test. Everything here is a string check against the shell component; it
// runs without a DOM and fails the moment somebody re-adds a retired entry or
// drops one that has a destination.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const shell = read('src/components/layout/ControlCenterLayout.tsx')

describe('Control Center navigation', () => {
  test('offers exactly the groups and entries that have a destination', () => {
    for (const label of ['Overview', 'Employees', 'Departments', 'Designations', 'By Employee', 'By Module', 'Order Numbering', 'Test Data Cleanup', 'Data Management', 'Task Records']) {
      assert.ok(shell.includes(`label="${label}"`), `${label} must be in the sidebar`)
    }
    for (const group of ['People', 'Access', 'System']) {
      assert.ok(shell.includes(`<span className={cc.navGroupLabel}>${group}</span>`), `${group} group label`)
    }
  })

  test('withholds what has no destination or was retired', () => {
    // "Positions" is gone as a LABEL, not as a screen: the same route and the
    // same editor are offered as Designations, which is what the field is
    // called everywhere else now.
    for (const label of ['Roles', 'Positions', 'Module Visibility', 'Action Queue', 'Change History']) {
      assert.equal(shell.includes(`label="${label}"`), false, `${label} must not be offered`)
    }
  })

  test('Employees is a route, not a tab, so its module gate can apply', () => {
    // Employee administration carries the `employee_records` ModuleGuard, which
    // needs a segment of its own — a ?tab= value cannot be guarded.
    assert.ok(shell.includes('href={`${MAIN_PATH}/people`}'))
    assert.equal(shell.includes("href={tabHref('people')}"), false)
    const layout = read('src/app/admin/control-center/people/layout.tsx')
    assert.ok(layout.includes('moduleKey="employee_records"'))
  })

  test('Task Records is the old Task Management "Super Admin" entry, moved not rebuilt', () => {
    assert.ok(shell.includes('href="/super-admin"'))
    const dashboard = read('src/components/layout/DashboardLayout.tsx')
    assert.equal(dashboard.includes('label="Super Admin"'), false, 'it must not still be in Task Management')
  })

  test('every entry is a real link, with tab links replacing history on the main page', () => {
    assert.ok(shell.includes("import Link from 'next/link'"))
    assert.equal(shell.includes('router.push(path)'), false, 'no button-driven navigation remains')
    assert.ok(shell.includes('replace={onMain}'))
  })

  test('the hidden ?tab=modules route still resolves', () => {
    assert.ok(shell.includes("tabParam === 'modules'"))
  })

  test('Designations is reachable inside the shell without a second implementation', () => {
    const route = read('src/app/admin/control-center/positions/page.tsx')
    const settings = read('src/app/settings/positions/page.tsx')
    assert.ok(route.includes("from '@/components/positions/PositionsManager'"))
    assert.ok(settings.includes("from '@/components/positions/PositionsManager'"))
    assert.equal(route.includes("from('positions')"), false, 'the route wraps; it does not query')
    assert.equal(settings.includes("from('positions')"), false, 'the settings page wraps; it does not query')
  })
})
