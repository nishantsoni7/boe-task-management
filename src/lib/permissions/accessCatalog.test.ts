/**
 * The access catalogue — what the Control Center OFFERS, pinned to what the
 * app really reads.
 *
 * Two promises are tested here. First, no control that decides nothing is
 * offered: every level adds an enforced action, every authority is a
 * protected action the enforcement map says is read. Second, every enforced
 * protected action HAS words, so a newly registered authority cannot appear
 * on screen as a bare key.
 *
 * Repository only: the registry (modules.ts) and the pure helpers. No DB.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/accessCatalog.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import './modules'
import { getRegisteredModule, getRegisteredModules } from './registry'
import { isActionEnforced } from './enforcement'
import { isProtectedAction } from './levels'
import {
  MODULE_WORDS,
  authoritiesFor,
  desiredForLevel,
  desiredWithAuthority,
  detectOfferedLevel,
  hiddenActions,
  isEntryOnly,
  isModuleOfferedTo,
  levelLabel,
  levelSentence,
  offeredLevels,
  offeredStandardActions,
  authoritiesClearedByOff,
  joinWords,
} from './accessCatalog'

const keysOf = (moduleKey: string) => {
  const mod = getRegisteredModule(moduleKey)
  assert.ok(mod, `${moduleKey} must be registered`)
  return mod.actions.map(a => a.actionKey)
}

describe('levels are offered only where they change behaviour', () => {
  test('the ladder per module, from the enforcement map', () => {
    const expected: Record<string, string[]> = {
      orders: ['viewer', 'contributor'],               // export and edit are read by nothing
      finance: ['viewer', 'contributor', 'manager'],   // Manager = payment verification
      meetings: ['viewer', 'contributor'],             // export is read by nothing
      assets_access: ['viewer', 'contributor'],        // registers no approve/export
      inventory: ['viewer', 'contributor', 'manager'], // Manager = confirm bookings
      vendors: ['viewer', 'contributor', 'manager'],   // Manager = later stages
      image_editor: ['viewer', 'contributor'],         // Contributor = generate (billed)
      task_management: ['viewer'],
      performance: ['viewer'],
      sample_tracking: ['viewer'],
      showroom_qr: ['viewer'],
      employee_records: ['viewer'],
      exhibition_leads: ['viewer'],
      customer_review_requests: ['viewer'],            // entry is `use`
      sales: ['viewer'],                               // Coming soon: entry is all there is
      marketing: ['viewer'],
      pricing: ['viewer'],
      seo: ['viewer', 'contributor', 'manager'],       // edit a board item, then answer a strategy change
    }
    for (const [moduleKey, levels] of Object.entries(expected)) {
      assert.deepEqual(offeredLevels(moduleKey, keysOf(moduleKey)), levels, moduleKey)
    }
  })

  test('a one-rung ladder is an Off / On control', () => {
    assert.equal(isEntryOnly('task_management', keysOf('task_management')), true)
    assert.equal(levelLabel('task_management', keysOf('task_management'), 'viewer'), 'On')
    assert.equal(isEntryOnly('finance', keysOf('finance')), false)
    assert.equal(levelLabel('finance', keysOf('finance'), 'viewer'), 'Viewer')
    assert.equal(levelLabel('finance', keysOf('finance'), 'off'), 'Off')
  })

  test('every offered level has a sentence', () => {
    for (const mod of getRegisteredModules()) {
      if (!MODULE_WORDS[mod.moduleKey]) continue
      const keys = mod.actions.map(a => a.actionKey)
      for (const level of offeredLevels(mod.moduleKey, keys)) {
        assert.ok(levelSentence(mod.moduleKey, keys, level).length > 10, `${mod.moduleKey}.${level} needs a sentence`)
      }
    }
  })

  test('Review Workflow enters through `use`, and Off/On writes that key', () => {
    const keys = keysOf('customer_review_requests')
    assert.deepEqual(offeredStandardActions('customer_review_requests', keys), ['use'])
    assert.deepEqual(desiredForLevel('customer_review_requests', keys, 'viewer', {}), { use: true, verify: false })
  })
})

describe('authorities are the enforced protected actions, with words', () => {
  test('every enforced protected action of every module has a label and a meaning', () => {
    for (const mod of getRegisteredModules()) {
      const words = MODULE_WORDS[mod.moduleKey]
      if (!words) continue // self-service modules carry no words on purpose
      for (const a of mod.actions) {
        if (!isProtectedAction(a.actionKey) || !isActionEnforced(mod.moduleKey, a.actionKey)) continue
        const w = words.authorities[a.actionKey]
        assert.ok(w, `${mod.moduleKey}.${a.actionKey} is an authority without words`)
        assert.ok(w.label.length > 3 && w.meaning.length > 10, `${mod.moduleKey}.${a.actionKey} words are too thin`)
      }
    }
  })

  test('no words name an action that is not a registered, enforced, protected authority', () => {
    for (const [moduleKey, words] of Object.entries(MODULE_WORDS)) {
      const keys = keysOf(moduleKey)
      for (const actionKey of Object.keys(words.authorities)) {
        assert.ok(keys.includes(actionKey), `${moduleKey}.${actionKey} is not registered`)
        assert.ok(isProtectedAction(actionKey), `${moduleKey}.${actionKey} is not protected`)
        assert.ok(isActionEnforced(moduleKey, actionKey), `${moduleKey}.${actionKey} is read by nothing`)
      }
    }
  })

  test('every module with words is registered, and Attendance & Payroll have none', () => {
    for (const moduleKey of Object.keys(MODULE_WORDS)) assert.ok(getRegisteredModule(moduleKey), moduleKey)
    assert.equal('attendance' in MODULE_WORDS, false)
    assert.equal('payroll' in MODULE_WORDS, false)
  })

  test('what each authority needs is said in the administrator’s words', () => {
    const finance = authoritiesFor('finance', keysOf('finance'))
    const by = Object.fromEntries(finance.map(a => [a.actionKey, a]))
    assert.equal(by.reconcile.needs, 'See all company payments')
    assert.equal(by.reimburse.needs, 'See all company payments')
    assert.equal(by.verify_own_payment.needs, 'Manager')
    assert.equal(by.view_all.needs, 'Open')
    const tasks = Object.fromEntries(authoritiesFor('task_management', keysOf('task_management')).map(a => [a.actionKey, a]))
    assert.equal(tasks.manage_quotations.needs, 'See quotation requests and prices')
    const orders = Object.fromEntries(authoritiesFor('orders', keysOf('orders')).map(a => [a.actionKey, a]))
    assert.equal(orders.approve_order.perPerson, true, 'PI approval is granted per person, Administrators included')
    assert.equal(orders.view_all.perPerson, false)
    assert.equal(orders.edit_payment_plan.needs, 'See the Payment plan')
  })

  test('Orders offers no delete authority: nothing reads it', () => {
    assert.equal(authoritiesFor('orders', keysOf('orders')).some(a => a.actionKey === 'delete'), false)
  })
})

describe('hidden actions: stored, read by nothing, offered to nobody', () => {
  test('the exact set per module', () => {
    const expected: Record<string, string[]> = {
      orders: ['edit', 'delete', 'export'],
      finance: ['edit', 'export'],
      meetings: ['export'],
      vendors: ['export'],
      task_management: ['create', 'edit', 'delete', 'export', 'manage'],
      sample_tracking: ['create', 'edit', 'delete', 'approve', 'export', 'manage'],
      performance: ['create', 'edit', 'export', 'manage'],
      showroom_qr: ['create', 'edit', 'manage'],
      employee_records: ['create', 'edit', 'delete', 'export', 'manage', 'admin'],
      assets_access: [],
      inventory: [],
      image_editor: [],
      exhibition_leads: [],
      customer_review_requests: [],
      sales: [],
      marketing: [],
      pricing: [],
      seo: [],
    }
    for (const [moduleKey, hidden] of Object.entries(expected)) {
      assert.deepEqual(hiddenActions(moduleKey, keysOf(moduleKey)), hidden, moduleKey)
    }
  })
})

describe('reading a person’s state', () => {
  const FIN = () => keysOf('finance')

  test('the level is judged on offered standard actions only; authorities do not make it custom', () => {
    const keys = FIN()
    assert.equal(detectOfferedLevel('finance', keys, { view: true }), 'viewer')
    assert.equal(detectOfferedLevel('finance', keys, { view: true, create: true }), 'contributor')
    assert.equal(detectOfferedLevel('finance', keys, { view: true, create: true, approve: true }), 'manager')
    assert.equal(detectOfferedLevel('finance', keys, { view: true, create: true, approve: true, view_all: true, allocate: true }), 'manager')
    assert.equal(detectOfferedLevel('finance', keys, { view: false, create: true }), 'off', 'no entry means Off whatever else is held')
    // Hidden actions never count: an old `edit` grant does not make this custom.
    assert.equal(detectOfferedLevel('finance', keys, { view: true, create: true, edit: true }), 'contributor')
  })

  test('a hand-picked mix of standard actions is custom', () => {
    assert.equal(detectOfferedLevel('finance', FIN(), { view: true, approve: true }), 'custom')
  })

  test('an entry-only module reads On or Off', () => {
    const keys = keysOf('task_management')
    assert.equal(detectOfferedLevel('task_management', keys, { view: true, view_quotations: true }), 'viewer')
    assert.equal(detectOfferedLevel('task_management', keys, {}), 'off')
  })
})

describe('writing a person’s state', () => {
  test('a level write touches only the offered standard actions and keeps every authority', () => {
    const keys = keysOf('finance')
    const current = { view: true, create: true, approve: true, view_all: true, allocate: true, edit: true }
    const next = desiredForLevel('finance', keys, 'viewer', current)
    assert.equal(next.view, true)
    assert.equal(next.create, false)
    assert.equal(next.approve, false)
    assert.equal(next.view_all, true, 'authorities survive a level change')
    assert.equal(next.allocate, true)
    assert.equal(next.edit, true, 'a hidden action is carried through, never written by a level')
    assert.equal(next.export, false)
  })

  test('Off clears everything registered, hidden actions included', () => {
    const keys = keysOf('finance')
    const next = desiredForLevel('finance', keys, 'off', { view: true, allocate: true, edit: true })
    for (const a of keys) assert.equal(next[a], false, a)
    assert.deepEqual(Object.keys(next).sort(), [...keys].sort(), 'every registered action is stated')
  })

  test('giving an authority pulls in what it needs, entry included', () => {
    const keys = keysOf('finance')
    const next = desiredWithAuthority('finance', keys, 'reconcile', true, {})
    assert.equal(next.reconcile, true)
    assert.equal(next.view_all, true, 'reconcile needs See all company payments')
    assert.equal(next.view, true, 'and the module must be open')
    assert.equal(next.allocate, false)
  })

  test('taking an authority takes its dependants with it', () => {
    const keys = keysOf('finance')
    const held = { view: true, view_all: true, reconcile: true, reimburse: true, allocate: true }
    const next = desiredWithAuthority('finance', keys, 'view_all', false, held)
    assert.equal(next.view_all, false)
    assert.equal(next.reconcile, false)
    assert.equal(next.reimburse, false)
    assert.equal(next.allocate, true, 'an unrelated authority stays')
    assert.equal(next.view, true)
  })

  test('the Off confirmation names the authorities that would go', () => {
    const keys = keysOf('orders')
    const words = authoritiesClearedByOff('orders', keys, { view: true, view_all: true, approve_order: true })
    assert.deepEqual(words, ['See all company orders', 'Approve PI / Confirm Order'])
    assert.equal(joinWords(words), 'See all company orders and Approve PI / Confirm Order')
    assert.equal(joinWords(['One']), 'One')
    assert.equal(joinWords([]), '')
  })
})

describe('what is offered to whom', () => {
  test('Attendance and Payroll are never offered; Employee Records only on an Administrator', () => {
    assert.equal(isModuleOfferedTo('attendance', 'member'), false)
    assert.equal(isModuleOfferedTo('payroll', 'admin'), false)
    assert.equal(isModuleOfferedTo('employee_records', 'member'), false)
    assert.equal(isModuleOfferedTo('employee_records', 'manager'), false)
    assert.equal(isModuleOfferedTo('employee_records', 'admin'), true)
    assert.equal(isModuleOfferedTo('orders', 'member'), true)
  })

  test('Assets & Access is the one module that is on by default', () => {
    const defaults = Object.entries(MODULE_WORDS).filter(([, w]) => w.defaultOn).map(([k]) => k)
    assert.deepEqual(defaults, ['assets_access'])
  })
})
