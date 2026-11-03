/**
 * Control Center's Sales team tab: a job in Sales and the rights it means.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/team.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { holdChoice, holdsByDefault, rightsFor, roleOf, type SalesTeamMember } from './team'

const person = (over: Partial<SalesTeamMember> = {}): SalesTeamMember => ({
  id: 'u1', name: 'Asha', is_admin: false, candidate: true, view: false, view_all: false, create: false, edit: false, assign: false, juniors: [], can_hold: false, hold_set: null, ...over,
})
const changes = (m: SalesTeamMember, role: Parameters<typeof rightsFor>[1], adds = false) =>
  Object.fromEntries(rightsFor(m, role, adds).map(c => [c.actionKey, c.allowed]))

describe('what a person is in Sales', () => {
  test('is read from the rights they hold, the strongest first', () => {
    assert.equal(roleOf(person()), 'none')
    assert.equal(roleOf(person({ view: true })), 'sales')
    assert.equal(roleOf(person({ view: true, view_all: true })), 'manager')
    assert.equal(roleOf(person({ view: true, view_all: true, assign: true })), 'lead_manager')
  })
})

describe('the rights a job means', () => {
  test('a salesperson gets view, and only view', () => {
    assert.deepEqual(changes(person(), 'sales'), { view: true })
  })
  test('adding leads is a separate tick', () => {
    assert.deepEqual(changes(person(), 'sales', true), { view: true, create: true })
  })
  test('a manager reads everyone and allots nobody', () => {
    assert.deepEqual(changes(person({ view: true }), 'manager'), { view_all: true })
  })
  test('a lead manager adds, corrects and allots', () => {
    assert.deepEqual(changes(person({ view: true }), 'lead_manager'), { create: true, edit: true, assign: true })
  })
  test('taking access away takes everything away', () => {
    assert.deepEqual(changes(person({ view: true, view_all: true, create: true }), 'none'), { view: false, view_all: false, create: false })
  })
  test('nothing is sent when nothing changes', () => {
    assert.deepEqual(rightsFor(person({ view: true }), 'sales', false), [])
  })
})

describe('Can be given leads', () => {
  test('a Salesperson is, by their job; a Manager and a Lead manager are not', () => {
    assert.equal(holdsByDefault('sales'), true)
    assert.equal(holdsByDefault('manager'), false)
    assert.equal(holdsByDefault('lead_manager'), false)
    assert.equal(holdsByDefault('none'), false)
  })
  test('only a tick that differs from the job is kept as a choice', () => {
    assert.equal(holdChoice('sales', false), false, 'a Salesperson kept out, like the dummy account')
    assert.equal(holdChoice('manager', true), true, 'a Manager who also sells')
    assert.equal(holdChoice('sales', true), null, 'what the job means anyway')
    assert.equal(holdChoice('manager', false), null)
    assert.equal(holdChoice('none', true), null, 'no job, no choice')
  })
})
