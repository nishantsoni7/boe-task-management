/**
 * The 20 July defect: partial lunch overlap, and the band that cost nothing.
 *
 *   npx tsx --test src/lib/attendance/partialLunchOverlap.test.ts
 *
 * THE REPORTED CASE
 * -----------------
 * A day punched 10:05 → 13:33 against a 13:00–14:00 lunch displayed as
 * "2h 28m · Short Present · 1d" and produced NO deduction line at all, so the
 * date was missing from the payslip entirely.
 *
 * Two independent defects made that happen, and neither would have been caught
 * by the other's fix:
 *
 *   1. LUNCH WAS A BOOLEAN. Any day touching the lunch window lost the whole
 *      `lunch_hours`, so 33 minutes of overlap cost a full hour. 3h28m of
 *      presence became 2h28m of paid time instead of 2h55m.
 *
 *   2. THE BAND ABOVE THE PRESENCE FLOOR WAS FREE. `short_present` counted as a
 *      present day and raised no deduction, which made the cost of a day
 *      non-monotonic: four hours cost half a day's pay, under three hours cost
 *      nothing. Working less was cheaper than working more, and the cheap band
 *      never appeared on a payslip for anyone to notice.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { classifyAttendanceDay } from './classification'
import { overlapMinutes, computeWorkedDuration } from './workedDuration'
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from '../payroll/settings'
import { generatePayrollForEmployee } from '../payroll/engine'
import { isSkip } from '../payroll/types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult } from '../payroll/types'
import { roundRupees } from '../payroll/money'

const S = DEFAULT_PAYROLL_SETTINGS
const LUNCH = { start: S.lunch_out_after_minutes, end: S.lunch_in_before_minutes, maxHours: S.lunch_hours }

/** An IST wall-clock time on a July 2026 date, as an ISO instant. */
const ist = (day: number, h: number, m: number) =>
  new Date(Date.UTC(2026, 6, day, h - 5, m - 30)).toISOString()

const mins = (h: number, m: number) => h * 60 + m

function classify(inH: number, inM: number, outH: number, outM: number, settings: PayrollSettings = S) {
  return classifyAttendanceDay(
    { check_in_at: ist(20, inH, inM), check_out_at: ist(20, outH, outM), direction_source: 'confirmed' },
    settings,
  )
}

/** Hours → "2h 55m", the way the day row renders it. */
function hhmm(hours: number): string {
  const total = Math.round(hours * 60)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

// ─── 1–3. The duration ────────────────────────────────────────────────────────

describe('the reported day: 10:05 → 13:33', () => {
  const IN = mins(10, 5), OUT = mins(13, 33)
  const elapsed = (OUT - IN) / 60

  test('1. elapsed presence is 3h 28m', () => {
    assert.equal(hhmm(elapsed), '3h 28m')
  })

  test('2. lunch overlap is 33m, not the full hour', () => {
    assert.equal(overlapMinutes({ start: IN, end: OUT }, { start: LUNCH.start, end: LUNCH.end }), 33)
  })

  test('3. paid worked time is 2h 55m', () => {
    const worked = computeWorkedDuration(IN, OUT, elapsed, LUNCH)
    assert.equal(hhmm(worked.paid_hours), '2h 55m')
    assert.equal(hhmm(worked.lunch_hours_deducted), '0h 33m')
  })

  test('the classifier reports the same 2h 55m — one duration path, not two', () => {
    assert.equal(hhmm(classify(10, 5, 13, 33).effective_hours_worked), '2h 55m')
  })

  test('it is no longer the 2h 28m the screen showed', () => {
    assert.notEqual(hhmm(classify(10, 5, 13, 33).effective_hours_worked), '2h 28m')
  })
})

// ─── 4–9. The classification and what it costs ────────────────────────────────

const EMPLOYEE: EngineEmployee = {
  id: 'emp-1', monthly_salary: 20_000, payroll_active: true,
  joining_date: null, employment_type: 'permanent',
}
const PERIOD: EnginePeriod = { id: 'per-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

/**
 * July 2026 with every working day punched full, except the overrides.
 * A full month keeps the paid-leave allowance from silently absorbing the very
 * deduction under test.
 */
function july(overrides: Record<number, [number, number, number, number] | null>): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    if (d in overrides) {
      const o = overrides[d]
      if (o === null) continue                       // absent: no record at all
      out.push({ id: `r${d}`, attendance_date: date, check_in_at: ist(d, o[0], o[1]), check_out_at: ist(d, o[2], o[3]), direction_source: 'confirmed' })
    } else {
      out.push({ id: `r${d}`, attendance_date: date, check_in_at: ist(d, 10, 0), check_out_at: ist(d, 18, 30), direction_source: 'confirmed' })
    }
  }
  return out
}

function run(records: EngineAttendanceRecord[], settings: PayrollSettings = S): EngineResult {
  const o = generatePayrollForEmployee(EMPLOYEE, PERIOD, records, [], [], [], settings)
  assert.equal(isSkip(o), false)
  return o as EngineResult
}

const linesOn = (r: EngineResult, date: string) => r.deduction_lines.filter(l => l.line_date === date)

describe('what the reported day is, and what it costs', () => {
  // 20 July as reported, 21 July absent — exactly the screenshot's two dates.
  const result = run(july({ 7: null, 20: [10, 5, 13, 33], 21: null }))
  const day20 = linesOn(result, '2026-07-20')
  const day21 = linesOn(result, '2026-07-21')

  test('4. it classifies as a half day, not short present', () => {
    assert.equal(classify(10, 5, 13, 33).classification, 'half_day')
  })

  test('5. it stores a 0.5 day deduction fraction', () => {
    assert.equal(day20.length, 1)
    assert.equal(day20[0]!.deduction_type, 'half_day')
    assert.equal(day20[0]!.explain!.units, 0.5)
    assert.equal(day20[0]!.explain!.unit, 'days')
  })

  test('6. at ₹20,000 ÷ 26 it stores ₹385 — derived, not hardcoded', () => {
    const expected = roundRupees(20_000 / S.per_day_divisor * S.half_day_fraction)
    assert.equal(expected, 385)
    assert.equal(day20[0]!.amount_deducted, 385)
  })

  test('7. no early-departure line is stacked on it', () => {
    assert.equal(day20.some(l => l.deduction_type === 'early_checkout'), false)
  })

  test('8. no short-hours line is stacked on it', () => {
    assert.equal(day20.some(l => l.deduction_type === 'short_hours'), false)
  })

  test('9. no absence line is stacked on it', () => {
    assert.equal(day20.some(l => l.deduction_type === 'absent'), false)
  })

  test('no late-arrival line either — 10:05 is inside the grace period', () => {
    assert.ok(mins(10, 5) <= S.grace_end_minutes)
    assert.equal(day20.some(l => l.deduction_type === 'late_arrival'), false)
  })

  test('the date carries exactly one deduction, totalling ₹385', () => {
    assert.equal(day20.length, 1)
    assert.equal(day20.reduce((s, l) => s + l.amount_deducted, 0), 385)
  })

  test('the unrelated 21 July absence is still charged a full day', () => {
    assert.equal(day21.length, 1)
    assert.equal(day21[0]!.deduction_type, 'absent')
    assert.equal(day21[0]!.amount_deducted, roundRupees(20_000 / S.per_day_divisor))
    assert.equal(day21[0]!.amount_deducted, 769)
  })

  test('the totals are the sum of the stored rounded lines: ₹385 + ₹769 = ₹1,154', () => {
    const sum = result.deduction_lines.reduce((s, l) => s + l.amount_deducted, 0)
    assert.equal(result.total_deductions, sum)
    assert.equal(result.total_deductions, 1_154)
    assert.equal(result.gross_salary - result.total_deductions, 18_846)
  })

  test('20 July is PRESENT in the deduction ledger — the missing-row symptom', () => {
    const dates = result.deduction_lines.map(l => l.line_date)
    assert.ok(dates.includes('2026-07-20'), 'the reported date must appear on the payslip')
    assert.ok(dates.includes('2026-07-21'))
  })
})

// ─── The cost curve is monotonic again ────────────────────────────────────────

describe('working less is never cheaper than working more', () => {
  test('the free band is gone: 2h55m now costs the same half day as 4h', () => {
    const fourHours   = run(july({ 7: null, 20: [10, 0, 15, 0], 21: null }))
    const twoFiftyFive = run(july({ 7: null, 20: [10, 5, 13, 33], 21: null }))
    assert.equal(linesOn(fourHours, '2026-07-20')[0]!.amount_deducted, 385)
    assert.equal(linesOn(twoFiftyFive, '2026-07-20')[0]!.amount_deducted, 385)
  })

  test('cost never falls as hours fall, across the whole range', () => {
    const cases: Array<[string, [number, number, number, number] | null]> = [
      ['8h30m', [10, 0, 18, 30]],
      ['5h30m', [10, 0, 16, 30]],
      ['4h00m', [10, 0, 15, 0]],
      ['2h55m', [10, 5, 13, 33]],
      ['absent', null],
    ]
    let previous = -1
    for (const [label, punch] of cases) {
      const r = run(july({ 7: null, 20: punch, 21: null }))
      const cost = linesOn(r, '2026-07-20').reduce((s, l) => s + l.amount_deducted, 0)
      assert.ok(cost >= previous, `${label} cost ₹${cost}, less than the longer day above it (₹${previous})`)
      previous = cost
    }
  })
})

// ─── 10–13. The lunch overlap table ───────────────────────────────────────────

describe('lunch is the actual overlap, never a flat hour', () => {
  const cases: Array<[string, number, number, number, number, number]> = [
    // label,            inH, inM, outH, outM, expected overlap minutes
    ['10:05–12:55 ends before lunch', 10, 5, 12, 55, 0],
    ['10:05–13:33 partial',           10, 5, 13, 33, 33],
    ['10:05–14:20 covers all',        10, 5, 14, 20, 60],
    ['13:20–13:50 inside lunch',      13, 20, 13, 50, 30],
    ['13:30–18:30 second half',       13, 30, 18, 30, 30],
    ['14:00–18:30 starts at lunch end', 14, 0, 18, 30, 0],
  ]

  for (const [label, inH, inM, outH, outM, expected] of cases) {
    test(`${label} → ${expected}m`, () => {
      assert.equal(
        overlapMinutes({ start: mins(inH, inM), end: mins(outH, outM) }, { start: LUNCH.start, end: LUNCH.end }),
        expected,
      )
    })
  }

  test('10. a day ending before lunch loses nothing', () => {
    const w = computeWorkedDuration(mins(10, 5), mins(12, 55), 170 / 60, LUNCH)
    assert.equal(w.lunch_hours_deducted, 0)
    assert.equal(hhmm(w.paid_hours), '2h 50m')
  })

  test('11. a partial overlap deducts only the overlap', () => {
    const w = computeWorkedDuration(mins(10, 5), mins(13, 33), 208 / 60, LUNCH)
    assert.equal(hhmm(w.lunch_hours_deducted), '0h 33m')
  })

  test('12. full coverage deducts exactly the configured lunch', () => {
    const w = computeWorkedDuration(mins(10, 0), mins(18, 30), 8.5, LUNCH)
    assert.equal(w.lunch_hours_deducted, S.lunch_hours)
    assert.equal(hhmm(w.paid_hours), '7h 30m')
  })

  test('13. an after-lunch interval does not lose an hour', () => {
    const w = computeWorkedDuration(mins(14, 0), mins(18, 30), 4.5, LUNCH)
    assert.equal(w.lunch_hours_deducted, 0)
    assert.equal(hhmm(w.paid_hours), '4h 30m')
  })

  test('the deduction is capped at the configured allowance, not the window width', () => {
    // A 13:00–14:00 window with only 30 unpaid minutes configured.
    const halfAllowance = { ...LUNCH, maxHours: 0.5 }
    const w = computeWorkedDuration(mins(10, 0), mins(18, 30), 8.5, halfAllowance)
    assert.equal(w.lunch_hours_deducted, 0.5)
  })

  test('a misconfigured lunch longer than the day cannot make paid hours negative', () => {
    const absurd = { start: 0, end: 1439, maxHours: 24 }
    const w = computeWorkedDuration(mins(10, 0), mins(11, 0), 1, absurd)
    assert.equal(w.paid_hours, 0)
    assert.ok(w.paid_hours >= 0)
  })
})

// ─── 14–16. Everything else is untouched ──────────────────────────────────────

describe('unchanged behaviour', () => {
  test('14. a normal full day is still a full day, at 7h30m paid', () => {
    const c = classify(10, 0, 18, 30)
    assert.equal(c.classification, 'full_present')
    assert.equal(hhmm(c.effective_hours_worked), '7h 30m')
    assert.equal(linesOn(run(july({})), '2026-07-20').length, 0)
  })

  test('15. a genuine absence is still charged a full day', () => {
    const r = run(july({ 7: null, 20: [10, 0, 18, 30], 21: null }))
    const line = linesOn(r, '2026-07-21')[0]!
    assert.equal(line.deduction_type, 'absent')
    assert.equal(line.amount_deducted, 769)
  })

  test('15b. too little attendance is still an absence, not a half day', () => {
    // Below the presence floor. This is the insufficient-attendance rule the
    // fix deliberately preserves.
    const c = classify(10, 0, 11, 0)
    assert.equal(c.classification, 'full_absent')
  })

  test('16. single-punch handling is untouched — still a missing punch', () => {
    const c = classifyAttendanceDay(
      { check_in_at: ist(20, 10, 0), check_out_at: null, direction_source: 'confirmed' }, S,
    )
    assert.equal(c.classification, 'missing_punch')
    assert.equal(c.missing_punch_type, 'missing_punch_out')
  })

  test('16b. a missing punch still costs the flat missing-punch hours, not a half day', () => {
    const records = july({}).filter(r => r.attendance_date !== '2026-07-20')
    records.push({ id: 'r20', attendance_date: '2026-07-20', check_in_at: ist(20, 10, 0), check_out_at: null, direction_source: 'confirmed' })
    const lines = linesOn(run(records), '2026-07-20')
    assert.ok(lines.some(l => l.deduction_type === 'missing_punch_out'))
    assert.equal(lines.some(l => l.deduction_type === 'half_day'), false)
  })

  test('the office-timing override still wins over the hour bands', () => {
    const c = classify(10, 15, 18, 30)
    assert.equal(c.classification, 'full_present')
    assert.equal(c.on_office_timing, true)
  })

  test('31. whole-rupee half-up rounding is unchanged', () => {
    assert.equal(roundRupees(384.615), 385)
    assert.equal(roundRupees(769.23), 769)
    assert.equal(roundRupees(-10.5), -11)
  })
})

// ─── 17. Corrections use the same path ────────────────────────────────────────

describe('17. an admin correction measures duration the same way', () => {
  test('corrected punches get the partial-overlap treatment too', () => {
    const records = july({ 7: null, 20: [9, 0, 17, 0], 21: null })
    const corrections = [{
      attendance_date: '2026-07-20',
      corrected_check_in_at:  ist(20, 10, 5),
      corrected_check_out_at: ist(20, 13, 33),
      day_treatment: 'auto' as const,
      waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false,
    }]
    const o = generatePayrollForEmployee(EMPLOYEE, PERIOD, records, [], [], corrections, S)
    assert.equal(isSkip(o), false)
    const r = o as EngineResult
    const day = r.day_results.find(d => d.date === '2026-07-20')!
    assert.equal(hhmm(day.effective_hours_worked), '2h 55m')
    assert.equal(day.classification, 'half_day')
    assert.equal(linesOn(r, '2026-07-20')[0]!.amount_deducted, 385)
  })

  test('an explicit half-day treatment still overrides the punches', () => {
    const records = july({ 7: null, 20: [10, 0, 18, 30], 21: null })
    const corrections = [{
      attendance_date: '2026-07-20',
      corrected_check_in_at: null, corrected_check_out_at: null,
      day_treatment: 'half_day' as const,
      waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false,
    }]
    const o = generatePayrollForEmployee(EMPLOYEE, PERIOD, records, [], [], corrections, S)
    const r = o as EngineResult
    assert.equal(linesOn(r, '2026-07-20')[0]!.deduction_type, 'half_day')
  })
})

// ─── 18–19, 23. One calculation path ──────────────────────────────────────────

describe('every path agrees', () => {
  const records = july({ 7: null, 20: [10, 5, 13, 33], 21: null })

  test('18/19. preview, generation and recalculation produce identical lines', () => {
    const a = run(records)   // generation
    const b = run(records)   // Monthly Review preview — same engine, same args
    const c = run(records)   // recalculation
    const shape = (r: EngineResult) =>
      r.deduction_lines.map(l => [l.line_date, l.deduction_type, l.amount_deducted])
    assert.deepEqual(shape(b), shape(a))
    assert.deepEqual(shape(c), shape(a))
    assert.equal(b.total_deductions, a.total_deductions)
    assert.equal(c.total_deductions, a.total_deductions)
  })

  test('23. recalculating repeatedly never duplicates a deduction', () => {
    for (let i = 0; i < 3; i++) {
      const r = run(records)
      assert.equal(linesOn(r, '2026-07-20').length, 1, `run ${i + 1} duplicated the line`)
      assert.equal(r.total_deductions, 1_154)
    }
  })

  test('the engine is pure — the same input never drifts', () => {
    assert.equal(run(records).total_deductions, run(records).total_deductions)
  })
})

// ─── 27. Settings selection ───────────────────────────────────────────────────

describe('27. the settings actually in force decide the outcome', () => {
  test('a snapshot with the OLD lunch allowance still deducts only the overlap', () => {
    // The code fix applies to any settings; what the snapshot controls is the
    // window and the allowance, not whether overlap is measured.
    const narrowLunch: PayrollSettings = { ...S, lunch_out_after_minutes: mins(13, 0), lunch_in_before_minutes: mins(13, 30) }
    const c = classify(10, 5, 13, 33, narrowLunch)
    assert.equal(hhmm(c.effective_hours_worked), '2h 58m')  // only 30m of lunch exists to overlap
  })

  test('a period whose snapshot sets a different presence floor classifies by it', () => {
    const strict: PayrollSettings = { ...S, threshold_short_present_hours: 4 }
    assert.equal(classify(10, 5, 13, 33, strict).classification, 'full_absent')
    assert.equal(classify(10, 5, 13, 33, S).classification, 'half_day')
  })
})
