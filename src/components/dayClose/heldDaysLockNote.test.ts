// The payroll lock's line about Day Close held days: named, never blocking (owner, 2026-11-18).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldDaysLockLine } from './heldDaysLockNote'

test('nothing when there are none; otherwise the count and that they count as present', () => {
  assert.equal(heldDaysLockLine(0), '')
  assert.match(heldDaysLockLine(1), /1 Day Close held day is still undecided/)
  assert.match(heldDaysLockLine(3), /3 Day Close held days are still undecided[\s\S]*counts them as present; nothing is deducted/)
})
