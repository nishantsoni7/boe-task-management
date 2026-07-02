import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

const ALLOWED_ROLES = ['admin', 'manager']

// ─── Types ────────────────────────────────────────────────────────────────────

type DayRecord = {
  day: number
  in: string
  out: string
}

type EmployeeBlock = {
  empcode: string
  name: string
  year: number
  month: number
  days: DayRecord[]
}

// ─── Parser (same format detection as import route) ───────────────────────────

const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const MONTH_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december']

function monthYearFromText(v: string): { year: number; month: number } | null {
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
  const mSlash = v.match(/\b(0?[1-9]|1[0-2])[\/\-](\d{4})\b/)
  if (mSlash) {
    const month = parseInt(mSlash[1], 10)
    const year  = parseInt(mSlash[2], 10)
    if (year >= 2000 && year <= 2100) return { year, month }
  }
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

function cellStr(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })]
  if (!cell) return ''
  return String(cell.v ?? '').trim()
}

// ─── Format A parser (Empcode-row XLS: per-employee vertical blocks) ──────────

function parseFormatA(ws: XLSX.WorkSheet, monthYear: { year: number; month: number }): EmployeeBlock[] {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const blocks: EmployeeBlock[] = []

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (cellStr(ws, r, 0) !== 'Empcode') continue
    if (cellStr(ws, r, 1) === 'Name') continue

    const empcode = cellStr(ws, r, 2).trim()
    const name    = cellStr(ws, r, 7).trim()
    if (!empcode) continue

    const inRow  = r + 3
    const outRow = r + 4

    const days: DayRecord[] = []
    for (let day = 1; day <= 31; day++) {
      const inV = cellStr(ws, inRow, day)
      if (!inV || inV === '--:--') continue
      days.push({ day, in: inV, out: cellStr(ws, outRow, day) })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Format B parser (horizontal row layout: "List of Logs" style) ────────────

function parseFormatB(ws: XLSX.WorkSheet, monthYear: { year: number; month: number }): EmployeeBlock[] {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')

  let headerRow = -1
  for (let r = range.s.r; r <= Math.min(range.e.r, 10); r++) {
    if (cellStr(ws, r, 0) === 'Empcode' && cellStr(ws, r, 1) === 'Name') {
      headerRow = r
      break
    }
  }
  if (headerRow === -1) return []

  const colToDay = new Map<number, number>()
  for (let c = 2; c <= range.e.c; c++) {
    const v = cellStr(ws, headerRow, c)
    const n = parseInt(v, 10)
    if (!isNaN(n) && n >= 1 && n <= 31) colToDay.set(c, n)
  }

  const blocks: EmployeeBlock[] = []
  for (let r = headerRow + 2; r <= range.e.r; r++) {
    const empcode = cellStr(ws, r, 0).trim()
    const name    = cellStr(ws, r, 1).trim()
    if (!empcode) continue

    const days: DayRecord[] = []
    for (const [col, day] of colToDay) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: col })]
      if (!cell) continue
      const raw = String(cell.v ?? cell.w ?? '').trim()
      if (!raw) continue
      const punches = raw.split(/[\n\r]+/).map(s => s.trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s))
      if (punches.length === 0) continue
      days.push({
        day,
        in:  punches[0],
        out: punches.length > 1 ? punches[punches.length - 1] : '',
      })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Auto-detect format and parse ────────────────────────────────────────────

function parseXLSPreview(buffer: Buffer): { blocks: EmployeeBlock[]; deviceFormat: string } {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const monthYear = parseMonthYear(ws, wb.SheetNames[0])
  if (!monthYear) throw new Error(
    'Could not detect report month/year from file. ' +
    'Expected a cell in the first 20 rows (or sheet name) containing a value like ' +
    '"Jun-2026", "June 2026", "06/2026", or "2026-06".'
  )

  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  for (let r = range.s.r; r <= Math.min(range.e.r, 10); r++) {
    if (cellStr(ws, r, 0) === 'Empcode' && cellStr(ws, r, 1) === 'Name') {
      return {
        blocks: parseFormatB(ws, monthYear),
        deviceFormat: 'Fingerprint Machine Export (Horizontal Row Format)',
      }
    }
  }

  return {
    blocks: parseFormatA(ws, monthYear),
    deviceFormat: 'Fingerprint Machine Export (Empcode-row XLS)',
  }
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Convert "HH:MM" IST → UTC ISO string (IST = UTC+5:30, subtract 330 min)
function toTimestamp(hhmm: string, year: number, month: number, day: number): string | null {
  if (!hhmm || hhmm === '--:--') return null
  const parts = hhmm.split(':')
  if (parts.length < 2) return null
  const hh = parseInt(parts[0], 10)
  const mm = parseInt(parts[1], 10)
  if (isNaN(hh) || isNaN(mm)) return null
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm - 330, 0))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// Convert UTC ISO → IST "HH:MM" for display
function utcToIST(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const istMs = d.getTime() + 330 * 60 * 1000
  const istDate = new Date(istMs)
  return `${String(istDate.getUTCHours()).padStart(2, '0')}:${String(istDate.getUTCMinutes()).padStart(2, '0')}`
}

// Compare timestamps at minute precision to ignore sub-second DB differences
function toMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor(t / 60000)
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await svc
    .from('users').select('role').eq('id', user.id).single()
  if (!callerProfile || !ALLOWED_ROLES.includes(callerProfile.role)) {
    return NextResponse.json({ error: 'Forbidden: admin or manager role required' }, { status: 403 })
  }

  let fileBuffer: Buffer
  let fileName = ''
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
    fileName = (file as File).name
    fileBuffer = Buffer.from(await (file as File).arrayBuffer())
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 })
  }

  let blocks: EmployeeBlock[]
  let deviceFormat: string
  try {
    const parsed = parseXLSPreview(fileBuffer)
    blocks = parsed.blocks
    deviceFormat = parsed.deviceFormat
  } catch (e) {
    return NextResponse.json({ error: `Failed to parse file: ${(e as Error).message}` }, { status: 400 })
  }

  if (blocks.length === 0) {
    return NextResponse.json({ error: 'No employee blocks found in the file' }, { status: 400 })
  }

  const reportMonth = blocks[0]?.month ?? 0
  const reportYear  = blocks[0]?.year  ?? 0

  // Fetch employee fingerprint mappings
  const { data: empRows, error: empErr } = await svc
    .from('users')
    .select('id, full_name, fingerprint_employee_code')
    .not('fingerprint_employee_code', 'is', null)
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })

  const fpToUser = new Map<string, { id: string; name: string }>()
  for (const e of empRows ?? []) {
    if (e.fingerprint_employee_code) {
      fpToUser.set(e.fingerprint_employee_code.trim(), { id: e.id, name: e.full_name })
    }
  }

  // Classify each employee block
  type UnmatchedEntry = { excel_code: string; excel_name: string; days: number }
  const matchedNames: string[] = []
  const unmatchedEntries: UnmatchedEntry[] = []

  type PendingRow = {
    user_id: string
    employee_name: string
    attendance_date: string
    check_in_at: string | null
    check_out_at: string | null
    in_hhmm: string
    out_hhmm: string
  }
  const pendingRows: PendingRow[] = []

  let totalRows = 0

  for (const block of blocks) {
    totalRows += block.days.length
    const matched = fpToUser.get(block.empcode)
    if (!matched) {
      unmatchedEntries.push({ excel_code: block.empcode, excel_name: block.name, days: block.days.length })
      continue
    }
    matchedNames.push(matched.name)
    for (const day of block.days) {
      const dateStr    = toDateStr(block.year, block.month, day.day)
      const checkInAt  = toTimestamp(day.in, block.year, block.month, day.day)
      const checkOutAt = toTimestamp(day.out, block.year, block.month, day.day)
      if (!checkInAt) continue  // skip rows with unparseable punch-in (same as import)
      pendingRows.push({
        user_id:         matched.id,
        employee_name:   matched.name,
        attendance_date: dateStr,
        check_in_at:     checkInAt,
        check_out_at:    checkOutAt,
        in_hhmm:         day.in,
        out_hhmm:        day.out,
      })
    }
  }

  // Fetch existing records with timestamps for comparison
  type ExistingRec = { check_in_at: string | null; check_out_at: string | null }
  const existingMap = new Map<string, ExistingRec>()

  if (pendingRows.length > 0) {
    const userIds = [...new Set(pendingRows.map(r => r.user_id))]
    const dates   = [...new Set(pendingRows.map(r => r.attendance_date))]
    const { data: existing } = await svc
      .from('attendance_records')
      .select('user_id, attendance_date, check_in_at, check_out_at')
      .in('user_id', userIds)
      .in('attendance_date', dates)
    for (const row of existing ?? []) {
      existingMap.set(`${row.user_id}|${row.attendance_date}`, {
        check_in_at:  row.check_in_at,
        check_out_at: row.check_out_at,
      })
    }
  }

  // Classify each pending row
  type ModifiedRecord = {
    employeeName: string
    date: string
    oldCheckIn: string
    newCheckIn: string
    oldCheckOut: string
    newCheckOut: string
  }

  let newCount       = 0
  let unchangedCount = 0
  let modifiedCount  = 0
  const modifiedRecords: ModifiedRecord[] = []

  for (const row of pendingRows) {
    const key      = `${row.user_id}|${row.attendance_date}`
    const existing = existingMap.get(key)

    if (!existing) {
      newCount++
    } else {
      const oldIn  = toMinutes(existing.check_in_at)
      const newIn  = toMinutes(row.check_in_at)
      const oldOut = toMinutes(existing.check_out_at)
      const newOut = toMinutes(row.check_out_at)

      if (oldIn === newIn && oldOut === newOut) {
        unchangedCount++
      } else {
        modifiedCount++
        modifiedRecords.push({
          employeeName: row.employee_name,
          date:         row.attendance_date,
          oldCheckIn:   utcToIST(existing.check_in_at),
          newCheckIn:   row.in_hhmm,
          oldCheckOut:  utcToIST(existing.check_out_at),
          newCheckOut:  row.out_hhmm,
        })
      }
    }
  }

  const allUnchanged = pendingRows.length > 0 && newCount === 0 && modifiedCount === 0

  // Check payroll period status for this month — matters whenever this import would
  // write new or modified rows, matching the lock check enforced by /api/attendance/import.
  let payrollStatus: string | null = null
  if ((newCount > 0 || modifiedCount > 0) && reportMonth > 0 && reportYear > 0) {
    const { data: period } = await svc
      .from('payroll_periods')
      .select('status')
      .eq('payroll_month', reportMonth)
      .eq('payroll_year', reportYear)
      .maybeSingle()
    payrollStatus = period?.status ?? null
  }

  return NextResponse.json({
    preview: {
      fileName,
      deviceFormat,
      month:             reportMonth,
      year:              reportYear,
      totalRows,
      detectedEmployees: blocks.length,
      matchedCount:      matchedNames.length,
      unmatchedCount:    unmatchedEntries.length,
      unmatchedEntries,
      newCount,
      unchangedCount,
      modifiedCount,
      modifiedRecords,
      allUnchanged,
      payrollStatus,
    },
  })
}
