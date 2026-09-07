/**
 * Access levels — behavioural tests.
 *
 * Pure data-in/data-out (no DB, no network). Covers the V1 administrator-facing
 * levels and, above all, the promise that a level never hands over a protected
 * action.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/levels.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCESS_LEVELS,
  PRESET_LEVELS,
  PROTECTED_ACTIONS,
  isProtectedAction,
  standardActionsForLevel,
  presetAllowedActions,
  enableModuleEntry,
  applyPresetToActions,
  protectedActionsClearedByPreset,
  detectAccessLevel,
  needsViewNormalization,
  normalizeGrantedActions,
  allowedMapFromEffective,
  type PresetLevel,
} from './levels'

// Real module action sets, mirroring what production registers (verified
// against permission_modules / module_permission_actions).
const FINANCE = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'allocate', 'allocate_correct']
// Orders no longer registers `approve` or `can_be_order_assignee`: both existed
// only for the retired Order Request workflow (20261007000000). The fixture
// mirrors what production registers, so a preset applied to it produces exactly
// what an administrator would see.
const ORDERS = ['view', 'create', 'edit', 'delete', 'export', 'manage', 'approve_order', 'approve_advance_exception', 'align_production']
const ASSETS = ['view', 'create', 'edit', 'delete', 'manage', 'assign']
const SAMPLES = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'dispatch', 'receive', 'mark_lost', 'close']
const PAYROLL = ['view', 'edit', 'approve', 'export', 'manage', 'admin']
const SHOWROOM = ['view', 'create', 'edit', 'manage']

const granted = (map: Record<string, boolean>) =>
  Object.entries(map).filter(([, v]) => v).map(([k]) => k).sort()

describe('the level vocabulary', () => {
  test('there are exactly five levels, in the agreed order', () => {
    assert.deepEqual([...ACCESS_LEVELS], ['no_access', 'viewer', 'contributor', 'manager', 'custom'])
  })

  test('custom is not a preset — it has no fixed action set', () => {
    assert.deepEqual([...PRESET_LEVELS], ['no_access', 'viewer', 'contributor', 'manager'])
    assert.equal((PRESET_LEVELS as readonly string[]).includes('custom'), false)
  })
})

describe('standard action mapping', () => {
  test('no_access grants nothing, on every module', () => {
    for (const keys of [FINANCE, ORDERS, ASSETS, SAMPLES, PAYROLL, SHOWROOM]) {
      assert.deepEqual(standardActionsForLevel('no_access', keys), [])
    }
  })

  test('viewer grants view only', () => {
    assert.deepEqual(standardActionsForLevel('viewer', FINANCE), ['view'])
    assert.deepEqual(standardActionsForLevel('viewer', ASSETS), ['view'])
  })

  test('contributor grants view, create, edit', () => {
    assert.deepEqual(standardActionsForLevel('contributor', FINANCE), ['view', 'create', 'edit'])
  })

  test('manager grants view, create, edit, approve, export', () => {
    assert.deepEqual(standardActionsForLevel('manager', FINANCE), ['view', 'create', 'edit', 'approve', 'export'])
  })

  test('levels are cumulative — each contains the one below it', () => {
    for (const keys of [FINANCE, ORDERS, SAMPLES]) {
      const viewer = standardActionsForLevel('viewer', keys)
      const contributor = standardActionsForLevel('contributor', keys)
      const manager = standardActionsForLevel('manager', keys)
      assert.ok(viewer.every(a => contributor.includes(a)), 'viewer ⊆ contributor')
      assert.ok(contributor.every(a => manager.includes(a)), 'contributor ⊆ manager')
    }
  })
})

describe('unavailable module actions are never invented', () => {
  test('Payroll has no create, so no level produces one', () => {
    for (const level of PRESET_LEVELS) {
      assert.equal(standardActionsForLevel(level, PAYROLL).includes('create'), false)
    }
  })

  test('Showroom QR has no approve or export, so Manager stops at edit', () => {
    assert.deepEqual(standardActionsForLevel('manager', SHOWROOM), ['view', 'create', 'edit'])
  })

  test('a preset map only ever mentions actions the module registers', () => {
    for (const level of PRESET_LEVELS) {
      const map = presetAllowedActions(level, SHOWROOM)
      assert.deepEqual(Object.keys(map).sort(), [...SHOWROOM].sort())
    }
  })

  test('a module with no actions at all yields an empty map, not a crash', () => {
    assert.deepEqual(presetAllowedActions('manager', []), {})
    assert.equal(detectAccessLevel([], {}), 'no_access')
  })
})

describe('Manager never receives a protected action', () => {
  const modules: [string, string[]][] = [
    ['finance', FINANCE], ['orders', ORDERS], ['assets_access', ASSETS],
    ['sample_tracking', SAMPLES], ['payroll', PAYROLL], ['showroom_qr', SHOWROOM],
  ]

  for (const [name, keys] of modules) {
    test(`${name}: no preset level grants any protected action`, () => {
      for (const level of PRESET_LEVELS) {
        for (const action of standardActionsForLevel(level, keys)) {
          assert.equal(isProtectedAction(action), false, `${level} granted protected "${action}" on ${name}`)
        }
      }
    })
  }

  test('delete is never granted by Manager — the specific regression to avoid', () => {
    assert.equal(presetAllowedActions('manager', FINANCE).delete, false)
    assert.equal(presetAllowedActions('manager', ORDERS).delete, false)
    assert.equal(presetAllowedActions('manager', ASSETS).delete, false)
  })

  test('manage, admin and assign are never granted by Manager', () => {
    assert.equal(presetAllowedActions('manager', FINANCE).manage, false)
    assert.equal(presetAllowedActions('manager', PAYROLL).admin, false)
    assert.equal(presetAllowedActions('manager', PAYROLL).manage, false)
    assert.equal(presetAllowedActions('manager', ASSETS).assign, false)
  })

  test('Sample Tracking lifecycle actions are never granted by Manager', () => {
    const map = presetAllowedActions('manager', SAMPLES)
    for (const action of ['dispatch', 'receive', 'mark_lost', 'close']) {
      assert.equal(map[action], false, `Manager granted ${action}`)
    }
  })

  test('the two retired Orders actions are not even in the module any more', () => {
    // `approve` (Order Request conversion) and `can_be_order_assignee` were
    // registered against Orders until the workflow was retired. An action a
    // module does not declare is never invented by a preset — which is stronger
    // than protecting it, and is why neither appears in the map at all.
    const map = presetAllowedActions('manager', ORDERS)
    assert.equal('approve' in map, false)
    assert.equal('can_be_order_assignee' in map, false)
  })

  test('neither PI review nor advance-exception authority is granted by any preset', () => {
    // The two the business has decided must be handed over one person at a
    // time. A preset reaching either would be an administrator granting money
    // authority by picking a word from a dropdown.
    for (const level of PRESET_LEVELS) {
      const map = presetAllowedActions(level, ORDERS)
      assert.equal(map.approve_order, false, `${level} granted approve_order`)
      assert.equal(map.approve_advance_exception, false,
        `${level} granted approve_advance_exception`)
    }
  })

  test('the protected set is exactly what V1 agreed', () => {
    // Grew by three in 20260903000000, on a production finding: `orders.view`
    // was carrying company-wide sight through the blanket SELECT policies in
    // 20260685000000/20260686000000, so module entry and seeing every order
    // were one grant. Splitting them needs a protected action, and the same
    // reasoning covers company-wide Finance sight and the quotation screens.
    //
    // This assertion is deliberately exact rather than a superset check: the
    // set growing is a decision someone must make on purpose, and an action
    // silently becoming protected would take authority away from whoever holds
    // it the next time an administrator picks a preset.
    //
    // Grew by one again in 20260908000000: `orders.approve_order`, the
    // authority to review an imported PI submission and turn it into a numbered
    // Order. It was deliberately a SEPARATE action from `approve` — which meant
    // Order Request conversion — precisely so that neither implied the other.
    //
    // AND SHRANK BY ONE when the Order Request workflow was retired
    // (20261007000000): `can_be_order_assignee` named a request's assignee and
    // is read by nothing now that no request can be created or edited. It is
    // removed from the set because the Orders module no longer REGISTERS it —
    // an action nothing declares cannot be granted, which is stronger than
    // protecting it. Grants already made are not deleted; they resolve to
    // nothing. `orders.approve` went the same way and was never protected.
    //
    // And by one more in 20260913000000: `orders.approve_advance_exception`,
    // the authority to decide whether BOE will start an order on less than its
    // standard 40% advance — zero included. Separate from `approve_order` for
    // the same reason and in both directions: reviewing a PI and settling money
    // at risk are two decisions, assignable to two different people, and
    // neither may be acquired by picking a preset from a dropdown.
    //
    // And by two more in 20260918000000: `finance.allocate` and
    // `finance.allocate_correct`. Allocation is what makes a verified payment
    // count toward a PI or an Order, and reversal rewrites an allocation that
    // has already been reported. They are separate from each other and from
    // `finance.approve` — which remains payment VERIFICATION — in every
    // direction, so that verifying money, deciding whose it is, and undoing
    // that decision can be held by three different people.
    //
    // And by one more in 20261017000000: `verify`, registered by Customer
    // Review Outreach. It is the authority to say that a customer really did
    // publish a review and to close the request on that basis — the module's
    // only claim about the outside world that anybody else relies on. Its
    // separation from `use` IS the safeguard: the employee who ran the outreach
    // must not be able to sign off their own outreach, so this must never
    // arrive with a preset. `use` is that module's ENTRY action and is
    // deliberately not protected, exactly as `view` is not.
    //
    // And by one more in 20261028000000: `manage_access_records`, registered by
    // Assets & Access. It reads, adds and edits the login records of EVERY
    // employee, on a table that still stores secret_value in plain text — the
    // reason that table was admin-only until it was delegated. Protected for
    // the plainest reason on this list: it must be handed to a named person on
    // purpose, one person at a time, and never acquired by picking "Manager"
    // from a dropdown.
    //
    // And by one more in 20261109000000: `view_team`, registered by Performance.
    // It opens Team Performance — every employee's score, ranking, EOD
    // discipline and attention briefing — which is sight of other people's
    // measured work. The name collision is the reason it must be protected: the
    // `manager` PRESET must not be a way to acquire the management half of
    // Performance, or the split between Personal and Team that 20261109000000
    // exists to create would be undone by a dropdown. `view_all`, already on
    // this list, is what widens it from the caller's own department to the
    // whole company.
    //
    // And by one more in 20261119000000: `orders.align_production`, the Head
    // of Manufacturing's statement that the factory can make a Confirmed Order
    // — the gate between commercial approval and work starting. Every Order is
    // born Not Aligned, and a preset must not hand out the decision that moves
    // it; it is neither approve_order nor manage, and implies neither.
    assert.deepEqual([...PROTECTED_ACTIONS].sort(), [
      'admin', 'align_production', 'allocate', 'allocate_correct', 'approve_advance_exception',
      'approve_order', 'assign', 'close', 'delete',
      'dispatch', 'manage', 'manage_access_records', 'manage_quotations',
      'mark_lost', 'receive', 'verify', 'view_all', 'view_quotations',
      'view_team',
    ])
  })

  test('neither allocation authority is granted by any preset', () => {
    // The Phase 1 equivalent of the two Orders assertions above. Allocating a
    // payment moves money onto a piece of business; reversing an allocation
    // rewrites a financial fact somebody has already acted on. Neither may
    // arrive by picking a word from a dropdown.
    for (const level of PRESET_LEVELS) {
      const map = presetAllowedActions(level, FINANCE)
      assert.equal(map.allocate, false, `${level} granted allocate`)
      assert.equal(map.allocate_correct, false, `${level} granted allocate_correct`)
    }
  })

  test('approve is NOT protected, and allocation does not change that', () => {
    // finance.approve is the verification authority and has always been
    // preset-reachable at Manager. 20260918000000 must not have quietly
    // narrowed it while adding two neighbours.
    assert.equal(isProtectedAction('approve'), false)
    assert.equal(presetAllowedActions('manager', FINANCE).approve, true)
  })

  test('a protected key smuggled into a level is still filtered out', () => {
    // standardActionsForLevel filters at the point of use rather than trusting
    // the table, so this holds even if STANDARD_LEVEL_ACTIONS is edited badly.
    const withProtected = standardActionsForLevel('manager', [...FINANCE, 'delete'])
    assert.equal(withProtected.includes('delete'), false)
  })
})

describe('a standard preset clears protected actions', () => {
  // Aditya's real production Assets grant: view, create, edit, manage, assign.
  const aditya = Object.freeze({
    view: true, create: true, edit: true, manage: true, assign: true, delete: false,
  })

  test('Custom → Viewer clears assign and manage', () => {
    const next = applyPresetToActions('viewer', ASSETS)
    assert.deepEqual(granted(next), ['view'])
    assert.equal(next.assign, false, 'assign must not survive a standard preset')
    assert.equal(next.manage, false)
  })

  test('Custom → Contributor clears assign, manage and delete', () => {
    const next = applyPresetToActions('contributor', ASSETS)
    assert.deepEqual(granted(next), ['create', 'edit', 'view'])
    assert.equal(next.assign, false)
    assert.equal(next.manage, false)
    assert.equal(next.delete, false)
  })

  test('Custom → Manager clears them too — Manager is not a back door', () => {
    const next = applyPresetToActions('manager', FINANCE)
    assert.equal(next.manage, false)
    assert.equal(next.delete, false)
    assert.deepEqual(granted(next), ['approve', 'create', 'edit', 'export', 'view'])
  })

  test('no_access clears everything, protected actions included', () => {
    assert.deepEqual(granted(applyPresetToActions('no_access', ASSETS)), [])
    assert.deepEqual(granted(applyPresetToActions('no_access', ORDERS)), [])
  })

  test('every preset result is free of protected actions, on every module', () => {
    for (const keys of [FINANCE, ORDERS, ASSETS, SAMPLES, PAYROLL, SHOWROOM]) {
      for (const level of PRESET_LEVELS) {
        for (const action of granted(applyPresetToActions(level, keys))) {
          assert.equal(isProtectedAction(action), false, `${level} kept protected "${action}"`)
        }
      }
    }
  })

  test('protectedActionsClearedByPreset names exactly what would be lost', () => {
    assert.deepEqual(
      protectedActionsClearedByPreset('viewer', ASSETS, aditya).sort(),
      ['assign', 'manage'],
    )
    assert.deepEqual(
      protectedActionsClearedByPreset('viewer', ASSETS, { view: true }),
      [],
      'nothing to clear when nothing protected is held',
    )
  })

  test('assign is only reachable through Custom, never through a level', () => {
    for (const level of PRESET_LEVELS) {
      assert.equal(applyPresetToActions(level, ASSETS).assign, false, `${level} granted assign`)
    }
  })
})

describe('reading a level never mutates stored state', () => {
  const stored = Object.freeze({
    view: true, create: true, edit: true, manage: true, assign: true, delete: false,
  })

  test('detectAccessLevel does not touch its input', () => {
    const before = JSON.stringify(stored)
    detectAccessLevel(ASSETS, stored)
    assert.equal(JSON.stringify(stored), before)
  })

  test('protectedActionsClearedByPreset does not touch its input', () => {
    const before = JSON.stringify(stored)
    protectedActionsClearedByPreset('no_access', ASSETS, stored)
    assert.equal(JSON.stringify(stored), before)
  })

  test('applyPresetToActions returns a fresh map each call', () => {
    const first = applyPresetToActions('viewer', ASSETS)
    first.view = false
    assert.equal(applyPresetToActions('viewer', ASSETS).view, true)
  })

  test('presetAllowedActions does not alias the module action list', () => {
    const keys = [...ASSETS]
    presetAllowedActions('manager', keys)
    assert.deepEqual(keys, ASSETS)
  })

  test("Aditya's stored grant is unchanged by detecting it as Custom", () => {
    assert.equal(detectAccessLevel(ASSETS, stored), 'custom')
    assert.equal(stored.assign, true)
    assert.equal(stored.manage, true)
  })
})

describe('view is required, and preset writes are normalized to include it', () => {
  test('needsViewNormalization spots a grant that would be invisible', () => {
    assert.equal(needsViewNormalization(['create', 'edit'], FINANCE), true)
    assert.equal(needsViewNormalization(['view', 'create'], FINANCE), false)
    assert.equal(needsViewNormalization([], FINANCE), false, 'granting nothing needs no view')
  })

  test('a module with no view action is left alone', () => {
    const noView = ['create', 'edit']
    assert.equal(needsViewNormalization(['create'], noView), false)
    assert.deepEqual(normalizeGrantedActions(['create'], noView), ['create'])
  })

  test('normalizeGrantedActions adds view and never removes anything', () => {
    assert.deepEqual(normalizeGrantedActions(['approve'], FINANCE).sort(), ['approve', 'view'])
    assert.deepEqual(normalizeGrantedActions(['manage', 'delete'], FINANCE).sort(), ['delete', 'manage', 'view'])
  })

  test('a hand-picked Custom action gets view too — same rule as a preset', () => {
    // Custom is the one mode that writes protected actions, so it is also the
    // one mode that can produce an invisible module without this.
    assert.deepEqual(normalizeGrantedActions(['manage'], FINANCE).sort(), ['manage', 'view'])
    assert.deepEqual(normalizeGrantedActions(['assign'], ASSETS).sort(), ['assign', 'view'])
  })

  test('every preset that grants anything grants view', () => {
    for (const level of PRESET_LEVELS) {
      const actions = standardActionsForLevel(level, FINANCE)
      if (actions.length > 0) assert.ok(actions.includes('view'), `${level} granted without view`)
    }
  })
})

describe('detectAccessLevel', () => {
  const effOf = (keys: string[], allowedActions: string[]) =>
    Object.fromEntries(keys.map(k => [k, allowedActions.includes(k)]))

  test('recognises each preset exactly', () => {
    const cases: [PresetLevel, string[]][] = [
      ['no_access', []],
      ['viewer', ['view']],
      ['contributor', ['view', 'create', 'edit']],
      ['manager', ['view', 'create', 'edit', 'approve', 'export']],
    ]
    for (const [level, actions] of cases) {
      assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, actions)), level)
    }
  })

  test('anything holding a protected action reads as custom', () => {
    assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, ['view', 'manage'])), 'custom')
    assert.equal(detectAccessLevel(ASSETS, effOf(ASSETS, ['view', 'create', 'edit', 'manage', 'assign'])), 'custom')
  })

  test('Custom with assign reads as Custom, at every standard shape', () => {
    assert.equal(detectAccessLevel(ASSETS, effOf(ASSETS, ['view', 'assign'])), 'custom')
    assert.equal(detectAccessLevel(ASSETS, effOf(ASSETS, ['view', 'create', 'edit', 'assign'])), 'custom')
  })

  test('Custom with delete reads as Custom, at every standard shape', () => {
    assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, ['view', 'delete'])), 'custom')
    assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, ['view', 'create', 'edit', 'delete'])), 'custom')
    assert.equal(
      detectAccessLevel(FINANCE, effOf(FINANCE, ['view', 'create', 'edit', 'approve', 'export', 'delete'])),
      'custom',
      'Manager plus delete is not Manager',
    )
  })

  test('a Custom employee is never auto-classified onto a standard preset', () => {
    // The four holders of a protected action in the captured baseline.
    const cases: [string[], string[]][] = [
      [ASSETS, ['view', 'create', 'edit', 'manage', 'assign']],            // Aditya
      [FINANCE, ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']], // Dhruv
      [ORDERS, ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'can_be_order_assignee']],
      [ORDERS, ['view', 'create', 'edit', 'approve', 'manage']],           // Test Sales User
    ]
    for (const [keys, held] of cases) {
      assert.equal(detectAccessLevel(keys, effOf(keys, held)), 'custom')
    }
  })

  test("Dhruv's real production Finance grant reads as custom, not Manager", () => {
    const dhruv = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']
    assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, dhruv)), 'custom')
  })

  test('a partial set that matches no preset reads as custom', () => {
    assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, ['create'])), 'custom')
    assert.equal(detectAccessLevel(FINANCE, effOf(FINANCE, ['view', 'export'])), 'custom')
  })

  test('detect → apply → detect is stable for every preset', () => {
    for (const level of PRESET_LEVELS) {
      const map = presetAllowedActions(level, ORDERS)
      assert.equal(detectAccessLevel(ORDERS, map), level)
    }
  })

  test('on a module with no approve or export, Manager reads back as Contributor', () => {
    // Contributor and Manager are indistinguishable on Showroom QR, which
    // registers neither action, so the more conservative label wins by design.
    assert.equal(detectAccessLevel(SHOWROOM, presetAllowedActions('manager', SHOWROOM)), 'contributor')
  })
})

describe('allowedMapFromEffective', () => {
  test('reduces resolver rows to a plain allow map', () => {
    const map = allowedMapFromEffective([
      { actionKey: 'view', allowed: true, source: 'role' },
      { actionKey: 'delete', allowed: false, source: 'system_default' },
    ])
    assert.deepEqual(map, { view: true, delete: false })
  })
})

// ── Switching MODULE ACCESS on ──────────────────────────────────────────────
//
// The regression this file exists to prevent recurring: enabling a module used
// to apply the Viewer preset, which wrote an explicit deny over every child
// action the employee held. It erased Aditya's Sample Tracking dispatch,
// receive and mark_lost in production on 2026-08-15, silently — the
// destructive-action confirmation only ever ran on the OFF path.

// Task Management and the two view_all modules, with the protected actions the
// shorter constants above omit.
const TASKS = ['view', 'create', 'edit', 'delete', 'export', 'manage', 'view_quotations', 'manage_quotations']
const ORDERS_FULL = [...ORDERS, 'view_all']
const FINANCE_FULL = [...FINANCE, 'view_all']

const allFalse = (keys: readonly string[]): Record<string, boolean> =>
  Object.fromEntries(keys.map(k => [k, false]))

describe('enabling a module preserves existing child permissions', () => {
  // Aditya's exact production state on the day the defect fired.
  const aditya: Record<string, boolean> = {
    ...allFalse(SAMPLES),
    view: false, dispatch: true, receive: true, mark_lost: true,
  }

  test('1. view goes true and every held child action survives', () => {
    const next = enableModuleEntry(SAMPLES, aditya)
    assert.equal(next.view, true)
    assert.equal(next.dispatch, true)
    assert.equal(next.receive, true)
    assert.equal(next.mark_lost, true)
  })

  test('1b. the result reports as Custom, because it is', () => {
    const next = enableModuleEntry(SAMPLES, aditya)
    assert.equal(detectAccessLevel(SAMPLES, next), 'custom')
  })

  test('1c. nothing else was switched on as a side effect', () => {
    const next = enableModuleEntry(SAMPLES, aditya)
    assert.deepEqual(granted(next), ['dispatch', 'mark_lost', 'receive', 'view'])
  })

  test('2. with no child actions held, the result is exactly Viewer', () => {
    const next = enableModuleEntry(SAMPLES, { ...allFalse(SAMPLES), view: false })
    assert.equal(next.view, true)
    assert.deepEqual(granted(next), ['view'])
    assert.equal(detectAccessLevel(SAMPLES, next), 'viewer')
    // Identical to what the Viewer preset would have produced — so the fix
    // changes nothing for the case the old code got right.
    assert.deepEqual(next, presetAllowedActions('viewer', SAMPLES))
  })

  test('3. no protected action is ever cleared, in any module', () => {
    const cases: [string, readonly string[], string[]][] = [
      ['quotations',   TASKS,        ['view_quotations', 'manage_quotations']],
      // `can_be_order_assignee` is no longer in this list because Orders no
      // longer REGISTERS it — the Order Request workflow it named an assignee
      // for is retired (20261007000000). enableModuleEntry only ever describes
      // the actions a module declares, so naming it here would assert that an
      // action nobody can hold survives a change nobody can make.
      ['orders',       ORDERS_FULL,  ['view_all', 'approve_order', 'delete', 'manage']],
      ['finance',      FINANCE_FULL, ['view_all', 'approve', 'delete', 'manage']],
      ['assets',       ASSETS,       ['assign', 'manage', 'delete']],
      ['payroll',      PAYROLL,      ['admin', 'manage']],
    ]
    for (const [name, keys, held] of cases) {
      const current = { ...allFalse(keys), view: false, ...Object.fromEntries(held.map(k => [k, true])) }
      const next = enableModuleEntry(keys, current)
      for (const action of held) {
        assert.equal(next[action], true, `${name}: ${action} must survive enabling the module`)
      }
      assert.equal(next.view, true, `${name}: view must be granted`)
      assert.equal(
        protectedActionsClearedByPreset('no_access', keys, next).length >= held.filter(isProtectedAction).length,
        true,
        `${name}: the held protected actions are still there to be reported`,
      )
    }
  })

  test('3b. only this module is described — no key from another module appears', () => {
    const next = enableModuleEntry(SHOWROOM, { ...allFalse(SHOWROOM), view: false })
    assert.deepEqual(Object.keys(next).sort(), [...SHOWROOM].sort())
    assert.equal('dispatch' in next, false)
    assert.equal('view_all' in next, false)
  })

  test('4. picking Viewer explicitly still applies the whole preset', () => {
    // The contrast that matters: the checkbox preserves, the preset replaces.
    const viaPreset = presetAllowedActions('viewer', SAMPLES)
    assert.equal(viaPreset.dispatch, false)
    assert.equal(viaPreset.receive, false)
    assert.equal(viaPreset.mark_lost, false)
    assert.equal(detectAccessLevel(SAMPLES, viaPreset), 'viewer')

    const viaToggle = enableModuleEntry(SAMPLES, aditya)
    assert.equal(viaToggle.dispatch, true)
    assert.notDeepEqual(viaToggle, viaPreset)
  })

  test('4b. every preset still behaves exactly as before', () => {
    for (const level of PRESET_LEVELS) {
      const preset = presetAllowedActions(level, SAMPLES)
      for (const action of SAMPLES) {
        if (isProtectedAction(action)) assert.equal(preset[action], false, `${level}/${action}`)
      }
    }
  })

  test('5. turning OFF is unchanged — it still clears and still reports what goes', () => {
    const cleared = protectedActionsClearedByPreset('no_access', SAMPLES, aditya)
    assert.deepEqual(cleared.sort(), ['dispatch', 'mark_lost', 'receive'])
    const off = presetAllowedActions('no_access', SAMPLES)
    assert.deepEqual(granted(off), [])
  })

  test('the function is pure — the caller\u2019s map is never written to', () => {
    const before = { ...aditya }
    enableModuleEntry(SAMPLES, aditya)
    assert.deepEqual(aditya, before)
  })

  test('applying it twice changes nothing further', () => {
    const once = enableModuleEntry(SAMPLES, aditya)
    assert.deepEqual(enableModuleEntry(SAMPLES, once), once)
  })

  test('a module that registers no view action is left exactly as it was', () => {
    const noView = ['create', 'edit']
    const current = { create: true, edit: false }
    assert.deepEqual(enableModuleEntry(noView, current), current)
  })

  test('an absent key reads as false, never undefined', () => {
    const next = enableModuleEntry(SAMPLES, { view: false, dispatch: true })
    assert.equal(next.close, false)
    assert.equal(next.manage, false)
    assert.equal(next.dispatch, true)
    assert.equal(next.view, true)
  })
})

describe('enabling a module writes only the difference it intends', () => {
  const SAMPLES_KEYS = SAMPLES

  test('7. exactly one action changes value — view, and nothing else', () => {
    const before: Record<string, boolean> = {
      ...allFalse(SAMPLES_KEYS),
      view: false, dispatch: true, receive: true, mark_lost: true,
    }
    const after = enableModuleEntry(SAMPLES_KEYS, before)
    const changed = SAMPLES_KEYS.filter(k => (before[k] ?? false) !== after[k])
    assert.deepEqual(changed, ['view'])
  })

  test('7b. re-enabling an already-enabled module changes nothing at all', () => {
    const before: Record<string, boolean> = {
      ...allFalse(SAMPLES_KEYS), view: true, dispatch: true,
    }
    const after = enableModuleEntry(SAMPLES_KEYS, before)
    assert.deepEqual(SAMPLES_KEYS.filter(k => (before[k] ?? false) !== after[k]), [])
  })

  test('7c. by contrast, a preset legitimately changes many actions at once', () => {
    const before: Record<string, boolean> = {
      ...allFalse(SAMPLES_KEYS),
      view: false, dispatch: true, receive: true, mark_lost: true,
    }
    const viewer = presetAllowedActions('viewer', SAMPLES_KEYS)
    const changed = SAMPLES_KEYS.filter(k => (before[k] ?? false) !== viewer[k]).sort()
    assert.deepEqual(changed, ['dispatch', 'mark_lost', 'receive', 'view'])
  })
})
