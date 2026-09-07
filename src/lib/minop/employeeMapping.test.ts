import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveMinopEmployee, type MinopEmployeeCandidate } from './employeeMapping'

const active = (id: string, code: string): MinopEmployeeCandidate =>
  ({ id, fingerprint_employee_code: code, is_active: true, is_deleted: false })

test('exactly one active employee with the code resolves', () => {
  const result = resolveMinopEmployee('0014', [active('u1', '0014')])
  assert.deepEqual(result, { ok: true, userId: 'u1' })
})

test('a code with no employee at all is unmapped', () => {
  const result = resolveMinopEmployee('0099', [active('u1', '0014')])
  assert.deepEqual(result, { ok: false, reason: 'unmapped' })
})

test('no candidates at all is unmapped', () => {
  assert.deepEqual(resolveMinopEmployee('0014', []), { ok: false, reason: 'unmapped' })
})

test('two employees sharing one code is a mapping conflict, never a guess', () => {
  const result = resolveMinopEmployee('0014', [active('u1', '0014'), active('u2', '0014')])
  assert.deepEqual(result, { ok: false, reason: 'mapping_conflict' })
})

test('an inactive employee does not post attendance even though the code matches', () => {
  const inactive: MinopEmployeeCandidate = { id: 'u1', fingerprint_employee_code: '0014', is_active: false, is_deleted: false }
  assert.deepEqual(resolveMinopEmployee('0014', [inactive]), { ok: false, reason: 'inactive_employee', userId: 'u1' })
})

test('a deleted employee does not post attendance', () => {
  const deleted: MinopEmployeeCandidate = { id: 'u1', fingerprint_employee_code: '0014', is_active: true, is_deleted: true }
  assert.deepEqual(resolveMinopEmployee('0014', [deleted]), { ok: false, reason: 'inactive_employee', userId: 'u1' })
})

test('the match is exact — a leading zero is a different code, not normalised', () => {
  // Mirrors src/lib/attendance/employeeMapping.ts: "14" and "0014" are
  // different device codes until real Minop data proves otherwise.
  assert.deepEqual(resolveMinopEmployee('14', [active('u1', '0014')]), { ok: false, reason: 'unmapped' })
  assert.deepEqual(resolveMinopEmployee('0014', [active('u1', '14')]), { ok: false, reason: 'unmapped' })
})

test('candidates for other codes are ignored, not counted toward a conflict', () => {
  const result = resolveMinopEmployee('0014', [active('u1', '0014'), active('u2', '0099')])
  assert.deepEqual(result, { ok: true, userId: 'u1' })
})
