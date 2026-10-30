// One month of attendance, day by day and person by person, as the Overview and
// Monthly Review read it.
//
// Every day goes through the payroll engine (classifyDayForAttendance), so
// corrections, waivers, half-day holidays and the 10:15 grace period all apply
// exactly as they do on a payslip. The reason this exists is that
// attendance_records.status cannot answer these questions: its CHECK allows only
// present, checked_in, absent and half_day, and the import and the machine write
// only the first two, so a count of `status === 'late'` or `'half_day'` is always
// zero.
//
// Read-only, and nothing here stores a result.

import type { ServiceClient } from '../security/attendancePayrollApiAuth'
import { istCurrentYearMonth, type YearMonth } from './monthAvailability'
import {
  attendanceCoverageThrough, isMachineMonth, machineLatestDate, withinCoverage,
} from './monthAvailability'
import { monthDates, nonWorkingReason, workingDatesInMonth } from './monthCalendar'
import {
  MIN_COUNTED_DAYS, NOTHING_APPROVED, attentionReason, clockLabel, countedDays, dayKind, emptyTally,
  greatReason, scoreBand, scoreOf, usualArrivalMinutes,
  type ApprovedDay, type DayTally, type OverviewData, type OverviewPerson, type OverviewTotal,
  type ScoreDayKind, type StripDay,
} from './attendanceScore'
import type { AttendanceDayCorrection } from './corrections'
import { istDateRange, istMinutesOfDay } from '../istDate'
import { classifyDayForAttendance } from '../payroll/engine'
import type { PayrollSettings } from '../payroll/settings'
import { fetchActiveSettings } from '../payroll/settingsStore'
import { toEngineAttendanceRecord } from '../payroll/store'
import type { EngineHoliday, HolidayHalfSession } from '../payroll/types'
import { fetchAllRows, unwrapPagedRows } from '../supabasePaging'

/** The attendance_records columns a day needs. Named once so no route spells them out. */
export const SCORE_RECORD_COLUMNS = 'id, user_id, attendance_date, check_in_at, check_out_at, punch_direction_source'

export type ScoreRecord = {
  id: string
  user_id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  punch_direction_source: string | null
}

export type ScoreEmployee = {
  id: string
  full_name: string
  employee_code: string | null
  joining_date: string | null
  exit_date: string | null
  minop_user_id: string | null
}

type StoredCorrection = AttendanceDayCorrection & { user_id: string }

export type ScoreRequest = {
  employee_id: string
  request_type: string
  start_date: string
  end_date: string
}

/** Everything about a date range except the punches. */
export type ScoreContext = {
  settings: PayrollSettings
  corrections: StoredCorrection[]
  requests: ScoreRequest[]
  holidays: EngineHoliday[]
}

/**
 * Corrections, approved requests, holidays and the active settings for a range.
 * Throws on a failed read: a score worked out without someone's corrections looks
 * like an answer and is not one. Pass `userId` to read one person's only.
 */
export async function readScoreContext(
  svc: ServiceClient,
  from: string,
  to: string,
  userId?: string,
): Promise<ScoreContext> {
  const [{ settings }, corrections, requests, holidays] = await Promise.all([
    fetchActiveSettings(svc),
    fetchAllRows<StoredCorrection>((pageFrom, pageTo) => {
      const query = svc
        .from('attendance_day_corrections')
        .select('user_id, attendance_date, corrected_check_in_at, corrected_check_out_at, day_treatment, waive_late_arrival, waive_early_checkout, waive_missing_punch')
        .eq('is_current', true)
        .gte('attendance_date', from)
        .lte('attendance_date', to)
      return (userId ? query.eq('user_id', userId) : query)
        .order('id', { ascending: true })
        .range(pageFrom, pageTo)
    }),
    fetchAllRows<ScoreRequest>((pageFrom, pageTo) => {
      const query = svc
        .from('attendance_requests')
        .select('employee_id, request_type, start_date, end_date')
        .eq('status', 'approved')
        .lte('start_date', to)
        .gte('end_date', from)
      return (userId ? query.eq('employee_id', userId) : query)
        .order('id', { ascending: true })
        .range(pageFrom, pageTo)
    }),
    svc
      .from('payroll_holidays')
      .select('holiday_date, holiday_type, half_session')
      .gte('holiday_date', from)
      .lte('holiday_date', to),
  ])
  if (holidays.error) throw new Error(`Could not read holidays: ${holidays.error.message}`)
  return {
    settings,
    corrections: unwrapPagedRows('attendance corrections', corrections),
    requests: unwrapPagedRows('attendance requests', requests),
    holidays: (holidays.data ?? []) as EngineHoliday[],
  }
}

/** The dates a person is not expected in on, as the month calendar wants them. */
export function fullDayHolidayDates(holidays: readonly EngineHoliday[]): string[] {
  return holidays.filter(h => h.holiday_type === 'full_day').map(h => h.holiday_date)
}

export type ScoreIndex = {
  settings: PayrollSettings
  records: Map<string, ScoreRecord>
  corrections: Map<string, AttendanceDayCorrection>
  approved: Map<string, ApprovedDay>
  halfDayHolidays: Map<string, HolidayHalfSession>
}

const dayKey = (userId: string, date: string) => `${userId}|${date}`

export function buildScoreIndex(records: readonly ScoreRecord[], context: ScoreContext): ScoreIndex {
  const approved = new Map<string, ApprovedDay>()
  for (const request of context.requests) {
    for (const date of istDateRange(request.start_date, request.end_date)) {
      const key = dayKey(request.employee_id, date)
      const day = approved.get(key) ?? { ...NOTHING_APPROVED }
      if (request.request_type === 'full_day_leave') day.fullLeave = true
      if (request.request_type === 'half_day') day.halfLeave = true
      if (request.request_type === 'late_arrival') day.lateArrival = true
      if (request.request_type === 'early_departure') day.earlyDeparture = true
      approved.set(key, day)
    }
  }
  return {
    settings: context.settings,
    records: new Map(records.map(r => [dayKey(r.user_id, r.attendance_date), r])),
    corrections: new Map(context.corrections.map(c => [dayKey(c.user_id, c.attendance_date), c])),
    approved,
    halfDayHolidays: new Map(
      context.holidays.flatMap(h => (h.holiday_type === 'half_day' && h.half_session
        ? [[h.holiday_date, h.half_session] as const]
        : [])),
    ),
  }
}

export type ScoredDay = {
  kind: ScoreDayKind
  /** The punches payroll used: corrected when a correction applies. */
  checkInAt: string | null
  checkOutAt: string | null
}

/** One working day of one person, as payroll reads it. */
export function scoreDay(index: ScoreIndex, userId: string, date: string): ScoredDay {
  const key = dayKey(userId, date)
  const record = index.records.get(key)
  const day = classifyDayForAttendance(
    date,
    record ? toEngineAttendanceRecord(record) : undefined,
    index.settings,
    index.corrections.get(key),
    index.halfDayHolidays.get(date),
  )
  const lines = day.deduction_lines.map(line => line.deduction_type)
  return {
    kind: dayKind({
      classification: day.classification,
      late: lines.includes('late_arrival'),
      early: lines.includes('early_checkout'),
      missing: lines.includes('missing_punch_in') || lines.includes('missing_punch_out'),
      approved: index.approved.get(key) ?? NOTHING_APPROVED,
    }),
    checkInAt: day.check_in_at,
    checkOutAt: day.check_out_at,
  }
}

/** Moves a month forwards or backwards. */
export function shiftMonth({ year, month }: YearMonth, by: number): YearMonth {
  const index = year * 12 + (month - 1) + by
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

function latestDateByMonth(records: readonly ScoreRecord[]): Map<string, string> {
  const latest = new Map<string, string>()
  for (const { attendance_date: date } of records) {
    const month = date.slice(0, 7)
    const seen = latest.get(month)
    if (!seen || date > seen) latest.set(month, date)
  }
  return latest
}

const monthKey = ({ year, month }: YearMonth) => `${year}-${String(month).padStart(2, '0')}`

function monthCoverage(latest: Map<string, string>, ym: YearMonth, now: Date): string | null {
  const inMonth = latest.get(monthKey(ym)) ?? null
  const reached = isMachineMonth(ym.year, ym.month) ? machineLatestDate(inMonth, now) : inMonth
  return attendanceCoverageThrough(ym.year, ym.month, reached, now)
}

type EmployeeMonth = {
  strip: StripDay[]
  tally: DayTally
  points: number
  counted: number
  /** Null below the minimum, or when punches cannot be read for this person. */
  score: number | null
  arrivals: number[]
  absentDates: string[]
  unmeasured: boolean
}

function scoreEmployeeMonth(
  index: ScoreIndex,
  employee: ScoreEmployee,
  { year, month }: YearMonth,
  coverageThrough: string | null,
  fullDayHolidays: string[],
): EmployeeMonth {
  const calendar = { holidays: fullDayHolidays, joiningDate: employee.joining_date, exitDate: employee.exit_date }
  // The machine supplies this month and has no ID for them, so their days are
  // unknown. Reading those as absences would rank them last for a missing link.
  const unmeasured = isMachineMonth(year, month) && !employee.minop_user_id

  const tally = emptyTally()
  const arrivals: number[] = []
  const absentDates: string[] = []

  const strip = monthDates(year, month).map((date): StripDay => {
    const reason = nonWorkingReason(date, calendar)
    if (reason === 'weekly_off' || reason === 'holiday') return { date, kind: 'off' }
    if (reason) return { date, kind: 'not_employed' }
    if (!coverageThrough || date > coverageThrough) return { date, kind: 'pending' }
    if (unmeasured) return { date, kind: 'unknown' }

    const { kind, checkInAt } = scoreDay(index, employee.id, date)
    tally[kind]++
    if (kind === 'absent') absentDates.push(date)
    if (checkInAt && (kind === 'ok' || kind === 'late' || kind === 'early')) arrivals.push(istMinutesOfDay(checkInAt))
    return { date, kind }
  })

  const { counted, points } = countedDays(tally)
  const ranked = !unmeasured && counted >= MIN_COUNTED_DAYS
  return { strip, tally, points, counted, score: ranked ? scoreOf(points, counted) : null, arrivals, absentDates, unmeasured }
}

const dayMonthLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

const monthNameOf = ({ year, month }: YearMonth) =>
  new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })

function notRankedLine(employee: ScoreEmployee, result: EmployeeMonth, ym: YearMonth): string {
  if (result.unmeasured) return 'No Machine ID yet, so no punches can be read'
  const soFar = `${result.counted} ${result.counted === 1 ? 'day' : 'days'} so far`
  const joinedThisMonth = employee.joining_date?.startsWith(monthKey(ym))
  return joinedThisMonth ? `Joined ${dayMonthLabel(employee.joining_date!)}, ${soFar}` : `Too few days to rank, ${soFar}`
}

function totalOf(people: readonly OverviewPerson[], count: (p: OverviewPerson) => number): OverviewTotal {
  const involved = people.filter(p => count(p) > 0)
  const top = involved.reduce<OverviewPerson | null>((best, p) => (!best || count(p) > count(best) ? p : best), null)
  return {
    total: people.reduce((sum, p) => sum + count(p), 0),
    people: involved.length,
    top: top ? { name: top.name, count: count(top) } : null,
  }
}

/** The month the Overview opens on: the newest with enough complete days to rank. */
export function chooseDefaultMonth(
  records: readonly ScoreRecord[],
  holidays: readonly EngineHoliday[],
  now: Date = new Date(),
): YearMonth {
  const current = istCurrentYearMonth(now)
  const latest = latestDateByMonth(records)
  const fullDay = fullDayHolidayDates(holidays)
  for (let back = 0; back <= 6; back++) {
    const ym = shiftMonth(current, -back)
    const worked = withinCoverage(workingDatesInMonth(ym.year, ym.month, { holidays: fullDay }), monthCoverage(latest, ym, now))
    if (worked.length >= MIN_COUNTED_DAYS) return ym
  }
  return current
}

/**
 * The Overview for one month, with the five months before it for the trends.
 * `records` and `context` must cover all six months.
 */
export function buildOverview(input: {
  employees: readonly ScoreEmployee[]
  records: readonly ScoreRecord[]
  context: ScoreContext
  year: number
  month: number
  pendingRequests: number
  fellBackFrom: YearMonth | null
  now?: Date
}): OverviewData {
  const { employees, records, context, year, month, pendingRequests, fellBackFrom, now = new Date() } = input
  const chosen = { year, month }
  const index = buildScoreIndex(records, context)
  const latest = latestDateByMonth(records)
  const fullDay = fullDayHolidayDates(context.holidays)

  const months = [5, 4, 3, 2, 1, 0].map(back => shiftMonth(chosen, -back))
  const scored = months.map(ym => {
    const coverage = monthCoverage(latest, ym, now)
    return new Map(employees.map(e => [e.id, scoreEmployeeMonth(index, e, ym, coverage, fullDay)]))
  })
  const thisMonth = scored[scored.length - 1]
  const previousMonthName = monthNameOf(months[months.length - 2])
  const coverageThrough = monthCoverage(latest, chosen, now)

  const people = employees.flatMap((employee): OverviewPerson[] => {
    const result = thisMonth.get(employee.id)!
    // Not on the staff in this month at all, such as someone who joined later.
    if (result.strip.every(d => d.kind === 'off' || d.kind === 'not_employed')) return []

    const history = scored.map(month => month.get(employee.id)!.score)
    const previous = history[history.length - 2]
    const delta = result.score !== null && previous !== null ? result.score - previous : null
    const usual = usualArrivalMinutes(result.arrivals)
    const band = result.score === null ? null : scoreBand(result.score)

    return [{
      id: employee.id,
      name: employee.full_name,
      code: employee.employee_code,
      strip: result.strip,
      tally: result.tally,
      counted: result.counted,
      score: result.score,
      band,
      rank: null,
      notRanked: result.score === null ? notRankedLine(employee, result, chosen) : null,
      reason: band === 'great'
        ? greatReason(result.tally)
        : band === 'attention'
          ? attentionReason({ tally: result.tally, absentDates: result.absentDates, usualArrival: usual, delta, previousMonthName })
          : '',
      usualArrival: usual === null ? null : clockLabel(usual),
      history,
      delta,
    }]
  })

  const ranked = people
    .filter(p => p.score !== null)
    .sort((a, b) => b.score! - a.score! || a.tally.absent - b.tally.absent || a.name.localeCompare(b.name))
    .map((p, i) => ({ ...p, rank: i + 1 }))
  const unranked = people
    .filter(p => p.score === null)
    .sort((a, b) => a.name.localeCompare(b.name))

  const companyHistory = scored.map(month => {
    let points = 0
    let counted = 0
    for (const result of month.values()) {
      if (result.score === null) continue
      points += result.points
      counted += result.counted
    }
    return scoreOf(points, counted)
  })
  const companyScore = companyHistory[companyHistory.length - 1]
  const companyPrevious = companyHistory[companyHistory.length - 2]

  return {
    year,
    month,
    coverageThrough,
    workingDaysCounted: withinCoverage(workingDatesInMonth(year, month, { holidays: fullDay }), coverageThrough).length,
    months,
    company: {
      score: companyScore,
      history: companyHistory,
      delta: companyScore !== null && companyPrevious !== null ? companyScore - companyPrevious : null,
    },
    totals: {
      late: totalOf(ranked, p => p.tally.late + p.tally.early),
      absent: totalOf(ranked, p => p.tally.absent),
      miss: totalOf(ranked, p => p.tally.miss),
    },
    people: [...ranked, ...unranked],
    pendingRequests,
    noMachineId: employees.filter(e => !e.minop_user_id).length,
    fellBackFrom,
  }
}
