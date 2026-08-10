// The fingerprint attendance file, parsed once for the whole application.
//
// WHY THIS MODULE EXISTS
// ----------------------
// This parser lived twice, copied almost line for line into
// src/app/api/attendance/import/route.ts and
// src/app/api/attendance/preview/route.ts. Preview is the screen an admin reads
// before deciding to import, so the two agreeing is the entire point of having a
// preview — and two copies of a parser agree only for as long as nobody edits
// one of them. They had already drifted (preview dropped the work/ot/status
// columns import carried), and the single-punch fix below would have had to be
// made identically in both.
//
// So both routes now call parseAttendanceWorkbook() and buildAttendanceRow()
// from here, and "does the preview match the import?" is answered by
// construction rather than by inspection.
//
// WHAT CHANGED IN THE PARSING ITSELF
// ----------------------------------
// A working day with exactly one punch used to be handled two different wrong
// ways, and both cost the employee money:
//
//   Format A  A day with an OUT punch and no IN punch was DROPPED ENTIRELY —
//             `if (!inV || inV === '--:--') continue`. No attendance row was
//             written, so payroll saw no record at all and charged a FULL DAY'S
//             ABSENCE for a day the person demonstrably attended.
//
//   Format B  A lone punch was assigned to check_in_at unconditionally —
//             `in: punches[0]`. An employee whose only punch was at 18:36 was
//             recorded as arriving at 18:36, which is a missing punch-out AND
//             (because the engine stacks late arrival on a missing punch-out)
//             roughly nine hours of lateness. One forgotten morning punch could
//             cost more than being absent for the day.
//
// Both are fixed here, at the point where the direction is actually knowable,
// rather than being papered over later in the engine. Format A's direction is
// read from the file; Format B's is inferred from the clock and MARKED as
// inferred so no time-based deduction is built on top of a guess. See
// ./punchDirection for that distinction and why it is carried this far.

import * as XLSX from 'xlsx'
import {
  isArrivalByDivider,
  parseStoredDirectionSource,
  resolveDirectionSource,
  type PunchDirectionSource,
} from './punchDirection'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Which layout the workbook turned out to be. */
export type PunchFileFormat = 'A' | 'B'

/**
 * One day of one employee, as the file states it.
 *
 * `in` and `out` are the raw "HH:MM" strings, or '' when the file has no punch
 * for that side. Both being '' is not representable in a parsed block — such a
 * day is simply not emitted.
 */
export type DayPunches = {
  day: number
  in: string
  out: string
  /** How the IN/OUT split was decided for THIS day. See ./punchDirection. */
  direction_source: PunchDirectionSource
}

export type EmployeeBlock = {
  empcode: string
  name: string
  year: number
  /** 1-based. */
  month: number
  days: DayPunches[]
}

export type ParsedWorkbook = {
  blocks: EmployeeBlock[]
  format: PunchFileFormat
  /** Human-readable label for the preview screen. */
  deviceFormat: string
}

/** An attendance row ready to be written, or compared against, the database. */
export type ParsedAttendanceRow = {
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  /** 'present' when both punches landed, 'checked_in' when the day is half a pair. */
  status: 'present' | 'checked_in'
  direction_source: PunchDirectionSource
  /** The raw file strings, for the preview diff. */
  in_hhmm: string
  out_hhmm: string
}

export type BuildRowResult =
  | { ok: true; row: ParsedAttendanceRow }
  | { ok: false; attendance_date: string; reason: 'no_punches' | 'unparseable'; detail: string }

// ─── Month / year detection ───────────────────────────────────────────────────
// Unchanged from both original copies, including the order the four patterns are
// tried in. Attendance files in the wild carry the month in all of these shapes
// and an admin's upload must not start failing because this was "tidied".

const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const MONTH_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december']

export function monthYearFromText(v: string): { year: number; month: number } | null {
  // "Jun-2026" / "June-2026" / "Jun 2026" / "June 2026"
  const mName = v.match(/\b([A-Za-z]{3,9})[\s\-](\d{4})\b/)
  if (mName) {
    const name = mName[1].toLowerCase()
    const year = parseInt(mName[2], 10)
    if (year >= 2000 && year <= 2100) {
      const byAbbr = MONTH_ABBR.indexOf(name.slice(0, 3))
      if (byAbbr !== -1) return { year, month: byAbbr + 1 }
      const byFull = MONTH_FULL.indexOf(name)
      if (byFull !== -1) return { year, month: byFull + 1 }
    }
  }
  // "2026-Jun" / "2026 June"
  const mRev = v.match(/\b(\d{4})[\s\-]([A-Za-z]{3,9})\b/)
  if (mRev) {
    const year = parseInt(mRev[1], 10)
    const name = mRev[2].toLowerCase()
    if (year >= 2000 && year <= 2100) {
      const byAbbr = MONTH_ABBR.indexOf(name.slice(0, 3))
      if (byAbbr !== -1) return { year, month: byAbbr + 1 }
      const byFull = MONTH_FULL.indexOf(name)
      if (byFull !== -1) return { year, month: byFull + 1 }
    }
  }
  // "06/2026" / "06-2026"
  const mSlash = v.match(/\b(0?[1-9]|1[0-2])[\/\-](\d{4})\b/)
  if (mSlash) {
    const month = parseInt(mSlash[1], 10)
    const year  = parseInt(mSlash[2], 10)
    if (year >= 2000 && year <= 2100) return { year, month }
  }
  // "2026-06" / "2026/06"
  const mIso = v.match(/\b(\d{4})[\/\-](0[1-9]|1[0-2])\b/)
  if (mIso) {
    const year  = parseInt(mIso[1], 10)
    const month = parseInt(mIso[2], 10)
    if (year >= 2000 && year <= 2100) return { year, month }
  }
  return null
}

function parseMonthYear(sheet: XLSX.WorkSheet, sheetName: string): { year: number; month: number } | null {
  const fromSheet = monthYearFromText(sheetName)
  if (fromSheet) return fromSheet

  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1')
  for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })]
      if (!cell) continue
      const v = String(cell.v ?? '').trim()
      if (!v) continue
      const result = monthYearFromText(v)
      if (result) return result
    }
  }
  return null
}

export const MONTH_YEAR_PARSE_ERROR =
  'Could not detect report month/year from file. ' +
  'Expected a cell in the first 20 rows (or sheet name) containing a value like ' +
  '"Jun-2026", "June 2026", "06/2026", or "2026-06".'

// ─── Cell helpers ─────────────────────────────────────────────────────────────

function cellStr(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })]
  if (!cell) return ''
  return String(cell.v ?? '').trim()
}

/** '--:--' is the machine's way of writing "no punch". Normalise it to empty. */
function punchCell(raw: string): string {
  const v = raw.trim()
  return v === '' || v === '--:--' ? '' : v
}

/** Lower-cased, whitespace-collapsed — the form header labels are compared in. */
function normaliseHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The labels a horizontal workbook may use over its employee-code column.
 *
 * The exports differ only in what they call this column. Our own fingerprint
 * machine writes 'Empcode'; the monthly workbook we receive from Santosh writes
 * 'No.'. The layout underneath — a day per column, every punch of a day in one
 * cell — is the same file shape, so it is read by the same code path rather than
 * by a third format reader that would immediately start drifting from this one.
 *
 * Matched case-insensitively, and always TOGETHER WITH a 'Name' cell in the next
 * column. On its own 'No.' is far too common a spreadsheet heading to treat as a
 * format signal; 'No.' immediately left of 'Name' with numbered day columns to
 * the right is not.
 */
export const EMPLOYEE_CODE_HEADER_LABELS = [
  'empcode',
  'emp code',
  'emp. code',
  'employee code',
  'no.',
  'no',
] as const

export function isEmployeeCodeHeader(raw: string): boolean {
  return (EMPLOYEE_CODE_HEADER_LABELS as readonly string[]).includes(normaliseHeader(raw))
}

/**
 * The punch times in one day cell, in the order the file lists them.
 *
 * Splitting used to be newline-only. That is how our own machine writes a
 * multi-punch day, but it is not the only way: the same day arrives from other
 * exports space-separated ("10:07 13:02 18:36") or comma-separated, and on a
 * newline-only split the whole cell fails the HH:MM shape and the day is
 * silently DROPPED — an attendance day turned into an absence by a separator.
 *
 * Every separator below is whitespace or punctuation that cannot occur inside
 * "HH:MM", so a newline-separated cell splits exactly as it always did.
 */
export function splitPunchCell(raw: string): string[] {
  return raw
    .split(/[\s,;|/]+/)
    .map(s => s.trim())
    .filter(s => hhmmToIstMinutes(s) !== null)
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

const HHMM = /^(\d{1,2}):(\d{2})$/

/**
 * "HH:MM" → minutes past midnight IST, or null when it is not a real clock time.
 *
 * The range check is new and it matters more than it looks. The old code only
 * asked whether the two halves were numbers, then handed them to
 * `Date.UTC(y, m, d, hh, mm - 330)`, which NORMALISES overflow rather than
 * rejecting it — "25:99" silently became a valid timestamp on the following day.
 * That was tolerable while the value was only ever a timestamp; it is not
 * tolerable now that the HOUR decides whether a lone punch is an arrival or a
 * departure. A nonsense hour must be rejected, not quietly routed.
 */
export function hhmmToIstMinutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm.trim())
  if (!m) return null
  const hh = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

/**
 * "HH:MM" IST + a calendar date → the UTC ISO instant, or null.
 *
 * Fingerprint machine times are IST (UTC+5:30), so 330 minutes come off before
 * the value is stored. Unchanged from both original copies apart from the range
 * validation described above.
 */
export function toTimestamp(hhmm: string, year: number, month: number, day: number): string | null {
  const minutes = hhmmToIstMinutes(hhmm)
  if (minutes === null) return null
  const d = new Date(Date.UTC(year, month - 1, day, 0, minutes - 330, 0))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** UTC ISO → IST "HH:MM", for the preview diff. */
export function utcToIST(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const istDate = new Date(d.getTime() + 330 * 60 * 1000)
  return `${String(istDate.getUTCHours()).padStart(2, '0')}:${String(istDate.getUTCMinutes()).padStart(2, '0')}`
}

/** Compare stored and incoming timestamps at minute precision. */
export function toMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor(t / 60000)
}

// ─── Format A: per-employee vertical blocks, separate IN and OUT rows ─────────

function parseFormatA(ws: XLSX.WorkSheet, monthYear: { year: number; month: number }): EmployeeBlock[] {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const blocks: EmployeeBlock[] = []

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (cellStr(ws, r, 0) !== 'Empcode') continue
    // Skip Format B header rows (col 1 = "Name")
    if (cellStr(ws, r, 1) === 'Name') continue

    const empcode = cellStr(ws, r, 2).trim()
    const name    = cellStr(ws, r, 7).trim()
    if (!empcode) continue

    const inRow  = r + 3
    const outRow = r + 4

    const days: DayPunches[] = []
    for (let day = 1; day <= 31; day++) {
      const inV  = punchCell(cellStr(ws, inRow,  day))
      const outV = punchCell(cellStr(ws, outRow, day))

      // A day is emitted when the file has EITHER punch. Previously the loop
      // required the IN cell and `continue`d otherwise, so an OUT-only day never
      // reached the database and payroll read it as an absence.
      if (!inV && !outV) continue

      // The file put these in two different rows. That IS the direction; nothing
      // is being decided here.
      days.push({ day, in: inV, out: outV, direction_source: 'confirmed' })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Format B: horizontal "List of Logs", all punches in one cell ────────────
//
// Two workbooks share this layout and differ only in surface detail: our own
// machine's "List of Logs" export, and the monthly workbook received from
// Santosh, which heads its code column 'No.' instead of 'Empcode', omits the
// weekday row, and may separate a day's punches with spaces rather than
// newlines. All three differences are absorbed here rather than in a third
// format reader, so a fix to how a horizontal day is read reaches both files.

/**
 * The row carrying the employee-code and Name headings, or -1.
 *
 * Shared by the reader below and the format detector at the bottom of this
 * module, because those two answering the question differently is how a file
 * gets detected as horizontal and then read as empty.
 */
function findHorizontalHeaderRow(ws: XLSX.WorkSheet): number {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  for (let r = range.s.r; r <= Math.min(range.e.r, 10); r++) {
    if (isEmployeeCodeHeader(cellStr(ws, r, 0)) && normaliseHeader(cellStr(ws, r, 1)) === 'name') {
      return r
    }
  }
  return -1
}

function parseFormatB(ws: XLSX.WorkSheet, monthYear: { year: number; month: number }): EmployeeBlock[] {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')

  const headerRow = findHorizontalHeaderRow(ws)
  if (headerRow === -1) return []

  // col → day number (1-31) from the header row
  const colToDay = new Map<number, number>()
  for (let c = 2; c <= range.e.c; c++) {
    const n = parseInt(cellStr(ws, headerRow, c), 10)
    if (!isNaN(n) && n >= 1 && n <= 31) colToDay.set(c, n)
  }

  const blocks: EmployeeBlock[] = []
  // Scanning starts at headerRow + 1, not + 2. Our own export puts a row of
  // weekday names there, which is skipped below because its employee-code cell
  // is empty; a workbook that has no such row (Santosh's does not) used to lose
  // its FIRST EMPLOYEE to an unconditional +2. Skipping by what the row contains
  // rather than by where it sits reads both.
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const empcode = cellStr(ws, r, 0).trim()
    const name    = cellStr(ws, r, 1).trim()
    if (!empcode) continue
    // A repeated header — some exports restate it per page — is not an employee.
    if (isEmployeeCodeHeader(empcode) && normaliseHeader(name) === 'name') continue

    const days: DayPunches[] = []
    for (const [col, day] of colToDay) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: col })]
      if (!cell) continue
      // A cell holding a real Excel time is a NUMBER (0.42…), and stringifying
      // that yields a fraction no clock parser will accept. `w` is the text the
      // spreadsheet displays, which is the "HH:MM" a human sees, so it is
      // preferred whenever the value is not already text.
      const raw = (typeof cell.v === 'string' ? cell.v : (cell.w ?? String(cell.v ?? ''))).trim()
      if (!raw) continue

      // Only real clock times survive. A cell entry that matches the shape but
      // not the range ("25:99") is discarded here rather than being allowed to
      // decide a direction.
      const punches = splitPunchCell(raw)

      if (punches.length === 0) continue

      if (punches.length === 1) {
        // Nothing in this file says which door a lone punch was. The clock is
        // the only signal there is, so it is used — and the day is marked
        // 'inferred' so the engine will not build a lateness charge on it.
        const minutes = hhmmToIstMinutes(punches[0])!
        const arrival = isArrivalByDivider(minutes)
        days.push({
          day,
          in:  arrival ? punches[0] : '',
          out: arrival ? '' : punches[0],
          direction_source: 'inferred',
        })
        continue
      }

      // Two or more punches: first and last are the pair, exactly as before.
      // Nothing was inferred, so this day is as confirmed as Format A's.
      days.push({
        day,
        in:  punches[0],
        out: punches[punches.length - 1],
        direction_source: 'confirmed',
      })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Format detection ─────────────────────────────────────────────────────────

export function parseAttendanceWorkbook(buffer: Buffer): ParsedWorkbook {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const monthYear = parseMonthYear(ws, wb.SheetNames[0])
  if (!monthYear) throw new Error(MONTH_YEAR_PARSE_ERROR)

  if (findHorizontalHeaderRow(ws) !== -1) {
    return {
      blocks: parseFormatB(ws, monthYear),
      format: 'B',
      deviceFormat: 'Fingerprint Machine Export (Horizontal Row Format)',
    }
  }

  return {
    blocks: parseFormatA(ws, monthYear),
    format: 'A',
    deviceFormat: 'Fingerprint Machine Export (Empcode-row XLS)',
  }
}

// ─── One parsed day → one attendance row ──────────────────────────────────────

/**
 * The row import writes and preview compares against — built once, here.
 *
 * A punch string that will not parse is tolerated on ONE side, which preserves
 * the original import's behaviour: a bad OUT cell became a null punch-out and
 * the day was still recorded. That tolerance is now symmetric, because a
 * punch-out-only day is a legitimate row rather than something to discard. The
 * day is only rejected when NEITHER side yields a usable time.
 */
/** The columns import and preview read back to work out what an upload changes. */
export type StoredAttendanceRow = {
  check_in_at: string | null
  check_out_at: string | null
  /** `text` in the database, so `string | null` here until it is narrowed. */
  punch_direction_source?: string | null
}

export type AttendanceRowChange = {
  /** Anything at all differs, so the stored row must be written. */
  changed: boolean
  /** A punch time differs. Only these belong in attendance_correction_log. */
  punchesChanged: boolean
}

/**
 * What an incoming row would change about the row already stored.
 *
 * Used by BOTH the import and the preview, so the count an admin approves and
 * the work the import then does cannot disagree.
 *
 * Two separate answers, because they drive different things:
 *
 *   punchesChanged  is the admin-visible fact — a punch time moved. It is what
 *                   the before/after diff shows and the ONLY thing that earns an
 *                   attendance_correction_log entry, which exists to record
 *                   punch corrections and would be actively misleading if it
 *                   filled up with rows whose before and after are identical.
 *
 *   changed         additionally covers provenance drifting. Re-importing a
 *                   month is how a legacy row (NULL, imported before the column
 *                   existed) or a row whose file format changed acquires the
 *                   right value. Without this, stale provenance would survive
 *                   any re-import whose punch times happened to match, and the
 *                   engine would keep reading a Format A day as a guess.
 *
 * Punch times compare at MINUTE precision, as they always have, so sub-second
 * database rounding is not a change.
 */
export function attendanceRowChange(
  next: Pick<ParsedAttendanceRow, 'check_in_at' | 'check_out_at' | 'direction_source'>,
  existing: StoredAttendanceRow,
): AttendanceRowChange {
  const punchesChanged =
    toMinutes(existing.check_in_at)  !== toMinutes(next.check_in_at) ||
    toMinutes(existing.check_out_at) !== toMinutes(next.check_out_at)

  // Compared through the resolver, not raw: a stored NULL and a stored
  // 'inferred' mean the same thing to the calculation, so re-importing a legacy
  // inferred day is not a change worth writing. A stored NULL against an
  // incoming 'confirmed' IS.
  const directionChanged =
    resolveDirectionSource(parseStoredDirectionSource(existing.punch_direction_source)) !==
    next.direction_source

  return { changed: punchesChanged || directionChanged, punchesChanged }
}

export function buildAttendanceRow(
  block: Pick<EmployeeBlock, 'year' | 'month'>,
  day: DayPunches,
): BuildRowResult {
  const attendance_date = toDateStr(block.year, block.month, day.day)

  const inText  = day.in.trim()
  const outText = day.out.trim()

  if (inText === '' && outText === '') {
    return { ok: false, attendance_date, reason: 'no_punches', detail: 'no punch recorded' }
  }

  const check_in_at  = inText  === '' ? null : toTimestamp(inText,  block.year, block.month, day.day)
  const check_out_at = outText === '' ? null : toTimestamp(outText, block.year, block.month, day.day)

  if (check_in_at === null && check_out_at === null) {
    const bad = inText !== '' ? `IN time "${day.in}"` : `OUT time "${day.out}"`
    return { ok: false, attendance_date, reason: 'unparseable', detail: `invalid ${bad}` }
  }

  const complete = check_in_at !== null && check_out_at !== null

  return {
    ok: true,
    row: {
      attendance_date,
      check_in_at,
      check_out_at,
      status: complete ? 'present' : 'checked_in',
      // With both punches present nothing had to be decided, whatever the file
      // format — so the day is confirmed even when it came from Format B.
      direction_source: complete ? 'confirmed' : day.direction_source,
      in_hhmm:  day.in,
      out_hhmm: day.out,
    },
  }
}
