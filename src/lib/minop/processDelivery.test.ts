import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeMinopAttendanceOutcome, type ExistingAttendanceRow } from './processDelivery'
import type { MinopEmployeeCandidate } from './employeeMapping'

const activeUser: MinopEmployeeCandidate = {
  id: 'user-1', fingerprint_employee_code: '0014', is_active: true, is_deleted: false,
}
const unlocked = { locked: false }
const locked = { locked: true }

function base(overrides: Partial<Parameters<typeof computeMinopAttendanceOutcome>[0]> = {}) {
  return computeMinopAttendanceOutcome({
    minopUserId: '0014',
    type: 'CheckIn',
    logTimeUtc: '2026-01-08T09:40:00.000Z',
    candidates: [activeUser],
    existingRow: null,
    payrollLock: unlocked,
    ...overrides,
  })
}

test('a fresh CheckIn for a mapped employee is processed and written', () => {
  const result = base()
  assert.equal(result.status, 'processed')
  if (result.status !== 'processed') return
  assert.equal(result.userId, 'user-1')
  assert.equal(result.attendanceDate, '2026-01-08') // 09:40 UTC = 15:10 IST, same day
  assert.equal(result.write, true)
  assert.deepEqual(result.row, {
    check_in_at: '2026-01-08T09:40:00.000Z',
    check_out_at: null,
    status: 'checked_in',
    punch_direction_source: 'confirmed',
    source: 'minop',
  })
})

test('a CheckOut completing an existing CheckIn is present, not checked_in', () => {
  const existingRow: ExistingAttendanceRow = {
    check_in_at: '2026-01-08T04:10:00.000Z', check_out_at: null, punch_direction_source: 'confirmed',
  }
  const result = computeMinopAttendanceOutcome({
    minopUserId: '0014', type: 'CheckOut', logTimeUtc: '2026-01-08T12:40:00.000Z',
    candidates: [activeUser], existingRow, payrollLock: unlocked,
  })
  assert.equal(result.status, 'processed')
  if (result.status !== 'processed') return
  assert.equal(result.row.status, 'present')
  assert.equal(result.row.check_in_at, '2026-01-08T04:10:00.000Z')
  assert.equal(result.row.check_out_at, '2026-01-08T12:40:00.000Z')
  assert.equal(result.write, true)
})

test('an exact repeat of an already-stored punch is processed but not written', () => {
  const existingRow: ExistingAttendanceRow = {
    check_in_at: '2026-01-08T09:40:00.000Z', check_out_at: null, punch_direction_source: 'confirmed',
  }
  const result = computeMinopAttendanceOutcome({
    minopUserId: '0014', type: 'CheckIn', logTimeUtc: '2026-01-08T09:40:00.000Z',
    candidates: [activeUser], existingRow, payrollLock: unlocked,
  })
  assert.equal(result.status, 'processed')
  if (result.status !== 'processed') return
  assert.equal(result.write, false)
})

test('a later CheckIn that loses to an earlier stored arrival is not written', () => {
  const existingRow: ExistingAttendanceRow = {
    check_in_at: '2026-01-08T09:40:00.000Z', check_out_at: null, punch_direction_source: 'confirmed',
  }
  const result = computeMinopAttendanceOutcome({
    minopUserId: '0014', type: 'CheckIn', logTimeUtc: '2026-01-08T11:00:00.000Z',
    candidates: [activeUser], existingRow, payrollLock: unlocked,
  })
  assert.equal(result.status, 'processed')
  if (result.status !== 'processed') return
  assert.equal(result.write, false)
  assert.equal(result.row.check_in_at, '2026-01-08T09:40:00.000Z')
})

test('an unmapped Minop UserId does not touch attendance', () => {
  const result = base({ minopUserId: 'UNKNOWN', candidates: [activeUser] })
  assert.deepEqual(result, { status: 'unmapped' })
})

test('a code carried by two employees is a mapping conflict, never a guess', () => {
  const second: MinopEmployeeCandidate = { id: 'user-2', fingerprint_employee_code: '0014', is_active: true, is_deleted: false }
  const result = base({ candidates: [activeUser, second] })
  assert.deepEqual(result, { status: 'mapping_conflict' })
})

test('an inactive employee does not receive attendance, but the resolved userId is still reported', () => {
  const inactive: MinopEmployeeCandidate = { id: 'user-1', fingerprint_employee_code: '0014', is_active: false, is_deleted: false }
  const result = base({ candidates: [inactive] })
  assert.deepEqual(result, { status: 'inactive_employee', userId: 'user-1' })
})

test('a locked payroll period refuses the write but still names the employee', () => {
  const result = base({ payrollLock: locked })
  assert.deepEqual(result, { status: 'payroll_locked', userId: 'user-1' })
})

test('mapping is checked before the payroll lock, so an unmapped code is never reported as locked', () => {
  const result = base({ minopUserId: 'UNKNOWN', payrollLock: locked })
  assert.deepEqual(result, { status: 'unmapped' })
})

test('the attendance date is the IST calendar date, which can differ from the UTC one', () => {
  // 2026-01-08T20:00:00Z is 2026-01-09 01:30 IST — after the UTC midnight
  // boundary the IST day has already turned over.
  const result = base({ logTimeUtc: '2026-01-08T20:00:00.000Z' })
  assert.equal(result.status, 'processed')
  if (result.status === 'processed') assert.equal(result.attendanceDate, '2026-01-09')
})

test('a punch just before the IST midnight boundary stays on the earlier date', () => {
  // 2026-01-08T18:29:00Z is 2026-01-08 23:59 IST.
  const result = base({ logTimeUtc: '2026-01-08T18:29:00.000Z' })
  assert.equal(result.status, 'processed')
  if (result.status === 'processed') assert.equal(result.attendanceDate, '2026-01-08')
})

test('a punch just after the IST midnight boundary lands on the next date', () => {
  // 2026-01-08T18:31:00Z is 2026-01-09 00:01 IST.
  const result = base({ logTimeUtc: '2026-01-08T18:31:00.000Z' })
  assert.equal(result.status, 'processed')
  if (result.status === 'processed') assert.equal(result.attendanceDate, '2026-01-09')
})
