// Future dates in an unfinished payroll month.
//
// Reproduces the defect with the REAL engine on a fixed date (27 Sep 2026,
// a realistic Mon–Sat 10:00–18:30 schedule, an employee punching every day so
// far), then pins the fix: payroll writes refuse a month that has not ended,
// and the read-only preview leaves not-yet-occurred days out entirely. A month
// that has ended calculates exactly as before.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generatePayrollForEmployee } from './engine'
import { DEFAULT_PAYROLL_SETTINGS } from './settings'
import { isSkip, type EngineResult } from './types'
import {
  isPayrollMonthComplete, payrollMonthLastDay, payrollMonthOpensOn, calendarThroughFor, monthInProgressMessage,
} from './periodCompletion'
import { istClockToUtc } from '../istDate'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const TODAY = '2026-09-27'   // a Sunday; 28, 29, 30 Sep are working days still to come
const employee = { id: 'e', monthly_salary: 26000, payroll_active: true, joining_date: null, employment_type: 'permanent' as const }
const period = { id: 'p', payroll_month: 9, payroll_year: 2026, status: 'draft' as const }

/** Punches for every working day up to and including `through`. */
function punchedThrough(through: string) {
  const out = []
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`
    if (date > through || new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    out.push({ id: date, attendance_date: date, check_in_at: istClockToUtc(date, '09:55'), check_out_at: istClockToUtc(date, '18:35'), direction_source: 'confirmed' as const })
  }
  return out
}
const run = (records: ReturnType<typeof punchedThrough>, options?: { calendarThrough?: string }) => {
  const out = generatePayrollForEmployee(employee, period, records, [], [], [], DEFAULT_PAYROLL_SETTINGS, [], options)
  assert.ok(!isSkip(out))
  return out as EngineResult
}

describe('the defect, reproduced with the real engine on 27 Sep 2026', () => {
  test('without a guard, 28–30 Sep (not yet happened) are charged as full-day absences', () => {
    const r = run(punchedThrough('2026-09-26'))
    const future = r.deduction_lines.filter(l => l.line_date > TODAY)
    assert.deepEqual(future.map(l => [l.line_date, l.deduction_type]), [
      ['2026-09-28', 'absent'], ['2026-09-29', 'absent'], ['2026-09-30', 'absent'],
    ])
    // The first of them is absorbed by the month's paid leave; the rest cost money.
    assert.ok(future.reduce((t, l) => t + l.amount_deducted, 0) >= 2000)
    assert.equal(r.days_absent, 3)
  })
})

describe('the rule: payroll for a month is written only after the month has ended (IST)', () => {
  test('boundaries', () => {
    assert.equal(payrollMonthLastDay(2026, 9), '2026-09-30')
    assert.equal(payrollMonthOpensOn(2026, 9), '2026-10-01')
    assert.equal(payrollMonthOpensOn(2026, 12), '2027-01-01')
    assert.equal(isPayrollMonthComplete(2026, 9, '2026-09-30'), false, 'the last day itself is still in progress')
    assert.equal(isPayrollMonthComplete(2026, 9, '2026-10-01'), true)
    assert.equal(isPayrollMonthComplete(2026, 2, '2026-03-01'), true)
    assert.equal(isPayrollMonthComplete(2026, 8, TODAY), true, 'historical months are unaffected')
    assert.match(monthInProgressMessage(2026, 9, 'generated'), /September 2026 has not ended yet[\s\S]*from 1 Oct \(IST\)[\s\S]*Payroll Monthly Preview/)
  })

  test('every payroll WRITE checks it before calculating: generate, attendance correction, lock', () => {
    const generate = read('src/app/api/payroll/generate/route.ts')
    assert.ok(generate.indexOf('isPayrollMonthComplete(') > 0)
    assert.ok(generate.indexOf('isPayrollMonthComplete(') < generate.indexOf('generatePayrollForEmployee('), 'generate refuses before any engine run')
    assert.ok(generate.indexOf('isPayrollMonthComplete(') < generate.indexOf('pinSettingsToPeriod('), 'and before pinning settings')
    const correction = read('src/lib/payroll/attendanceCorrectionService.ts')
    assert.ok(correction.indexOf('isPayrollMonthComplete(') < correction.indexOf('generatePayrollForEmployee('))
    const lock = read('src/lib/payroll/lockPeriod.ts')
    assert.ok(lock.indexOf('isPayrollMonthComplete(') < lock.indexOf('await attendanceLockState(svc'))
  })

  test('no write path passes calendarThrough — only the read-only preview trims', () => {
    for (const p of ['src/app/api/payroll/generate/route.ts', 'src/lib/payroll/attendanceCorrectionService.ts']) {
      assert.equal(read(p).includes('calendarThrough'), false, p)
    }
    assert.ok(read('src/app/api/payroll/monthly-review/route.ts').includes('{ calendarThrough }'))
  })
})

describe('the read-only preview of an in-progress month', () => {
  test('calendarThrough is yesterday for the current month and undefined for a finished one', () => {
    assert.equal(calendarThroughFor(2026, 9, TODAY), '2026-09-26')
    assert.equal(calendarThroughFor(2026, 8, TODAY), undefined)
    assert.equal(calendarThroughFor(2026, 9, '2026-09-01'), '2026-08-31', 'on the 1st nothing of the month has happened yet')
  })

  test('days after calendarThrough are never worked, absent or charged — they are not in the calendar', () => {
    const r = run(punchedThrough('2026-09-26'), { calendarThrough: '2026-09-26' })
    assert.equal(r.deduction_lines.filter(l => l.line_date > '2026-09-26').length, 0)
    assert.equal(r.day_results.some(d => d.date > '2026-09-26'), false)
    assert.equal(r.days_absent, 0)
    assert.equal(r.total_deductions, 0)
  })

  test('a finished month is identical with or without the option — history is not restated', () => {
    const full = punchedThrough('2026-09-30')
    const a = run(full)
    const b = run(full, { calendarThrough: undefined })
    const c = run(full, { calendarThrough: '2026-09-30' })
    for (const x of [b, c]) {
      assert.deepEqual(
        { ...x, generated_at: '' },
        { ...a, generated_at: '' },
      )
    }
  })
})
