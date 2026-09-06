/**
 * The Performance module: its own navigation, and its own measured population.
 *
 * TWO RULES UNDER TEST:
 *
 *   1. Performance is a MODULE, not a page inside Task Management. Its screens
 *      render a Performance sidebar — My Performance, and Team Performance for a
 *      `view_team` holder — and none of Task Management's menu.
 *
 *   2. PARTICIPATION IS NOT ACCESS. `users.performance_tracking_enabled` decides
 *      whether somebody is MEASURED; the permission engine decides what they may
 *      OPEN. An excluded employee reaches no list, average, ranking or rate, and
 *      nothing of theirs is deleted.
 *
 * Run:
 *   npx tsx --test src/lib/performanceModuleShell.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  isPerformanceTracked, partitionByTracking, excludedSummaryLine,
  canViewExcludedDetails,
} from './performanceEligibility'
import { derivePerformanceCapabilities } from './permissions/performance'
import type { EffectivePermission } from './permissions/types'

const read = (path: string) => readFileSync(path, 'utf8')

const SHELL       = 'src/components/layout/PerformanceLayout.tsx'
const PERSONAL    = 'src/app/performance/page.tsx'
const TEAM        = 'src/app/performance/team/page.tsx'
const TEAM_ROUTE  = 'src/app/api/performance-metrics/team/route.ts'
const EOD_ROUTE   = 'src/app/api/eod-logs/team/route.ts'
const MEMBERS     = 'src/components/controlCenter/MembersWorkspace.tsx'
const MIGRATION   = 'supabase/migrations/20261112000000_exclude_partner_from_performance_population.sql'

const PERFORMANCE_ACTIONS = ['view', 'create', 'edit', 'export', 'manage', 'view_team', 'view_all']
const perms = (allowed: string[]): EffectivePermission[] =>
  PERFORMANCE_ACTIONS.map(actionKey => ({
    actionKey, allowed: allowed.includes(actionKey), source: 'employee_override' as const,
  }))

// ─── 1. Performance has its own navigation ───────────────────────────────────

describe('the Performance module shell', () => {
  const shell = read(SHELL)

  test('both Performance screens render it, and neither renders Task Management', () => {
    for (const path of [PERSONAL, TEAM]) {
      const source = read(path)
      assert.ok(source.includes('<PerformanceLayout'), `${path} does not use the Performance shell`)
      assert.ok(!source.includes('DashboardLayout'),
        `${path} still renders the Task Management shell`)
    }
  })

  test('it offers My Performance and Team Performance, and nothing else', () => {
    const labels = [...shell.matchAll(/label: '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(labels, ['My Performance', 'Team Performance'],
      'the module menu must not grow placeholder destinations')
  })

  test('no Task Management menu item appears anywhere in it', () => {
    // Comments stripped first: the file explains the defect by naming the very
    // entries it removed, and an assertion that cannot tell code from prose
    // would fail on its own documentation.
    const code = shell.replace(/\/\/[^\n]*/g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    // The exact entries the screenshot showed on /performance.
    for (const item of ['My Tasks', 'Assigned By Me', 'Quotation Requests', 'NotificationsNavItem']) {
      assert.ok(!code.includes(item), `the Performance shell must not offer ${item}`)
    }
    // …and it must not reach for the Task Management shell's nav pieces.
    assert.ok(!code.includes('CollapsibleNav') && !code.includes('NavChild'),
      'the Performance shell must not reuse Task Management navigation components')
  })

  test('Team Performance is the only conditional entry', () => {
    assert.match(shell, /label: 'Team Performance'[\s\S]{0,200}teamOnly: true/)
    assert.match(shell, /NAV_ITEMS\.filter\(item => !item\.teamOnly \|\| canViewTeam\)/)
    // My Performance has no condition — everybody with the module is first an
    // individual employee.
    assert.ok(!/label: 'My Performance'[\s\S]{0,160}teamOnly/.test(shell))
  })

  test('visibility comes from a capability, never a role name', () => {
    assert.ok(!/role\s*===\s*'(admin|manager)'/.test(shell),
      'the Performance menu must not branch on a role name')
    const personal = read(PERSONAL)
    assert.ok(personal.includes('canViewTeam={canOpenTeamView}'),
      'the personal page must pass the resolved capability')
    assert.ok(personal.includes('canOpenTeamView = capabilities.canAccessTeamPerformance'))
  })

  test('the module keeps its own identity and its way home', () => {
    assert.ok(shell.includes('Performance'), 'the sidebar must name the module')
    assert.ok(shell.includes("router.push('/modules')"), 'the Home button must return to the launcher')
    assert.ok(!shell.includes("'/tasks"), 'the Performance shell must not link into Task Management')
  })

  test('View Mode survives the new shell', () => {
    // The banner and the read-only sidebar section are the shared components;
    // mounting them is what keeps every View As rule intact.
    assert.ok(shell.includes('<ViewModeBanner />'), 'the View Mode banner must render')
    assert.ok(shell.includes('ViewModeSidebarSection'), 'the View Mode sidebar section must render')
  })
})

// ─── 2. Who sees which entry ─────────────────────────────────────────────────

describe('the menu each employee gets', () => {
  /** What PerformanceLayout would render, from a subject's capabilities. */
  const menuFor = (role: string, allowed: string[]): string[] => {
    const caps = derivePerformanceCapabilities(role, perms(allowed))
    if (!caps.canAccessPersonalPerformance) return []
    return caps.canAccessTeamPerformance
      ? ['My Performance', 'Team Performance']
      : ['My Performance']
  }

  test('Dhruv — both entries', () => {
    assert.deepEqual(menuFor('manager', ['view', 'view_team', 'view_all']),
      ['My Performance', 'Team Performance'])
  })

  test('a normal employee — My Performance only', () => {
    assert.deepEqual(menuFor('member', ['view']), ['My Performance'])
  })

  test('a manager WITHOUT view_team — My Performance only', () => {
    // Being a manager is not what puts Team Performance in the menu.
    assert.deepEqual(menuFor('manager', ['view']), ['My Performance'])
  })

  test('an admin — both entries', () => {
    assert.deepEqual(menuFor('admin', []), ['My Performance', 'Team Performance'])
  })

  test('View As reproduces the SUBJECT’s menu, not the admin’s', () => {
    // The page derives `capabilities` from the display subject, so the menu an
    // administrator sees while previewing is the one that employee would get.
    const personal = read(PERSONAL)
    assert.ok(personal.includes('subjectPermissionsByModule.get(\'performance\')'),
      'the page must derive capabilities from the display subject')
    // An admin previewing an employee with no view_team gets one entry.
    assert.deepEqual(menuFor('member', ['view']), ['My Performance'])
  })
})

// ─── 3. Participation is a separate concept from access ──────────────────────

describe('Performance participation', () => {
  const employee = (id: string, tracked: boolean | null) => ({
    id, full_name: id, team: 'sales',
    performance_tracking_enabled: tracked,
    performance_tracking_note: null,
  })

  test('included by default — null and undefined both mean included', () => {
    assert.equal(isPerformanceTracked(employee('a', null)), true)
    assert.equal(isPerformanceTracked({ id: 'b', full_name: 'b', team: 'sales' }), true)
    assert.equal(isPerformanceTracked(employee('c', true)), true)
    assert.equal(isPerformanceTracked(employee('d', false)), false)
  })

  test('an excluded employee is absent from the measured population', () => {
    const { tracked, excluded } = partitionByTracking([
      employee('kept-1', true),
      employee('partner', false),
      employee('kept-2', null),
    ])
    assert.deepEqual(tracked.map(u => u.id), ['kept-1', 'kept-2'])
    assert.deepEqual(excluded.map(u => u.userId), ['partner'])
  })

  test('re-enabling makes them eligible again — the split is pure', () => {
    const before = partitionByTracking([employee('partner', false)])
    assert.deepEqual(before.tracked, [])
    const after = partitionByTracking([employee('partner', true)])
    assert.deepEqual(after.tracked.map(u => u.id), ['partner'])
    // Nothing about the employee is mutated by asking the question.
    const row = employee('partner', false)
    partitionByTracking([row])
    assert.equal(row.performance_tracking_enabled, false)
  })

  test('the coverage line counts the held-out employees', () => {
    assert.equal(excludedSummaryLine(0), null)
    assert.equal(excludedSummaryLine(1), '1 user excluded from Performance tracking')
    assert.equal(excludedSummaryLine(3), '3 users excluded from Performance tracking')
  })

  test('the exclusion reasons stay admin-only', () => {
    assert.equal(canViewExcludedDetails({ role: 'admin' }), true)
    assert.equal(canViewExcludedDetails({ role: 'manager' }), false)
    assert.equal(canViewExcludedDetails({ role: 'member' }), false)
  })
})

// ─── 4. It is enforced server-side, before anything is measured ──────────────

describe('exclusion happens on the server, before the numbers exist', () => {
  test('the team dataset partitions before any bulk read or metric', () => {
    const source = read(TEAM_ROUTE)
    const partitionAt = source.lastIndexOf('partitionByTracking(inScope)')
    const bulkAt      = source.indexOf('await Promise.all([')
    const loopAt      = source.indexOf('for (const user of userRows) {')
    assert.ok(partitionAt > -1, 'the eligibility partition is gone')
    assert.ok(partitionAt < bulkAt, 'an excluded employee must never be fetched')
    assert.ok(partitionAt < loopAt, 'an excluded employee must never be measured')
    // Every aggregate is derived from `userRows`, which IS the tracked subset.
    assert.ok(source.includes('const userIds = userRows.map(u => u.id)'),
      'the bulk reads must be scoped to the tracked list')
  })

  test('the team EOD register applies the same rule', () => {
    const source = read(EOD_ROUTE)
    assert.ok(source.includes('isPerformanceTracked'),
      'the EOD register must exclude held-out employees too')
    assert.ok(source.includes('performance_tracking_enabled'),
      'the EOD register must read the participation column')
  })

  test('one shared helper decides it, not a rule per route', () => {
    for (const path of [TEAM_ROUTE, EOD_ROUTE]) {
      assert.match(read(path), /from '@\/lib\/performanceEligibility'/,
        `${path} must use the shared eligibility helper`)
    }
  })

  test('no employee is filtered by name, anywhere', () => {
    for (const path of [TEAM_ROUTE, EOD_ROUTE, 'src/lib/performanceEligibility.ts']) {
      const code = read(path).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      assert.ok(!/\bNitish\b/i.test(code), `${path} filters by name`)
      assert.ok(!/full_name\s*(===|==|\.includes|ilike)/i.test(code),
        `${path} matches an employee by display name`)
    }
  })
})

// ─── 5. Control Center owns the setting ──────────────────────────────────────

describe('Control Center', () => {
  const members = read(MEMBERS)

  test('the employee editor exposes it, in its own group', () => {
    assert.ok(members.includes('Included in Performance'), 'the setting is not offered')
    assert.match(members, /memberGroupTitle\}>Performance</, 'it needs its own group')
  })

  test('it writes the existing field through the existing admin route', () => {
    assert.match(members, /fetch\('\/api\/update-employee', \{\s*\n?\s*method: 'PATCH'/)
    assert.ok(members.includes('performance_tracking_enabled: next'))
  })

  test('the editor can actually see the current value', () => {
    assert.ok(read('src/app/api/admin-members/route.ts').includes('performance_tracking_enabled'),
      'the members list must return the field or the toggle renders a guess')
    assert.ok(members.includes('member.performance_tracking_enabled !== false'),
      'absent must read as included, matching isPerformanceTracked')
  })

  test('it does not duplicate the permission controls', () => {
    // Participation and access are different questions. The three permission
    // actions belong to Access Control and must not be re-offered here.
    const group = members.slice(members.indexOf('── Performance ──'), members.indexOf('── Access ──'))
    for (const action of ['view_team', 'view_all', 'performance:view']) {
      assert.ok(!group.includes(action),
        `the participation group must not restate the ${action} permission`)
    }
    assert.ok(group.includes('separate from Performance'),
      'the group must say that participation is not access')
  })
})

// ─── 6. The production configuration ─────────────────────────────────────────

describe('20261112000000', () => {
  const sql = read(MIGRATION)
  const code = sql.replace(/--[^\n]*/g, '')

  test('it is a DATA migration — no schema is touched', () => {
    for (const ddl of ['create table', 'alter table', 'drop ', 'create or replace function']) {
      assert.ok(!new RegExp(ddl, 'i').test(code), `the migration must not ${ddl}`)
    }
    assert.equal((code.match(/^\s*update public\./gm) ?? []).length, 1, 'exactly one UPDATE')
  })

  test('it targets a stable id, never a display name', () => {
    assert.match(code, /where id = '58ec48e3-d252-4660-b61b-4db48fb58e9e'/)
    assert.ok(!/full_name/.test(code), 'no display-name matching')
  })

  test('it refuses to act on the wrong person', () => {
    assert.match(sql, /raise exception\s*\n?\s*'refusing to change Performance participation/)
    assert.match(sql, /v_target\.email is distinct from 'nitish\.bansal4956@gmail\.com'/)
  })

  test('it changes participation and NOTHING about access', () => {
    // The only column written is the participation flag and its note.
    const set = code.slice(code.indexOf('set '), code.indexOf('where id ='))
    assert.ok(set.includes('performance_tracking_enabled = false'))
    assert.ok(set.includes('performance_tracking_note'))
    // Assignments, not substrings — the note's own text mentions the word
    // "role" while describing why the partner is held out, and that is prose,
    // not a column being written.
    const assigned = [...set.matchAll(/(\w+)\s*=(?!=)/g)].map(m => m[1])
    assert.deepEqual(assigned.sort(), ['performance_tracking_enabled', 'performance_tracking_note'],
      'the migration must write the participation flag and its note, and nothing else')
    for (const table of ['employee_permission_overrides', 'role_permissions', 'permission_modules']) {
      assert.ok(!code.includes(table), `the migration must not touch ${table}`)
    }
    // …and it asserts as much afterwards.
    assert.match(sql, /this migration must not touch roles/)
    assert.match(sql, /participation is not access/)
  })

  test('it deletes no history', () => {
    for (const table of ['daily_work_logs', 'activity_log', 'performance_app_opens', 'tasks']) {
      assert.ok(!code.includes(table), `the migration must not touch ${table}`)
    }
    assert.ok(!/\bdelete\b/i.test(code), 'the migration must delete nothing')
  })

  test('it is idempotent and safe on a database without that employee', () => {
    assert.match(code, /performance_tracking_enabled is distinct from false/)
    assert.match(sql, /if v_target\.id is null then/)
    assert.match(sql, /raise notice 'Performance participation: target account absent/)
  })
})
