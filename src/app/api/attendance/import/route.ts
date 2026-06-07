import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_ROLES = ['admin', 'manager']

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const nonEmpty = lines.map(l => l.trim()).filter(Boolean)
  if (nonEmpty.length < 2) return []

  const headers = nonEmpty[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''))
  const rows: Record<string, string>[] = []

  for (let i = 1; i < nonEmpty.length; i++) {
    const cells = splitCSVLine(nonEmpty[i])
    if (cells.length === 0) continue
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = (cells[idx] ?? '').trim().replace(/"/g, '') })
    rows.push(row)
  }
  return rows
}

// Handles quoted fields with commas inside them
function splitCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes }
    else if (ch === ',' && !inQuotes) { result.push(current); current = '' }
    else { current += ch }
  }
  result.push(current)
  return result
}

// Normalise a time-only string ("09:30" or "09:30:00") combined with a date
// into a full ISO timestamp. If the value already looks like an ISO datetime,
// return as-is. Returns null for empty/invalid values.
function toTimestamp(value: string, date: string): string | null {
  if (!value) return null
  const v = value.trim()
  if (!v) return null

  // Already a full datetime (contains T or a space + time after the date part)
  if (v.includes('T') || (v.length > 10 && v[10] === ' ')) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }

  // Time-only: HH:MM or HH:MM:SS
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) {
    const d = new Date(`${date}T${v.length === 5 ? v + ':00' : v}`)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }

  return null
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

  // Read CSV from multipart form
  let csvText = ''
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
    csvText = await (file as File).text()
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 })
  }

  const rows = parseCSV(csvText)
  if (rows.length === 0) {
    return NextResponse.json({ error: 'CSV is empty or has no data rows' }, { status: 400 })
  }

  // Validate required headers
  const required = ['employee_code', 'attendance_date', 'check_in_at']
  const firstRow = rows[0]
  const missing  = required.filter(h => !(h in firstRow))
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing CSV columns: ${missing.join(', ')}` }, { status: 400 })
  }

  // Fetch all employee_code → user_id mappings in one query
  const { data: empRows, error: empErr } = await svc
    .from('users')
    .select('id, employee_code')
    .not('employee_code', 'is', null)
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 })

  const codeToId = new Map<string, string>()
  for (const e of empRows ?? []) {
    if (e.employee_code) codeToId.set(e.employee_code.trim().toLowerCase(), e.id)
  }

  // Process rows
  const summary = { total: rows.length, imported: 0, updated: 0, skipped: 0, errors: [] as string[] }

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i]
    const lineNum  = i + 2 // 1-based, +1 for header
    const code     = (row['employee_code'] ?? '').trim().toLowerCase()
    const dateRaw  = (row['attendance_date'] ?? '').trim()
    const ciRaw    = (row['check_in_at'] ?? '').trim()
    const coRaw    = (row['check_out_at'] ?? '').trim()

    if (!code) { summary.skipped++; summary.errors.push(`Row ${lineNum}: missing employee_code`); continue }
    if (!dateRaw) { summary.skipped++; summary.errors.push(`Row ${lineNum}: missing attendance_date`); continue }

    const userId = codeToId.get(code)
    if (!userId) {
      summary.skipped++
      summary.errors.push(`Row ${lineNum}: employee_code "${row['employee_code']}" not found`)
      continue
    }

    const checkInAt  = toTimestamp(ciRaw, dateRaw)
    const checkOutAt = toTimestamp(coRaw, dateRaw)

    if (!checkInAt) {
      summary.skipped++
      summary.errors.push(`Row ${lineNum}: invalid or missing check_in_at`)
      continue
    }

    const status = checkOutAt ? 'present' : 'checked_in'

    // Check if record exists (to track imported vs updated in summary)
    const { data: existing } = await svc
      .from('attendance_records')
      .select('id')
      .eq('user_id', userId)
      .eq('attendance_date', dateRaw)
      .maybeSingle()

    const { error: upsertErr } = await svc
      .from('attendance_records')
      .upsert(
        {
          user_id:         userId,
          attendance_date: dateRaw,
          check_in_at:     checkInAt,
          check_out_at:    checkOutAt,
          status,
        },
        { onConflict: 'user_id,attendance_date' }
      )

    if (upsertErr) {
      summary.skipped++
      summary.errors.push(`Row ${lineNum}: ${upsertErr.message}`)
      continue
    }

    if (existing) { summary.updated++ } else { summary.imported++ }
  }

  return NextResponse.json({ summary })
}
