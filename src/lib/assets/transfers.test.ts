/**
 * Custody — the current-custodian rule and transfer validation.
 *
 * Run:
 *   npx tsx --test src/lib/assets/transfers.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeCustody,
  describeTransferSide,
  findOpenAssignment,
  isOpenAssignment,
  transferCandidates,
  validateAssignment,
  validateRecovery,
  validateTransfer,
} from './transfers'
import type { EmployeeAsset } from './types'

const names: Record<string, string> = { u1: 'Priya Sharma', u2: 'Rahul Verma' }
const lookup = (id: string) => names[id] ?? null

const assignment = (over: Partial<EmployeeAsset> = {}): EmployeeAsset => ({
  id: 'ea1',
  asset_id: 'a1',
  employee_id: 'u1',
  assigned_by: 'admin',
  assigned_at: '2026-01-01T00:00:00Z',
  accepted_at: null,
  returned_at: null,
  lost_at: null,
  status: 'accepted',
  ...over,
})

describe('isOpenAssignment', () => {
  test('open means the asset is still out with someone', () => {
    assert.equal(isOpenAssignment('pending_acceptance'), true)
    assert.equal(isOpenAssignment('accepted'), true)
    assert.equal(isOpenAssignment('returned'), false)
    assert.equal(isOpenAssignment('lost'), false)
    assert.equal(isOpenAssignment(null), false)
    assert.equal(isOpenAssignment(undefined), false)
  })
})

describe('findOpenAssignment', () => {
  test('ignores closed periods and rows for other assets', () => {
    const rows = [
      assignment({ id: 'old', status: 'returned' }),
      assignment({ id: 'other', asset_id: 'a2' }),
      assignment({ id: 'live' }),
    ]
    assert.equal(findOpenAssignment(rows, 'a1')?.id, 'live')
  })

  test('with two open rows it takes the LATEST, never an arbitrary one', () => {
    // Should be impossible — every RPC closes the previous period in the same
    // transaction — but a coin toss would be the wrong answer if it happened.
    const rows = [
      assignment({ id: 'earlier', assigned_at: '2026-01-01T00:00:00Z' }),
      assignment({ id: 'later',   assigned_at: '2026-06-01T00:00:00Z' }),
    ]
    assert.equal(findOpenAssignment(rows, 'a1')?.id, 'later')
  })

  test('null when nobody holds it', () => {
    assert.equal(findOpenAssignment([assignment({ status: 'returned' })], 'a1'), null)
  })
})

describe('describeCustody — the ownership rule', () => {
  test('an assigned asset with a live custody row names its holder', () => {
    const c = describeCustody({ status: 'assigned', location: null }, assignment(), lookup)
    assert.equal(c.kind, 'employee')
    assert.equal(c.label, 'Priya Sharma')
    assert.equal(c.employeeId, 'u1')
    assert.equal(c.inconsistent, false)
  })

  test('an unresolvable holder is still a holder — never a dash', () => {
    const c = describeCustody({ status: 'assigned', location: null }, assignment({ employee_id: 'gone' }), lookup)
    assert.equal(c.kind, 'employee')
    assert.equal(c.label, 'Unknown employee')
    assert.equal(c.inconsistent, false)
  })

  test('status "assigned" with NO custody row is reported as inconsistent', () => {
    // The accountability hole this rule exists to close. It must never render
    // as an empty cell.
    const c = describeCustody({ status: 'assigned', location: 'Store Room' }, null, lookup)
    assert.equal(c.kind, 'inconsistent')
    assert.equal(c.inconsistent, true)
    assert.ok(c.label.includes('custodian missing'))
    assert.equal(c.employeeId, null)
  })

  test('a live custody row on an available asset is reported, not smoothed over', () => {
    const c = describeCustody({ status: 'available', location: null }, assignment(), lookup)
    assert.equal(c.kind, 'inconsistent')
    assert.equal(c.inconsistent, true)
    assert.ok(c.label.includes('Priya Sharma'))
    assert.ok(c.label.includes('review'))
  })

  test('custody survives a repair round-trip — the holder is still accountable', () => {
    const c = describeCustody({ status: 'under_repair', location: null }, assignment(), lookup)
    assert.equal(c.kind, 'employee')
    assert.equal(c.inconsistent, false)
  })

  test('an available asset at a location reads as that location', () => {
    const c = describeCustody({ status: 'available', location: '  Store Room  ' }, null, lookup)
    assert.equal(c.kind, 'location')
    assert.equal(c.label, 'Store Room')
    assert.equal(c.location, 'Store Room')
  })

  test('an available asset with nowhere recorded reads as Unassigned', () => {
    const c = describeCustody({ status: 'available', location: null }, null, lookup)
    assert.equal(c.kind, 'unassigned')
    assert.equal(c.label, 'Unassigned')
  })

  test('a blank location is not a location', () => {
    const c = describeCustody({ status: 'available', location: '   ' }, null, lookup)
    assert.equal(c.kind, 'unassigned')
  })

  test('a lost asset never claims a custodian', () => {
    const c = describeCustody({ status: 'lost', location: null }, null, lookup)
    assert.equal(c.kind, 'unassigned')
    assert.equal(c.inconsistent, false)
  })
})

describe('validateAssignment', () => {
  test('accepts an available asset and a chosen employee', () => {
    assert.equal(validateAssignment({ assetStatus: 'available', employeeId: 'u1' }), null)
  })

  test('refuses anything that is not available', () => {
    for (const s of ['assigned', 'lost', 'under_repair', 'retired', 'disposed']) {
      assert.ok(validateAssignment({ assetStatus: s, employeeId: 'u1' }), s)
    }
  })

  test('refuses with no employee chosen', () => {
    assert.ok(validateAssignment({ assetStatus: 'available', employeeId: null }))
  })
})

describe('validateTransfer', () => {
  const ok = { assetStatus: 'assigned', currentEmployeeId: 'u1' }

  test('accepts a transfer to a different employee', () => {
    assert.equal(validateTransfer({ ...ok, target: { kind: 'employee', employeeId: 'u2' } }), null)
  })

  test('accepts a transfer to a company location', () => {
    assert.equal(validateTransfer({ ...ok, target: { kind: 'location', location: 'Store Room' } }), null)
  })

  test('refuses transferring to the person who already holds it', () => {
    const msg = validateTransfer({ ...ok, target: { kind: 'employee', employeeId: 'u1' } })
    assert.ok(msg && msg.includes('already held'))
  })

  test('refuses a lost asset and points at recovery', () => {
    const msg = validateTransfer({
      assetStatus: 'lost', currentEmployeeId: null,
      target: { kind: 'location', location: 'Store Room' },
    })
    assert.ok(msg && msg.toLowerCase().includes('recovery'))
  })

  test('refuses a retired or disposed asset', () => {
    for (const s of ['retired', 'disposed']) {
      assert.ok(validateTransfer({
        assetStatus: s, currentEmployeeId: null,
        target: { kind: 'location', location: 'X' },
      }), s)
    }
  })

  test('refuses while the asset is away for service', () => {
    const msg = validateTransfer({
      assetStatus: 'under_repair', currentEmployeeId: 'u1',
      target: { kind: 'employee', employeeId: 'u2' },
    })
    assert.ok(msg && msg.includes('service'))
  })

  test('refuses with no destination at all', () => {
    assert.ok(validateTransfer({ ...ok, target: null }))
  })

  test('refuses a blank location', () => {
    assert.ok(validateTransfer({ ...ok, target: { kind: 'location', location: '   ' } }))
  })
})

describe('validateRecovery', () => {
  test('only a lost asset can be recovered', () => {
    const msg = validateRecovery({ assetStatus: 'available', target: { kind: 'location', location: 'X' } })
    assert.ok(msg && msg.includes('not marked lost'))
  })

  test('accepts recovery to a location or to an employee', () => {
    assert.equal(validateRecovery({ assetStatus: 'lost', target: { kind: 'location', location: 'Store' } }), null)
    assert.equal(validateRecovery({ assetStatus: 'lost', target: { kind: 'employee', employeeId: 'u2' } }), null)
  })

  test('refuses recovery with no destination', () => {
    assert.ok(validateRecovery({ assetStatus: 'lost', target: null }))
    assert.ok(validateRecovery({ assetStatus: 'lost', target: { kind: 'employee', employeeId: '' } }))
    assert.ok(validateRecovery({ assetStatus: 'lost', target: { kind: 'location', location: '' } }))
  })
})

describe('describeTransferSide', () => {
  test('names a person, a place, or says nothing rather than printing an id', () => {
    assert.equal(describeTransferSide('u1', null, lookup), 'Priya Sharma')
    assert.equal(describeTransferSide('missing', null, lookup), 'Unknown employee')
    assert.equal(describeTransferSide(null, '  Store Room ', lookup), 'Store Room')
    assert.equal(describeTransferSide(null, null, lookup), '—')
    assert.equal(describeTransferSide(null, '   ', lookup), '—')
  })
})

describe('transferCandidates', () => {
  test('excludes the current holder so the form cannot offer a no-op', () => {
    const employees = [
      { id: 'u1', full_name: 'Priya Sharma', role: 'employee', team: 'Design' },
      { id: 'u2', full_name: 'Rahul Verma', role: 'manager', team: 'Sales' },
    ]
    assert.deepEqual(transferCandidates(employees, 'u1').map(e => e.id), ['u2'])
    assert.deepEqual(transferCandidates(employees, null).map(e => e.id), ['u1', 'u2'])
  })
})
