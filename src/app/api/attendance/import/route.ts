import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

const ALLOWED_ROLES = ['admin', 'manager']

// ─── XLS parser ───────────────────────────────────────────────────────────────

type DayRecord = {
  day: number
  in: string
  out: string
  work: string
  ot: string
  status: string
}

type EmployeeBlock = {
  empcode: string
  name: string
  year: number
  month: number // 1-based
  days: DayRecord[]
}

const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const MONTH_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december']

function monthYearFromText(v: string): { year: number; month: number } | null {
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
  // "06/2026" / "06-2026" (month/year numeric)
  const mSlash = v.match(/\b(0?[1-9]|1[0-2])[\/\-](\d{4})\b/)
  if (mSlash) {
    const month = parseInt(mSlash[1], 10)
    const year  = parseInt(mSlash[2], 10)
    if (year >= 2000 && year <= 2100) return { year, month }
  }
  // "2026-06" / "2026/06" (ISO-style)
  const mIso = v.match(/\b(\d{4})[\/\-](0[1-9]|1[0-2])\b/)
  if (mIso) {
    const year  = parseInt(mIso[1], 10)
    const month = parseInt(mIso[2], 10)
    if (year >= 2000 && year <= 2100) return { year, month }
  }
  return null
}

function parseMonthYear(sheet: XLSX.WorkSheet, sheetName: string): { year: number; month: number } | null {
  // Check sheet name first
  const fromSheet = monthYearFromText(sheetName)
  if (fromSheet) return fromSheet

  // Scan first 20 rows across all columns
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
    // Skip Format B header rows (col 1 = "Name")
    if (cellStr(ws, r, 1) === 'Name') continue

    const empcode = cellStr(ws, r, 2).trim()
    const name    = cellStr(ws, r, 7).trim()
    if (!empcode) continue

    const inRow     = r + 3
    const outRow    = r + 4
    const workRow   = r + 5
    const otRow     = r + 7
    const statusRow = r + 8

    const days: DayRecord[] = []
    for (let day = 1; day <= 31; day++) {
      const inV = cellStr(ws, inRow, day)
      if (!inV || inV === '--:--') continue
      days.push({
        day,
        in:     inV,
        out:    cellStr(ws, outRow, day),
        work:   cellStr(ws, workRow, day),
        ot:     cellStr(ws, otRow, day),
        status: cellStr(ws, statusRow, day),
      })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Format B parser (horizontal row layout: "List of Logs" style) ────────────
// Row structure:
//   Row 0: "List of Logs"
//   Row 1: "01/05/2026 ~ 31/05/2026"   ← month/year detected here
//   Row 2: "Empcode" | "Name" | 1 | 2 | ... | 31   ← header
//   Row 3: weekday names                             ← skip
//   Row 4+: employee rows  (col A = empcode, col B = name, cols C+ = punches)
// Punch cells contain multiline text, e.g. "10:07\n18:36\n"

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

  // col → day number (1-31) from header row
  const colToDay = new Map<number, number>()
  for (let c = 2; c <= range.e.c; c++) {
    const n = parseInt(cellStr(ws, headerRow, c), 10)
    if (!isNaN(n) && n >= 1 && n <= 31) colToDay.set(c, n)
  }

  const blocks: EmployeeBlock[] = []
  // headerRow + 1 is the weekday-name row — skip it
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
        in:     punches[0],
        out:    punches.length > 1 ? punches[punches.length - 1] : '',
        work:   '',
        ot:     '',
        status: '',
      })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Auto-detect format and parse ────────────────────────────────────────────

function parseXLS(buffer: Buffer): EmployeeBlock[] {
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
      return parseFormatB(ws, monthYear)
    }
  }
  return parseFormatA(ws, monthYear)
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

// Convert "HH:MM" IST + date parts → UTC ISO timestamp string, or null.
// Fingerprint machine times are IST (UTC+5:30). We subtract 330 minutes so the
// stored UTC value is correct. Date.UTC handles minute values outside 0-59.
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

// Compare timestamps at minute precision to ignore sub-second DB differences
function toMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor(t / 60000)
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
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

  // Read file from multipart form
  let fileBuffer: Buffer
  let fileName = ''
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
    fileName   = (file as File).name
    fileBuffer = Buffer.from(await (file as File).arrayBuffer())
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 })
  }

  // Parse XLS
  let blocks: EmployeeBlock[]
  try {
    blocks = parseXLS(fileBuffer)
  } catch (e) {
    return NextResponse.json({ error: `Failed to parse file: ${(e as Error).message}` }, { status: 400 })
  }

  if (blocks.length === 0) {
    return NextResponse.json({ error: 'No employee blocks found in the file' }, { status: 400 })
  }

  // Fetch all fingerprint_employee_code → user mappings (include name for the report)
  const { data: empRows, error: empErr } = await svc
    .from('users')
    .select('id, full_name, employee_code, fingerprint_employee_code')
    .not('fingerprint_employee_code', 'is', null)
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })

  type FpEntry = { id: string; name: string; employee_code: string | null }
  const fpToEntry = new Map<string, FpEntry>()  // fingerprint_code → entry
  const idToEntry = new Map<string, FpEntry>()  // user_id → entry
  for (const e of empRows ?? []) {
    if (e.fingerprint_employee_code) {
      const entry: FpEntry = { id: e.id, name: e.full_name, employee_code: e.employee_code }
      fpToEntry.set(e.fingerprint_employee_code.trim(), entry)
      idToEntry.set(e.id, entry)
    }
  }

  // Detect month/year from the first block (all blocks share the same month)
  const reportMonth = blocks[0]?.month ?? 0
  const reportYear  = blocks[0]?.year  ?? 0

  // Check how many attendance records already exist for this month before import
  let priorExistingCount = 0
  if (reportMonth > 0 && reportYear > 0) {
    const mm = String(reportMonth).padStart(2, '0')
    const monthStart  = `${reportYear}-${mm}-01`
    const nextMonth   = reportMonth === 12 ? 1 : reportMonth + 1
    const nextYear    = reportMonth === 12 ? reportYear + 1 : reportYear
    const nextMonthStart = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
    const { count } = await svc
      .from('attendance_records')
      .select('id', { count: 'exact', head: true })
      .gte('attendance_date', monthStart)
      .lt('attendance_date', nextMonthStart)
    priorExistingCount = count ?? 0
  }

  let totalRows  = 0
  let skipped    = 0
  const unmappedCodes: string[] = []
  const errors:        string[] = []

  type SkippedEmployee = { excel_code: string; excel_name: string; days_skipped: number; reason: string }
  const skippedEmployees: SkippedEmployee[] = []

  // Build all valid upsert rows and track which user+date pairs are involved
  type UpsertRow = {
    user_id: string
    attendance_date: string
    check_in_at: string
    check_out_at: string | null
    status: string
  }

  const upsertRows: UpsertRow[] = []
  const involvedKeys = new Set<string>() // "userId|dateStr"

  for (const block of blocks) {
    const entry = fpToEntry.get(block.empcode)
    if (!entry) {
      unmappedCodes.push(block.empcode)
      skipped    += block.days.length
      totalRows  += block.days.length
      skippedEmployees.push({
        excel_code:   block.empcode,
        excel_name:   block.name,
        days_skipped: block.days.length,
        reason:       'Fingerprint code not mapped in Employee Master',
      })
      continue
    }

    let badDays = 0
    for (const day of block.days) {
      totalRows++
      const dateStr    = toDateStr(block.year, block.month, day.day)
      const checkInAt  = toTimestamp(day.in,  block.year, block.month, day.day)
      const checkOutAt = toTimestamp(day.out, block.year, block.month, day.day)

      if (!checkInAt) {
        skipped++
        badDays++
        errors.push(`${block.empcode} ${dateStr}: invalid IN time "${day.in}"`)
        continue
      }

      involvedKeys.add(`${entry.id}|${dateStr}`)
      upsertRows.push({
        user_id:         entry.id,
        attendance_date: dateStr,
        check_in_at:     checkInAt,
        check_out_at:    checkOutAt,
        status:          checkOutAt ? 'present' : 'checked_in',
      })
    }

    if (badDays > 0) {
      skippedEmployees.push({
        excel_code:   block.empcode,
        excel_name:   block.name,
        days_skipped: badDays,
        reason:       `${badDays} day${badDays !== 1 ? 's' : ''} had invalid punch-in time`,
      })
    }
  }

  // Fetch existing records with timestamps to distinguish new / modified / unchanged
  type ExistingRec = { check_in_at: string | null; check_out_at: string | null }
  const existingMap = new Map<string, ExistingRec>()
  if (involvedKeys.size > 0) {
    const userIds = [...new Set(upsertRows.map(r => r.user_id))]
    const dates   = [...new Set(upsertRows.map(r => r.attendance_date))]
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

  // Classify rows into new / modified / unchanged
  const newRows:      UpsertRow[] = []
  const modifiedRows: UpsertRow[] = []

  for (const row of upsertRows) {
    const key      = `${row.user_id}|${row.attendance_date}`
    const existing = existingMap.get(key)
    if (!existing) {
      newRows.push(row)
    } else {
      const oldIn  = toMinutes(existing.check_in_at)
      const newIn  = toMinutes(row.check_in_at)
      const oldOut = toMinutes(existing.check_out_at)
      const newOut = toMinutes(row.check_out_at)
      if (oldIn !== newIn || oldOut !== newOut) {
        modifiedRows.push(row)
      }
      // else: unchanged — skip
    }
  }

  // Payroll lock check — block all imports (new rows and corrections) if payroll is locked for this month
  if ((newRows.length > 0 || modifiedRows.length > 0) && reportMonth > 0 && reportYear > 0) {
    const { data: payrollPeriod } = await svc
      .from('payroll_periods')
      .select('status')
      .eq('payroll_month', reportMonth)
      .eq('payroll_year', reportYear)
      .maybeSingle()

    if (payrollPeriod?.status === 'locked') {
      return NextResponse.json({
        error: 'Payroll is locked for this month. Attendance cannot be imported or corrected.',
        payrollLocked: true,
      }, { status: 422 })
    }
  }

  // Per-employee tracking
  const empInserted  = new Map<string, number>()
  const empUpdated   = new Map<string, number>()
  const empUnchanged = new Map<string, number>()

  // Insert new records
  if (newRows.length > 0) {
    const { error: insertErr } = await svc
      .from('attendance_records')
      .insert(newRows)

    if (insertErr) {
      return NextResponse.json({ error: `Batch insert failed: ${insertErr.message}` }, { status: 500 })
    }

    for (const row of newRows) {
      empInserted.set(row.user_id, (empInserted.get(row.user_id) ?? 0) + 1)
    }
  }

  // Update modified records (corrections) and write audit log
  for (const row of modifiedRows) {
    const existing = existingMap.get(`${row.user_id}|${row.attendance_date}`)

    const { error: updateErr } = await svc
      .from('attendance_records')
      .update({
        check_in_at:  row.check_in_at,
        check_out_at: row.check_out_at,
        status:       row.status,
      })
      .eq('user_id', row.user_id)
      .eq('attendance_date', row.attendance_date)

    if (updateErr) {
      errors.push(`Update failed for ${row.user_id} ${row.attendance_date}: ${updateErr.message}`)
      continue
    }

    empUpdated.set(row.user_id, (empUpdated.get(row.user_id) ?? 0) + 1)

    // Audit trail — fire-and-forget; don't block the response on log failure
    svc.from('attendance_correction_log').insert({
      user_id:          row.user_id,
      attendance_date:  row.attendance_date,
      old_check_in_at:  existing?.check_in_at  ?? null,
      new_check_in_at:  row.check_in_at,
      old_check_out_at: existing?.check_out_at ?? null,
      new_check_out_at: row.check_out_at,
      corrected_by:     user.id,
      corrected_at:     new Date().toISOString(),
      source_file_name: fileName || null,
    }).then(({ error: logErr }) => {
      if (logErr) console.error('Attendance correction applied but audit log failed:', logErr.message)
    })
  }

  // Count unchanged (existing rows that were not modified)
  const modifiedKeys = new Set(modifiedRows.map(r => `${r.user_id}|${r.attendance_date}`))
  for (const row of upsertRows) {
    const key = `${row.user_id}|${row.attendance_date}`
    if (existingMap.has(key) && !modifiedKeys.has(key)) {
      empUnchanged.set(row.user_id, (empUnchanged.get(row.user_id) ?? 0) + 1)
    }
  }

  const totalImported  = [...empInserted.values()].reduce((a, b) => a + b, 0)
  const totalUpdated   = [...empUpdated.values()].reduce((a, b) => a + b, 0)
  const totalUnchanged = [...empUnchanged.values()].reduce((a, b) => a + b, 0)

  // Build per-employee report (employees with at least one record touched)
  const allTouchedIds = new Set([...empInserted.keys(), ...empUpdated.keys(), ...empUnchanged.keys()])
  const importedEmployees = [...allTouchedIds]
    .map(userId => {
      const e = idToEntry.get(userId)
      return {
        name:          e?.name          ?? userId,
        employee_code: e?.employee_code ?? null,
        inserted:      empInserted.get(userId)  ?? 0,
        updated:       empUpdated.get(userId)   ?? 0,
        unchanged:     empUnchanged.get(userId) ?? 0,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const dedupedUnmapped = [...new Set(unmappedCodes)]

  return NextResponse.json({
    summary: {
      month:               reportMonth,
      year:                reportYear,
      total:               totalRows,
      imported:            totalImported,
      updated:             totalUpdated,
      unchanged:           totalUnchanged,
      skipped,
      prior_existing_count: priorExistingCount,
      unmappedCodes:       dedupedUnmapped,
      unmappedCount:       dedupedUnmapped.length,
      errors,
      importedEmployees,
      skippedEmployees,
    },
  })
}
