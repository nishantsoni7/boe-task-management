/**
 * WHAT EACH KIND OF EMPLOYEE ACTUALLY ENDS UP WITH, once 20261017000000 is
 * applied — admin, manager, member, an explicitly assigned user, and somebody
 * unauthorized.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three true statements about this module read, together, as a contradiction:
 *
 *   "role defaults are admin only"     — role_permissions gets admin rows.
 *   "verify is PROTECTED, so no preset grants it"
 *   "the migration grants verify to nobody"
 *
 * They are describing three DIFFERENT levels of one hierarchy, and the only
 * honest way to settle what an administrator can actually do is to resolve
 * them the way the database does. So this file models
 * resolve_effective_permissions() — employee_override > department > role >
 * system_default, from 20260660_create_permission_engine.sql §7 — and drives it
 * with the seed rows THIS migration writes, read out of the migration text
 * rather than retyped.
 *
 * WHAT IT IS AND IS NOT. It is a faithful model of the resolver plus a proof
 * that the migration seeds what the model assumes. It is NOT a live database
 * check: nothing here connects to Postgres, and the migration has not been
 * applied anywhere. A live confirmation is still required before this ships,
 * and is listed in the module doc.
 *
 * Fictional users only.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/customerReviewEffectiveAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveCustomerReviewCapabilities } from './customerReviewOutreach'
import { PROTECTED_ACTIONS, PRESET_LEVELS, presetAllowedActions } from './levels'
import type { EffectivePermission, PermissionLevel } from './types'

const ROOT = process.cwd()
const sql = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'),
  'utf8',
).replace(/\r\n/g, '\n')
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const MODULE = 'customer_review_requests'
const ACTIONS = ['use', 'verify'] as const
type Action = (typeof ACTIONS)[number]

// ── The seed, read out of the migration rather than assumed ─────────────────

describe('what the migration actually seeds', () => {
  test('the module is registered, so the resolver returns rows at all', () => {
    // resolve_effective_permissions returns NOTHING for an unregistered or
    // inactive module — every action would then resolve false for everyone,
    // admins included. permission_modules.is_active defaults to true
    // (20260660 §1), and this migration does not override it.
    assert.ok(code.includes("insert into public.permission_modules (module_key, display_name, description)"))
    // THE MODULE KEY IS UNCHANGED AND THE DISPLAY NAME IS NOT. The key is what
    // every existing Control Center grant is written against; the display name
    // is what a human reads, and it is what changed when the module became an
    // internal test workflow.
    assert.ok(code.includes(`'${MODULE}', 'Review Workflow Test (Internal)'`))
    // Scoped to the registration statement: users.is_active appears all over
    // this migration and is a different column entirely.
    const registration = code.slice(
      code.indexOf('insert into public.permission_modules'),
      code.indexOf('insert into public.permission_actions'),
    )
    assert.equal(/is_active/.test(registration), false, 'the module must not be seeded inactive')
  })

  test('both actions are registered against it, deny-by-default', () => {
    assert.ok(code.includes("join public.permission_actions pa on pa.action_key in ('use', 'verify')"))
    assert.ok(/select pm\.id, pa\.id, false/.test(code), 'default_allowed must be false')
  })

  test('exactly one role receives anything, and it is admin', () => {
    const grants = [...code.matchAll(/insert into public\.role_permissions[\s\S]*?;/g)]
    assert.equal(grants.length, 1)
    assert.ok(grants[0][0].includes("select 'admin'"))
    assert.equal(grants[0][0].includes("'manager'"), false)
    assert.equal(grants[0][0].includes("'member'"), false)
    // The admin grant covers EVERY action the module registers, not a subset —
    // it joins module_permission_actions with no action filter.
    assert.equal(grants[0][0].includes('pa.action_key'), false)
  })

  test('no department row and no employee override is created', () => {
    assert.equal(code.includes('insert into public.department_permissions'), false)
    assert.equal(code.includes('insert into public.employee_permission_overrides'), false)
  })
})

// ── The resolver, modelled ──────────────────────────────────────────────────

type Level = { employeeOverride?: boolean; department?: boolean; role?: boolean }

/**
 * resolve_effective_permissions(), as SQL implements it:
 * COALESCE(employee_override, department, role, system_default, false), with
 * `source` naming whichever level was not null.
 *
 * system_default is false for both actions — asserted above against the
 * migration, so this constant is not an assumption.
 */
const SYSTEM_DEFAULT = false

function resolve(levels: Partial<Record<Action, Level>>): EffectivePermission[] {
  return ACTIONS.map(actionKey => {
    const level = levels[actionKey] ?? {}
    let allowed = SYSTEM_DEFAULT
    let source: PermissionLevel = 'system_default'
    if (level.role !== undefined) { allowed = level.role; source = 'role' }
    if (level.department !== undefined) { allowed = level.department; source = 'department' }
    if (level.employeeOverride !== undefined) { allowed = level.employeeOverride; source = 'employee_override' }
    return { actionKey, allowed, source }
  })
}

/** The role rows this migration writes: admin true on both, nobody else. */
const roleLevels = (role: string): Partial<Record<Action, Level>> =>
  role === 'admin'
    ? { use: { role: true }, verify: { role: true } }
    : {}

// ── The five people ─────────────────────────────────────────────────────────

describe('EFFECTIVE PERMISSIONS, person by person', () => {
  test('ADMIN: holds use AND verify, from the role level, with no override', () => {
    const effective = resolve(roleLevels('admin'))
    assert.deepEqual(effective, [
      { actionKey: 'use',    allowed: true, source: 'role' },
      { actionKey: 'verify', allowed: true, source: 'role' },
    ])
    // And the application agrees — FROM THE ENGINE ROWS, which is now the only
    // route for `use`. An administrator holds it because the role_permissions
    // seed grants it, not because of their role name.
    assert.deepEqual(deriveCustomerReviewCapabilities('admin', effective), {
      canAccessModule: true, canUse: true, canVerify: true,
    })

    // WITH NO ROWS AT ALL the answer differs, and that difference is the whole
    // of the correction: candidate authority comes from the resolved
    // permission, verifier authority still admits the role.
    assert.deepEqual(deriveCustomerReviewCapabilities('admin', []), {
      canAccessModule: true, canUse: false, canVerify: true,
    })
  })

  test('MANAGER: holds neither, and falls through to system default', () => {
    const effective = resolve(roleLevels('manager'))
    assert.deepEqual(effective, [
      { actionKey: 'use',    allowed: false, source: 'system_default' },
      { actionKey: 'verify', allowed: false, source: 'system_default' },
    ])
    assert.deepEqual(deriveCustomerReviewCapabilities('manager', effective), {
      canAccessModule: false, canUse: false, canVerify: false,
    })
  })

  test('MEMBER: identical to manager — nothing is conferred by a role name', () => {
    const effective = resolve(roleLevels('member'))
    assert.equal(effective.every(p => !p.allowed), true)
    assert.deepEqual(deriveCustomerReviewCapabilities('member', effective), {
      canAccessModule: false, canUse: false, canVerify: false,
    })
  })

  test('ASSIGNED USER (Control Center → Custom → Use): opens the module, cannot verify', () => {
    const effective = resolve({ ...roleLevels('member'), use: { employeeOverride: true } })
    assert.deepEqual(effective, [
      { actionKey: 'use',    allowed: true,  source: 'employee_override' },
      { actionKey: 'verify', allowed: false, source: 'system_default' },
    ])
    assert.deepEqual(deriveCustomerReviewCapabilities('member', effective), {
      canAccessModule: true, canUse: true, canVerify: false,
    })
  })

  test('ASSIGNED VERIFIER (Custom → Verify, which brings Use): both', () => {
    // withRequiredDependencies adds `use` on the save — see the dependency test
    // in customerReviewOutreach.test.ts — so this is the row pair Control
    // Center actually writes.
    const effective = resolve({
      use:    { employeeOverride: true },
      verify: { employeeOverride: true },
    })
    assert.deepEqual(deriveCustomerReviewCapabilities('member', effective), {
      canAccessModule: true, canUse: true, canVerify: true,
    })
  })

  test('UNAUTHORIZED USER: no rows at any level, so nothing', () => {
    const effective = resolve({})
    assert.equal(effective.every(p => !p.allowed && p.source === 'system_default'), true)
    assert.deepEqual(deriveCustomerReviewCapabilities('member', effective), {
      canAccessModule: false, canUse: false, canVerify: false,
    })
    // And an unidentified caller — a failed profile read — is denied too.
    assert.deepEqual(deriveCustomerReviewCapabilities(null, effective), {
      canAccessModule: false, canUse: false, canVerify: false,
    })
  })

  test('AN EXPLICIT DENY beats the admin role row, ON THE SCREEN AS WELL', () => {
    // employee_override is the highest level, so revoking an individual admin
    // is expressible.
    const effective = resolve({ use: { role: true, employeeOverride: false }, verify: { role: true } })
    assert.equal(effective.find(p => p.actionKey === 'use')?.allowed, false)
    assert.equal(effective.find(p => p.actionKey === 'use')?.source, 'employee_override')

    // AND THE DERIVATION NOW AGREES. The line that stood here asserted the
    // opposite — that the role short-circuit "still admits them" — and called
    // the disagreement between screen and database "a real asymmetry somebody
    // will meet". Somebody did: the screen drew a Book button that
    // book_customer_review_test_card() refuses 42501, because it asks
    // resolve_permission and has no administrator branch. The screen and the
    // database give the same answer now.
    assert.equal(deriveCustomerReviewCapabilities('admin', effective).canUse, false)

    // Verifier authority is unaffected, and is checked here so this test is
    // about `use` rather than about administrators in general.
    assert.equal(deriveCustomerReviewCapabilities('admin', effective).canVerify, true)
  })
})

// ── The three statements that read as a contradiction ───────────────────────

describe('the three statements, reconciled', () => {
  test('"role defaults are admin only" — true, and it is why admins hold verify', () => {
    assert.equal(resolve(roleLevels('admin')).find(p => p.actionKey === 'verify')?.allowed, true)
    assert.equal(resolve(roleLevels('manager')).find(p => p.actionKey === 'verify')?.allowed, false)
  })

  test('"no preset grants verify" — true, and it constrains the UI, not the role level', () => {
    // PROTECTED_ACTIONS governs what the Access Control LEVEL BUTTONS may write.
    // It says nothing about role_permissions, which is a different level.
    assert.ok(PROTECTED_ACTIONS.has('verify'))
    for (const level of PRESET_LEVELS) {
      assert.equal(presetAllowedActions(level, [...ACTIONS]).verify, false, level)
    }
    // An administrator can still tick it deliberately in Custom — that is the
    // whole point of the distinction.
    assert.equal(PROTECTED_ACTIONS.has('use'), false)
  })

  test('"the migration grants verify to nobody" — true of EMPLOYEE OVERRIDES only', () => {
    // The migration's own assertion counts employee_permission_overrides, not
    // role_permissions. Both statements are true at once because they are
    // about different levels.
    const assertion = code.slice(code.indexOf('do $$'))
    assert.ok(assertion.includes('employee_permission_overrides'))
    assert.equal(assertion.includes('from public.role_permissions'), false)
  })

  test('THE ANSWER: after this migration an admin holds both; nobody else holds either', () => {
    const results = ['admin', 'manager', 'member'].map(role => ({
      role,
      caps: deriveCustomerReviewCapabilities(role, resolve(roleLevels(role))),
    }))
    assert.deepEqual(results, [
      { role: 'admin',   caps: { canAccessModule: true,  canUse: true,  canVerify: true  } },
      { role: 'manager', caps: { canAccessModule: false, canUse: false, canVerify: false } },
      { role: 'member',  caps: { canAccessModule: false, canUse: false, canVerify: false } },
    ])
  })
})
