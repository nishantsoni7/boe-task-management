import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  parseAttendanceWorkbook,
  buildAttendanceRow,
  attendanceRowChange,
  utcToIST,
  type EmployeeBlock,
} from '@/lib/attendance/punchParser'
import {
  parseManualMappings,
  resolveEmployeeMapping,
} from '@/lib/attendance/employeeMapping'
import type { PunchDirectionSource } from '@/lib/attendance/punchDirection'

// Admin only. This route reads every employee's stored punches for the month in
// the uploaded file and returns the before/after diff, so it is team attendance
// visibility, not just an upload. BOE grants that to admins; holding the
// manager role is not, by itself, a grant over colleagues' attendance.
const ALLOWED_ROLES = ['admin']

// The parser this route used to carry was a near-copy of the one in
// ../import/route.ts. Both now call src/lib/attendance/punchParser.ts, which is
// what makes this preview a truthful statement about what the import will do
// rather than a second implementation that happens to agree today.

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
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let fileBuffer: Buffer
  let fileName = ''
  // The employees an admin named by hand for codes the device lookup could not
  // place. Read here and applied below through the SAME resolver the import
  // uses, so this preview describes the import that the admin is about to run.
  let manualMappingsRaw: unknown = null
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
    fileName = (file as File).name
    fileBuffer = Buffer.from(await (file as File).arrayBuffer())
    manualMappingsRaw = form.get('manualMappings')
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 })
  }

  const parsedMappings = parseManualMappings(manualMappingsRaw)
  if (!parsedMappings.ok) {
    return NextResponse.json({ error: parsedMappings.error }, { status: 400 })
  }

  let blocks: EmployeeBlock[]
  let deviceFormat: string
  try {
    const parsed = parseAttendanceWorkbook(fileBuffer)
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

  // The people an admin is allowed to name for an unmatched code — every live
  // employee, not just the ones carrying a device code, since the whole point is
  // that the person in question has no device code to match on.
  const { data: selectableRows, error: selectableErr } = await svc
    .from('users')
    .select('id, full_name')
    .or('is_deleted.eq.false,is_deleted.is.null')
  if (selectableErr) return NextResponse.json({ error: selectableErr.message }, { status: 500 })

  const mappingResult = resolveEmployeeMapping({
    blocks,
    fingerprintToUser: fpToUser,
    manualMappings: parsedMappings.mappings,
    selectableUsers: selectableRows ?? [],
  })
  if (!mappingResult.ok) {
    return NextResponse.json({ error: mappingResult.error }, { status: 400 })
  }
  const { resolved, unmatched: unmatchedEntries, applied: appliedMappings } = mappingResult.mapping

  // Classify each employee block
  const matchedNames: string[] = []

  type PendingRow = {
    user_id: string
    employee_name: string
    attendance_date: string
    check_in_at: string | null
    check_out_at: string | null
    /** Carried so the comparison below matches the import's exactly. */
    direction_source: PunchDirectionSource
    in_hhmm: string
    out_hhmm: string
  }
  const pendingRows: PendingRow[] = []

  let totalRows = 0

  for (const block of blocks) {
    totalRows += block.days.length
    const matched = resolved.get(block.empcode)
    if (!matched) continue  // still unmatched — already listed by the resolver
    matchedNames.push(matched.name)
    for (const day of block.days) {
      // Same builder the import uses, so a day this preview counts as new or
      // modified is exactly the day the import will write — including
      // punch-out-only days, which used to be discarded here and there.
      const built = buildAttendanceRow(block, day)
      if (!built.ok) continue  // unreadable on both sides — the import skips it too
      pendingRows.push({
        user_id:          matched.id,
        employee_name:    matched.name,
        attendance_date:  built.row.attendance_date,
        check_in_at:      built.row.check_in_at,
        check_out_at:     built.row.check_out_at,
        direction_source: built.row.direction_source,
        in_hhmm:          built.row.in_hhmm,
        out_hhmm:         built.row.out_hhmm,
      })
    }
  }

  // Fetch existing records for comparison — the same columns the import reads,
  // provenance included, so both routes decide "changed" from the same facts.
  type ExistingRec = {
    check_in_at: string | null
    check_out_at: string | null
    punch_direction_source: string | null
  }
  const existingMap = new Map<string, ExistingRec>()

  if (pendingRows.length > 0) {
    const userIds = [...new Set(pendingRows.map(r => r.user_id))]
    const dates   = [...new Set(pendingRows.map(r => r.attendance_date))]
    const { data: existing } = await svc
      .from('attendance_records')
      .select('user_id, attendance_date, check_in_at, check_out_at, punch_direction_source')
      .in('user_id', userIds)
      .in('attendance_date', dates)
    for (const row of existing ?? []) {
      existingMap.set(`${row.user_id}|${row.attendance_date}`, {
        check_in_at:            row.check_in_at,
        check_out_at:           row.check_out_at,
        punch_direction_source: row.punch_direction_source ?? null,
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
      // The import's own comparison, called here. A row can also count as
      // modified because its stored provenance is stale — a legacy record whose
      // direction was never recorded — in which case the punch times below read
      // the same on both sides, which is accurate: nothing about the punches is
      // changing, only what the system knows about them.
      const change = attendanceRowChange(row, existing)

      if (!change.changed) {
        unchangedCount++
      } else {
        modifiedCount++
        modifiedRecords.push({
          employeeName: row.employee_name,
          date:         row.attendance_date,
          oldCheckIn:   utcToIST(existing.check_in_at),
          // An absent side is now a real outcome rather than an impossible one,
          // so it reads as the same em dash utcToIST uses for a missing stored
          // punch instead of as a blank cell.
          newCheckIn:   row.in_hhmm  || '—',
          oldCheckOut:  utcToIST(existing.check_out_at),
          newCheckOut:  row.out_hhmm || '—',
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
      // What the manual selections resolved to, echoed so the upload screen can
      // state whose attendance each hand-mapped code is about to become — and so
      // the admin confirms against the server's reading, not the browser's.
      manualMappings:    appliedMappings,
      newCount,
      unchangedCount,
      modifiedCount,
      modifiedRecords,
      allUnchanged,
      payrollStatus,
    },
  })
}
