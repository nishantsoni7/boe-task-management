import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Control Center's visible navigation, pinned to its source.
//
// The sidebar is the map of what an administrator can manage, so what it
// offers — and what it deliberately withholds — is a product decision worth a
// test. The map itself is data (src/lib/controlCenter/navModel.ts); the shell
// draws it. Everything here is a string check; it runs without a DOM and fails
// the moment somebody re-adds a retired entry or drops one that has a
// destination.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const shell = read('src/components/layout/ControlCenterLayout.tsx')
const model = read('src/lib/controlCenter/navModel.ts')

describe('Control Center navigation', () => {
  test('the sidebar offers six hubs, not one entry per screen', () => {
    for (const hub of ['Home', 'People', 'Access', 'Order Setup', 'Announcements', 'Records & Data']) {
      assert.ok(model.includes(`label: '${hub}',`), `${hub} must be a hub`)
    }
    // Hubs are drawn from the registry; the shell lists no screen of its own.
    assert.ok(shell.includes('NAV_HUBS'))
    assert.equal(/<NavItem\s+label="/.test(shell), false, 'no hand-written sidebar entries remain')
  })

  test('every screen that has a destination is a section of a hub', () => {
    // Access is three screens since 2026-10-29: People (one person), Modules
    // (one module across everyone) and Authorities (every per-person decision).
    for (const label of ['Employees', 'Departments', 'Designations', 'People', 'Modules', 'Authorities', 'Numbering',
      'Notifications', 'Operations Handoff', 'Order Visibility', 'Announcements', 'Task Records',
      'Test Data Cleanup', 'Data Management']) {
      assert.ok(model.includes(`label: '${label}'`), `${label} must be reachable`)
    }
  })

  test('withholds what has no destination or was retired', () => {
    // "Positions" is gone as a LABEL, not as a screen: the same route and the
    // same editor are offered as Designations, which is what the field is
    // called everywhere else now.
    for (const label of ['Roles', 'Positions', 'Module Visibility', 'Action Queue', 'Change History']) {
      assert.equal(model.includes(`label: '${label}'`), false, `${label} must not be offered`)
    }
  })

  test('Records & Data is apart from the everyday entries and marked as dangerous', () => {
    assert.ok(/id: 'records',[\s\S]{0,80}danger: true/.test(model))
    assert.ok(shell.includes('<div className={cc.navDivider} />'))
  })

  test('Employees is a route, not a tab, so its module gate can apply', () => {
    // Employee administration carries the `employee_records` ModuleGuard, which
    // needs a segment of its own — a ?tab= value cannot be guarded.
    assert.ok(model.includes('href: `${MAIN_PATH}/people`'))
    const layout = read('src/app/admin/control-center/people/layout.tsx')
    assert.ok(layout.includes('moduleKey="employee_records"'))
  })

  test('Task Records is the old Task Management "Super Admin" entry, moved not rebuilt', () => {
    assert.ok(model.includes("href: '/super-admin'"))
    const dashboard = read('src/components/layout/DashboardLayout.tsx')
    assert.equal(dashboard.includes('label="Super Admin"'), false, 'it must not still be in Task Management')
  })

  test('every entry is a real link, with tab links replacing history on the main page', () => {
    assert.ok(shell.includes("import Link from 'next/link'"))
    assert.equal(shell.includes('router.push(path)'), false, 'no button-driven navigation remains')
    assert.ok(shell.includes('replace={onMain'))
  })

  test('a hub with several screens shows them as tabs above the page', () => {
    assert.ok(shell.includes('SectionTabsWithTab'))
    assert.ok(shell.includes('hub.sections.length < 2'))
  })

  test('the hidden ?tab=modules route still resolves', () => {
    assert.ok(model.includes("'modules'"))
    assert.ok(model.includes("loc.tab === 'modules'"))
  })

  test('Find anything opens from the sidebar and from Ctrl/Cmd+K', () => {
    assert.ok(shell.includes('<FindAnything'))
    assert.ok(shell.includes("e.key.toLowerCase() === 'k'"))
    assert.ok(shell.includes('Find anything'))
  })

  test('Designations is reachable inside the shell without a second implementation', () => {
    const route = read('src/app/admin/control-center/positions/page.tsx')
    const settings = read('src/app/settings/positions/page.tsx')
    assert.ok(route.includes("from '@/components/positions/PositionsManager'"))
    assert.ok(settings.includes("from '@/components/positions/PositionsManager'"))
    assert.equal(route.includes("from('positions')"), false, 'the route wraps; it does not query')
    assert.equal(settings.includes("from('positions')"), false, 'the settings page wraps; it does not query')
  })

  test('Home reads the same Action Queue rules as the queue page, not a copy', () => {
    const page = read('src/app/admin/control-center/page.tsx')
    const queue = read('src/app/admin/control-center/action-queue/page.tsx')
    const loader = read('src/lib/controlCenter/actionQueue.ts')
    assert.ok(page.includes("useActionQueue"))
    assert.ok(queue.includes('loadActionQueue'))
    assert.ok(loader.includes('export async function loadActionQueue'))
    assert.equal(/\.from\('finance_payment_requests'\)/.test(page), false, 'Home does not query the queue tables itself')
  })
})
