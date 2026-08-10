/**
 * Punch-direction provenance, from the attendance file to the payslip.
 *
 *   npx tsx --test src/lib/attendance/punchProvenance.test.ts
 *
 * The parser has always known whether it READ a day's IN/OUT direction or
 * GUESSED it. Payroll generation runs days later, in a different request, from
 * attendance_records — so until the column existed the distinction died at the
 * database boundary and every stored day had to be treated as a guess.
 *
 * These tests follow the value the whole way:
 *
 *   file → parser → row written → stored column → read back → engine → deduction
 *
 * and pin the two rules that make it safe: an unrecognised stored value falls
 * back to 'inferred', and a legacy NULL keeps behaving exactly as it did before
 * the column existed.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'

import {
  parseAttendanceWorkbook,
  buildAttendanceRow,
  attendanceRowChange,
  type EmployeeBlock,
} from './punchParser'
import { resolveDirectionSource, parseStoredDirectionSource } from './punchDirection'
import { resolveEffectiveAttendance, type AttendanceDayCorrection } from './corrections'
import { toEngineAttendanceRecord } from '../payroll/store'
import { generatePayrollForEmployee } from '../payroll/engine'
import { isSkip } from '../payroll/types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineResult,
  PendingDeductionLine,
} from '../payroll/types'
import { PER_DAY_DIVISOR, MISSING_PUNCH_HOURS, FULL_DAY_HOURS } from '../payroll/rules'
import { roundRupees } from '../payroll/money'

// ─── Workbook builders (same shapes as punchParser.test.ts) ───────────────────

function workbook(rows: (string | number | null)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c == null ? '' : c))))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function formatAWorkbook(days: { day: number; in?: string; out?: string }[]): Buffer {
  const width = 33
  const blank = () => Array<string>(width).fill('')
  const title = blank(); title[0] = 'Jun-2026'
  const head  = blank(); head[0] = 'Empcode'; head[2] = 'EMP01'; head[7] = 'Asha Rao'
  const inRow = blank()
  const outRow = blank()
  for (const d of days) {
    inRow[d.day]  = d.in  ?? '--:--'
    outRow[d.day] = d.out ?? '--:--'
  }
  return workbook([title, head, blank(), blank(), inRow, outRow])
}

function formatBWorkbook(cellsByDay: Record<number, string>): Buffer {
  const width = 10
  const title = Array<string>(width).fill(''); title[0] = 'List of Logs — Jun-2026'
  const header: string[] = ['Empcode', 'Name']
  for (let d = 1; d <= width - 2; d++) header.push(String(d))
  const row: string[] = ['EMP01', 'Asha Rao']
  for (let d = 1; d <= width - 2; d++) row.push(cellsByDay[d] ?? '')
  return workbook([title, header, Array<string>(width).fill(''), row])
}

const JUNE = { year: 2026, month: 6 }

/**
 * The row the import writes, for one day of one workbook.
 *
 * `punch_direction_source` in the database is `built.row.direction_source` —
 * the route copies it across verbatim — so asserting this is asserting the
 * persisted value.
 */
function importedRow(buffer: Buffer, day: number) {
  const { blocks } = parseAttendanceWorkbook(buffer)
  const parsed = (blocks as EmployeeBlock[])[0]?.days.find(d => d.day === day)
  assert.ok(parsed, `the parser must emit day ${day}`)
  const built = buildAttendanceRow(JUNE, parsed)
  assert.equal(built.ok, true, `day ${day} must be writable`)
  if (!built.ok) throw new Error('unreachable')
  return built.row
}

// ─── 1–5. What the import writes ──────────────────────────────────────────────

describe('the provenance the import persists', () => {
  test('1. Format A, IN only → confirmed', () => {
    const row = importedRow(formatAWorkbook([{ day: 3, in: '10:02' }]), 3)
    assert.equal(row.direction_source, 'confirmed')
    assert.equal(row.check_out_at, null)
  })

  test('2. Format A, OUT only → confirmed', () => {
    const row = importedRow(formatAWorkbook([{ day: 4, out: '18:36' }]), 4)
    assert.equal(row.direction_source, 'confirmed')
    assert.equal(row.check_in_at, null)
  })

  test('Format A, complete pair → confirmed', () => {
    const row = importedRow(formatAWorkbook([{ day: 5, in: '10:00', out: '18:30' }]), 5)
    assert.equal(row.direction_source, 'confirmed')
    assert.equal(row.status, 'present')
  })

  test('3. Format B, one punch before 2:00 PM → inferred', () => {
    const row = importedRow(formatBWorkbook({ 1: '10:00' }), 1)
    assert.equal(row.direction_source, 'inferred')
    assert.equal(row.check_out_at, null)
  })

  test('4. Format B, one punch at or after 2:00 PM → inferred', () => {
    for (const [day, punch] of [[2, '14:00'], [3, '18:36']] as const) {
      const row = importedRow(formatBWorkbook({ [day]: punch }), day)
      assert.equal(row.direction_source, 'inferred', punch)
      assert.equal(row.check_in_at, null, punch)
    }
  })

  test('5. Format B, two or more valid punches → confirmed', () => {
    const two = importedRow(formatBWorkbook({ 4: '10:07\n18:36\n' }), 4)
    assert.equal(two.direction_source, 'confirmed')

    const many = importedRow(formatBWorkbook({ 5: '09:58\n13:05\n14:02\n19:11\n' }), 5)
    assert.equal(many.direction_source, 'confirmed')
  })

  test('a no-punch day produces no row at all, so there is nothing to store', () => {
    const { blocks } = parseAttendanceWorkbook(formatAWorkbook([{ day: 9 }]))
    assert.equal(blocks[0].days.length, 0)

    // And the builder, asked directly, refuses rather than inventing provenance.
    const built = buildAttendanceRow(JUNE, { day: 9, in: '', out: '', direction_source: 'confirmed' })
    assert.equal(built.ok, false)
  })

  test('every writable row carries a value — the column is never null on a fresh import', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatBWorkbook({ 1: '10:07\n18:36\n', 2: '18:40', 3: '09:15', 4: '14:00' }),
    )
    const rows = blocks.flatMap(b => b.days.map(d => buildAttendanceRow(b, d)))
    assert.equal(rows.length, 4)
    for (const r of rows) {
      assert.equal(r.ok, true)
      if (!r.ok) continue
      assert.ok(
        r.row.direction_source === 'confirmed' || r.row.direction_source === 'inferred',
        'a written row always states how its direction was decided',
      )
    }
  })
})

// ─── 6. Re-import replaces stale provenance ───────────────────────────────────

describe('6. re-importing a month refreshes stale provenance', () => {
  const punches = { check_in_at: '2026-06-03T04:32:00.000Z', check_out_at: null }

  test('a legacy NULL row with unchanged punches is still rewritten', () => {
    const change = attendanceRowChange(
      { ...punches, direction_source: 'confirmed' },
      { ...punches, punch_direction_source: null },
    )
    assert.equal(change.changed, true, 'stale provenance must not survive a re-import')
    assert.equal(change.punchesChanged, false, 'but no punch actually moved')
  })

  test('a row whose provenance already agrees is left alone', () => {
    const change = attendanceRowChange(
      { ...punches, direction_source: 'confirmed' },
      { ...punches, punch_direction_source: 'confirmed' },
    )
    assert.equal(change.changed, false)
    assert.equal(change.punchesChanged, false)
  })

  test('NULL and inferred mean the same thing, so that pairing is not a change', () => {
    const change = attendanceRowChange(
      { ...punches, direction_source: 'inferred' },
      { ...punches, punch_direction_source: null },
    )
    assert.equal(change.changed, false, 'a legacy row already reads as inferred')
  })

  test('a moved punch is a punch change as well as a row change', () => {
    const change = attendanceRowChange(
      { check_in_at: '2026-06-03T05:00:00.000Z', check_out_at: null, direction_source: 'confirmed' },
      { ...punches, punch_direction_source: 'confirmed' },
    )
    assert.equal(change.changed, true)
    assert.equal(change.punchesChanged, true, 'this one belongs in the correction log')
  })

  test('sub-minute differences are still not changes', () => {
    const change = attendanceRowChange(
      { check_in_at: '2026-06-03T04:32:00.000Z', check_out_at: null, direction_source: 'inferred' },
      { check_in_at: '2026-06-03T04:32:41.000Z', check_out_at: null, punch_direction_source: 'inferred' },
    )
    assert.equal(change.changed, false)
  })

  test('a direction that flips from inferred to confirmed rewrites the row', () => {
    // What happens when a month first uploaded as Format B is re-uploaded as
    // Format A: same punch, but now the file states the direction.
    const change = attendanceRowChange(
      { ...punches, direction_source: 'confirmed' },
      { ...punches, punch_direction_source: 'inferred' },
    )
    assert.equal(change.changed, true)
    assert.equal(change.punchesChanged, false)
  })
})

// ─── 7. Preview matches, and writes nothing ───────────────────────────────────

describe('7. the preview classifies identically and stays read-only', () => {
  test('preview and import derive provenance from the same builder', () => {
    const buffer = formatBWorkbook({ 1: '10:07\n18:36\n', 2: '18:40', 3: '09:15' })

    // Both routes call parseAttendanceWorkbook + buildAttendanceRow. Building
    // twice from one workbook is the guarantee they rely on.
    const once  = parseAttendanceWorkbook(buffer).blocks.flatMap(b => b.days.map(d => buildAttendanceRow(b, d)))
    const twice = parseAttendanceWorkbook(buffer).blocks.flatMap(b => b.days.map(d => buildAttendanceRow(b, d)))

    assert.deepEqual(once, twice)
    const directions = once.map(r => (r.ok ? r.row.direction_source : null))
    assert.deepEqual(directions, ['confirmed', 'inferred', 'inferred'])
  })

  test('the preview route performs no write of any kind', async () => {
    const src = await readFile('src/app/api/attendance/preview/route.ts', 'utf8')
    const code = src.split(/\r?\n/).map(l => l.replace(/(^|\s)\/\/.*/, '$1')).join('\n')

    for (const write of ['.insert(', '.update(', '.upsert(', '.delete(']) {
      assert.equal(code.includes(write), false, `preview must not ${write}`)
    }
    // It must still READ the column, or its diff would disagree with the import.
    assert.match(code, /punch_direction_source/, 'preview reads provenance to compare against')
  })

  test('the import route writes the column on BOTH the insert and the update path', async () => {
    // Narrow architecture guard: a provenance value that is written on insert
    // but not on update is exactly how a corrected re-import leaves a stale
    // 'confirmed' attached to punches that have since changed.
    const src = await readFile('src/app/api/attendance/import/route.ts', 'utf8')
    const code = src.split(/\r?\n/).map(l => l.replace(/(^|\s)\/\/.*/, '$1')).join('\n')

    const updateBlock = code.slice(code.indexOf('.update({'), code.indexOf('.eq(\'user_id\', row.user_id)'))
    assert.match(updateBlock, /punch_direction_source/, 'the update must carry provenance')

    assert.match(code, /punch_direction_source:\s*built\.row\.direction_source/, 'the row builder feeds the column')
  })
})

// ─── 8–11. Reading the column back ────────────────────────────────────────────

describe('reading the stored column', () => {
  const base = { id: 'r1', attendance_date: '2026-06-03', check_in_at: null, check_out_at: null }

  test('8. a stored "confirmed" maps to confirmed', () => {
    assert.equal(toEngineAttendanceRecord({ ...base, punch_direction_source: 'confirmed' }).direction_source, 'confirmed')
  })

  test('9. a stored "inferred" maps to inferred', () => {
    assert.equal(toEngineAttendanceRecord({ ...base, punch_direction_source: 'inferred' }).direction_source, 'inferred')
  })

  test('10. a legacy NULL maps to inferred', () => {
    assert.equal(parseStoredDirectionSource(null), null)
    assert.equal(resolveDirectionSource(toEngineAttendanceRecord({ ...base, punch_direction_source: null }).direction_source), 'inferred')
  })

  test('an omitted column (older code, or a select that forgot it) maps to inferred', () => {
    assert.equal(resolveDirectionSource(toEngineAttendanceRecord(base).direction_source), 'inferred')
  })

  test('11. an unexpected stored value maps to inferred, never to confirmed', () => {
    for (const junk of ['CONFIRMED', 'Confirmed', 'yes', '', 'true', 0, 1, {}, [], true]) {
      assert.equal(parseStoredDirectionSource(junk), null, JSON.stringify(junk))
      const mapped = toEngineAttendanceRecord({ ...base, punch_direction_source: junk })
      assert.equal(resolveDirectionSource(mapped.direction_source), 'inferred', JSON.stringify(junk))
    }
  })

  test('no arbitrary database text reaches the engine', () => {
    const mapped = toEngineAttendanceRecord({ ...base, punch_direction_source: 'something-else' })
    assert.equal(mapped.direction_source, null, 'the unrecognised string is dropped, not passed through')
  })

  test('the punches themselves are mapped through unchanged', () => {
    const mapped = toEngineAttendanceRecord({
      id: 'r2',
      attendance_date: '2026-06-04',
      check_in_at: '2026-06-04T04:30:00.000Z',
      check_out_at: '2026-06-04T13:00:00.000Z',
      punch_direction_source: 'confirmed',
    })
    assert.equal(mapped.id, 'r2')
    assert.equal(mapped.attendance_date, '2026-06-04')
    assert.equal(mapped.check_in_at, '2026-06-04T04:30:00.000Z')
    assert.equal(mapped.check_out_at, '2026-06-04T13:00:00.000Z')
  })
})

// ─── The engine, driven from stored rows ──────────────────────────────────────

const SALARY   = 26_000
const PER_DAY  = SALARY / PER_DAY_DIVISOR
const PER_HOUR = PER_DAY / FULL_DAY_HOURS

const employee: EngineEmployee = {
  id: 'emp-1', monthly_salary: SALARY, payroll_active: true,
  joining_date: null, employment_type: 'permanent',
}
const period: EnginePeriod = { id: 'p1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const JULY_WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]
const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()

/** A row exactly as `select(...)` hands it back, before any narrowing. */
function storedRow(
  day: number,
  checkIn: string | null,
  checkOut: string | null,
  storedDirection: unknown,
) {
  return {
    id: `r-${day}`,
    attendance_date: iso(day),
    check_in_at: checkIn,
    check_out_at: checkOut,
    punch_direction_source: storedDirection,
  }
}

/**
 * A month of stored rows, mapped the way a payroll read maps them.
 *
 * Day 1 is deliberately absent so the paid-leave allowance is spent on it —
 * otherwise absorption zeroes the 2 h charge under test and the assertions
 * measure nothing. (Absorption itself is covered in engine.companyPaidLeave.)
 */
function storedMonth(...overrides: ReturnType<typeof storedRow>[]): EngineAttendanceRecord[] {
  const overridden = new Set(overrides.map(r => r.attendance_date))
  const clean = JULY_WORKING_DAYS
    .filter(d => d !== 1)
    .map(d => storedRow(d, at(d, 10, 0), at(d, 18, 30), 'confirmed'))
    .filter(r => !overridden.has(r.attendance_date))
  return [...clean, ...overrides].map(toEngineAttendanceRecord)
}

function run(records: EngineAttendanceRecord[], corrections: AttendanceDayCorrection[] = []): EngineResult {
  const outcome = generatePayrollForEmployee(employee, period, records, [], [], corrections)
  assert.equal(isSkip(outcome), false)
  return outcome as EngineResult
}

const linesOn = (r: EngineResult, day: number): PendingDeductionLine[] =>
  r.deduction_lines.filter(l => l.line_date === iso(day))
const typesOn = (r: EngineResult, day: number) => linesOn(r, day).map(l => l.deduction_type).sort()
const amountOn = (r: EngineResult, day: number) =>
  linesOn(r, day).reduce((s, l) => s + l.amount_deducted, 0)

describe('the deduction a stored row produces', () => {
  test('12. stored Format A confirmed late IN with missing OUT → 2 h plus the late arrival', () => {
    const r = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'confirmed')))

    assert.deepEqual(typesOn(r, 9), ['late_arrival', 'missing_punch_out'])
    const missing = linesOn(r, 9).find(l => l.deduction_type === 'missing_punch_out')!
    const late    = linesOn(r, 9).find(l => l.deduction_type === 'late_arrival')!
    assert.equal(missing.hours_deducted, MISSING_PUNCH_HOURS)
    assert.equal(late.hours_deducted, 1.5)   // 11:30 is 90 min past 10:00
    // Each line is rounded to a whole rupee as it is built, so the day is the
    // SUM of rounded lines rather than the rounding of a summed total.
    assert.equal(
      amountOn(r, 9),
      roundRupees(MISSING_PUNCH_HOURS * PER_HOUR) + roundRupees(1.5 * PER_HOUR),
    )
  })

  test('13. stored Format B inferred single punch → the two-hour charge only', () => {
    const r = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'inferred')))

    assert.deepEqual(typesOn(r, 9), ['missing_punch_out'])
    assert.equal(amountOn(r, 9), roundRupees(MISSING_PUNCH_HOURS * PER_HOUR))
    assert.ok(amountOn(r, 9) < PER_DAY, 'a present day never costs more than a day')
  })

  test('14. stored confirmed OUT-only never receives a late-arrival deduction', () => {
    const r = run(storedMonth(storedRow(9, null, at(9, 19, 0), 'confirmed')))

    assert.deepEqual(typesOn(r, 9), ['missing_punch_in'])
    assert.equal(amountOn(r, 9), roundRupees(MISSING_PUNCH_HOURS * PER_HOUR))
  })

  test('the same punch stored two different ways produces two different bills', () => {
    // The single clearest statement of what the column buys.
    const confirmed = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'confirmed')))
    const inferred  = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'inferred')))

    assert.ok(amountOn(confirmed, 9) > amountOn(inferred, 9))
    assert.equal(
      amountOn(confirmed, 9) - amountOn(inferred, 9),
      roundRupees(1.5 * PER_HOUR),
      'the difference is exactly the late-arrival line the confirmed punch earns',
    )
  })
})

// ─── 18. Legacy rows ──────────────────────────────────────────────────────────

describe('18. legacy NULL rows stay calculable', () => {
  test('a whole month of NULL provenance calculates without error', () => {
    const legacy = JULY_WORKING_DAYS
      .filter(d => d !== 1)
      .map(d => storedRow(d, at(d, 10, 0), at(d, 18, 30), null))
      .map(toEngineAttendanceRecord)

    const r = run(legacy)
    assert.equal(r.days_present, JULY_WORKING_DAYS.length - 1)
    assert.equal(r.days_absent, 1)
  })

  test('a legacy single-punch row behaves exactly as it did before the column existed', () => {
    const withColumn    = run(storedMonth(storedRow(9, at(9, 11, 30), null, null)))
    const withoutColumn = run(storedMonth({
      id: 'r-9', attendance_date: iso(9), check_in_at: at(9, 11, 30), check_out_at: null,
    } as ReturnType<typeof storedRow>))

    assert.deepEqual(typesOn(withColumn, 9), ['missing_punch_out'])
    assert.deepEqual(typesOn(withoutColumn, 9), ['missing_punch_out'])
    assert.equal(amountOn(withColumn, 9), amountOn(withoutColumn, 9))
  })

  test('a legacy evening punch is NOT read as a confirmed arrival', () => {
    // The trap the fallback exists to avoid: deciding provenance from which
    // timestamp column happens to be populated. A legacy row with only
    // check_in_at set is a guess, whatever the clock says.
    const r = run(storedMonth(storedRow(9, at(9, 18, 36), null, null)))
    assert.deepEqual(typesOn(r, 9), ['missing_punch_out'])
    assert.ok(amountOn(r, 9) < PER_DAY)
  })
})

// ─── 15. Corrections ──────────────────────────────────────────────────────────

function correction(day: number, over: Partial<AttendanceDayCorrection> = {}): AttendanceDayCorrection {
  return {
    attendance_date: iso(day),
    corrected_check_in_at: null,
    corrected_check_out_at: null,
    day_treatment: 'auto',
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
    ...over,
  }
}

describe('15. a correction is confirmed, and leaves the stored row alone', () => {
  test('the effective layer reports confirmed whatever the raw row stored', () => {
    for (const stored of ['inferred', 'confirmed', null, 'junk'] as const) {
      const effective = resolveEffectiveAttendance(
        { check_in_at: at(9, 18, 36), check_out_at: null, direction_source: parseStoredDirectionSource(stored) },
        correction(9, { corrected_check_in_at: at(9, 11, 30) }),
      )
      assert.equal(effective.direction_source, 'confirmed', String(stored))
      assert.equal(effective.source, 'corrected', String(stored))
    }
  })

  test('an inferred stored row plus a correction gains the late-arrival charge', () => {
    const raw = storedMonth(storedRow(9, at(9, 11, 30), null, 'inferred'))

    assert.deepEqual(typesOn(run(raw), 9), ['missing_punch_out'])
    assert.deepEqual(
      typesOn(run(raw, [correction(9, { corrected_check_in_at: at(9, 11, 30) })]), 9),
      ['late_arrival', 'missing_punch_out'],
    )
  })

  test('the raw attendance array is not mutated by applying a correction', () => {
    const records = storedMonth(storedRow(9, at(9, 18, 36), null, 'inferred'))
    const snapshot = JSON.parse(JSON.stringify(records))

    run(records, [correction(9, { corrected_check_in_at: at(9, 10, 0), corrected_check_out_at: at(9, 18, 36) })])

    assert.deepEqual(records, snapshot, 'the biometric input is read-only to the engine')
  })

  test('the day view still reports the machine punches next to the corrected ones', () => {
    const r = run(
      storedMonth(storedRow(9, at(9, 18, 36), null, 'inferred')),
      [correction(9, { corrected_check_in_at: at(9, 10, 0), corrected_check_out_at: at(9, 18, 36) })],
    )
    const day = r.day_results.find(d => d.date === iso(9))!
    assert.equal(day.raw_check_in_at, at(9, 18, 36))
    assert.equal(day.raw_check_out_at, null)
    assert.equal(day.check_in_at, at(9, 10, 0))
    assert.equal(day.is_corrected, true)
  })

  test('removing the correction returns the day to its STORED provenance', () => {
    const records = storedMonth(storedRow(9, at(9, 11, 30), null, 'inferred'))
    const corrected = run(records, [correction(9, { corrected_check_in_at: at(9, 11, 30) })])
    const reverted  = run(records, [])   // correction superseded / withdrawn

    assert.deepEqual(typesOn(corrected, 9), ['late_arrival', 'missing_punch_out'])
    assert.deepEqual(typesOn(reverted, 9),  ['missing_punch_out'])
  })

  test('a completed corrected punch pair is treated as an ordinary present day', () => {
    const r = run(
      storedMonth(storedRow(9, at(9, 18, 36), null, 'inferred')),
      [correction(9, { corrected_check_in_at: at(9, 10, 0), corrected_check_out_at: at(9, 18, 30) })],
    )
    assert.equal(r.day_results.find(d => d.date === iso(9))!.classification, 'full_present')
    assert.deepEqual(typesOn(r, 9), [])
  })
})

// ─── 17. Provenance is internal ───────────────────────────────────────────────

describe('17. employee-facing APIs do not expose provenance', () => {
  const EMPLOYEE_FACING = [
    'src/app/api/payroll/my-result/route.ts',
    'src/app/api/attendance/employee-monthly-detail/route.ts',
    'src/app/api/attendance/employee-records/route.ts',
    'src/app/api/attendance/monthly-summary/route.ts',
    'src/app/api/attendance/records/route.ts',
    'src/app/api/attendance/dashboard/route.ts',
    'src/app/api/objections/route.ts',
  ]

  test('none of them select or return the column', async () => {
    for (const path of EMPLOYEE_FACING) {
      const src = await readFile(path, 'utf8')
      assert.equal(
        src.includes('punch_direction_source'), false,
        `${path} must not read or expose punch_direction_source`,
      )
      assert.equal(
        src.includes('direction_source'), false,
        `${path} must not surface the internal provenance field`,
      )
    }
  })

  test('the visible classification an employee sees is unaffected by provenance', () => {
    // Missing Punch In / Missing Punch Out is derived from WHICH punch is
    // absent, not from how confidently we know it. Provenance changes the money,
    // never the label — so there is nothing an employee-facing view needs it for.
    const confirmed = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'confirmed')))
    const inferred  = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'inferred')))

    const classOf = (r: EngineResult) => r.day_results.find(d => d.date === iso(9))!.classification
    assert.equal(classOf(confirmed), 'missing_punch')
    assert.equal(classOf(inferred),  'missing_punch')

    const missingType = (r: EngineResult) =>
      linesOn(r, 9).find(l => l.deduction_type.startsWith('missing_punch'))!.deduction_type
    assert.equal(missingType(confirmed), 'missing_punch_out')
    assert.equal(missingType(inferred),  'missing_punch_out')
  })

  test('the engine day view carries no provenance field of its own', () => {
    const r = run(storedMonth(storedRow(9, at(9, 11, 30), null, 'confirmed')))
    const day = r.day_results.find(d => d.date === iso(9))!
    assert.equal('direction_source' in day, false, 'provenance is an input, not a rendered fact')
  })
})
