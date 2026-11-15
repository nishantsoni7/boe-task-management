import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
  test('the sidebar offers Home and six areas, not one entry per screen', () => {
    for (const area of ['People', 'Access', 'Orders', 'Sales', 'Staff experience', 'Data & Safety']) {
      assert.ok(model.includes(`label: '${area}',`), `${area} must be an area`)
    }
    // Areas are drawn from the registry; the shell lists no screen of its own.
    assert.ok(shell.includes('NAV_HUBS'))
    assert.equal(/<NavItem\s+label="/.test(shell), false, 'no hand-written sidebar entries remain')
  })

  test('every screen that has a destination is a setting of an area', () => {
    for (const label of ['Employees', 'Departments', 'Designations', 'By person', 'By module', 'Authorities', 'Numbering',
      'Notifications', 'Operations handoff', 'Order visibility', 'Sales team', 'WhatsApp connection', 'Announcements',
      'For you column', 'Review leaderboard', 'Day Close & Scoreboard', 'Test data cleanup', 'Data management',
      'Task records']) {
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

  test('Data & Safety is apart from the everyday areas and marked as dangerous', () => {
    assert.ok(/id: 'data',[\s\S]{0,200}danger: true/.test(model))
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

  test('every entry is a real link, and leaving Home is a step of its own in the history', () => {
    assert.ok(shell.includes("import { AppLink as Link } from '@/components/ui/AppLink'"))
    assert.equal(shell.includes('router.push(path)'), false, 'no button-driven navigation remains')
    // Switching between two screens of the main page replaces the entry, as it always did; leaving Home does not,
    // so Back from a setting returns to the directory.
    assert.ok(shell.includes("const inTab = onMain && !!tab && tab !== 'overview'"))
    assert.ok(shell.includes('replace={inTab && !!s.tab}'))
  })

  test('the pages of the open area show under it, and there are no tabs above the page', () => {
    assert.ok(shell.includes('boe-rail-tree'), 'the rail\'s own sub-list')
    assert.ok(shell.includes('inert={!open}'), 'a folded page is not a tab stop')
    assert.ok(shell.includes('aria-expanded'))
    assert.equal(/SectionTabs|sectionTabs/.test(shell), false, 'the section tabs are retired')
    assert.equal(/sectionTab/.test(read('src/components/controlCenter/controlCenter.module.css')), false)
  })

  test('the page names where you are: a breadcrumb, one line on what it affects, and a way back on a phone', () => {
    assert.ok(shell.includes('aria-label="Breadcrumb"'))
    assert.ok(shell.includes('section.affects'))
    assert.ok(shell.includes('cc.crumbsBack'))
    assert.ok(shell.includes('rememberSection(id)'), 'recent screens feed the search')
  })

  test('the hidden ?tab=modules route still resolves', () => {
    assert.ok(model.includes("'modules'"))
    assert.ok(model.includes("loc.tab === 'modules'"))
    assert.ok(shell.includes("tab === 'modules'"))
  })

  test('Search opens from the sidebar, the header and Ctrl/Cmd+K', () => {
    assert.ok(shell.includes('<FindAnything'))
    assert.ok(shell.includes("e.key.toLowerCase() === 'k'"))
    assert.ok(shell.includes('Search settings'))
    assert.ok(shell.includes('cc.headFind'))
  })

  test('the menu starts open for a browser that never chose, and a stored choice wins', () => {
    assert.ok(shell.includes('useSidebarPinned(true)'))
    const rail = read('src/components/layout/RailControls.tsx')
    assert.ok(rail.includes('stored === null ? fallback : stored === \'1\''))
    // No other module changes: they ask for no fallback.
    for (const layout of ['FinanceLayout', 'OrdersLayout', 'DashboardLayout']) {
      assert.equal(/useSidebarPinned\(true\)/.test(read(`src/components/layout/${layout}.tsx`)), false, layout)
    }
  })

  test('Designations is reachable inside the shell without a second implementation', () => {
    const route = read('src/app/admin/control-center/positions/page.tsx')
    const settings = read('src/app/settings/positions/page.tsx')
    assert.ok(route.includes("from '@/components/positions/PositionsManager'"))
    assert.ok(settings.includes("from '@/components/positions/PositionsManager'"))
    assert.equal(route.includes("from('positions')"), false, 'the route wraps; it does not query')
    assert.equal(settings.includes("from('positions')"), false, 'the settings page wraps; it does not query')
  })

  test('Home is the settings directory, and pending work is not in the Control Center', () => {
    // Owner rule, 15 Nov 2026: approvals and other action items show on the dashboard of the module that
    // owns them. The Action Queue page, its loader and its hook are gone; Home fetches nothing of its own.
    for (const gone of ['src/app/admin/control-center/action-queue/page.tsx', 'src/lib/controlCenter/actionQueue.ts', 'src/hooks/queries/useActionQueue.ts']) {
      assert.equal(existsSync(join(ROOT, gone)), false, `${gone} must stay deleted`)
    }
    const page = read('src/app/admin/control-center/page.tsx')
    assert.ok(page.includes('<HomeDirectory'))
    assert.equal(page.includes('useActionQueue'), false)
    const home = read('src/components/controlCenter/HomeDirectory.tsx')
    assert.equal(/\.from\(|useQuery|fetch\(/.test(home), false, 'Home derives everything from lists already loaded')
    assert.equal(/finance_payment_requests|order_change_requests|pendingAgeLabel/.test(home), false, 'no pending work on Home')
    for (const file of [shell, model, home]) {
      assert.equal(/action-queue/.test(file), false)
    }
  })
})
