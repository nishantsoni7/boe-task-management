/**
 * Performance access — enforcement, asserted against the source that enforces it.
 *
 * derivePerformanceCapabilities being correct is worth nothing if a route does
 * not ask it. This file is the other half: it reads the actual route files and
 * the actual migration, so a capability cannot quietly stop being checked and a
 * role test cannot quietly come back. Same method as enforcement.test.ts,
 * teamPerformanceQueries.test.ts and moduleParentGate.test.ts.
 *
 * THE SECURITY CLAIM UNDER TEST, in the words of the requirement:
 *
 *   · a caller without Personal Performance cannot reach the personal endpoints
 *     by typing the URL;
 *   · a caller without Team Performance cannot retrieve team data;
 *   · a Team Performance caller without `view_all` cannot obtain all-employee
 *     data by manipulating query parameters;
 *   · no route trusts a client-supplied role, actor id, employee id or
 *     permission value.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/performanceAccessEnforcement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MODULE_ENFORCEMENT } from './enforcement'

const read = (path: string) => readFileSync(path, 'utf8')

const ROUTES = {
  personalMetrics: 'src/app/api/performance-metrics/route.ts',
  teamMetrics:     'src/app/api/performance-metrics/team/route.ts',
  dailyLog:        'src/app/api/daily-log/route.ts',
  teamEod:         'src/app/api/eod-logs/team/route.ts',
  audit:           'src/app/api/performance-audit/route.ts',
  personalLog:     'src/app/api/performance/route.ts',
} as const

const MIGRATION = 'supabase/migrations/20261109000000_performance_personal_and_team_capabilities.sql'
const CORRECTION = 'supabase/migrations/20261110000000_performance_team_visibility_is_granted_not_inherited.sql'

// ─── 1. No Performance route decides access from a role ──────────────────────

describe('the role tests are gone', () => {
  test('no Performance route reads users.role to authorize', () => {
    for (const [name, path] of Object.entries(ROUTES)) {
      const source = read(path)
      assert.ok(!/\['admin', 'manager'\]\.includes/.test(source),
        `${name} still authorizes with an admin/manager role list`)
      assert.ok(!/canViewTeamPerformance|canViewPerformanceOf/.test(source),
        `${name} still calls a deleted role helper`)
    }
  })

  test('the deleted helpers are not re-exported from performanceCalendar', () => {
    const source = read('src/lib/performanceCalendar.ts')
    assert.ok(!/export function canViewTeamPerformance|export function canViewPerformanceOf/.test(source),
      'a role test that still compiles is a role test somebody will reach for')
  })

  test('every Performance route resolves capabilities from the bearer token', () => {
    for (const [name, path] of Object.entries(ROUTES)) {
      assert.ok(read(path).includes('resolvePerformanceAccess'),
        `${name} does not resolve Performance capabilities`)
    }
  })
})

// ─── 2. Personal Performance is enforced, not merely navigated to ────────────

describe('personal endpoints require Personal Performance', () => {
  test('POST /api/daily-log refuses an EOD without canSubmitOwnEod', () => {
    const source = read(ROUTES.dailyLog)
    assert.match(source, /if \(!capabilities\.canSubmitOwnEod\) \{\s*\n\s*return NextResponse\.json\(\{ error: 'Forbidden' \}, \{ status: 403 \}\)/,
      'submitting an EOD is no longer gated on Personal Performance')
    // And the author is still the token's user, never a body field.
    assert.ok(source.includes('user_id:   caller.id'),
      'the EOD author must come from the resolved caller')
    assert.ok(!/user_id:\s*body\.|user_id:\s*userId/.test(source),
      'the EOD author must never come from the request body')
  })

  test('/api/performance is gated for both GET and POST', () => {
    const source = read(ROUTES.personalLog)
    assert.ok(source.includes('canAccessPersonalPerformance'),
      'the personal log route no longer checks Personal Performance')
    assert.equal((source.match(/await personalAccess\(token\)/g) ?? []).length, 2,
      'both handlers must resolve access')
  })

  test('reading your own figures asks the personal capability, not the team one', () => {
    // canReadPerformanceOf answers the self case with
    // canAccessPersonalPerformance and never falls through to team scope, so a
    // caller whose personal access is off cannot read themselves via `?userId=`.
    const source = read('src/lib/permissions/performance.ts')
    assert.match(source, /if \(caller\.id === target\.id\) return capabilities\.canAccessPersonalPerformance/)
  })
})

// ─── 3. Team endpoints require Team Performance ──────────────────────────────

describe('team endpoints require Team Performance', () => {
  for (const [name, path] of [['team metrics', ROUTES.teamMetrics], ['team EOD register', ROUTES.teamEod]] as const) {
    test(`${name} refuses a caller without canAccessTeamPerformance`, () => {
      const source = read(path)
      assert.match(source, /if \(!capabilities\.canAccessTeamPerformance\) \{\s*\n\s*return NextResponse\.json\(\{ error: 'Forbidden' \}, \{ status: 403 \}\)/,
        `${name} no longer refuses without team access`)
    })
  }
})

// ─── 4. `view_all` is what widens the scope — never a query parameter ────────

describe('scope cannot be widened from the request', () => {
  test('the team dataset filters its user rows by the resolved scope', () => {
    const source = read(ROUTES.teamMetrics)
    assert.ok(source.includes('isWithinTeamPerformanceScope(caller, capabilities, user)'),
      'the team dataset no longer applies a visibility scope')
  })

  test('the team EOD register filters its author map by the resolved scope', () => {
    const source = read(ROUTES.teamEod)
    assert.ok(source.includes('isWithinTeamPerformanceScope(caller, capabilities, u)'),
      'the EOD register no longer applies a visibility scope')
  })

  test('per-employee routes read the target department from the database', () => {
    // The scope decision needs the TARGET's department. Taking it from the
    // request would let `?userId=` carry its own answer, which is precisely the
    // query-parameter escalation this must not allow.
    for (const [name, path] of [['personal metrics', ROUTES.personalMetrics], ['daily log', ROUTES.dailyLog]] as const) {
      const source = read(path)
      assert.match(source, /\.from\('users'\)\s*\n?\s*\.select\('id, team'\)/,
        `${name} does not read the target department from the database`)
      assert.ok(source.includes('canReadPerformanceOf(caller, capabilities, target)'),
        `${name} does not authorize the resolved target`)
    }
  })

  test('the reflection route authorizes the target it actually read', () => {
    const source = read(ROUTES.audit)
    assert.ok(source.includes('canReadPerformanceOf(caller, capabilities, target)'),
      'the reflection route no longer authorizes its target')
    // The read must precede the decision, or the decision has no department.
    assert.ok(source.indexOf("select('id, full_name, team, position, role')")
            < source.indexOf('canReadPerformanceOf(caller, capabilities, target)'),
      'the target must be read before it is authorized')
  })

  test('an unreadable target is refused rather than defaulted', () => {
    for (const path of [ROUTES.personalMetrics, ROUTES.dailyLog]) {
      assert.match(read(path), /if \(!targetScope\) return NextResponse\.json\(\{ error: 'Forbidden' \}, \{ status: 403 \}\)/,
        'a target that cannot be read must not be authorized')
    }
  })
})

// ─── 5. The UI gates read the same capabilities ──────────────────────────────

describe('the screens ask the same question as the routes', () => {
  test('/performance/team has its own route guard', () => {
    const source = read('src/app/performance/team/layout.tsx')
    assert.ok(source.includes('canAccessTeamPerformance'), 'the team guard checks nothing')
    assert.ok(source.includes("router.replace('/performance')"),
      'a denied caller should land on their own report')
    // children render in no state but allowed — the ModuleGuard property.
    assert.match(source, /if \(!allowed\) return <LoadingScreen \/>/)
  })

  test('the team page no longer carries its own role redirect', () => {
    const source = read('src/app/performance/team/page.tsx')
    assert.ok(!/\['admin', 'manager'\]\.includes/.test(source),
      'the team page still redirects on a role')
  })

  test('the personal page no longer ejects a non-admin holding a View As target', () => {
    const source = read('src/app/performance/page.tsx')
    assert.ok(!/callerProfile\?\.role !== 'admin'/.test(source),
      'the admin-only View As gate is back — this is the bounce that hid a manager’s own report')
    assert.ok(!source.includes("router.push('/dashboard')"),
      'the personal Performance page must not eject anyone to the dashboard')
    assert.ok(source.includes('capabilities.canAccessTeamPerformance'),
      'View As on the personal page is no longer decided by a capability')
  })

  test('the launcher destination follows the capability, not the role', () => {
    const source = read('src/app/modules/page.tsx')
    assert.ok(source.includes('performanceCapabilities.canAccessTeamPerformance'),
      'the Performance card destination is no longer capability-derived')
    assert.ok(!/effectiveProfile\?\.role === 'admin' \|\| effectiveProfile\?\.role === 'manager'\)\s*\n?\s*\? '\/performance\/team'/.test(source),
      'the role-derived Performance href is back')
  })

  test('Control Center names the three capabilities in Performance’s own words', () => {
    const source = read('src/app/api/control-center/permissions/employees/[id]/route.ts')
    assert.match(source, /performance: \{[\s\S]*?view:\s*'Personal Performance'/)
    assert.match(source, /performance: \{[\s\S]*?view_team:\s*'Team Performance'/)
    assert.match(source, /performance: \{[\s\S]*?view_all:\s*'View All Employees'/)
  })
})

// ─── 6. The enforcement registry tells the truth ─────────────────────────────

describe('MODULE_ENFORCEMENT.performance', () => {
  test('claims exactly the three actions that are checked', () => {
    assert.deepEqual(MODULE_ENFORCEMENT.performance.enforcedActions,
      ['view', 'view_team', 'view_all'])
    assert.equal(MODULE_ENFORCEMENT.performance.state, 'partial')
  })
})

// ─── 7. The migration ────────────────────────────────────────────────────────

describe('20261109000000', () => {
  const sql = read(MIGRATION)

  test('registers both actions against the performance module', () => {
    assert.match(sql, /insert into public\.permission_actions[\s\S]*'view_team'/)
    assert.match(sql, /insert into public\.module_permission_actions[\s\S]*'view_team', 'view_all'/)
  })

  test('does not rename view_all underneath Orders and Finance', () => {
    // DO NOTHING, not DO UPDATE: display_name is global per action key.
    assert.match(sql, /insert into public\.permission_actions[\s\S]*?on conflict \(action_key\) do nothing;/)
  })

  test('grants the two new actions at ROLE level to admin and manager', () => {
    // SUPERSEDED BY 20261110000000, which deletes the `manager` half. This
    // assertion is about the CONTENT of an applied migration, which does not
    // change, and it is kept so the correction below has something to be a
    // correction to. What production actually resolves is asserted in the
    // 20261110000000 block.
    assert.match(sql, /insert into public\.role_permissions[\s\S]*\('admin'\), \('manager'\)/)
    assert.match(sql, /where m\.module_key = 'performance'[\s\S]*a\.action_key in \('view_team', 'view_all'\)/)
  })

  test('touches no employee override and names no individual', () => {
    assert.ok(!/employee_permission_overrides/.test(sql.replace(/--[^\n]*/g, '')),
      'no employee’s hand-made grant may be overwritten by this migration')
    // A user id, an email, or a name would be a hard-coded exception in SQL.
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sql),
      'no user id may appear in this migration')
    assert.ok(!/@gmail\.com|@bestofexports/i.test(sql), 'no email may appear in this migration')
    assert.ok(!/\bDhruv\b/i.test(sql.replace(/--[^\n]*/g, '')),
      'no individual may be named in the executable body')
  })

  test('is idempotent — every insert states its conflict behaviour', () => {
    const inserts = [...sql.matchAll(/insert into public\.\w+/g)]
    assert.equal(inserts.length, 3, 'unexpected number of inserts')
    assert.equal((sql.match(/on conflict/g) ?? []).length, 3,
      'every insert must be safe to re-run')
  })

  test('asserts what it did, or fails', () => {
    assert.match(sql, /raise exception 'performance should link view_team and view_all/)
    assert.match(sql, /raise exception 'expected 4 allowed admin\/manager role grants/)
    const blocks = [...sql.matchAll(/^do \$\$/gm)]
    assert.equal(blocks.length, 1, 'expected exactly one assertion block')
  })
})

// ─── 8. The correction: management visibility is granted, never inherited ────

describe('20261110000000', () => {
  const sql = read(CORRECTION)

  test('it is a NEW file — the applied migration is not edited', () => {
    // 20261109000000 is in production. Editing an applied migration makes the
    // repository disagree with the database it claims to describe.
    assert.notEqual(MIGRATION, CORRECTION)
    assert.ok(read(MIGRATION).includes("('admin'), ('manager')"),
      'the applied migration must be left exactly as it was applied')
  })

  test('removes the manager role grants and nothing else', () => {
    assert.match(sql, /delete from public\.role_permissions/)
    // Scoped three ways: this module, these two actions, non-admin roles.
    assert.match(sql, /pm\.module_key = 'performance'/)
    assert.match(sql, /pa\.action_key in \('view_team', 'view_all'\)/)
    assert.match(sql, /rp\.role <> 'admin'/)
    // Exactly one DELETE in the whole file.
    assert.equal((sql.match(/^delete from/gm) ?? []).length, 1)
  })

  test('DELETEs rather than writing an explicit role-level deny', () => {
    // role_permissions has no revoked_at, and `allowed = false` is an ACTIVE
    // deny that says something about every future manager. Deleting lets the
    // decision fall through to the module default. Same reasoning as
    // 20260723000000 §2.
    assert.ok(!/update public\.role_permissions/i.test(sql),
      'the manager rows must be removed, not set to false')
  })

  test('preserves the registered actions', () => {
    for (const table of ['permission_actions', 'module_permission_actions']) {
      assert.ok(!new RegExp(`(insert into|update|delete from) public\.${table}`, 'i')
        .test(sql.replace(/--[^\n]*/g, '')),
        `${table} must not be touched — this file corrects who holds an action, never whether it exists`)
    }
    assert.match(sql, /raise exception 'view_team and view_all must stay registered and default-deny/)
  })

  test('preserves admin access', () => {
    assert.match(sql, /raise exception 'admin role grants on performance dropped to/)
  })

  test('grants the one reviewed employee an EMPLOYEE-LEVEL override', () => {
    assert.match(sql, /insert into public\.employee_permission_overrides/)
    assert.match(sql, /pa\.action_key in \('view_team', 'view_all'\)/)
    // Targeted by the stable primary key, which is the repository's convention
    // for a per-employee grant (20260723000000 §3a/§3b) — never by display name.
    assert.match(sql, /u\.id = '61f4a1f7-3c2a-435f-abca-f884301dcc96'/)
    assert.ok(!/full_name\s*(=|ilike)/i.test(sql),
      'an employee must never be matched by display name')
    // granted_by is resolved to the acting administrator, not hardcoded.
    assert.match(sql, /select id from public\.users where role = 'admin' and is_active order by created_at limit 1/)
  })

  test('refuses to grant the wrong person company-wide visibility', () => {
    assert.match(sql, /raise exception 'refusing to grant company-wide Performance visibility/)
    assert.match(sql, /v_target\.email is distinct from 'boebdm@gmail\.com'/)
    assert.match(sql, /raise exception 'refusing to grant Performance visibility to an inactive or deleted account/)
  })

  test('never takes Personal Performance away', () => {
    // The bug the whole piece of work exists to prevent coming back.
    assert.match(sql, /raise exception 'the reviewed account lost Personal Performance/)
    assert.ok(!/'view'[^_]/.test(
      sql.split('do $$')[0].replace(/--[^\n]*/g, '')),
      'the executable body before the assertions must not mention the personal `view` action at all')
  })

  test('disturbs no unrelated override', () => {
    const body = sql.replace(/--[^\n]*/g, '')
    // No soft-revoke, no delete, no blanket update of anybody's overrides.
    assert.ok(!/revoked_at\s*=\s*now\(\)/.test(body),
      'no existing override may be revoked by this migration')
    assert.ok(!/delete from public\.employee_permission_overrides/i.test(body))
    // The only write is the ON CONFLICT re-activation of the two rows it owns.
    assert.equal((body.match(/insert into public\.employee_permission_overrides/g) ?? []).length, 1)
    assert.match(sql, /on conflict \(user_id, module_id, action_id\) do update/)
  })

  test('is idempotent, and does not rewrite the audit trail on a re-run', () => {
    // granted_at / granted_by are absent from the DO UPDATE clause, so a second
    // run cannot restamp when the authority was first given.
    const conflictClause = sql.slice(sql.indexOf('on conflict (user_id'))
    assert.ok(!/granted_at/.test(conflictClause.split(';')[0]),
      'a re-run must not rewrite granted_at')
    assert.ok(!/granted_by/.test(conflictClause.split(';')[0]),
      'a re-run must not rewrite granted_by')
  })

  test('does nothing at all on a database without that employee', () => {
    // INSERT ... SELECT FROM users, so a fresh local stack writes zero rows and
    // does not fail. The grant is a production fact, not a schema fact.
    assert.match(sql, /from public\.users u\s*\n\s*cross join public\.permission_modules pm/)
    assert.match(sql, /if v_target\.id is not null then/)
  })
})
