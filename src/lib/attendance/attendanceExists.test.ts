/**
 * attendanceExistsForMonth / monthsWithAttendance — the plain existence check
 * behind the payroll-period creation rule (a month must have at least one
 * attendance_records row before a payroll period may be created for it).
 *
 * Run:
 *   npx tsx --test src/lib/attendance/attendanceExists.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { attendanceExistsForMonth, monthsWithAttendance } from './attendanceExists'

/** A fake that only needs to answer a count query bounded by date range. */
function fakeSvc(rows: { attendance_date: string }[]) {
  const chain = (filters: Array<(r: { attendance_date: string }) => boolean> = []) => {
    const c: Record<string, unknown> = {
      select: () => c,
      gte: (col: string, val: string) => chain([...filters, r => r.attendance_date >= val]),
      lte: (col: string, val: string) => chain([...filters, r => r.attendance_date <= val]),
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve({ count: rows.filter(r => filters.every(f => f(r))).length, error: null }).then(ok),
    }
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => chain() } as any
}

describe('attendanceExistsForMonth', () => {
  test('true when at least one row falls inside the month', async () => {
    const svc = fakeSvc([{ attendance_date: '2026-08-15' }])
    assert.equal(await attendanceExistsForMonth(svc, 2026, 8), true)
  })

  test('false for an empty table', async () => {
    const svc = fakeSvc([])
    assert.equal(await attendanceExistsForMonth(svc, 2026, 8), false)
  })

  test('a row in an ADJACENT month does not count — bounds are exact', async () => {
    const svc = fakeSvc([{ attendance_date: '2026-07-31' }, { attendance_date: '2026-09-01' }])
    assert.equal(await attendanceExistsForMonth(svc, 2026, 8), false)
  })

  test('the first and last day of the month are both inside the range', async () => {
    const first = fakeSvc([{ attendance_date: '2026-08-01' }])
    assert.equal(await attendanceExistsForMonth(first, 2026, 8), true)
    const last = fakeSvc([{ attendance_date: '2026-08-31' }])
    assert.equal(await attendanceExistsForMonth(last, 2026, 8), true)
  })
})

describe('monthsWithAttendance', () => {
  test('checks several months at once and returns only the ones with rows', async () => {
    const svc = fakeSvc([{ attendance_date: '2026-08-10' }])
    const result = await monthsWithAttendance(svc, [
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ])
    assert.deepEqual([...result], ['2026-08'])
  })

  test('an empty candidate list returns an empty set, no queries needed', async () => {
    const svc = fakeSvc([{ attendance_date: '2026-08-10' }])
    const result = await monthsWithAttendance(svc, [])
    assert.equal(result.size, 0)
  })
})
