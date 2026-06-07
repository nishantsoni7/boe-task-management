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

function parseMonthYear(sheet: XLSX.WorkSheet): { year: number; month: number } | null {
  // Scan first few rows for a cell containing a month name pattern like "May-2026"
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1')
  for (let r = range.s.r; r <= Math.min(range.e.r, 10); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })]
      if (!cell) continue
      const v = String(cell.v ?? '')
      const m = v.match(/(\w{3})-(\d{4})/)
      if (m) {
        const monthIdx = monthNames.findIndex(n => n.toLowerCase() === m[1].toLowerCase())
        if (monthIdx !== -1) return { year: parseInt(m[2]), month: monthIdx + 1 }
      }
    }
  }
  return null
}

function cellStr(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })]
  if (!cell) return ''
  return String(cell.v ?? '').trim()
}

function parseXLS(buffer: Buffer): EmployeeBlock[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const monthYear = parseMonthYear(ws)
  if (!monthYear) throw new Error('Could not detect report month/year from file')

  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const blocks: EmployeeBlock[] = []

  for (let r = range.s.r; r <= range.e.r; r++) {
    const col0 = cellStr(ws, r, 0)
    if (col0 !== 'Empcode') continue

    const empcode = cellStr(ws, r, 2).trim()
    const name    = cellStr(ws, r, 7).trim()
    if (!empcode) continue

    // Rows relative to Empcode row:
    // +2 = day numbers (not needed, we use col index directly)
    // +4 = IN, +5 = OUT, +6 = WORK, +8 = OT, +9 = Status
    const inRow     = r + 4
    const outRow    = r + 5
    const workRow   = r + 6
    const otRow     = r + 8
    const statusRow = r + 9

    const days: DayRecord[] = []
    for (let day = 1; day <= 31; day++) {
      const c   = day // col 1 = day 1, col 2 = day 2, …, col 31 = day 31
      const inV = cellStr(ws, inRow, c)
      // Skip days with no punch data
      if (!inV || inV === '--:--') continue

      days.push({
        day,
        in:     inV,
        out:    cellStr(ws, outRow, c),
        work:   cellStr(ws, workRow, c),
        ot:     cellStr(ws, otRow, c),
        status: cellStr(ws, statusRow, c),
      })
    }

    blocks.push({ empcode, name, year: monthYear.year, month: monthYear.month, days })
  }

  return blocks
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

// Convert "HH:MM" + date parts → ISO timestamp string, or null
function toTimestamp(hhmm: string, year: number, month: number, day: number): string | null {
  if (!hhmm || hhmm === '--:--') return null
  const parts = hhmm.split(':')
  if (parts.length < 2) return null
  const hh = parseInt(parts[0], 10)
  const mm = parseInt(parts[1], 10)
  if (isNaN(hh) || isNaN(mm)) return null
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm, 0))
  return isNaN(d.getTime()) ? null : d.toISOString()
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
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
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

  // Fetch all fingerprint_employee_code → user_id mappings
  const { data: empRows, error: empErr } = await svc
    .from('users')
    .select('id, fingerprint_employee_code')
    .not('fingerprint_employee_code', 'is', null)
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })

  const fingerprintToId = new Map<string, string>()
  for (const e of empRows ?? []) {
    if (e.fingerprint_employee_code) {
      fingerprintToId.set(e.fingerprint_employee_code.trim(), e.id)
    }
  }

  const summary = {
    total: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    unmappedCodes: [] as string[],
    errors: [] as string[],
  }

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
    const userId = fingerprintToId.get(block.empcode)
    if (!userId) {
      summary.unmappedCodes.push(block.empcode)
      summary.skipped += block.days.length
      summary.total   += block.days.length
      continue
    }

    for (const day of block.days) {
      summary.total++
      const dateStr    = toDateStr(block.year, block.month, day.day)
      const checkInAt  = toTimestamp(day.in,  block.year, block.month, day.day)
      const checkOutAt = toTimestamp(day.out, block.year, block.month, day.day)

      if (!checkInAt) {
        summary.skipped++
        summary.errors.push(`${block.empcode} ${dateStr}: invalid IN time "${day.in}"`)
        continue
      }

      involvedKeys.add(`${userId}|${dateStr}`)
      upsertRows.push({
        user_id:         userId,
        attendance_date: dateStr,
        check_in_at:     checkInAt,
        check_out_at:    checkOutAt,
        status:          checkOutAt ? 'present' : 'checked_in',
      })
    }
  }

  // Single query to find which records already exist (to distinguish imported vs updated)
  const existingKeys = new Set<string>()
  if (involvedKeys.size > 0) {
    const userIds  = [...new Set(upsertRows.map(r => r.user_id))]
    const dates    = [...new Set(upsertRows.map(r => r.attendance_date))]
    const { data: existing } = await svc
      .from('attendance_records')
      .select('user_id, attendance_date')
      .in('user_id', userIds)
      .in('attendance_date', dates)
    for (const row of existing ?? []) {
      existingKeys.add(`${row.user_id}|${row.attendance_date}`)
    }
  }

  // Single batch upsert for all valid rows
  if (upsertRows.length > 0) {
    const { error: upsertErr } = await svc
      .from('attendance_records')
      .upsert(upsertRows, { onConflict: 'user_id,attendance_date' })

    if (upsertErr) {
      return NextResponse.json({ error: `Batch upsert failed: ${upsertErr.message}` }, { status: 500 })
    }

    for (const row of upsertRows) {
      const key = `${row.user_id}|${row.attendance_date}`
      if (existingKeys.has(key)) { summary.updated++ } else { summary.imported++ }
    }
  }

  // Deduplicate unmapped codes
  summary.unmappedCodes = [...new Set(summary.unmappedCodes)]

  return NextResponse.json({ summary })
}
