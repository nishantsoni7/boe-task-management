/**
 * Integration test for runMinopAttendanceProcessing against a minimal
 * in-memory fake of the three tables it reads and the one it writes —
 * `users`, `payroll_periods`, `attendance_records`. No live Supabase project
 * is touched: attendance test data must never be written against the shared
 * project real employees also live in, and this exercises the exact
 * production code path (not a reimplementation of it) without that risk.
 *
 * The pure decision logic (mapping, the first-in/last-out merge, the IST
 * date) is already covered by processDelivery.test.ts, attendanceMerge.test.ts
 * and employeeMapping.test.ts. This file is about the wiring: does the real
 * function read the right rows, write the right upsert, and record the right
 * outcome on the delivery.
 *
 * Run:
 *   npx tsx --test src/lib/minop/runProcessing.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { runMinopAttendanceProcessing } from './runProcessing'

type FakeUser = { id: string; fingerprint_employee_code: string; is_active: boolean; is_deleted: boolean }
type FakeAttendanceRow = {
  user_id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string
  punch_direction_source: string | null
  source: string | null
}
type FakePeriod = { payroll_month: number; payroll_year: number; status: string }

let users: FakeUser[]
let attendance: FakeAttendanceRow[]
let periods: FakePeriod[]

/** Just enough of the supabase-js query builder for the four call shapes
 *  runMinopAttendanceProcessing actually makes — not a general PostgREST fake. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeClient(): any {
  const from = (table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: (_col: string, code: string) => ({
              // awaited directly, as the users lookup is
              then: (resolve: (v: { data: FakeUser[]; error: null }) => void) =>
                resolve({ data: users.filter(u => u.fingerprint_employee_code === code), error: null }),
            }),
          }),
        }
      }
      if (table === 'payroll_periods') {
        return {
          select: () => ({
            eq: (_c1: string, month: number) => ({
              eq: (_c2: string, year: number) => ({
                maybeSingle: async () => ({
                  data: periods.find(p => p.payroll_month === month && p.payroll_year === year) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'attendance_records') {
        return {
          select: () => ({
            eq: (_c1: string, userId: string) => ({
              eq: (_c2: string, date: string) => ({
                maybeSingle: async () => ({
                  data: attendance.find(r => r.user_id === userId && r.attendance_date === date) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
          upsert: async (row: FakeAttendanceRow) => {
            const i = attendance.findIndex(r => r.user_id === row.user_id && r.attendance_date === row.attendance_date)
            if (i === -1) attendance.push(row)
            else attendance[i] = row
            return { error: null }
          },
        }
      }
      throw new Error(`unstubbed table: ${table}`)
  }
  return { from }
}

const EMPLOYEE_A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', fingerprint_employee_code: '0099' }

const publishedPayload = (userId: string, type: 'CheckIn' | 'CheckOut', logTime: string) => ({
  RealTime: { OperationID: 1, PunchLog: { UserId: userId, Type: type, LogTime: logTime } },
})

beforeEach(() => {
  users = [{ id: EMPLOYEE_A.id, fingerprint_employee_code: EMPLOYEE_A.fingerprint_employee_code, is_active: true, is_deleted: false }]
  attendance = []
  periods = []
})

describe('a mapped employee', () => {
  test('a CheckIn creates a checked_in row, sourced as minop', async () => {
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1',
      payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z'),
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'processed')
    assert.equal(result.deliveryUpdate.mapped_user_id, EMPLOYEE_A.id)
    assert.equal(attendance.length, 1)
    assert.deepEqual(attendance[0], {
      user_id: EMPLOYEE_A.id,
      attendance_date: '2026-01-08',
      check_in_at: '2026-01-08T04:10:00.000Z',
      check_out_at: null,
      status: 'checked_in',
      punch_direction_source: 'confirmed',
      source: 'minop',
    })
  })

  test('a later CheckOut completes the same day to present', async () => {
    const svc = fakeClient()
    await runMinopAttendanceProcessing(svc, { id: 'd1', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z') })
    await runMinopAttendanceProcessing(svc, { id: 'd2', payload: publishedPayload('0099', 'CheckOut', '2026-01-08T12:40:00Z') })

    assert.equal(attendance.length, 1)
    assert.equal(attendance[0].status, 'present')
    assert.equal(attendance[0].check_in_at, '2026-01-08T04:10:00.000Z')
    assert.equal(attendance[0].check_out_at, '2026-01-08T12:40:00.000Z')
  })

  test('a retried CheckIn (same delivery content, new delivery row) does not duplicate or corrupt the day', async () => {
    const svc = fakeClient()
    await runMinopAttendanceProcessing(svc, { id: 'd1', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z') })
    const retry = await runMinopAttendanceProcessing(svc, { id: 'd1-retry', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z') })

    assert.equal(retry.deliveryUpdate.attendance_status, 'processed')
    assert.equal(attendance.length, 1) // still exactly one attendance row
    assert.equal(attendance[0].check_in_at, '2026-01-08T04:10:00.000Z')
  })

  test('an out-of-order CheckOut arriving before the CheckIn is still recorded correctly', async () => {
    const svc = fakeClient()
    await runMinopAttendanceProcessing(svc, { id: 'd1', payload: publishedPayload('0099', 'CheckOut', '2026-01-08T12:40:00Z') })
    await runMinopAttendanceProcessing(svc, { id: 'd2', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z') })

    assert.equal(attendance.length, 1)
    assert.equal(attendance[0].check_in_at, '2026-01-08T04:10:00.000Z')
    assert.equal(attendance[0].check_out_at, '2026-01-08T12:40:00.000Z')
    assert.equal(attendance[0].status, 'present')
  })
})

describe('mapping and validation failures never touch attendance_records', () => {
  test('an unmapped Minop UserId', async () => {
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1', payload: publishedPayload('UNKNOWN_CODE', 'CheckIn', '2026-01-08T04:10:00Z'),
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'unmapped')
    assert.equal(result.deliveryUpdate.mapped_user_id, null)
    assert.equal(attendance.length, 0)
  })

  test('two employees sharing one code is a mapping conflict, not a guess', async () => {
    users.push({ id: 'other', fingerprint_employee_code: '0099', is_active: true, is_deleted: false })
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z'),
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'mapping_conflict')
    assert.equal(attendance.length, 0)
  })

  test('an inactive employee does not receive attendance, but is still named for the admin', async () => {
    users[0].is_active = false
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z'),
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'inactive_employee')
    assert.equal(result.deliveryUpdate.mapped_user_id, EMPLOYEE_A.id)
    assert.equal(attendance.length, 0)
  })

  test('a malformed payload (no RealTime) is marked malformed_event, not thrown', async () => {
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, { id: 'd1', payload: { nothing: true } })
    assert.equal(result.deliveryUpdate.attendance_status, 'malformed_event')
    assert.match(result.deliveryUpdate.attendance_error as string, /missing_realtime/)
    assert.equal(attendance.length, 0)
  })

  test('an unsupported type (BreakIn) is ignored, not an error', async () => {
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1',
      payload: { RealTime: { PunchLog: { UserId: '0099', Type: 'BreakIn', LogTime: '2026-01-08T04:10:00Z' } } },
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'ignored_unsupported_type')
    assert.equal(attendance.length, 0)
  })
})

describe('payroll lock', () => {
  test('a locked month refuses the write but still records who it was for', async () => {
    periods.push({ payroll_month: 1, payroll_year: 2026, status: 'locked' })
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z'),
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'payroll_locked')
    assert.equal(result.deliveryUpdate.mapped_user_id, EMPLOYEE_A.id)
    assert.equal(attendance.length, 0)
  })

  test('an unlocked (draft/generated) month is not blocked', async () => {
    periods.push({ payroll_month: 1, payroll_year: 2026, status: 'generated' })
    const svc = fakeClient()
    const result = await runMinopAttendanceProcessing(svc, {
      id: 'd1', payload: publishedPayload('0099', 'CheckIn', '2026-01-08T04:10:00Z'),
    })
    assert.equal(result.deliveryUpdate.attendance_status, 'processed')
    assert.equal(attendance.length, 1)
  })
})
