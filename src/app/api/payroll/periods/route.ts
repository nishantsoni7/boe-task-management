// GET /api/payroll/periods
// Returns all payroll periods with latest generation metadata.
// GET needs Payroll module access (admin, or a member named in Control Center →
// Module Visibility → Custom). POST — creating a period — stays admin-only.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { fetchAllRows } from '@/lib/supabasePaging'
import { isFutureMonth } from '@/lib/attendance/monthAvailability'
import { attendanceExistsForMonth } from '@/lib/attendance/attendanceExists'
import { periodLabel } from '@/lib/payroll/months'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

export type PayrollPeriodRecord = {
  id: string
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  [key: string]: unknown
}

export type GetOrCreatePeriodResult =
  | { outcome: 'created'; period: PayrollPeriodRecord }
  | { outcome: 'reused';  period: PayrollPeriodRecord }
  | { outcome: 'locked' }

// Core branching logic for POST /api/payroll/periods, factored out so it can
// be exercised directly against a real Supabase client in tests without going
// through HTTP/auth. See route.test.ts for coverage of all three outcomes.
//
// Invariant POST relies on without re-checking: this never inserts a second
// row for a month/year that already has a non-locked period — every non-error
// path either returns the pre-existing row ('reused'/'locked') or inserts
// exactly once ('created'). Callers can treat the result as the single source
// of truth for which HTTP status to return.
export type PeriodCreateEligibility =
  | { ok: true }
  | { ok: false; error: string }

/**
 * The rule POST /api/payroll/periods enforces before it will create or reuse
 * a period: not a future month, and attendance already uploaded for it.
 *
 * Extracted so it is testable the same way getOrCreatePayrollPeriod and
 * computeOutOfDate already are in this file — directly, against a real
 * Supabase client, without constructing a NextRequest.
 */
export async function checkPeriodCreateEligibility(
  svc: Svc,
  month: number,
  year: number,
): Promise<PeriodCreateEligibility> {
  if (isFutureMonth(year, month)) {
    return { ok: false, error: 'Cannot create payroll for a future month.' }
  }

  const attendanceExists = await attendanceExistsForMonth(svc, year, month)
  if (!attendanceExists) {
    const label = periodLabel(month, year)
    return {
      ok: false,
      error: `Attendance for ${label} has not been uploaded. Upload attendance before creating payroll.`,
    }
  }

  return { ok: true }
}

export async function getOrCreatePayrollPeriod(
  svc: Svc,
  month: number,
  year: number,
): Promise<GetOrCreatePeriodResult> {
  const { data: existing } = await svc
    .from('payroll_periods')
    .select('*')
    .eq('payroll_month', month)
    .eq('payroll_year', year)
    .maybeSingle()

  if (existing) {
    if (existing.status === 'locked') return { outcome: 'locked' }
    // Draft/Generated — reuse it. Attendance may have been re-uploaded since the
    // last generation; the caller should hit /api/payroll/generate next to
    // recompute results for this same period (upsert keeps one row per employee).
    return { outcome: 'reused', period: existing as PayrollPeriodRecord }
  }

  const { data: created, error: insertErr } = await svc
    .from('payroll_periods')
    .insert({ payroll_month: month, payroll_year: year, status: 'draft' })
    .select()
    .single()

  if (insertErr || !created) {
    throw new Error(`getOrCreatePayrollPeriod insert: ${insertErr?.message ?? 'no row returned'}`)
  }

  return { outcome: 'created', period: created as PayrollPeriodRecord }
}

/**
 * How many employees each period currently holds a payroll result for.
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * The dashboard used to show `payroll_generation.employee_count` from the latest
 * completed run. That column records how many employees ONE generation REQUEST
 * processed, which is only the period's headcount when the run happened to cover
 * everybody. Every attendance correction triggers a regeneration for the single
 * employee it affects, so a 12-person month displayed "1" the moment one date
 * was corrected — while the period still held all 12 results.
 *
 * `payroll_results` is the source of truth for who is in a period: it is upserted
 * on (payroll_period_id, employee_id), so regenerating one employee replaces that
 * one row and leaves the other eleven untouched. Counting those rows is therefore
 * correct for a partial run, a full run and a historical locked month alike —
 * a locked period's rows never change, so its count stays what it was.
 *
 * Pure, so it can be tested without a database. The generation metadata is not
 * deleted; it simply stops being used as a headcount.
 */
export function countResultsByPeriod(
  resultRows: Array<{ payroll_period_id: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of resultRows) {
    counts[row.payroll_period_id] = (counts[row.payroll_period_id] ?? 0) + 1
  }
  return counts
}

// Pure decision logic for attendance-vs-generation staleness, factored out of
// GET so it's unit-testable with fabricated data — no DB writes needed. See
// the caller below for how attendanceRows is fetched (bounded to the months
// that actually have a generation to compare against).
export function computeOutOfDate(
  generatedPeriods: Array<{ id: string; payroll_month: number; payroll_year: number }>,
  lastGeneratedAt: Record<string, string>,   // period id → payroll_generation.completed_at
  attendanceRows: Array<{ attendance_date: string; updated_at: string }>,
): Record<string, boolean> {
  const outOfDate: Record<string, boolean> = {}

  for (const p of generatedPeriods) {
    const mm = String(p.payroll_month).padStart(2, '0')
    const nextMonth = p.payroll_month === 12 ? 1 : p.payroll_month + 1
    const nextYear  = p.payroll_month === 12 ? p.payroll_year + 1 : p.payroll_year
    const start = `${p.payroll_year}-${mm}-01`
    const end   = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

    const maxUpdatedMs = attendanceRows
      .filter(r => r.attendance_date >= start && r.attendance_date < end)
      .reduce((max, r) => Math.max(max, new Date(r.updated_at).getTime()), 0)

    const lastGeneratedMs = new Date(lastGeneratedAt[p.id]).getTime()
    outOfDate[p.id] = maxUpdatedMs > lastGeneratedMs
  }

  return outOfDate
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const { data: periods, error: periodsErr } = await svc
    .from('payroll_periods')
    .select('*')
    .order('payroll_year', { ascending: false })
    .order('payroll_month', { ascending: false })

  if (periodsErr) return NextResponse.json({ error: periodsErr.message }, { status: 500 })

  // Fetch latest done generation per period for employee count + timestamp
  const { data: generations, error: genErr } = await svc
    .from('payroll_generation')
    .select('payroll_period_id, employee_count, completed_at')
    .eq('status', 'done')
    .order('completed_at', { ascending: false })

  if (genErr) return NextResponse.json({ error: genErr.message }, { status: 500 })

  // ── Period headcount ──────────────────────────────────────────────────────
  // Read from payroll_results, not from the generation run — see
  // countResultsByPeriod above for why the two are not the same number.
  // Paged: PostgREST silently caps a response at 1000 rows, and results grow as
  // employees × months, so an unpaged read would quietly start under-counting
  // the oldest periods once the table passes that mark.
  const resultRowsRead = await fetchAllRows<{ payroll_period_id: string }>((from, to) =>
    svc
      .from('payroll_results')
      .select('id, payroll_period_id')
      .order('id', { ascending: true })
      .range(from, to),
  )

  if (!resultRowsRead.ok || resultRowsRead.truncated) {
    const detail = resultRowsRead.ok ? 'exceeded the paged read cap' : resultRowsRead.error
    console.error('[payroll/periods] result headcount read failed:', detail)
    return NextResponse.json({ error: 'Failed to read payroll results' }, { status: 500 })
  }

  const resultCounts = countResultsByPeriod(resultRowsRead.rows)

  // Keep only the first (latest) done generation per period
  const latestGen: Record<string, { employee_count: number; completed_at: string }> = {}
  for (const g of generations ?? []) {
    if (!latestGen[g.payroll_period_id]) {
      latestGen[g.payroll_period_id] = {
        employee_count: g.employee_count ?? 0,
        completed_at: g.completed_at,
      }
    }
  }

  // ── Attendance-vs-generation staleness ────────────────────────────────────
  // A period is "out of date" once attendance for its month has been touched
  // (imported or corrected) any time after its last completed generation.
  // attendance_records.updated_at is already maintained for us — a DB trigger
  // bumps it on every UPDATE, and it defaults to now() on INSERT — and the
  // import route only writes rows that are new or actually changed, so an
  // unchanged row's updated_at never moves. That makes MAX(updated_at) per
  // month a reliable "attendance last touched" signal with no new columns.
  const generatedPeriods = (periods ?? []).filter(p => latestGen[p.id] != null)
  let outOfDate: Record<string, boolean> = {}

  if (generatedPeriods.length > 0) {
    // Bound the query to the months actually in play instead of scanning the
    // whole table.
    const monthStarts = generatedPeriods.map(p => `${p.payroll_year}-${String(p.payroll_month).padStart(2, '0')}-01`)
    const overallStart = monthStarts.reduce((min, s) => (s < min ? s : min))
    const lastPeriod   = generatedPeriods.reduce((latest, p) =>
      (p.payroll_year > latest.payroll_year ||
        (p.payroll_year === latest.payroll_year && p.payroll_month > latest.payroll_month)) ? p : latest)
    const overallEndMonth = lastPeriod.payroll_month === 12 ? 1 : lastPeriod.payroll_month + 1
    const overallEndYear  = lastPeriod.payroll_month === 12 ? lastPeriod.payroll_year + 1 : lastPeriod.payroll_year
    const overallEnd = `${overallEndYear}-${String(overallEndMonth).padStart(2, '0')}-01`

    // PAGED. The window is bounded to the months in play, but "the months in
    // play" is every generated period — so for a year of payroll this is
    // (employees x 365) rows, far past PostgREST's silent 1000-row cap
    // (src/lib/supabasePaging.ts).
    //
    // A short read here does not report a smaller number; it makes a period look
    // UP TO DATE when attendance has since changed underneath it, because the
    // rows that would have said otherwise are the ones that went missing. The
    // stale marker exists precisely to catch that, so it must not be the thing
    // that fails quietly.
    //
    // A failed or capped read leaves the marker unset rather than confidently
    // clean: `attendanceRows` stays undefined, and the code below already treats
    // an absent row set as "nothing to compare", which shows no stale badge
    // rather than a false all-clear.
    const attendancePage = await fetchAllRows<{ attendance_date: string; updated_at: string }>(
      (pageFrom, pageTo) => svc
        .from('attendance_records')
        .select('attendance_date, updated_at')
        .gte('attendance_date', overallStart)
        .lt('attendance_date', overallEnd)
        // A unique tiebreak: range() maps to LIMIT/OFFSET, and every employee
        // shares an attendance_date with every other employee.
        .order('id', { ascending: true })
        .range(pageFrom, pageTo))

    const attendanceRows = attendancePage.ok && !attendancePage.truncated
      ? attendancePage.rows
      : undefined

    const lastGeneratedAt = Object.fromEntries(
      generatedPeriods.map(p => [p.id, latestGen[p.id].completed_at]),
    )
    outOfDate = computeOutOfDate(generatedPeriods, lastGeneratedAt, attendanceRows ?? [])
  }

  // ── Finalisation trail ────────────────────────────────────────────────────
  // The dashboard needs two facts per period: what the last finalisation event
  // was (for "Last Activity") and, separately, the last time it was reopened
  // after being locked — with who did it and why. Both come from the same
  // append-only table, so the page never has a second source of truth for them.
  const { latestEvent, latestUnlock } = await fetchStatusEvents(svc, (periods ?? []).map(p => p.id))

  const result = (periods ?? []).map(p => ({
    ...p,
    out_of_date: outOfDate[p.id] ?? false,
    // The period's headcount: employees it currently holds a result for.
    employee_count: resultCounts[p.id] ?? 0,
    // Run metadata, kept because it is genuinely useful when diagnosing a
    // generation — but it is NOT the headcount and nothing displays it as one.
    last_run_employee_count: latestGen[p.id]?.employee_count ?? null,
    last_generated_at:       latestGen[p.id]?.completed_at ?? null,
    last_status_event:   latestEvent[p.id]  ?? null,
    last_unlock:         latestUnlock[p.id] ?? null,
  }))

  return NextResponse.json({ periods: result })
}

export type PayrollStatusEvent = {
  event: 'locked' | 'unlocked'
  actor_name: string | null
  reason: string | null
  created_at: string
}

/**
 * The latest status event, and the latest unlock, for each of these periods.
 *
 * Degrades to empty rather than failing the whole dashboard: the finalisation
 * trail is added by migration 20260811000000, and a payroll list that 500s
 * because that migration has not been applied yet would take out generation,
 * locking and results along with it. Nothing here feeds a calculation.
 */
async function fetchStatusEvents(
  svc: Svc,
  periodIds: string[],
): Promise<{
  latestEvent:  Record<string, PayrollStatusEvent>
  latestUnlock: Record<string, PayrollStatusEvent>
}> {
  const latestEvent:  Record<string, PayrollStatusEvent> = {}
  const latestUnlock: Record<string, PayrollStatusEvent> = {}
  if (periodIds.length === 0) return { latestEvent, latestUnlock }

  const { data, error } = await svc
    .from('payroll_period_status_events')
    .select('payroll_period_id, event, actor_name, reason, created_at')
    .in('payroll_period_id', periodIds)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[payroll/periods] status events unavailable:', error.message)
    return { latestEvent, latestUnlock }
  }

  // Rows arrive newest-first, so the first hit per period is the latest one.
  for (const row of data ?? []) {
    const e: PayrollStatusEvent = {
      event:      row.event,
      actor_name: row.actor_name ?? null,
      reason:     row.reason ?? null,
      created_at: row.created_at,
    }
    if (!latestEvent[row.payroll_period_id]) latestEvent[row.payroll_period_id] = e
    if (e.event === 'unlocked' && !latestUnlock[row.payroll_period_id]) {
      latestUnlock[row.payroll_period_id] = e
    }
  }

  return { latestEvent, latestUnlock }
}

// POST /api/payroll/periods
// Creates a new payroll period for the given month/year.
// If a period already exists and is not locked, returns that existing period
// (200) instead of erroring — attendance can be re-uploaded and payroll
// regenerated any number of times against the same Draft/Generated period.
// Returns 409 only if the existing period is locked.
export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user: caller }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await svc
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const month = Number(body?.month)
  const year  = Number(body?.year)

  if (!month || month < 1 || month > 12 || !year || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'Invalid month or year' }, { status: 400 })
  }

  // A payroll period may only be created for a month that has actually
  // happened AND that attendance has already been uploaded for. Server-side,
  // because the eligibility list the UI offers is exactly that — a UI
  // convenience, not the boundary. A direct POST for an ineligible month must
  // fail here regardless of what the picker showed.
  let eligibility: PeriodCreateEligibility
  try {
    eligibility = await checkPeriodCreateEligibility(svc, month, year)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
  if (!eligibility.ok) {
    return NextResponse.json({ error: eligibility.error }, { status: 400 })
  }

  let result: GetOrCreatePeriodResult
  try {
    result = await getOrCreatePayrollPeriod(svc, month, year)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  if (result.outcome === 'locked') {
    return NextResponse.json({ error: `Payroll period for this month already exists` }, { status: 409 })
  }

  return NextResponse.json({ period: result.period }, { status: result.outcome === 'created' ? 201 : 200 })
}
