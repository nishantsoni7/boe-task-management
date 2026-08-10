/**
 * The shared attendance parser.
 *
 *   npx tsx --test src/lib/attendance/punchParser.test.ts
 *
 * The cases that matter most here are the SINGLE-punch ones. A day with one
 * punch used to be handled two different wrong ways depending on the file
 * format, and both cost the employee money — Format A dropped an OUT-only day
 * entirely (payroll then charged a full absence), and Format B filed every lone
 * punch as an arrival however late in the day it was.
 *
 * Workbooks are built in memory with the same `xlsx` package the routes read
 * with, so these exercise the real cell walk, the real format detection and the
 * real IST conversion rather than a stand-in for them.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'

import {
  parseAttendanceWorkbook,
  buildAttendanceRow,
  hhmmToIstMinutes,
  isEmployeeCodeHeader,
  splitPunchCell,
  toTimestamp,
  utcToIST,
  toDateStr,
  toMinutes,
  type EmployeeBlock,
  type DayPunches,
} from './punchParser'
import { TEMP_SINGLE_PUNCH_DIVIDER_MINUTES } from './punchDirection'

// ─── Workbook builders ────────────────────────────────────────────────────────

/** Rows of cells → a one-sheet workbook buffer, as the routes receive it. */
function workbook(rows: (string | number | null)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c == null ? '' : c))))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/**
 * Format A: per-employee vertical block.
 *   header row   → 'Empcode' | '' | <code> | … | <name> at col 7
 *   header + 3   → IN times,  indexed by day number in the column
 *   header + 4   → OUT times
 */
function formatAWorkbook(
  days: { day: number; in?: string; out?: string }[],
  opts: { monthText?: string } = {},
): Buffer {
  const width = 33
  const blank = () => Array<string>(width).fill('')

  const title = blank(); title[0] = opts.monthText ?? 'Jun-2026'
  const head  = blank(); head[0] = 'Empcode'; head[2] = 'EMP01'; head[7] = 'Asha Rao'
  const pad1  = blank()
  const pad2  = blank()
  const inRow = blank()
  const outRow = blank()

  for (const d of days) {
    inRow[d.day]  = d.in  ?? '--:--'
    outRow[d.day] = d.out ?? '--:--'
  }

  // header is row index 1; IN is +3 → row 4, OUT is +4 → row 5
  return workbook([title, head, pad1, pad2, inRow, outRow])
}

/**
 * Format B: horizontal "List of Logs".
 *   row 0 → title carrying the month
 *   row 1 → 'Empcode' | 'Name' | 1 | 2 | … (the header the detector looks for)
 *   row 2 → weekday names, skipped
 *   row 3 → the employee, punches newline-separated per day column
 */
function formatBWorkbook(cellsByDay: Record<number, string>): Buffer {
  const width = 10
  const title = Array<string>(width).fill(''); title[0] = 'List of Logs — Jun-2026'
  const header: string[] = ['Empcode', 'Name']
  for (let d = 1; d <= width - 2; d++) header.push(String(d))
  const weekdays = Array<string>(width).fill('')
  const row: string[] = ['EMP01', 'Asha Rao']
  for (let d = 1; d <= width - 2; d++) row.push(cellsByDay[d] ?? '')

  return workbook([title, header, weekdays, row])
}

/**
 * The workbook received from Santosh: the same horizontal layout, but the code
 * column is headed 'No.', there is no weekday row under the header, and a day's
 * punches are separated by spaces rather than newlines.
 */
function santoshWorkbook(
  cellsByDay: Record<number, string>,
  opts: { code?: string; name?: string; header?: string } = {},
): Buffer {
  const width = 10
  const title = Array<string>(width).fill(''); title[0] = 'Attendance Jun-2026'
  const header: string[] = [opts.header ?? 'No.', 'Name']
  for (let d = 1; d <= width - 2; d++) header.push(String(d))
  const row: string[] = [opts.code ?? 'S-1', opts.name ?? 'Santosh Kumar']
  for (let d = 1; d <= width - 2; d++) row.push(cellsByDay[d] ?? '')

  // No weekday row — the employee row sits directly under the header.
  return workbook([title, header, row])
}

function dayOf(blocks: EmployeeBlock[], day: number): DayPunches | undefined {
  return blocks[0]?.days.find(d => d.day === day)
}

const JUNE = { year: 2026, month: 6 }

// ─── Format A ─────────────────────────────────────────────────────────────────

describe('Format A — the file states the direction', () => {
  test('1. IN present, OUT missing → punch-in only, confirmed', () => {
    const { blocks, format } = parseAttendanceWorkbook(
      formatAWorkbook([{ day: 3, in: '10:02' }]),
    )
    assert.equal(format, 'A')

    const day = dayOf(blocks, 3)
    assert.ok(day, 'the day must survive parsing')
    assert.equal(day.in, '10:02')
    assert.equal(day.out, '')
    assert.equal(day.direction_source, 'confirmed')

    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(utcToIST(built.row.check_in_at), '10:02')
    assert.equal(built.row.check_out_at, null)
    assert.equal(built.row.status, 'checked_in')
    assert.equal(built.row.direction_source, 'confirmed')
  })

  test('2. IN missing, OUT present → punch-out only, confirmed, day NOT dropped', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatAWorkbook([{ day: 4, out: '18:36' }]),
    )

    // The regression this whole change exists for: the old parser `continue`d on
    // a missing IN cell, so this day never reached the database at all and
    // payroll read it as a full absence.
    const day = dayOf(blocks, 4)
    assert.ok(day, 'an OUT-only day must not be discarded')
    assert.equal(day.in, '')
    assert.equal(day.out, '18:36')
    assert.equal(day.direction_source, 'confirmed')

    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(built.row.check_in_at, null)
    assert.equal(utcToIST(built.row.check_out_at), '18:36')
    assert.equal(built.row.status, 'checked_in')
  })

  test('3. both punches missing → no day emitted at all', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatAWorkbook([{ day: 5 }]),
    )
    assert.equal(dayOf(blocks, 5), undefined)
    assert.equal(blocks[0].days.length, 0)
  })

  test('4. both punches present → an ordinary complete pair', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatAWorkbook([{ day: 6, in: '10:07', out: '18:42' }]),
    )
    const day = dayOf(blocks, 6)
    assert.ok(day)
    assert.equal(day.in, '10:07')
    assert.equal(day.out, '18:42')

    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(utcToIST(built.row.check_in_at), '10:07')
    assert.equal(utcToIST(built.row.check_out_at), '18:42')
    assert.equal(built.row.status, 'present')
    assert.equal(built.row.direction_source, 'confirmed')
  })

  test('an empty string and "--:--" mean the same thing', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatAWorkbook([{ day: 7, in: '', out: '17:00' }]),
    )
    const day = dayOf(blocks, 7)
    assert.ok(day)
    assert.equal(day.in, '')
    assert.equal(day.out, '17:00')
  })
})

// ─── Format B ─────────────────────────────────────────────────────────────────

describe('Format B — the direction is inferred from the clock', () => {
  test('the divider is exactly 2:00 PM', () => {
    assert.equal(TEMP_SINGLE_PUNCH_DIVIDER_MINUTES, 14 * 60)
  })

  test('5. one punch at 10:00 AM → read as the arrival, inferred', () => {
    const { blocks, format } = parseAttendanceWorkbook(formatBWorkbook({ 1: '10:00' }))
    assert.equal(format, 'B')

    const day = dayOf(blocks, 1)
    assert.ok(day)
    assert.equal(day.in, '10:00')
    assert.equal(day.out, '')
    assert.equal(day.direction_source, 'inferred')

    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(utcToIST(built.row.check_in_at), '10:00')
    assert.equal(built.row.check_out_at, null)
    assert.equal(built.row.direction_source, 'inferred')
  })

  test('6. one punch at 1:59 PM → still the arrival', () => {
    const { blocks } = parseAttendanceWorkbook(formatBWorkbook({ 2: '13:59' }))
    const day = dayOf(blocks, 2)
    assert.ok(day)
    assert.equal(day.in, '13:59')
    assert.equal(day.out, '')
    assert.equal(day.direction_source, 'inferred')
  })

  test('7. one punch at exactly 2:00 PM → the departure (boundary is afternoon)', () => {
    const { blocks } = parseAttendanceWorkbook(formatBWorkbook({ 3: '14:00' }))
    const day = dayOf(blocks, 3)
    assert.ok(day)
    assert.equal(day.in, '', '14:00 exactly must NOT be read as an arrival')
    assert.equal(day.out, '14:00')
    assert.equal(day.direction_source, 'inferred')
  })

  test('8. one punch at 6:30 PM → the departure', () => {
    const { blocks } = parseAttendanceWorkbook(formatBWorkbook({ 4: '18:30' }))
    const day = dayOf(blocks, 4)
    assert.ok(day)
    assert.equal(day.in, '')
    assert.equal(day.out, '18:30')

    // The exact shape of the ₹896 bug: this used to be stored as an arrival at
    // 18:30, which the engine then charged ~9 hours of lateness for.
    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(built.row.check_in_at, null)
    assert.equal(utcToIST(built.row.check_out_at), '18:30')
  })

  test('9. two punches → first is IN, last is OUT, nothing inferred', () => {
    const { blocks } = parseAttendanceWorkbook(formatBWorkbook({ 5: '10:07\n18:36\n' }))
    const day = dayOf(blocks, 5)
    assert.ok(day)
    assert.equal(day.in, '10:07')
    assert.equal(day.out, '18:36')
    assert.equal(day.direction_source, 'confirmed')

    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(built.row.status, 'present')
  })

  test('10. three or more punches → first and last, middles ignored', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatBWorkbook({ 6: '09:58\n13:05\n14:02\n19:11\n' }),
    )
    const day = dayOf(blocks, 6)
    assert.ok(day)
    assert.equal(day.in, '09:58')
    assert.equal(day.out, '19:11')
    assert.equal(day.direction_source, 'confirmed')
  })

  test('an evening-only punch and a full day in the same file stay independent', () => {
    const { blocks } = parseAttendanceWorkbook(
      formatBWorkbook({ 1: '10:07\n18:36\n', 2: '18:40' }),
    )
    assert.equal(dayOf(blocks, 1)?.direction_source, 'confirmed')
    assert.equal(dayOf(blocks, 2)?.direction_source, 'inferred')
    assert.equal(dayOf(blocks, 2)?.in, '')
  })
})

// ─── Santosh's workbook: the horizontal layout with a 'No.' code column ──────

describe("Santosh's workbook — horizontal layout, 'No.' code header", () => {
  test("'No.' over a Name column is recognised as the horizontal format", () => {
    const { blocks, format, deviceFormat } = parseAttendanceWorkbook(
      santoshWorkbook({ 1: '10:04 18:41' }),
    )
    assert.equal(format, 'B')
    assert.equal(deviceFormat, 'Fingerprint Machine Export (Horizontal Row Format)')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].empcode, 'S-1')
    assert.equal(blocks[0].name, 'Santosh Kumar')
    assert.equal(blocks[0].month, 6)
    assert.equal(blocks[0].year, 2026)
  })

  test('the employee row directly under the header is not skipped as a weekday row', () => {
    // The reader used to start at headerRow + 2 unconditionally. This workbook
    // has no weekday row, so that swallowed its only employee and the file
    // parsed as "no employee blocks found".
    const { blocks } = parseAttendanceWorkbook(santoshWorkbook({ 2: '09:58 19:02' }))
    assert.equal(blocks.length, 1, 'the first data row must survive')
    assert.equal(dayOf(blocks, 2)?.in, '09:58')
  })

  test('space-separated punches: first and last are the pair', () => {
    const { blocks } = parseAttendanceWorkbook(santoshWorkbook({ 3: '09:58 13:05 14:02 19:11' }))
    const day = dayOf(blocks, 3)
    assert.ok(day)
    assert.equal(day.in, '09:58')
    assert.equal(day.out, '19:11')
    assert.equal(day.direction_source, 'confirmed')

    const built = buildAttendanceRow(JUNE, day)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(utcToIST(built.row.check_in_at), '09:58')
    assert.equal(utcToIST(built.row.check_out_at), '19:11')
    assert.equal(built.row.status, 'present')
  })

  test('comma-separated punches split the same way', () => {
    const { blocks } = parseAttendanceWorkbook(santoshWorkbook({ 4: '10:01, 13:40, 18:55' }))
    const day = dayOf(blocks, 4)
    assert.ok(day)
    assert.equal(day.in, '10:01')
    assert.equal(day.out, '18:55')
  })

  test('a lone punch still goes through the divider, and is still inferred', () => {
    const { blocks } = parseAttendanceWorkbook(santoshWorkbook({ 5: '18:30' }))
    const day = dayOf(blocks, 5)
    assert.ok(day)
    assert.equal(day.in, '')
    assert.equal(day.out, '18:30')
    assert.equal(day.direction_source, 'inferred')
  })

  test('a day cell holding a real Excel time value is read from its display text', () => {
    // aoa_to_sheet turns "10:07" typed as a time into a NUMBER. Stringifying
    // that gives a fraction, which no clock parser accepts, so the day would be
    // dropped — an attendance day silently becoming an absence.
    const ws = XLSX.utils.aoa_to_sheet([
      ['Attendance Jun-2026', '', ''],
      ['No.', 'Name', '1'],
      ['S-1', 'Santosh Kumar', ''],
    ])
    // `w` is not stored in the file — it is regenerated from the number format
    // when the workbook is read, which is exactly how a real time cell arrives.
    ws['C3'] = { t: 'n', v: 0.4215277777777778, z: 'hh:mm' }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const { blocks } = parseAttendanceWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)

    const day = dayOf(blocks, 1)
    assert.ok(day, 'a time-typed cell must not be discarded')
    assert.equal(day.in, '10:07')
  })

  test('the accepted code headers are matched case- and spacing-insensitively', () => {
    for (const header of ['No.', 'no.', 'NO.', 'Empcode', 'EMPCODE', 'Emp Code', 'Employee Code']) {
      const { blocks, format } = parseAttendanceWorkbook(
        santoshWorkbook({ 1: '10:00 18:30' }, { header }),
      )
      assert.equal(format, 'B', header)
      assert.equal(blocks.length, 1, header)
      assert.equal(dayOf(blocks, 1)?.out, '18:30', header)
    }
    assert.ok(isEmployeeCodeHeader(' No. '))
    assert.equal(isEmployeeCodeHeader('Sr'), false)
    assert.equal(isEmployeeCodeHeader('Name'), false)
  })

  test('a repeated header row is not read as an employee', () => {
    const buffer = workbook([
      ['Attendance Jun-2026', '', ''],
      ['No.', 'Name', '1'],
      ['S-1', 'Santosh Kumar', '10:00 18:30'],
      ['No.', 'Name', '1'],
      ['S-2', 'Ravi Nair', '10:10 18:20'],
    ])
    const { blocks } = parseAttendanceWorkbook(buffer)
    assert.deepEqual(blocks.map(b => b.empcode), ['S-1', 'S-2'])
  })

  test('splitPunchCell keeps order and drops anything that is not a clock time', () => {
    assert.deepEqual(splitPunchCell('10:07 18:36'),      ['10:07', '18:36'])
    assert.deepEqual(splitPunchCell('10:07\n18:36\n'),   ['10:07', '18:36'])
    assert.deepEqual(splitPunchCell('10:07 , 18:36'),    ['10:07', '18:36'])
    assert.deepEqual(splitPunchCell('10:07 / 18:36'),    ['10:07', '18:36'])
    assert.deepEqual(splitPunchCell('--:-- 18:36'),      ['18:36'])
    assert.deepEqual(splitPunchCell('25:99 18:36'),      ['18:36'])
    assert.deepEqual(splitPunchCell('Absent'),           [])
    assert.deepEqual(splitPunchCell(''),                 [])
  })
})

// ─── Malformed input ──────────────────────────────────────────────────────────

describe('11. malformed times', () => {
  test('hhmmToIstMinutes rejects anything that is not a real clock time', () => {
    assert.equal(hhmmToIstMinutes('00:00'), 0)
    assert.equal(hhmmToIstMinutes('9:05'), 545)
    assert.equal(hhmmToIstMinutes('23:59'), 1439)

    assert.equal(hhmmToIstMinutes('25:99'), null)
    assert.equal(hhmmToIstMinutes('24:00'), null)
    assert.equal(hhmmToIstMinutes('10:60'), null)
    assert.equal(hhmmToIstMinutes('--:--'), null)
    assert.equal(hhmmToIstMinutes('abc'), null)
    assert.equal(hhmmToIstMinutes(''), null)
    assert.equal(hhmmToIstMinutes('10'), null)
  })

  test('an out-of-range time no longer rolls over into the next day', () => {
    // The old toTimestamp handed "25:99" straight to Date.UTC, which normalises
    // overflow — the punch silently became a valid instant on the 4th. That was
    // survivable while the value was only a timestamp; it is not survivable now
    // the HOUR decides whether a lone punch is an arrival or a departure.
    assert.equal(toTimestamp('25:99', 2026, 6, 3), null)
    assert.equal(toTimestamp('10:30', 2026, 6, 3), '2026-06-03T05:00:00.000Z')
  })

  test('Format B discards a malformed punch rather than letting it pick a direction', () => {
    const { blocks } = parseAttendanceWorkbook(formatBWorkbook({ 1: '25:99' }))
    assert.equal(dayOf(blocks, 1), undefined)
  })

  test('Format B keeps the readable punch when one of two is malformed', () => {
    const { blocks } = parseAttendanceWorkbook(formatBWorkbook({ 2: '25:99\n18:20\n' }))
    const day = dayOf(blocks, 2)
    assert.ok(day)
    // Only one punch survived, so it goes through the divider: 18:20 is a departure.
    assert.equal(day.in, '')
    assert.equal(day.out, '18:20')
    assert.equal(day.direction_source, 'inferred')
  })

  test('a day whose only punch text is unreadable is reported, not written', () => {
    const built = buildAttendanceRow(JUNE, {
      day: 9, in: '99:99', out: '', direction_source: 'confirmed',
    })
    assert.equal(built.ok, false)
    if (built.ok) return
    assert.equal(built.reason, 'unparseable')
    assert.equal(built.attendance_date, '2026-06-09')
    assert.match(built.detail, /invalid IN time/)
  })

  test('an unreadable OUT is tolerated when the IN is good — the day still imports', () => {
    // Preserves the original import's behaviour: a bad OUT became a null
    // punch-out and the day was still recorded.
    const built = buildAttendanceRow(JUNE, {
      day: 10, in: '10:05', out: '99:99', direction_source: 'confirmed',
    })
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(utcToIST(built.row.check_in_at), '10:05')
    assert.equal(built.row.check_out_at, null)
  })

  test('an unreadable IN is tolerated when the OUT is good — now symmetric', () => {
    const built = buildAttendanceRow(JUNE, {
      day: 11, in: '99:99', out: '18:05', direction_source: 'confirmed',
    })
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.equal(built.row.check_in_at, null)
    assert.equal(utcToIST(built.row.check_out_at), '18:05')
  })

  test('a day with no punch text at all is reported as no_punches', () => {
    const built = buildAttendanceRow(JUNE, {
      day: 12, in: '', out: '', direction_source: 'confirmed',
    })
    assert.equal(built.ok, false)
    if (built.ok) return
    assert.equal(built.reason, 'no_punches')
  })
})

// ─── Preserved behaviour ──────────────────────────────────────────────────────

describe('behaviour carried over unchanged from the two route copies', () => {
  test('month/year is detected from all four supported spellings', () => {
    for (const text of ['Jun-2026', 'June 2026', '06/2026', '2026-06']) {
      const { blocks } = parseAttendanceWorkbook(
        formatAWorkbook([{ day: 1, in: '10:00', out: '18:30' }], { monthText: text }),
      )
      assert.equal(blocks[0].year, 2026, text)
      assert.equal(blocks[0].month, 6, text)
    }
  })

  test('an undetectable month is a thrown error, not a silent default', () => {
    assert.throws(
      () => parseAttendanceWorkbook(formatAWorkbook([{ day: 1, in: '10:00' }], { monthText: 'no date here' })),
      /Could not detect report month\/year/,
    )
  })

  test('IST is converted by subtracting 5h30m, and round-trips', () => {
    const iso = toTimestamp('10:07', 2026, 6, 15)
    assert.equal(iso, '2026-06-15T04:37:00.000Z')
    assert.equal(utcToIST(iso), '10:07')
  })

  test('a punch before 05:30 IST belongs to the previous UTC day', () => {
    assert.equal(toTimestamp('01:00', 2026, 6, 15), '2026-06-14T19:30:00.000Z')
    assert.equal(utcToIST('2026-06-14T19:30:00.000Z'), '01:00')
  })

  test('toDateStr zero-pads', () => {
    assert.equal(toDateStr(2026, 6, 3), '2026-06-03')
    assert.equal(toDateStr(2026, 12, 31), '2026-12-31')
  })

  test('toMinutes ignores sub-minute differences and handles null', () => {
    assert.equal(toMinutes(null), null)
    assert.equal(toMinutes(undefined), null)
    assert.equal(
      toMinutes('2026-06-15T04:37:00.000Z'),
      toMinutes('2026-06-15T04:37:59.000Z'),
    )
  })

  test('utcToIST renders a missing punch as an em dash', () => {
    assert.equal(utcToIST(null), '—')
    assert.equal(utcToIST(undefined), '—')
  })
})

// ─── 12. Import and preview share this parser ─────────────────────────────────

describe('12. import and preview use the shared parser', () => {
  test('neither route defines its own parser any more', async () => {
    const fs = await import('node:fs/promises')
    const sources = await Promise.all([
      fs.readFile('src/app/api/attendance/import/route.ts', 'utf8'),
      fs.readFile('src/app/api/attendance/preview/route.ts', 'utf8'),
    ])

    for (const [i, src] of sources.entries()) {
      const which = i === 0 ? 'import' : 'preview'
      assert.match(src, /from '@\/lib\/attendance\/punchParser'/, `${which} must import the shared parser`)
      assert.match(src, /parseAttendanceWorkbook\(/,             `${which} must call the shared workbook parser`)
      assert.match(src, /buildAttendanceRow\(/,                  `${which} must call the shared row builder`)

      // The duplication this module replaced must not creep back.
      assert.doesNotMatch(src, /function parseFormatA/,  `${which} must not redefine parseFormatA`)
      assert.doesNotMatch(src, /function parseFormatB/,  `${which} must not redefine parseFormatB`)
      assert.doesNotMatch(src, /function toTimestamp/,   `${which} must not redefine toTimestamp`)
      assert.doesNotMatch(src, /from 'xlsx'/,            `${which} must not read the workbook itself`)
    }
  })

  test('the same workbook yields identical rows however it is consumed', () => {
    // Preview and import differ only in what they DO with a built row, so
    // building twice from one parse is the same guarantee both routes rely on.
    const buffer = formatBWorkbook({ 1: '10:07\n18:36\n', 2: '18:40', 3: '09:15' })
    const first  = parseAttendanceWorkbook(buffer)
    const second = parseAttendanceWorkbook(buffer)

    const rowsOf = (p: typeof first) =>
      p.blocks.flatMap(b => b.days.map(d => buildAttendanceRow(b, d)))

    assert.deepEqual(rowsOf(first), rowsOf(second))
    assert.equal(rowsOf(first).length, 3)
  })
})
