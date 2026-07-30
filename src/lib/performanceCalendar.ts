/**
 * Which dates an employee was actually expected to work.
 *
 * Performance averages count a day with no activity as zero — that is the point,
 * because system non-use has to stay visible. But that is only fair on days the
 * employee was expected to work. Averaging over every calendar date charged
 * people a zero for Sundays, festival holidays, dates before they joined and
 * dates after they left.
 *
 * Nothing here is a new source of truth. The rules and the data already existed
 * elsewhere in the app and are reused as-is:
 *
 *   Sunday weekly off   lib/payroll/engine.ts buildWorkingDayCalendar (dow 0)
 *   Company holidays    payroll_holidays          (migration 20260613)
 *   Joining date        users.joining_date        (migration 20260608000100)
 *   Exit date           users.exit_date           (migration 20260718000000)
 *                       falling back to users.deleted_at (migration 20260605)
 *
 * The one thing that does not exist anywhere in the schema is approved leave —
 * see APPROVED_LEAVE_UNAVAILABLE below.
 */

import {
  istDateRange, istDateOf, istDayStartUtc, istAddDays,
  istWeekStart, istMonthStart, istMonthEnd, istMonthStartOffset,
} from '@/lib/istDate'

/**
 * BOE app rollout. No task or EOD data exists before this date, so earlier days
 * would score as phantom zeroes for everyone.
 */
export const PERFORMANCE_ROLLOUT_DATE = '2026-06-08'

/**
 * Weekly off, as JS day-of-week numbers (0 = Sunday).
 *
 * This is not an assumption. BOE runs a six-day week, Monday to Saturday:
 *   docs/Module Docs/PAYROLL_RULES_V1.md   "Sundays and weekly offs are
 *                                           company holidays" (rules 3 and the
 *                                           deduction rules)
 *   docs/Module Docs/ATTENDANCE_MODULE_PLAN.md  "Mon–Sat or configured"
 *   lib/payroll/engine.ts buildWorkingDayCalendar  excludes dow 0 only
 *
 * Saturday is therefore a working day. There is no per-employee or
 * per-department weekly-off table in the schema; if one is ever added, this is
 * the single place that has to start reading from it.
 */
export const DEFAULT_WEEKLY_OFF_DAYS: ReadonlySet<number> = new Set([0])

/**
 * Hour (IST, 24h) after which the current day is treated as finished and its
 * score counts toward averages. Before this, today is still in progress and
 * scoring it as a completed day would drag every average down all morning.
 *
 * This is a constant rather than a setting because the schema has no settings
 * table (see migration 20260706000000, which notes the same absence).
 */
export const PERFORMANCE_DAY_CUTOFF_HOUR = 19

/**
 * Approved leave cannot be excluded yet. There is no leave-request or
 * leave-approval table in the schema, and attendance_records.status is
 * constrained to present / checked_in / absent / half_day (migration 20260635)
 * — none of which represents *approved* leave. payroll_generation.days_on_leave
 * is a computed monthly total, not a per-date record, so it cannot say which
 * dates to skip.
 *
 * Rather than infer leave from absence — which would hand anyone a way to erase
 * a bad day by not showing up — approved leave is left in scope and documented
 * as a known limitation.
 *
 * The extension point for supplying it later is `WorkingDayContext.neutralDates`,
 * populated from an `AttendanceProvider` via `splitAttendanceStates` in
 * lib/performanceAttendance.ts. Until a provider is wired, that set is empty and
 * this rule is unchanged.
 */
export const APPROVED_LEAVE_UNAVAILABLE = true

export type WorkingDayContext = {
  /** Company holiday dates (YYYY-MM-DD). */
  holidays:      ReadonlySet<string>
  /** users.joining_date. Null means no recorded start boundary. */
  joiningDate:   string | null
  /** users.exit_date, or the IST date of users.deleted_at. Null means still employed. */
  exitDate:      string | null
  /** Defaults to Sunday. */
  weeklyOffDays?: ReadonlySet<number>
  /**
   * Per-employee dates that carry no work expectation at all — approved leave,
   * and anything else an AttendanceProvider reports as neutral.
   *
   * This is the integration seam for Attendance. It is per-employee, unlike
   * `holidays`, because leave is. Empty today: no provider is wired, and leave is
   * never inferred from absence (see APPROVED_LEAVE_UNAVAILABLE).
   *
   * A neutral date is not a missed day and not a zero — it leaves both the
   * numerator and the denominator, exactly like a Sunday.
   */
  neutralDates?: ReadonlySet<string>
}

/** Day-of-week for a date-only value. Identical in IST and UTC, so UTC is safe. */
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/** Has the given IST business day passed its end-of-day cutoff? */
export function hasDayCutoffPassed(
  date: string,
  now: Date = new Date(),
  cutoffHour: number = PERFORMANCE_DAY_CUTOFF_HOUR,
): boolean {
  const cutoffMs = Date.parse(istDayStartUtc(date)) + cutoffHour * 3600_000
  return now.getTime() >= cutoffMs
}

/** Is this a day the employee was expected to be working? */
export function isExpectedWorkingDay(date: string, ctx: WorkingDayContext): boolean {
  if (date < PERFORMANCE_ROLLOUT_DATE)                       return false
  if ((ctx.weeklyOffDays ?? DEFAULT_WEEKLY_OFF_DAYS).has(dayOfWeek(date))) return false
  if (ctx.holidays.has(date))                                return false
  if (ctx.neutralDates?.has(date))                           return false
  if (ctx.joiningDate && date < ctx.joiningDate)             return false
  if (ctx.exitDate    && date > ctx.exitDate)                return false
  return true
}

/**
 * Every day in the range the employee was expected to work, oldest first.
 * Clamped to the rollout date and to today — the future is not yet missed.
 *
 * This is the display/fetch set: it includes today even while today is still in
 * progress, so the daily view can show a live score.
 */
export function expectedWorkingDates(
  from: string,
  to: string,
  today: string,
  ctx: WorkingDayContext,
): string[] {
  const start = from > PERFORMANCE_ROLLOUT_DATE ? from : PERFORMANCE_ROLLOUT_DATE
  const end   = to   < today                    ? to   : today
  return istDateRange(start, end).filter(d => isExpectedWorkingDay(d, ctx))
}

/**
 * The days that count toward an average. Same as expectedWorkingDates, minus
 * today while today is still in progress.
 *
 * A day the employee was expected to work but did nothing on stays in this set
 * and scores zero. That is deliberate: not using the system has to be visible.
 */
export function eligiblePerformanceDates(
  from: string,
  to: string,
  today: string,
  ctx: WorkingDayContext,
  now: Date = new Date(),
): string[] {
  return expectedWorkingDates(from, to, today, ctx)
    .filter(d => d !== today || hasDayCutoffPassed(d, now))
}

/**
 * Resolve an employee's exit boundary from whatever the row actually carries.
 * An explicit exit_date wins; otherwise a soft-deleted user's deleted_at marks
 * the last day they were around. A user who is merely inactive with neither
 * recorded has no boundary — see the limitation note in the route.
 */
export function resolveExitDate(user: {
  exit_date?:  string | null
  deleted_at?: string | null
  is_deleted?: boolean | null
}): string | null {
  if (user.exit_date) return user.exit_date
  if (user.is_deleted && user.deleted_at) return istDateOf(user.deleted_at)
  return null
}

// ─── Holiday calendar completeness ────────────────────────────────────────────
/**
 * Is the company holiday calendar trustworthy for this period?
 *
 * This matters because of what an empty calendar does to a ranking. Every
 * unrecorded festival holiday becomes an ordinary expected working day on which
 * nobody worked, so it scores zero for the entire company — and the employees
 * punished hardest are the ones whose period contains the most of them. A
 * confident ranking computed from an empty calendar is not a slightly-off
 * ranking; it is a ranking of who happened to have fewer unrecorded holidays.
 *
 * **Verified state, 2026-07-30: `payroll_holidays` holds 0 rows.** Not one
 * holiday is recorded for any date, so nothing is currently being excluded, over
 * the whole tracked period from the 2026-06-08 rollout onward. The page therefore
 * has to say so rather than present a clean-looking league table.
 *
 * There is a second table, `attendance_holidays`, which is also empty and is
 * referenced by no application code. `payroll_holidays` is the one the admin
 * Holidays screen writes to (src/app/api/attendance/holidays/route.ts) and the one
 * the payroll engine reads, so it stays the single source. No holiday record is
 * inserted or modified here — this only measures and reports.
 *
 * Note on what can and cannot be proven: a month with no holiday record might
 * genuinely have had no holiday. Absence of records is therefore reported as
 * *unverified coverage*, not as an assertion that data is missing — except in the
 * `no_records` case, where an entire multi-month period with zero holidays is not
 * a credible calendar for India.
 */
export type HolidayCoverageStatus = 'no_records' | 'partial' | 'covered'

export type HolidayCoverage = {
  from: string
  to:   string
  /** Every YYYY-MM the period touches. */
  monthsInRange:      string[]
  /** Months with at least one holiday record. */
  monthsWithRecords:  string[]
  /** Months with none — coverage unverified, not proven missing. */
  monthsWithoutRecords: string[]
  /** Distinct holiday dates that fall inside the period. */
  holidayCount:  number
  /** Dates supplied more than once. Duplicates are harmless (a Set absorbs them) but indicate data-entry drift. */
  duplicateDates: string[]
  /** Supplied dates outside the requested period — ignored, reported for transparency. */
  outOfRangeDates: string[]
  status:  HolidayCoverageStatus
  /** Management-facing warning, or null when nothing needs saying. */
  warning: string | null
}

/** The exact wording the page shows. Kept here so tests and UI cannot drift. */
export const HOLIDAY_CALENDAR_INCOMPLETE_WARNING = 'Holiday calendar incomplete for this period'

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = from.slice(0, 7)
  const last = to.slice(0, 7)
  while (cursor <= last) {
    out.push(cursor)
    const [y, m] = cursor.split('-').map(Number)
    cursor = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
  }
  return out
}

export function holidayCalendarCoverage(
  from: string,
  to: string,
  holidayDates: readonly string[],
): HolidayCoverage {
  // Clamp to the rollout — nobody is measured before it, so earlier gaps are moot.
  const start = from > PERFORMANCE_ROLLOUT_DATE ? from : PERFORMANCE_ROLLOUT_DATE
  const end   = to

  const inRange: string[] = []
  const outOfRangeDates: string[] = []
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const d of holidayDates) {
    if (d < start || d > end) { outOfRangeDates.push(d); continue }
    if (seen.has(d)) duplicates.add(d)
    else { seen.add(d); inRange.push(d) }
  }

  const monthsInRange = start > end ? [] : monthsBetween(start, end)
  const recorded = new Set(inRange.map(d => d.slice(0, 7)))
  const monthsWithRecords    = monthsInRange.filter(m => recorded.has(m))
  const monthsWithoutRecords = monthsInRange.filter(m => !recorded.has(m))

  let status: HolidayCoverageStatus
  if (inRange.length === 0)               status = 'no_records'
  else if (monthsWithoutRecords.length > 0) status = 'partial'
  else                                     status = 'covered'

  let warning: string | null = null
  if (status === 'no_records') {
    warning = `${HOLIDAY_CALENDAR_INCOMPLETE_WARNING} — no company holidays are recorded, `
            + `so any festival or government holiday in this range is being counted as an `
            + `ordinary working day and scoring zero for everyone.`
  } else if (status === 'partial') {
    warning = `${HOLIDAY_CALENDAR_INCOMPLETE_WARNING} — no holidays recorded for `
            + `${monthsWithoutRecords.join(', ')}. Any holiday in those months is being `
            + `counted as an ordinary working day.`
  }

  return {
    from: start, to: end,
    monthsInRange, monthsWithRecords, monthsWithoutRecords,
    holidayCount: inRange.length,
    duplicateDates: [...duplicates].sort(),
    outOfRangeDates: outOfRangeDates.sort(),
    status, warning,
  }
}

/**
 * How much confidence the page may express, given the calendar.
 *
 * `limited` is not cosmetic: it is what stops the six summary cards reading as
 * settled fact when the inputs are not.
 */
export function calendarConfidence(coverage: HolidayCoverage): 'full' | 'limited' {
  return coverage.status === 'covered' ? 'full' : 'limited'
}

// ─── Reporting periods ────────────────────────────────────────────────────────
/**
 * The period presets the Team Performance page offers. One selected period
 * drives every section of that page, so it is resolved once, server-side, and
 * the resolved range travels with the response.
 */
export const PERIOD_KEYS = [
  'today', 'this_week', 'last_week', 'this_month', 'last_month', 'custom',
] as const
export type PeriodKey = typeof PERIOD_KEYS[number]

export type ResolvedPeriod = {
  key:   PeriodKey
  from:  string
  to:    string
  label: string
  /** The equivalent preceding stretch, for "versus last period" comparisons. */
  previous: { from: string; to: string }
}

export function isPeriodKey(value: string | null): value is PeriodKey {
  return value !== null && (PERIOD_KEYS as readonly string[]).includes(value)
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * Turn a preset into concrete dates. `to` is never in the future.
 *
 * The previous range is the same *shape* as the selected one, immediately
 * before it: last week for this week, last month for this month, the day
 * before for today, and an equal-length stretch for a custom range. Comparing
 * a part-month against a whole previous month would flatter or punish everyone
 * unfairly, so a month-to-date is compared against the same span of the
 * previous month.
 */
export function resolvePeriod(
  key: PeriodKey,
  today: string,
  custom?: { from: string; to: string },
): ResolvedPeriod {
  switch (key) {
    case 'today':
      return {
        key, from: today, to: today, label: 'Today',
        previous: { from: istAddDays(today, -1), to: istAddDays(today, -1) },
      }

    case 'this_week': {
      const from = istWeekStart(today)
      return {
        key, from, to: today, label: 'This Week',
        previous: { from: istAddDays(from, -7), to: istAddDays(today, -7) },
      }
    }

    case 'last_week': {
      const from = istAddDays(istWeekStart(today), -7)
      return {
        key, from, to: istAddDays(from, 5), label: 'Last Week',   // Mon–Sat
        previous: { from: istAddDays(from, -7), to: istAddDays(from, -2) },
      }
    }

    case 'this_month': {
      const from    = istMonthStart(today)
      const dayspan = istDateRange(from, today).length
      const prevFrom = istMonthStartOffset(today, 1)
      return {
        key, from, to: today, label: monthLabel(today),
        // Same number of days into the previous month, so a month-to-date is
        // compared against a like-for-like stretch.
        previous: {
          from: prevFrom,
          to:   minDate(istAddDays(prevFrom, dayspan - 1), istMonthEnd(prevFrom)),
        },
      }
    }

    case 'last_month': {
      const from     = istMonthStartOffset(today, 1)
      const prevFrom = istMonthStartOffset(today, 2)
      return {
        key, from, to: istMonthEnd(from), label: monthLabel(from),
        previous: { from: prevFrom, to: istMonthEnd(prevFrom) },
      }
    }

    case 'custom': {
      const from = custom?.from ?? today
      const to   = minDate(custom?.to ?? today, today)
      const span = istDateRange(from, to).length
      return {
        key, from, to,
        label: from === to ? from : `${from} → ${to}`,
        previous: { from: istAddDays(from, -span), to: istAddDays(from, -1) },
      }
    }
  }
}

function minDate(a: string, b: string): string {
  return a < b ? a : b
}

// ─── Request parameter handling ───────────────────────────────────────────────

/** Longest span a single request may ask for. Guards against 10-year sweeps. */
export const MAX_RANGE_DAYS = 366

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A real YYYY-MM-DD calendar date — rejects both bad format and 30 February. */
export function isValidBusinessDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const isRealDate = isValidBusinessDate

export const PERFORMANCE_PERIODS = ['today', 'daily', 'weekly', 'monthly'] as const
export type PerformancePeriod = typeof PERFORMANCE_PERIODS[number]

/** Narrow a caller-supplied period, falling back to the default. */
export function parsePeriod(value: string | null): PerformancePeriod | null {
  if (value === null) return 'daily'
  return (PERFORMANCE_PERIODS as readonly string[]).includes(value)
    ? value as PerformancePeriod
    : null
}

export type DateRangeResult =
  | { ok: true;  from: string; to: string }
  | { ok: false; error: string }

/**
 * Validate a caller-supplied from/to pair before it reaches any date arithmetic.
 * Unvalidated input reached istAddDays, where a non-date produced an Invalid
 * Date and threw inside toISOString, and a decade-wide span would have built
 * thousands of day buckets per request.
 */
export function parseDateRangeParams(from: string | null, to: string | null): DateRangeResult {
  if (!from || !to) return { ok: false, error: 'Both from and to are required' }
  if (!isRealDate(from)) return { ok: false, error: `Invalid from date: ${from}` }
  if (!isRealDate(to))   return { ok: false, error: `Invalid to date: ${to}` }
  if (from > to)         return { ok: false, error: 'from must not be after to' }

  const span = istDateRange(from, to).length
  if (span > MAX_RANGE_DAYS) {
    return { ok: false, error: `Range too large: ${span} days (max ${MAX_RANGE_DAYS})` }
  }
  return { ok: true, from, to }
}

/**
 * May this caller see the whole team's performance? Team Performance exposes
 * every employee's numbers, so it is management-only regardless of what the
 * page renders.
 */
export function canViewTeamPerformance(caller: { role: string }): boolean {
  return caller.role === 'admin' || caller.role === 'manager'
}

/** May this caller read performance data for the target user? */
export function canViewPerformanceOf(
  caller: { id: string; role: string },
  targetUserId: string,
): boolean {
  if (caller.id === targetUserId) return true
  return caller.role === 'admin' || caller.role === 'manager'
}
