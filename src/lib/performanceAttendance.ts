/**
 * Attendance → Performance integration contract.
 *
 * Performance currently decides "was this person expected to work today?" from a
 * calendar alone: rollout date, Sunday weekly off, payroll_holidays, joining and
 * exit boundaries. That is all the data that exists today, and it has one obvious
 * gap — a day taken as **approved leave** is indistinguishable from a day someone
 * simply did not work.
 *
 * This file defines the shape of the answer so that when Attendance can supply
 * it, the calendar consumes it without being redesigned. It deliberately builds
 * nothing: there is no attendance-machine API call here, no polling, no import.
 *
 * WHAT EXISTS TODAY (verified against the live database, 2026-07-30)
 *
 *   attendance_records   413 rows, 2026-05-01 → 2026-06-30. Real check_in_at
 *                        timestamps from the fingerprint machine import.
 *                        status is CHECK-constrained (migration 20260635) to
 *                        present | checked_in | absent | half_day. In the live
 *                        data only 'present' and 'checked_in' actually occur.
 *                        Coverage stops at 30 June — there is no July data — so
 *                        it cannot describe the current reporting period.
 *   payroll_holidays     0 rows. See holidayCalendarCoverage in
 *                        performanceCalendar.ts.
 *   attendance_holidays  0 rows, referenced by no application code. A legacy
 *                        table; payroll_holidays is the one the admin Holidays
 *                        screen writes to (src/app/api/attendance/holidays).
 *
 * WHAT DOES NOT EXIST
 *
 *   No leave-request table. No leave-approval table. No approver, no approval
 *   timestamp, no leave type. `payroll_generation.days_on_leave` is a computed
 *   monthly total, so it cannot name a date.
 *
 * Therefore APPROVED LEAVE CANNOT BE HONOURED YET, and it is not inferred.
 * Inferring leave from absence — no login, no EOD, no task activity,
 * status = 'absent' — would hand every employee a way to delete a bad day by not
 * showing up. A day stays an expected working day until a reliable *approved*
 * source says otherwise.
 *
 * This is why the ranking must not be described as payroll-ready.
 */

/**
 * What a day was, for one employee.
 *
 * `unknown` is a real, required member. A provider that has no record for a date
 * must say `unknown` rather than guessing `present` or `absent` — a silent guess
 * is exactly the failure this contract exists to prevent.
 */
export type DayAttendanceState =
  | 'present'
  | 'approved_leave'
  | 'weekly_off'
  | 'company_holiday'
  | 'official_duty'
  | 'half_day'
  | 'absent'
  | 'unknown'

export const DAY_ATTENDANCE_STATES: readonly DayAttendanceState[] = [
  'present', 'approved_leave', 'weekly_off', 'company_holiday',
  'official_duty', 'half_day', 'absent', 'unknown',
] as const

/** One employee, one date. */
export type DayAttendance = {
  userId: string
  /** IST business date, YYYY-MM-DD. */
  date:   string
  state:  DayAttendanceState
  /** First check-in, when the source records one. Used only by System Adoption. */
  checkInAt: string | null
  /** Where this came from, for the evidence trail — e.g. 'fingerprint_import'. */
  source: string
}

/**
 * How Performance treats each state.
 *
 *   eligible          Counts as an expected working day, so it lands in the
 *                     denominator of the average and of the active-day rate.
 *   neutral           Removed from expectation entirely. Not a missed day, not a
 *                     zero, not an absence. Invisible to the score either way.
 *   expectation       How much output the day is expected to carry. 'half' exists
 *                     for half days; see HALF_DAY_SUPPORT below for what is and
 *                     is not implemented.
 *   measureLoginTiming  Whether the System Adoption start-window check applies.
 *                     Off for official duty: someone at a client site or a
 *                     factory visit has a legitimate reason not to open Task
 *                     Management at 10am, and penalising that would teach people
 *                     to stop recording offsite work.
 *   attendanceConcern Surface as an attendance finding rather than inventing a
 *                     task-performance conclusion.
 *
 * A state is never both eligible and neutral.
 */
export type AttendanceTreatment = {
  eligible:          boolean
  neutral:           boolean
  expectation:       'full' | 'half' | 'none'
  measureLoginTiming: boolean
  attendanceConcern: boolean
  label:             string
}

export const ATTENDANCE_TREATMENT: Record<DayAttendanceState, AttendanceTreatment> = {
  present: {
    eligible: true, neutral: false, expectation: 'full',
    measureLoginTiming: true, attendanceConcern: false,
    label: 'Present',
  },
  approved_leave: {
    // Neutral: an approved day off is not a performance event in either direction.
    eligible: false, neutral: true, expectation: 'none',
    measureLoginTiming: false, attendanceConcern: false,
    label: 'Approved leave',
  },
  weekly_off: {
    eligible: false, neutral: true, expectation: 'none',
    measureLoginTiming: false, attendanceConcern: false,
    label: 'Weekly off',
  },
  company_holiday: {
    eligible: false, neutral: true, expectation: 'none',
    measureLoginTiming: false, attendanceConcern: false,
    label: 'Company holiday',
  },
  official_duty: {
    // Eligible — work was expected and delivery still counts — but the person was
    // not at a desk, so the app-open window is not held against them.
    eligible: true, neutral: false, expectation: 'full',
    measureLoginTiming: false, attendanceConcern: false,
    label: 'Official duty / offsite',
  },
  half_day: {
    eligible: true, neutral: false, expectation: 'half',
    measureLoginTiming: true, attendanceConcern: false,
    label: 'Half day',
  },
  absent: {
    // Counted as an expected working day, because that is what it was. Flagged as
    // an attendance concern rather than converted into a task score: being absent
    // is an attendance fact, and fabricating output for the day — in either
    // direction — would be inventing data.
    eligible: true, neutral: false, expectation: 'full',
    measureLoginTiming: false, attendanceConcern: true,
    label: 'Absent (no approved leave)',
  },
  unknown: {
    // No record. Treated as expected, which is the pre-integration behaviour, and
    // marked so the page can say the day is unverified instead of implying it was
    // checked.
    eligible: true, neutral: false, expectation: 'full',
    measureLoginTiming: false, attendanceConcern: false,
    label: 'Not recorded',
  },
}

/**
 * Half-day expectation is **declared, not implemented**.
 *
 * `expectation: 'half'` is carried through the contract, but no scoring path
 * currently scales a day's expected output by it: the four pillar weights are a
 * whole-day formula, and halving them is a score-formula change, which this task
 * does not touch. A half day therefore behaves exactly like a full day today.
 *
 * Stated here rather than left as a surprise, because a half day that silently
 * scores as a full day is a defect the moment attendance data arrives.
 */
export const HALF_DAY_SUPPORT = {
  declared:    true,
  implemented: false,
  note: 'Half days are carried in the contract as expectation="half" but are '
      + 'scored as full days. Scaling a day\'s expected output is a score-formula '
      + 'change and is out of scope here.',
} as const

/**
 * The interface Attendance will implement.
 *
 * One bulk call for a whole team over a whole range — never per employee per day,
 * which is how the previous version of the Performance endpoint reached 120
 * queries per request.
 */
export interface AttendanceProvider {
  /** Human-readable source name, shown in the evidence trail. */
  readonly name: string
  /**
   * Attendance for every employee/date pair the caller can supply.
   * Keys are `${userId}|${date}`. A missing key means `unknown` — providers are
   * not required to emit a row for every date.
   */
  statesFor(
    userIds: readonly string[],
    from: string,
    to: string,
  ): Promise<ReadonlyMap<string, DayAttendance>>
}

export function attendanceKey(userId: string, date: string): string {
  return `${userId}|${date}`
}

/**
 * The provider in use today: none.
 *
 * Wired deliberately rather than left as a null check, so the absence is a
 * visible, testable value and the page can say *why* leave is not honoured.
 */
export const NO_ATTENDANCE_PROVIDER: AttendanceProvider = {
  name: 'none',
  async statesFor() { return new Map() },
}

/**
 * What the page must tell the owner while no provider is wired. Rendered in the
 * ranking-information panel; not an internal comment.
 */
export const ATTENDANCE_LIMITATION_NOTE =
  'Approved leave is not yet available. No leave-request or leave-approval table '
  + 'exists, so a day taken as approved leave still counts as an expected working '
  + 'day and scores zero. Leave is never inferred from absence. Treat rankings as '
  + 'a management view, not a payroll-ready measurement.'

/**
 * Split provider output into the two sets the calendar needs.
 *
 *   neutralDates      dates to remove from expectation altogether
 *   concernDates      dates the employee was absent without approved leave
 *   unverifiedDates   dates the provider had no record for, among those asked about
 *
 * With no provider wired every set is empty and the calendar behaves exactly as
 * it does today — which is what makes this safe to land before Attendance exists.
 */
export function splitAttendanceStates(
  userId: string,
  dates: readonly string[],
  states: ReadonlyMap<string, DayAttendance>,
): { neutralDates: Set<string>; concernDates: Set<string>; unverifiedDates: Set<string> } {
  const neutralDates    = new Set<string>()
  const concernDates    = new Set<string>()
  const unverifiedDates = new Set<string>()

  for (const date of dates) {
    const entry = states.get(attendanceKey(userId, date))
    if (!entry) continue           // no record at all — not asserted either way
    const treatment = ATTENDANCE_TREATMENT[entry.state]
    if (treatment.neutral)           neutralDates.add(date)
    if (treatment.attendanceConcern) concernDates.add(date)
    if (entry.state === 'unknown')   unverifiedDates.add(date)
  }

  return { neutralDates, concernDates, unverifiedDates }
}

/**
 * Where the adoption comparison is heading once check-in data is live:
 *
 *     first Task Management open   versus   attendance check-in
 *                                           (or the configured workday start)
 *
 * Today only the second half exists, so the start window is compared against the
 * employee's configured shift. See performanceAdoption.ts.
 */
export const ADOPTION_COMPARISON_TARGET = 'workday_start' as const
