/**
 * Performance capabilities — behavioural tests.
 *
 * THE RULE UNDER TEST: role and module capability are separate concepts. A
 * Manager may be an individual employee who submits an EOD and carries a score
 * of their own AND a manager who monitors other people through Team Performance;
 * neither implies, nor excludes, the other. Before 20261109000000 `users.role`
 * decided both, and it decided them in opposite directions — which is how a
 * Manager ended up holding Team Performance and losing their own report.
 *
 * Pure data-in/data-out (no DB, no network), the same shape as finance.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/performance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  derivePerformanceCapabilities, canReadPerformanceOf,
  isWithinTeamPerformanceScope, NO_PERFORMANCE_CAPABILITIES,
} from './performance'
import {
  presetAllowedActions, isProtectedAction, withRequiredDependencies,
  dependentActionsToRemove, actionDependencyChain,
} from './levels'
import { getRegisteredModule } from './registry'
import './modules'
import type { EffectivePermission } from './types'

/** Exactly what the `performance` module registers. */
const PERFORMANCE_ACTIONS = [
  'view', 'create', 'edit', 'export', 'manage',
  // Registered by 20261109000000. Both protected: no preset reaches either.
  'view_team', 'view_all',
]

const perms = (allowedActions: string[]): EffectivePermission[] =>
  PERFORMANCE_ACTIONS.map(actionKey => ({
    actionKey,
    allowed: allowedActions.includes(actionKey),
    source: 'employee_override' as const,
  }))

// The four people the defect report is about.
const EMPLOYEE  = { id: 'emp-1',  team: 'sales' }
const COLLEAGUE = { id: 'emp-2',  team: 'sales' }
const OUTSIDER  = { id: 'emp-3',  team: 'design' }
/** Dhruv's shape: role manager, department management. */
const MANAGER   = { id: 'mgr-1',  team: 'management' }

const personalOnly = () => derivePerformanceCapabilities('manager', perms(['view']))
const bothFull     = () => derivePerformanceCapabilities('manager', perms(['view', 'view_team', 'view_all']))
const teamScoped   = () => derivePerformanceCapabilities('manager', perms(['view', 'view_team']))
const teamNoSelf   = () => derivePerformanceCapabilities('manager', perms(['view_team', 'view_all']))

// ─── 1. The module registers what the model needs ────────────────────────────

describe('registration', () => {
  test('the performance module registers exactly these actions', () => {
    const mod = getRegisteredModule('performance')
    assert.ok(mod, 'the performance module is not registered')
    assert.deepEqual(
      mod.actions.map(a => a.actionKey).sort(),
      [...PERFORMANCE_ACTIONS].sort(),
    )
  })

  test('view_team and view_all are protected — no preset hands either out', () => {
    assert.equal(isProtectedAction('view_team'), true)
    assert.equal(isProtectedAction('view_all'), true)
    for (const level of ['no_access', 'viewer', 'contributor', 'manager'] as const) {
      const map = presetAllowedActions(level, PERFORMANCE_ACTIONS)
      assert.equal(map.view_team, false, `${level} must not grant view_team`)
      assert.equal(map.view_all, false, `${level} must not grant view_all`)
    }
  })

  test('the Manager PRESET grants ordinary access, never the team screen', () => {
    // The name collision matters: picking "Manager" from the Access Control
    // dropdown must not be a way to acquire sight of other people's scores.
    const map = presetAllowedActions('manager', PERFORMANCE_ACTIONS)
    assert.equal(map.view, true)
    assert.equal(map.view_team, false)
  })

  test('the dependency chain is view_all → view_team → view', () => {
    assert.deepEqual(actionDependencyChain('view_all'), ['view_team', 'view'])
    assert.deepEqual(actionDependencyChain('view_team'), ['view'])

    // Ticking View All Employees brings both parents with it, so an
    // administrator cannot store a grant with nowhere to act.
    assert.deepEqual(
      withRequiredDependencies(['view_all'], PERFORMANCE_ACTIONS),
      ['view', 'view_team', 'view_all'],
    )
    // Withdrawing Personal Performance takes the whole module with it, rather
    // than leaving the stronger grants standing.
    assert.deepEqual(
      dependentActionsToRemove('view', PERFORMANCE_ACTIONS).sort(),
      ['view_all', 'view_team'],
    )
  })

  test('the chain change does not alter Orders or Finance', () => {
    // Neither registers view_team, so withRequiredDependencies skips the missing
    // link and view_all still resolves to view alone — an action a module does
    // not declare is never invented.
    const ORDERS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'view_all']
    assert.deepEqual(withRequiredDependencies(['view_all'], ORDERS), ['view', 'view_all'])
    assert.ok(dependentActionsToRemove('view', ORDERS).includes('view_all'),
      'removing Orders view must still remove Orders view_all')
  })
})

// ─── 2. Module entry, and the dormant-grant rule ─────────────────────────────

describe('module entry', () => {
  test('no permissions at all means nothing', () => {
    assert.deepEqual(derivePerformanceCapabilities('member', []), NO_PERFORMANCE_CAPABILITIES)
  })

  test('a null role fails closed — a failed profile read is not an employee', () => {
    assert.deepEqual(derivePerformanceCapabilities(null, perms(['view', 'view_team', 'view_all'])),
      NO_PERFORMANCE_CAPABILITIES)
    assert.deepEqual(derivePerformanceCapabilities(undefined, perms(['view'])),
      NO_PERFORMANCE_CAPABILITIES)
  })

  test('view alone is Personal Performance and nothing more', () => {
    const caps = personalOnly()
    assert.equal(caps.canAccessPersonalPerformance, true)
    assert.equal(caps.canSubmitOwnEod, true)
    assert.equal(caps.canAccessTeamPerformance, false)
    assert.equal(caps.canViewAllEmployeePerformance, false)
  })

  test('a stronger action without view grants nothing — not even itself', () => {
    for (const action of ['view_team', 'view_all', 'create', 'edit', 'export', 'manage']) {
      assert.deepEqual(
        derivePerformanceCapabilities('manager', perms([action])),
        NO_PERFORMANCE_CAPABILITIES,
        `${action} must not open the module on its own`,
      )
    }
  })

  test('view_all without view_team confers no company-wide sight', () => {
    const caps = derivePerformanceCapabilities('manager', perms(['view', 'view_all']))
    assert.equal(caps.canAccessTeamPerformance, false)
    assert.equal(caps.canViewAllEmployeePerformance, false)
  })
})

// ─── 3. A Manager holding BOTH capabilities — the required case ──────────────

describe('manager with Personal Performance and Team Performance', () => {
  const caps = bothFull()

  test('can open their own Performance page', () => {
    assert.equal(caps.canAccessPersonalPerformance, true)
    assert.equal(canReadPerformanceOf(MANAGER, caps, MANAGER), true)
  })

  test('can submit their own EOD', () => {
    assert.equal(caps.canSubmitOwnEod, true)
  })

  test('can read their own monthly performance', () => {
    // The monthly view is the same per-employee read with a wider window, so it
    // is authorized by the same predicate.
    assert.equal(canReadPerformanceOf(MANAGER, caps, { id: MANAGER.id, team: MANAGER.team }), true)
  })

  test('can open Team Performance', () => {
    assert.equal(caps.canAccessTeamPerformance, true)
  })

  test('sees every employee when full visibility is enabled', () => {
    assert.equal(caps.canViewAllEmployeePerformance, true)
    for (const person of [EMPLOYEE, COLLEAGUE, OUTSIDER, MANAGER]) {
      assert.equal(isWithinTeamPerformanceScope(MANAGER, caps, person), true,
        `${person.id} must be visible to a full-visibility manager`)
    }
  })

  test('being a Manager does not exclude being scored as an individual', () => {
    // The two are not alternatives. Holding the team screen must never be the
    // reason somebody loses their own report.
    assert.equal(caps.canAccessPersonalPerformance && caps.canAccessTeamPerformance, true)
  })
})

// ─── 4. A Manager WITHOUT Personal Performance ───────────────────────────────

describe('manager without Personal Performance', () => {
  test('cannot reach their own report when view is explicitly denied', () => {
    // An explicit deny at employee level, which outranks the role grant.
    const caps = derivePerformanceCapabilities('manager', [
      { actionKey: 'view',      allowed: false, source: 'employee_override' },
      { actionKey: 'view_team', allowed: true,  source: 'role' },
      { actionKey: 'view_all',  allowed: true,  source: 'role' },
    ])
    assert.equal(caps.canAccessPersonalPerformance, false)
    assert.equal(canReadPerformanceOf(MANAGER, caps, MANAGER), false)
  })

  test('cannot submit an EOD through a direct server request', () => {
    const caps = derivePerformanceCapabilities('manager', perms(['view_team', 'view_all']))
    assert.equal(caps.canSubmitOwnEod, false)
  })

  test('team access is not a back door into their own report', () => {
    // canReadPerformanceOf answers the SELF case with the personal capability
    // and never falls through to the team one, so `?userId=<self>` on a
    // per-employee endpoint is refused exactly like the page is.
    const caps = teamNoSelf()
    assert.equal(canReadPerformanceOf(MANAGER, caps, MANAGER), false)
  })
})

// ─── 5. A Manager WITHOUT Team Performance ───────────────────────────────────

describe('manager without Team Performance', () => {
  const caps = personalOnly()

  test('cannot retrieve team performance data', () => {
    assert.equal(caps.canAccessTeamPerformance, false)
    for (const person of [EMPLOYEE, COLLEAGUE, OUTSIDER]) {
      assert.equal(isWithinTeamPerformanceScope(MANAGER, caps, person), false)
      assert.equal(canReadPerformanceOf(MANAGER, caps, person), false)
    }
  })

  test('not even their own row through the team scope', () => {
    // The team screen is shut, so it is shut for every row including theirs.
    assert.equal(isWithinTeamPerformanceScope(MANAGER, caps, MANAGER), false)
    // Their own report is still theirs — through the personal capability.
    assert.equal(canReadPerformanceOf(MANAGER, caps, MANAGER), true)
  })
})

// ─── 6. Team Performance with limited visibility ─────────────────────────────

describe('team performance without view_all', () => {
  const caps = teamScoped()
  const salesLead = { id: 'lead-1', team: 'sales' }

  test('sees their own department, and themselves', () => {
    assert.equal(isWithinTeamPerformanceScope(salesLead, caps, EMPLOYEE), true)
    assert.equal(isWithinTeamPerformanceScope(salesLead, caps, COLLEAGUE), true)
    assert.equal(isWithinTeamPerformanceScope(salesLead, caps, salesLead), true)
  })

  test('cannot retrieve employees outside that scope', () => {
    assert.equal(isWithinTeamPerformanceScope(salesLead, caps, OUTSIDER), false)
    assert.equal(canReadPerformanceOf(salesLead, caps, OUTSIDER), false)
  })

  test('department matching ignores case and surrounding space', () => {
    assert.equal(isWithinTeamPerformanceScope(
      { id: 'lead-2', team: ' Sales ' }, caps, { id: 'x', team: 'sales' },
    ), true)
  })

  test('a caller with no department of their own sees only themselves', () => {
    // Matching "no department" against other unassigned rows would hand out an
    // arbitrary set of colleagues. Too small beats nobody-chose-this.
    const unassigned = { id: 'lead-3', team: null }
    assert.equal(isWithinTeamPerformanceScope(unassigned, caps, unassigned), true)
    assert.equal(isWithinTeamPerformanceScope(unassigned, caps, { id: 'y', team: null }), false)
    assert.equal(isWithinTeamPerformanceScope(unassigned, caps, EMPLOYEE), false)
  })

  test('an empty-string department is absent, not a department', () => {
    assert.equal(isWithinTeamPerformanceScope(
      { id: 'lead-4', team: '   ' }, caps, { id: 'z', team: '' },
    ), false)
  })
})

// ─── 7. A normal employee ────────────────────────────────────────────────────

describe('normal employee', () => {
  const caps = derivePerformanceCapabilities('member', perms(['view']))

  test('keeps Personal Performance and EOD exactly as before', () => {
    assert.equal(caps.canAccessPersonalPerformance, true)
    assert.equal(caps.canSubmitOwnEod, true)
    assert.equal(canReadPerformanceOf(EMPLOYEE, caps, EMPLOYEE), true)
  })

  test('gains no Team Performance', () => {
    assert.equal(caps.canAccessTeamPerformance, false)
    assert.equal(caps.canViewAllEmployeePerformance, false)
    assert.equal(canReadPerformanceOf(EMPLOYEE, caps, COLLEAGUE), false,
      'a colleague in the same department is still not readable without team access')
    assert.equal(canReadPerformanceOf(EMPLOYEE, caps, OUTSIDER), false)
  })
})

// ─── 8. Admin ────────────────────────────────────────────────────────────────

describe('admin', () => {
  test('behaviour is unchanged — everything, with or without rows', () => {
    for (const permissions of [[], perms([]), perms(['view'])]) {
      const caps = derivePerformanceCapabilities('admin', permissions)
      assert.deepEqual(caps, {
        canAccessPersonalPerformance: true,
        canSubmitOwnEod: true,
        canAccessTeamPerformance: true,
        canViewAllEmployeePerformance: true,
      })
    }
  })

  test('an admin still reads every employee, in every department', () => {
    const caps = derivePerformanceCapabilities('admin', [])
    const admin = { id: 'adm-1', team: 'admin' }
    for (const person of [EMPLOYEE, COLLEAGUE, OUTSIDER, MANAGER, admin]) {
      assert.equal(canReadPerformanceOf(admin, caps, person), true)
    }
  })

  test('an explicit deny does not survive the admin short-circuit', () => {
    // Documenting the established project bypass rather than endorsing it: the
    // launcher, ModuleGuard and every other capability file behave this way, and
    // this file must not be the one that disagrees.
    const caps = derivePerformanceCapabilities('admin', [
      { actionKey: 'view', allowed: false, source: 'employee_override' },
    ])
    assert.equal(caps.canAccessPersonalPerformance, true)
  })
})

// ─── 9. Nothing the client sends can widen a decision ────────────────────────

describe('the capability object is the only input', () => {
  test('scope is decided by capabilities and identity, never by a claimed role', () => {
    // The subject shape carries id and team only. There is no role, no
    // "isManager", and no permission value on it — so a client that invents one
    // has nowhere to put it.
    const caps = teamScoped()
    const spoofed = { id: OUTSIDER.id, team: OUTSIDER.team, role: 'admin' } as unknown as
      { id: string; team: string }
    assert.equal(isWithinTeamPerformanceScope(EMPLOYEE, caps, spoofed), false)
  })
})
