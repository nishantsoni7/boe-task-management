import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  parseAttendanceWorkbook,
  buildAttendanceRow,
  attendanceRowChange,
  type EmployeeBlock,
  type ParsedAttendanceRow,
} from '@/lib/attendance/punchParser'
import {
  parseManualMappings,
  resolveEmployeeMapping,
} from '@/lib/attendance/employeeMapping'
import type { PunchDirectionSource } from '@/lib/attendance/punchDirection'
import { PagedReadError, fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'

/** One stored attendance row, as the existing-record map reads it. */
type ExistingRow = {
  user_id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  punch_direction_source: string | null
}


// Admin only — see the note in ../preview/route.ts. The import writes every
// employee's raw attendance and the correction log that payroll is computed
// from; it is the most privileged write in the module.
const ALLOWED_ROLES = ['admin']

// The XLS parser that used to live here — types, month/year detection, both
// format readers and the time helpers — now lives in
// src/lib/attendance/punchParser.ts, shared with ../preview/route.ts so the
// preview an admin approves and the import that follows it cannot disagree.
// Nothing about the supported formats or the IST handling changed in the move;
// what changed is how a day with exactly ONE punch is read. See that module.

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

  // Read file from multipart form
  let fileBuffer: Buffer
  let fileName = ''
  // The same field ../preview/route.ts reads, carrying the same selections. The
  // upload screen sends back exactly what it previewed with, and both routes run
  // it through the same resolver, so the employee the admin confirmed on the
  // preview is the employee written here.
  let manualMappingsRaw: unknown = null
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
    fileName   = (file as File).name
    fileBuffer = Buffer.from(await (file as File).arrayBuffer())
    manualMappingsRaw = form.get('manualMappings')
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 })
  }

  const parsedMappings = parseManualMappings(manualMappingsRaw)
  if (!parsedMappings.ok) {
    return NextResponse.json({ error: parsedMappings.error }, { status: 400 })
  }

  // Parse XLS — the same call ../preview/route.ts makes, so what the admin
  // approved on the preview screen is what lands here.
  let blocks: EmployeeBlock[]
  try {
    blocks = parseAttendanceWorkbook(fileBuffer).blocks
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

  // The people an admin may name for a code the lookup above could not place.
  // Deliberately a separate read: the map above is intentionally not restricted
  // to live employees (a departed colleague's historical attendance must still
  // import by their device code), whereas a hand-picked employee must be one who
  // is actually here to pick.
  const { data: selectableRows, error: selectableErr } = await svc
    .from('users')
    .select('id, full_name, employee_code')
    .or('is_deleted.eq.false,is_deleted.is.null')
  if (selectableErr) return NextResponse.json({ error: selectableErr.message }, { status: 500 })

  const mappingResult = resolveEmployeeMapping({
    blocks,
    fingerprintToUser: fpToEntry,
    manualMappings: parsedMappings.mappings,
    selectableUsers: selectableRows ?? [],
  })
  if (!mappingResult.ok) {
    return NextResponse.json({ error: mappingResult.error }, { status: 400 })
  }
  const { resolved: resolvedEmployees, applied: appliedMappings } = mappingResult.mapping

  // A hand-mapped employee has no fingerprint code, so they are absent from
  // idToEntry and the per-employee report would name them by UUID. Add them.
  const selectableById = new Map((selectableRows ?? []).map(u => [u.id, u]))
  for (const m of appliedMappings) {
    if (idToEntry.has(m.user_id)) continue
    idToEntry.set(m.user_id, {
      id: m.user_id,
      name: m.employee_name,
      employee_code: selectableById.get(m.user_id)?.employee_code ?? null,
    })
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

  // Build all valid upsert rows and track which user+date pairs are involved.
  //
  // check_in_at is NULLABLE here, and that is the point of this change. A day
  // where the machine recorded only a departure is a real attendance day — the
  // employee was demonstrably present — and it used to be discarded, which made
  // payroll charge a full day's absence for it. It is now stored as the
  // punch-out it is, with no punch-in, and payroll reads it as a missing
  // punch-in worth MISSING_PUNCH_HOURS.
  type UpsertRow = {
    user_id: string
    attendance_date: string
    check_in_at: string | null
    check_out_at: string | null
    status: ParsedAttendanceRow['status']
    /**
     * How the parser established this day's IN/OUT split, persisted so payroll
     * generation — which runs in a later request, from the database — can tell a
     * stated direction from a guessed one. Never null on a row we write: the
     * parser always knows which it did. NULL in the column means "imported
     * before this existed", and only legacy rows carry that.
     */
    punch_direction_source: PunchDirectionSource
  }

  const upsertRows: UpsertRow[] = []
  const involvedKeys = new Set<string>() // "userId|dateStr"

  for (const block of blocks) {
    const entry = resolvedEmployees.get(block.empcode)
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
      const built = buildAttendanceRow(block, day)

      // A day is only rejected when NEITHER punch yields a usable time. A single
      // unreadable cell no longer discards the whole day in either direction.
      if (!built.ok) {
        skipped++
        badDays++
        errors.push(`${block.empcode} ${built.attendance_date}: ${built.detail}`)
        continue
      }

      involvedKeys.add(`${entry.id}|${built.row.attendance_date}`)
      upsertRows.push({
        user_id:               entry.id,
        attendance_date:       built.row.attendance_date,
        check_in_at:           built.row.check_in_at,
        check_out_at:          built.row.check_out_at,
        status:                built.row.status,
        punch_direction_source: built.row.direction_source,
      })
    }

    if (badDays > 0) {
      skippedEmployees.push({
        excel_code:   block.empcode,
        excel_name:   block.name,
        days_skipped: badDays,
        reason:       `${badDays} day${badDays !== 1 ? 's' : ''} had no readable punch time`,
      })
    }
  }

  // Fetch existing records to distinguish new / modified / unchanged.
  //
  // punch_direction_source is selected as well as the timestamps: a row whose
  // punches match but whose provenance is stale still has to be rewritten, or a
  // legacy NULL would survive every future re-import of its month.
  type ExistingRec = {
    check_in_at: string | null
    check_out_at: string | null
    punch_direction_source: string | null
  }
  const existingMap = new Map<string, ExistingRec>()
  if (involvedKeys.size > 0) {
    const userIds = [...new Set(upsertRows.map(r => r.user_id))]
    const dates   = [...new Set(upsertRows.map(r => r.attendance_date))]
    // ── PAGED, AND A SHORT READ HERE IS THE WORST KIND ──
    //
    // This map is what decides whether each imported row is NEW or a CHANGE to
    // one already stored. It reads (users x dates), so a month for fifty people
    // is over 1,500 rows — and PostgREST caps a response at 1000 with no error
    // and no warning (src/lib/supabasePaging.ts).
    //
    // A truncated map does not merely under-report: every row it lost looks
    // BRAND NEW to the classifier below, so an import would report inserting
    // days that already exist and silently mis-state what it is about to change.
    // That is a wrong answer about attendance, which is a wrong answer about pay.
    //
    // A failed page therefore leaves `existing` empty AND the failure visible
    // rather than being absorbed into a confident classification: the read is
    // ordered on the primary key so pages cannot overlap, and any failure or cap
    // is surfaced instead of silently producing an all-new import.
    const existingResult = await fetchAllRows<ExistingRow>((pageFrom, pageTo) => svc
      .from('attendance_records')
      .select('user_id, attendance_date, check_in_at, check_out_at, punch_direction_source')
      .in('user_id', userIds)
      .in('attendance_date', dates)
      .order('id', { ascending: true })
      .range(pageFrom, pageTo))

    let existing: ExistingRow[]
    try {
      existing = unwrapPagedRows('existing attendance records', existingResult)
    } catch (err) {
      // REFUSE, do not proceed. Continuing with a partial map would classify
      // every unread day as new — see above. The detail names the read, never a
      // database string the caller did not ask for.
      const detail = err instanceof PagedReadError ? err.detail : String(err)
      return NextResponse.json(
        { error: `Could not read existing attendance records: ${detail}` },
        { status: 500 },
      )
    }

    for (const row of existing) {
      existingMap.set(`${row.user_id}|${row.attendance_date}`, {
        check_in_at:            row.check_in_at,
        check_out_at:           row.check_out_at,
        punch_direction_source: row.punch_direction_source ?? null,
      })
    }
  }

  // Classify rows into new / modified / unchanged, through the shared comparison
  // ../preview/route.ts uses, so the preview's counts are the import's counts.
  const newRows:      UpsertRow[] = []
  const modifiedRows: UpsertRow[] = []
  // The subset whose PUNCHES moved. Only these are corrections in the sense
  // attendance_correction_log records; a provenance-only rewrite is bookkeeping.
  const punchChangedKeys = new Set<string>()

  for (const row of upsertRows) {
    const key      = `${row.user_id}|${row.attendance_date}`
    const existing = existingMap.get(key)
    if (!existing) {
      newRows.push(row)
      continue
    }

    const change = attendanceRowChange(
      { check_in_at: row.check_in_at, check_out_at: row.check_out_at, direction_source: row.punch_direction_source },
      existing,
    )
    if (change.punchesChanged) punchChangedKeys.add(key)
    if (change.changed) modifiedRows.push(row)
    // else: unchanged — skip
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
    const key      = `${row.user_id}|${row.attendance_date}`
    const existing = existingMap.get(key)

    // punch_direction_source is written with the punches, not separately. The
    // whole point of the column is that it describes THESE timestamps; letting
    // the two be written apart is how a row ends up claiming a confirmed
    // direction for a punch pair that has since been replaced.
    const { error: updateErr } = await svc
      .from('attendance_records')
      .update({
        check_in_at:            row.check_in_at,
        check_out_at:           row.check_out_at,
        status:                 row.status,
        punch_direction_source: row.punch_direction_source,
      })
      .eq('user_id', row.user_id)
      .eq('attendance_date', row.attendance_date)

    if (updateErr) {
      errors.push(`Update failed for ${row.user_id} ${row.attendance_date}: ${updateErr.message}`)
      continue
    }

    empUpdated.set(row.user_id, (empUpdated.get(row.user_id) ?? 0) + 1)

    // The correction log records PUNCH corrections. A row rewritten only to
    // repair its provenance has identical before and after times, and logging
    // that would fill the attendance audit trail with entries stating that
    // nothing happened.
    if (!punchChangedKeys.has(key)) continue

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
      // Which codes were placed by hand rather than by the device lookup. Shown
      // on the result screen because "imported as" is the one fact about this
      // import that is not recoverable from the file afterwards.
      manualMappings: appliedMappings,
    },
  })
}
