// The attendance score: one person's month as a single number, for the admin's
// Overview.
//
// Each working day earns points, and the score is the points earned out of the
// days counted. It is information only: it changes no pay and nothing stores it,
// so an old month restates itself when a correction or an approval is made later.
//
// This file does not decide what a day was. The payroll engine does that
// (attendanceScoreboard.ts asks it), so a day cannot read one way here and another
// on a payslip. This file says what each kind of day is worth and how a month is
// described. It is pure and free of the engine, so the screen can import it.

/** What a working day came to. */
export type ScoreDayKind = 'ok' | 'late' | 'early' | 'miss' | 'half' | 'absent' | 'leave'

/** What one block in a person's month can show. */
export type StripDayKind = ScoreDayKind | 'off' | 'not_employed' | 'pending' | 'unknown'

/** Points a day earns. Null means the day is left out of the score altogether. */
export const DAY_POINTS: Record<ScoreDayKind, number | null> = {
  ok:     1,
  late:   0.75,
  early:  0.75,
  miss:   0.75,
  half:   0.5,
  absent: 0,
  leave:  null,
}

export const GREAT_FROM = 95
export const OKAY_FROM = 85

/**
 * Fewer counted days than this is not a fair basis for a ranking, the same idea
 * as Performance's "Insufficient Data": a classification, not a low score.
 */
export const MIN_COUNTED_DAYS = 5

export type ScoreBand = 'great' | 'okay' | 'attention'

export function scoreBand(score: number): ScoreBand {
  if (score >= GREAT_FROM) return 'great'
  return score >= OKAY_FROM ? 'okay' : 'attention'
}

/** What an admin approved for a date. An approved day never counts against the person. */
export type ApprovedDay = {
  fullLeave: boolean
  halfLeave: boolean
  lateArrival: boolean
  earlyDeparture: boolean
}

export const NOTHING_APPROVED: ApprovedDay = {
  fullLeave: false, halfLeave: false, lateArrival: false, earlyDeparture: false,
}

/** What the engine said about a day, reduced to what the score needs. */
export type DaySignals = {
  classification: string
  late: boolean
  early: boolean
  missing: boolean
  approved: ApprovedDay
}

/**
 * The one thing wrong with a day, worst first. A day loses points once, however
 * many things were wrong with it, and a waived line never reaches this function:
 * the engine leaves it out.
 */
export function dayKind({ classification, late, early, missing, approved }: DaySignals): ScoreDayKind {
  // A person who came in and did a normal day on approved leave is scored on it.
  if (approved.fullLeave && classification !== 'full_present') return 'leave'
  if (approved.halfLeave && classification !== 'full_present' && classification !== 'full_absent') return 'leave'

  if (classification === 'full_absent') return 'absent'
  if (classification === 'half_day' || classification === 'short_present') return 'half'
  if (classification === 'missing_punch' && missing) return 'miss'
  if (late && !approved.lateArrival) return 'late'
  if (early && !approved.earlyDeparture) return 'early'
  return 'ok'
}

export type DayTally = Record<ScoreDayKind, number>

export function emptyTally(): DayTally {
  return { ok: 0, late: 0, early: 0, miss: 0, half: 0, absent: 0, leave: 0 }
}

export function countedDays(tally: DayTally): { counted: number; points: number } {
  let counted = 0
  let points = 0
  for (const kind of Object.keys(tally) as ScoreDayKind[]) {
    const worth = DAY_POINTS[kind]
    if (worth === null) continue
    counted += tally[kind]
    points += tally[kind] * worth
  }
  return { counted, points }
}

/** Points earned out of the days counted, or null when no day was counted. */
export function scoreOf(points: number, counted: number): number | null {
  return counted === 0 ? null : Math.round(points / counted * 100)
}

/** The middle arrival of the month, so one very late day does not move it. */
export function usualArrivalMinutes(arrivals: readonly number[]): number | null {
  if (arrivals.length === 0) return null
  const sorted = [...arrivals].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** Minutes past midnight as `10:38`. */
export function clockLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Built in UTC: a date-only value has one weekday. */
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/** Why someone is doing well, in a line. */
export function greatReason(tally: DayTally): string {
  const { counted } = countedDays(tally)
  const onTime = tally.ok === counted ? `On time on all ${counted} days` : `On time on ${tally.ok} of ${counted} days`
  return tally.leave > 0 ? `${onTime}, ${plural(tally.leave, 'approved leave', 'approved leaves')}` : onTime
}

/** Why someone needs attention, biggest cause first. */
export function attentionReason(input: {
  tally: DayTally
  absentDates: readonly string[]
  usualArrival: number | null
  delta: number | null
  previousMonthName: string
}): string {
  const { tally, absentDates, usualArrival, delta, previousMonthName } = input
  const { counted } = countedDays(tally)

  const days = absentDates.map(weekdayOf)
  const oneWeekday = days.length >= 2 && days.every(d => d === days[0])

  let lead: string
  if (oneWeekday) {
    lead = `All ${days.length} absent days were ${WEEKDAYS[days[0]]}s`
  } else if (tally.late * 2 >= counted && tally.late > 0) {
    lead = `Late on ${tally.late} of ${counted} days`
    if (usualArrival !== null) lead += `, usually in at ${clockLabel(usualArrival)}`
  } else {
    const causes: Array<[number, string]> = [
      [tally.absent * 1, plural(tally.absent, 'absent day', 'absent days')],
      [tally.half * 0.5, plural(tally.half, 'half day', 'half days')],
      [tally.late * 0.25, `${tally.late} late`],
      [tally.early * 0.25, `${tally.early} left early`],
      [tally.miss * 0.25, plural(tally.miss, 'missing punch', 'missing punches')],
    ]
    lead = causes.filter(c => c[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 2).map(c => c[1]).join(' and ')
  }

  const falling = delta !== null && delta <= -5
  const tail = falling ? `${plural(Math.abs(delta!), 'point', 'points')} down on ${previousMonthName}` : ''
  return [lead, tail].filter(Boolean).join(', ')
}

/** A small trend line. Gaps are months with no score, and the line skips them. */
export function sparkLine(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  low: number,
  high: number,
): { points: string; end: { x: number; y: number } | null } {
  const pad = 5
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0
  const placed: Array<{ x: number; y: number }> = []
  values.forEach((value, i) => {
    if (value === null) return
    const clamped = Math.min(high, Math.max(low, value))
    placed.push({
      x: Math.round((pad + i * step) * 10) / 10,
      y: Math.round((pad + (high - clamped) / (high - low) * (height - 2 * pad)) * 10) / 10,
    })
  })
  return {
    points: placed.map(p => `${p.x},${p.y}`).join(' '),
    end: placed[placed.length - 1] ?? null,
  }
}

// ─── What the Overview receives ───────────────────────────────────────────────

export type StripDay = { date: string; kind: StripDayKind }

export type OverviewPerson = {
  id: string
  name: string
  code: string | null
  strip: StripDay[]
  tally: DayTally
  counted: number
  score: number | null
  band: ScoreBand | null
  rank: number | null
  /** Why there is no score, in a line. Null for anyone ranked. */
  notRanked: string | null
  /** The line shown in Doing great or Needs attention. */
  reason: string
  usualArrival: string | null
  /** One score per month in `months`, oldest first. The last is this month. */
  history: Array<number | null>
  /** Change from the month before, when both have a score. */
  delta: number | null
}

export type OverviewTotal = { total: number; people: number; top: { name: string; count: number } | null }

export type OverviewData = {
  year: number
  month: number
  /** The last date this answer speaks for, or null when the month has no data. */
  coverageThrough: string | null
  /** Working days of the month counted so far, company calendar. */
  workingDaysCounted: number
  /** The six months of `history`, oldest first. */
  months: Array<{ year: number; month: number }>
  company: { score: number | null; history: Array<number | null>; delta: number | null }
  totals: { late: OverviewTotal; absent: OverviewTotal; miss: OverviewTotal }
  /** Ranked people, best first, then anyone who could not be ranked. */
  people: OverviewPerson[]
  pendingRequests: number
  noMachineId: number
  /** Set when no month was asked for and the current one has too little to rank. */
  fellBackFrom: { year: number; month: number } | null
}
