/**
 * Team access in Control Center — the rules, the route's guarantees and the
 * wiring. (The engine's behaviour for a team rule and an individual override is
 * proven against Postgres in supabase/tests/exhibition_leads_assertions.sql §9c;
 * the screen is exercised in a browser.)
 *
 * Run: npx tsx --test src/lib/permissions/departmentAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describeTeamRules, parseTeamChanges, stateFromStored, teamRuleAction, TEAM_ACCESS_LABELS, TEAM_ACCESS_STATES,
} from './departmentAccess'
import { PROTECTED_ACTIONS } from './levels'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')

describe('the rule set', () => {
  test('a team rule is written for the module entry action only', () => {
    assert.equal(teamRuleAction(['view']), 'view')
    assert.equal(teamRuleAction(['create', 'view', 'edit']), 'view')
    assert.equal(teamRuleAction(['use', 'verify']), 'use')
    assert.equal(teamRuleAction(['create', 'edit']), null, 'no entry action → nothing to grant to a team')
    assert.equal(PROTECTED_ACTIONS.has('view'), false)
    assert.equal(PROTECTED_ACTIONS.has('use'), false, 'the entry actions are never protected ones')
  })
  test('three states, stored as allow / deny / no row', () => {
    assert.deepEqual([...TEAM_ACCESS_STATES], ['allow', 'block', 'inherit'])
    assert.equal(stateFromStored(true), 'allow')
    assert.equal(stateFromStored(false), 'block')
    assert.equal(stateFromStored(null), 'inherit')
    assert.equal(stateFromStored(undefined), 'inherit')
    for (const s of TEAM_ACCESS_STATES) assert.ok(TEAM_ACCESS_LABELS[s].label && TEAM_ACCESS_LABELS[s].hint)
  })
  test('requests are validated, never trusted', () => {
    const ok = parseTeamChanges({ changes: [{ departmentKey: 'sales', state: 'allow' }, { departmentKey: 'bdm', state: 'inherit' }] })
    assert.ok(ok.ok && ok.changes.length === 2)
    for (const bad of [
      null, {}, { changes: [] }, { changes: 'sales' },
      { changes: [{ departmentKey: 'sales', state: 'owner' }] },
      { changes: [{ departmentKey: '../x', state: 'allow' }] },
      { changes: [{ departmentKey: '', state: 'allow' }] },
      { changes: [{ state: 'allow' }] },
      { changes: [{ departmentKey: 'sales', state: 'allow' }, { departmentKey: 'sales', state: 'block' }] },
      { changes: Array.from({ length: 101 }, (_, i) => ({ departmentKey: `d${i}`, state: 'allow' })) },
    ]) assert.equal(parseTeamChanges(bad).ok, false, JSON.stringify(bad)?.slice(0, 60))
  })
  test('the summary sentence says who is in and who is out', () => {
    assert.equal(describeTeamRules([{ name: 'Sales', state: 'allow' }, { name: 'BDM', state: 'allow' }, { name: 'Design', state: 'block' }]),
      'Allowed for Sales, BDM; blocked for Design.')
    assert.match(describeTeamRules([{ name: 'Sales', state: 'inherit' }]), /No team has a rule/)
  })
})

describe('the route', () => {
  const route = read('src/app/api/control-center/permissions/modules/[key]/departments/route.ts')
  test('administrators only, decided from the session on both verbs', () => {
    assert.match(route, /p\.role !== 'admin' \|\| p\.is_active !== true \|\| p\.is_deleted === true/)
    assert.equal((route.match(/await adminClient\(req\)/g) ?? []).length, 2)
    assert.equal((route.match(/error: 'Unauthorized' \}, \{ status: 401/g) ?? []).length, 2)
    assert.doesNotMatch(route, /body\.(userId|adminId|actor)/, 'no identity comes from the body')
  })
  test('only the entry action is written, and only to department_permissions', () => {
    assert.match(route, /teamRuleAction\(actions\.map/)
    assert.match(route, /action_id: mod\.entry\.id/)
    assert.match(route, /\.eq\('action_id', mod\.entry\.id\)\.in\('department_id', toClear\)|\.eq\('module_id', mod\.id\)\.eq\('action_id', mod\.entry\.id\)\.in\('department_id', toClear\)/)
    assert.doesNotMatch(route, /employee_permission_overrides|role_permissions|permission_actions'\)\s*\.insert|app_modules/)
  })
  test('self-service modules and modules with no entry permission are refused', () => {
    assert.match(route, /isSelfServiceModule\(key\)/)
    assert.match(route, /has no single entry permission/)
  })
  test('unknown departments are refused before anything is written', () => {
    const put = route.slice(route.indexOf('export async function PUT'))
    assert.ok(put.indexOf('Unknown department') < put.indexOf(".upsert("), 'validation precedes the first write')
  })
  test('answers are never cached', () => {
    assert.match(route, /'Cache-Control': 'no-store, private'/)
  })
})

describe('the screen', () => {
  const card = read('src/components/controlCenter/TeamAccessCard.tsx')
  const page = read('src/app/admin/control-center/permissions/modules/page.tsx')
  const exhibitions = read('src/components/exhibitionLeads/ExhibitionsScreen.tsx')
  test('By Module shows it for the selected module, above the people table, and re-reads the table after a save', () => {
    assert.match(page, /<TeamAccessCard\s+moduleKey=\{selectedKey\}/)
    assert.ok(page.indexOf('<TeamAccessCard') < page.indexOf('<CcToolbar>'))
    assert.match(page, /onSaved=\{\(\) => \{ void matrixQuery\.refetch\(\) \}\}/)
  })
  test('every department has a labelled control, unsaved changes are marked and can be discarded', () => {
    assert.match(card, /aria-label=\{`\$\{d\.departmentName\}: access to \$\{moduleName\}`\}/)
    assert.match(card, /Unsaved/)
    assert.match(card, />Discard</)
    assert.match(card, /disabled=\{saving \|\| dirtyKeys\.length === 0\}/)
  })
  test('it says that an individual setting wins, and what each state means', () => {
    assert.match(card, /still wins over their team/)
    assert.match(card, /Allowed = the team can open it/)
  })
  test('the Exhibitions screen links Admin straight to it', () => {
    assert.ok(exhibitions.includes('/admin/control-center/permissions/modules?module=exhibition_leads'))
  })
  test('the module is a normal, enforced, engine-gated module with a single "view" entry action', () => {
    assert.match(read('src/lib/permissions/modules.ts'), /moduleKey: 'exhibition_leads'[\s\S]*?actionKey: 'view'/)
    assert.match(read('src/lib/permissions/enforcement.ts'), /exhibition_leads:\s*\{\s*state: 'enforced'/)
  })
})
