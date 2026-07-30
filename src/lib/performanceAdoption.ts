/**
 * System Adoption — is Task Management actually being opened, and when?
 *
 * The owner's question was whether employees open Task Management near the start
 * of the working day. Nothing in the schema could answer it, so a single minimal
 * event was added: `performance_app_opens`, one row per employee per IST business
 * date (migration 20260720000000).
 *
 * WHAT WAS REJECTED AS A LOGIN PROXY, AND WHY
 *
 *   EOD submission          Filed at the end of the day. Says nothing about when
 *                           the day started.
 *   First task created      Not everyone creates tasks, and someone can read the
 *                           board for an hour before touching anything.
 *   First task activity     Same problem: it is the first *action*, which can be
 *                           hours after the first open. Using it would report
 *                           people as late who were not.
 *   Open browser session    A tab left open overnight is not an open.
 *   last_sign_in_at         One value, overwritten. Cannot describe a past date,
 *                           and a long-lived session produces no new sign-in for
 *                           days.
 *
 * ADOPTION IS NOT PART OF THE OFFICIAL SCORE.
 *
 * It is reported beside the score, never inside it. Two reasons: the event only
 * starts existing from the day the migration lands, so folding it in would
 * retroactively punish every employee for history that was never recorded; and
 * "opened the app" is a proxy for engagement, not a measure of delivery. Adding
 * it to the score is a formula decision for the owner, not a side effect of
 * building the metric.
 */

import { istDateOf, istMinutesOfDay, formatMinutesOfDay } from '@/lib/istDate'

// ─── Workday start window ─────────────────────────────────────────────────────

/**
 * Shift start times, in minutes past midnight IST.
 *
 * These are the four values the employee configuration screen offers
 * (`OFFICE_TIMINGS` in src/app/attendance/employees/page.tsx), and the numbers
 * match the existing attendance parser in
 * src/app/api/attendance/employee-monthly-detail/route.ts — so Performance and
 * Attendance agree on when a shift starts rather than each inventing a value.
 */
export const SHIFT_START_MINUTES: Readonly<Record<string, number>> = {
  'General Shift': 10 * 60,      // 10:00 – 18:30
  'Factory Shift':  9 * 60,      // 09:00 – 18:00
  'Sales Shift':   10 * 60,      // 10:00 – 18:30
  'Half Day':      10 * 60,      // 10:00 – 13:30
}

/**
 * Fallback start time when an employee has no recognised `office_timing`.
 *
 * **Provisional.** There is no company-wide workday-start setting anywhere in the
 * schema, and inventing one silently is how a metric ends up marking people late
 * against a time nobody agreed. 10:00 is the start of General Shift, which is
 * what every configured employee in the database currently uses — but any
 * employee resolved through this fallback is flagged `provisional`, and the page
 * says so rather than presenting the classification as authoritative.
 */
export const PROVISIONAL_WORKDAY_START_MINUTES = 10 * 60

/**
 * Grace period after the shift start. An open inside start + grace counts as
 * within the window.
 *
 * Also provisional — no configured value exists. Kept generous on purpose: the
 * metric is meant to distinguish "opened the app as part of starting work" from
 * "did not open it until the afternoon", not to police five minutes.
 */
export const ADOPTION_GRACE_MINUTES = 30

export type WorkdayStart = {
  startMinutes: number
  graceMinutes: number
  /** Latest minute that still counts as within the window. */
  windowEndMinutes: number
  /** True when no configured shift produced this — the value is a documented default. */
  provisional: boolean
  /** Where it came from, for the evidence trail. */
  source: string
}

/**
 * Resolve an employee's expected start window from their configured shift.
 *
 * Accepts the named shifts first, then the free-text forms the column has held
 * historically ("9:00 AM", "09:30"), mirroring the attendance parser. Anything
 * unrecognised falls back to the provisional default and is marked as such.
 */
export function resolveWorkdayStart(
  officeTiming: string | null | undefined,
  graceMinutes: number = ADOPTION_GRACE_MINUTES,
): WorkdayStart {
  const build = (startMinutes: number, provisional: boolean, source: string): WorkdayStart => ({
    startMinutes,
    graceMinutes,
    windowEndMinutes: startMinutes + graceMinutes,
    provisional,
    source,
  })

  const raw = (officeTiming ?? '').trim()
  if (raw === '') {
    return build(PROVISIONAL_WORKDAY_START_MINUTES, true, 'no office_timing configured')
  }

  const named = SHIFT_START_MINUTES[raw]
  if (named !== undefined) return build(named, false, raw)

  const ampm = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i)
  if (ampm) {
    let h = parseInt(ampm[1], 10)
    const m = parseInt(ampm[2] ?? '0', 10)
    const meridiem = ampm[3].toUpperCase()
    if (meridiem === 'AM' && h === 12) h = 0
    if (meridiem === 'PM' && h !== 12) h += 12
    return build(h * 60 + m, false, raw)
  }

  const h24 = raw.match(/^(\d{1,2}):(\d{2})/)
  if (h24) return build(parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10), false, raw)

  return build(PROVISIONAL_WORKDAY_START_MINUTES, true, `unrecognised office_timing "${raw}"`)
}

// ─── First-open records ───────────────────────────────────────────────────────

/** One row of performance_app_opens. */
export type AppOpenRecord = {
  userId:       string
  businessDate: string
  firstOpenedAt: string
}

export type FirstOpenStatus = 'within_window' | 'late' | 'missing'

/**
 * Classify one expected working day.
 *
 * `missing` means no first-open row exists for that date. That is the honest
 * label: for every date before this metric was deployed there is no row, and
 * calling those days "late" would invent a finding. The page separates
 * "no recording yet" from "recorded and missed" using ADOPTION_RECORDING_FROM.
 */
export function classifyFirstOpen(
  firstOpenedAt: string | null,
  window: WorkdayStart,
): FirstOpenStatus {
  if (firstOpenedAt === null) return 'missing'
  return istMinutesOfDay(firstOpenedAt) <= window.windowEndMinutes ? 'within_window' : 'late'
}

/** Per-employee adoption result. Never folded into the score. */
export type AdoptionMetrics = {
  /** Eligible working days that could have carried a first open. */
  expectedDays:  number
  /** Of those, days with a recorded first open. */
  openedDays:    number
  withinWindowDays: number
  lateDays:      number
  /** Eligible days with no first-open record. */
  missingDays:   number
  /** Mean first-open time, in minutes past IST midnight. Null with no opens. */
  avgFirstOpenMinutes: number | null
  /** Consecutive most-recent eligible days with a recorded open. */
  streak:        number
  /** The window this employee was measured against. */
  window:        WorkdayStart
  /**
   * Eligible days that fall before any recording existed. These are counted in
   * `missingDays` but reported separately so the page never presents
   * pre-deployment history as a failure to open the app.
   */
  unrecordedDays: number
}

/**
 * The first business date for which absence of a row is meaningful.
 *
 * Before the recording endpoint existed, no row was written for anybody, so a
 * missing row proves nothing. This is read from the earliest row actually present
 * in the table rather than hardcoded to a deploy date — if the table is empty,
 * every day is unrecorded, and the page says exactly that instead of reporting
 * every employee as having never opened the app.
 */
export function adoptionRecordingFrom(records: readonly AppOpenRecord[]): string | null {
  let earliest: string | null = null
  for (const r of records) {
    if (earliest === null || r.businessDate < earliest) earliest = r.businessDate
  }
  return earliest
}

/**
 * Build one employee's adoption result.
 *
 * `eligibleDates` is the same working-day list the score uses, so adoption and
 * score describe the same days. Records for non-eligible dates (a Sunday open,
 * say) are ignored rather than credited — otherwise weekend keenness would offset
 * a weekday miss.
 */
export function computeAdoption(
  eligibleDates: readonly string[],
  records: readonly AppOpenRecord[],
  window: WorkdayStart,
  recordingFrom: string | null,
): AdoptionMetrics {
  const byDate = new Map<string, string>()
  for (const r of records) byDate.set(r.businessDate, r.firstOpenedAt)

  let openedDays = 0, withinWindowDays = 0, lateDays = 0, missingDays = 0, unrecordedDays = 0
  let minuteTotal = 0

  for (const date of eligibleDates) {
    const openedAt = byDate.get(date) ?? null
    const status = classifyFirstOpen(openedAt, window)

    if (status === 'missing') {
      missingDays++
      // `date <= recordingFrom`, not `<`: the first day recording existed was only
      // covered for part of itself — the endpoint went live partway through it — so
      // a missing row on that day proves nothing either. Counting it would accuse
      // the whole company of not opening the app on deployment day.
      if (recordingFrom === null || date <= recordingFrom) unrecordedDays++
      continue
    }

    openedDays++
    minuteTotal += istMinutesOfDay(openedAt!)
    if (status === 'within_window') withinWindowDays++
    else lateDays++
  }

  // Counted backwards from the most recent eligible day, so a streak describes
  // current behaviour rather than a good fortnight three weeks ago.
  let streak = 0
  for (let i = eligibleDates.length - 1; i >= 0; i--) {
    if (!byDate.has(eligibleDates[i])) break
    streak++
  }

  return {
    expectedDays: eligibleDates.length,
    openedDays, withinWindowDays, lateDays, missingDays,
    avgFirstOpenMinutes: openedDays > 0 ? Math.round(minuteTotal / openedDays) : null,
    streak,
    window,
    unrecordedDays,
  }
}

/**
 * Share of *recordable* eligible days that were opened, as a percentage.
 *
 * The denominator excludes days that predate recording. Null when there is
 * nothing recordable — which is not 0%, and must not display as 0%.
 */
export function adoptionRate(a: AdoptionMetrics): number | null {
  const recordable = a.expectedDays - a.unrecordedDays
  if (recordable <= 0) return null
  return Math.round(a.openedDays / recordable * 100)
}

/** Share of opened days that landed inside the start window. Null with no opens. */
export function withinWindowRate(a: AdoptionMetrics): number | null {
  if (a.openedDays === 0) return null
  return Math.round(a.withinWindowDays / a.openedDays * 100)
}

/** Average first-open time as a clock label, or null. */
export function avgFirstOpenLabel(a: AdoptionMetrics): string | null {
  return a.avgFirstOpenMinutes === null ? null : formatMinutesOfDay(a.avgFirstOpenMinutes)
}

/**
 * Does this employee have enough recorded adoption data to say anything?
 *
 * Used to suppress adoption conclusions rather than print a confident 0%.
 */
export function hasAdoptionData(a: AdoptionMetrics): boolean {
  return a.expectedDays - a.unrecordedDays > 0
}

/** Empty result, for an employee with no eligible days or when the table is unreadable. */
export function emptyAdoption(window: WorkdayStart): AdoptionMetrics {
  return {
    expectedDays: 0, openedDays: 0, withinWindowDays: 0, lateDays: 0,
    missingDays: 0, avgFirstOpenMinutes: null, streak: 0, window,
    unrecordedDays: 0,
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * The row to insert for a first open.
 *
 * `userId` must be the **real signed-in user**. While an admin is using View As,
 * the admin is browsing — recording the impersonated employee would manufacture
 * adoption history for someone who was not there, and would let an admin quietly
 * fix a subordinate's adoption record by viewing their account each morning. The
 * endpoint resolves the id from the bearer token for exactly this reason and
 * never accepts a user id from the request body.
 *
 * `businessDate` comes from the server clock in IST, never from the client.
 */
export function buildAppOpenRow(
  realUserId: string,
  route: string | null,
  now: Date = new Date(),
): { user_id: string; business_date: string; first_opened_at: string; first_route: string | null } {
  return {
    user_id:         realUserId,
    business_date:   istDateOf(now),
    first_opened_at: now.toISOString(),
    first_route:     route,
  }
}

/**
 * Paths that count as opening Task Management.
 *
 * Only the routes that actually exist: `/dashboard`, `/tasks/**` (my, assigned,
 * all, create, detail, quotation requests, cancelled, completed), `/manager` and
 * `/notifications`.
 *
 * Performance's own pages are excluded on purpose: a manager reading the Team
 * Performance report has not started their operational day, and counting it would
 * let checking the metric satisfy the metric. `/login` is excluded for the obvious
 * reason, and the other modules (`/finance`, `/orders`, `/attendance`, `/payroll`,
 * `/showroom*`, `/samples`, `/assets-access`, `/admin`, `/settings`, `/modules`)
 * are excluded because this metric is specifically about Task Management adoption.
 */
export function isTaskManagementRoute(pathname: string): boolean {
  return pathname === '/dashboard'
      || pathname.startsWith('/dashboard/')
      || pathname === '/tasks'
      || pathname.startsWith('/tasks/')
      || pathname === '/manager'
      || pathname === '/notifications'
}
