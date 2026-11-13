// THE BOE SCOREBOARD: the score, pure (owner, 2026-11-12).
//
// One score out of 100 a month. Six parts; only Results differs between the two tracks:
//
//   Results 40     general: tasks handed in on or before their due date, weighted by priority (30) and the
//                  monthly role target (10)
//                  sales:   confirmed sales against the monthly target (25) and new leads called the same day (15)
//   Attendance 20  present on working days (10), punched in by the grace time (10)
//   Discipline 20  Day Close: plan on time (7.5) and day closed before leaving (7.5); leave asked before the
//                  shift, not on the day (5)
//   Team 10        the monthly vote: up to 8 for votes received (3 or more is full), 2 for casting your own
//                  three. Counted once the vote has closed (the month's last day, in the final record)
//   Owner 5        the owner's 1-5 rating, worth its number of points, counted from when it is given
//   Loyalty 5      1 point per completed year, up to 5
//
// MONTH-TO-DATE, POINTS EARNED OUT OF POINTS POSSIBLE SO FAR. A part with nothing to judge yet (no task due,
// no target set, not switched on for Day Close, no vote yet) is left out of both, so the 5th and the 25th mean
// the same thing and nobody is marked down for what does not apply to them. Targets are paced: halfway through
// the month's working days, half the target is full marks.
//
// FAIR BY RULE: approved full-day leave and holidays are never a zero (they leave the count); a day still in
// progress counts only once it has a punch; waived strikes do not count. Nothing here reads a clock or a
// database: the server passes the facts (src/lib/scoreboard/server.ts).

export type Track = 'general' | 'sales'

export type PartKey =
  | 'tasks_on_time' | 'role_target' | 'sales_value' | 'lead_work'
  | 'present' | 'punctual' | 'plan_on_time' | 'closed_before_leaving' | 'informed_leave'
  | 'team_vote' | 'owner_rating' | 'loyalty'

export type Pillar = 'results' | 'attendance' | 'discipline' | 'team' | 'owner' | 'loyalty'

export const PART_INFO: Record<PartKey, { pillar: Pillar; max: number; label: string }> = {
  tasks_on_time:         { pillar: 'results',    max: 30,  label: 'Tasks done on time' },
  role_target:           { pillar: 'results',    max: 10,  label: 'Role target' },
  sales_value:           { pillar: 'results',    max: 25,  label: 'Sales against target' },
  lead_work:             { pillar: 'results',    max: 15,  label: 'New leads called the same day' },
  present:               { pillar: 'attendance', max: 10,  label: 'Present on working days' },
  punctual:              { pillar: 'attendance', max: 10,  label: 'On time' },
  plan_on_time:          { pillar: 'discipline', max: 7.5, label: 'Plan filed on time' },
  closed_before_leaving: { pillar: 'discipline', max: 7.5, label: 'Day closed before leaving' },
  informed_leave:        { pillar: 'discipline', max: 5,   label: 'Leave asked in advance' },
  team_vote:             { pillar: 'team',       max: 10,  label: 'Team vote' },
  owner_rating:          { pillar: 'owner',      max: 5,   label: 'Owner’s rating' },
  loyalty:               { pillar: 'loyalty',    max: 5,   label: 'Years with BOE' },
}

export const PILLAR_LABEL: Record<Pillar, string> = {
  results: 'Results', attendance: 'Attendance & punctuality', discipline: 'Discipline',
  team: 'Team spirit', owner: 'Owner’s rating', loyalty: 'Loyalty',
}

export const PRIORITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 }

/** Below this many points possible there is too little to judge: no score, no rank. */
export const MIN_POSSIBLE = 20

export type Band = 'star' | 'strong' | 'steady' | 'watch' | 'red'
export const BAND_LABEL: Record<Band, string> = { star: 'Star', strong: 'Strong', steady: 'Steady', watch: 'Watch', red: 'Red zone' }

export function bandOf(score: number): Band {
  if (score >= 85) return 'star'
  if (score >= 70) return 'strong'
  if (score >= 55) return 'steady'
  if (score >= 40) return 'watch'
  return 'red'
}

export type ScoreTask = {
  priority: string | null
  due_date: string
  /** When it was first submitted or completed (UTC instant), or null. */
  handed_in_at: string | null
}

export type ScoreLead = { assigned_at: string; first_attempt_at: string | null }

export type ScoreFacts = {
  track: Track
  /** The date scored (IST). */
  date: string
  /** True once the day is over (the nightly run); false for a live score during the day. */
  dayComplete: boolean
  /** Working dates of the month up to and including `date`, from the person's first counted day. */
  workingDates: string[]
  /** All working dates of the month (for pacing targets). */
  monthWorkingDates: string[]
  leaveDates: ReadonlySet<string>
  /** First punch of each date, minutes after IST midnight. Present = has an entry. */
  arrivals: ReadonlyMap<string, number | null>
  graceEndMinutes: number
  tasks: ScoreTask[]
  role: { target: number; actual: number; label: string } | null
  sales: { target: number; value: number } | null
  leads: ScoreLead[]
  /** Day Close: the date the person was switched on (IST), or null; strikes not waived, by date. */
  dayClose: { since: string | null; planStrikeDates: ReadonlySet<string>; closeStrikeDates: ReadonlySet<string> }
  /** Leave and lateness requests this month: was each one asked before the shift? */
  requestsInformed: boolean[]
  /** Completed years with BOE, or null when the joining date is unknown. */
  years: number | null
  /** The month's vote, once it has closed; null before that. */
  vote: { received: number; voted: boolean } | null
  /** The owner's rating for the month, once given. */
  rating: { value: number; reason: string } | null
}

export type Part = { key: PartKey; pillar: Pillar; label: string; max: number; earned: number | null; note: string }

export type ScoreResult = {
  score: number | null
  band: Band | null
  earned: number
  possible: number
  parts: Part[]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function part(key: PartKey, ratio: number | null, note: string): Part {
  const info = PART_INFO[key]
  return { key, pillar: info.pillar, label: info.label, max: info.max, earned: ratio === null ? null : round2(info.max * clamp01(ratio)), note }
}

/** The end of an IST date as a UTC instant. */
function endOfIstDate(date: string): number {
  return Date.parse(`${date}T23:59:59.999+05:30`)
}

function istDateOfInstant(instant: string): string {
  return new Date(Date.parse(instant) + 330 * 60_000).toISOString().slice(0, 10)
}

function istMinutesOfInstant(instant: string): number {
  const d = new Date(Date.parse(instant) + 330 * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** Share of the month's working days already gone (at least one day). */
function pace(f: ScoreFacts): number {
  const total = f.monthWorkingDates.length
  if (total === 0) return 1
  const gone = f.monthWorkingDates.filter(d => d < f.date || (d === f.date && f.dayComplete)).length
  return Math.max(1, gone) / total
}

/** Votes needed for full marks on the votes-received share. */
export const VOTES_FOR_FULL = 3

/** 8 of the 10 for votes received (3 or more is full), 2 for casting your own. */
export function voteRatio(v: { received: number; voted: boolean }): number {
  return (8 * Math.min(1, v.received / VOTES_FOR_FULL) + (v.voted ? 2 : 0)) / 10
}

export function computeScore(f: ScoreFacts): ScoreResult {
  const parts: Part[] = []

  // ── Results ──
  if (f.track === 'general') {
    // Due before today, or due today and already handed in; cancelled tasks never reach here.
    const judged = f.tasks.filter(t => t.due_date < f.date || (t.due_date === f.date && (f.dayComplete || t.handed_in_at)))
    let total = 0, onTime = 0
    for (const t of judged) {
      const w = PRIORITY_WEIGHT[t.priority ?? 'medium'] ?? 2
      total += w
      if (t.handed_in_at && Date.parse(t.handed_in_at) <= endOfIstDate(t.due_date)) onTime += w
    }
    parts.push(part('tasks_on_time', total ? onTime / total : null,
      total ? `${judged.filter(t => t.handed_in_at && Date.parse(t.handed_in_at) <= endOfIstDate(t.due_date)).length} of ${judged.length} tasks on time` : 'No task due yet this month'))
    parts.push(part('role_target', f.role ? f.role.actual / (f.role.target * pace(f)) : null,
      f.role ? `${f.role.actual} of ${f.role.target} ${f.role.label}` : 'Not set for this month'))
  } else {
    parts.push(part('sales_value', f.sales ? f.sales.value / (f.sales.target * pace(f)) : null,
      f.sales ? `₹${Math.round(f.sales.value).toLocaleString('en-IN')} of ₹${Math.round(f.sales.target).toLocaleString('en-IN')}` : 'Target not set for this month'))
    // A lead given after 17:30 may be called the next day.
    let judged = 0, sameDay = 0
    for (const l of f.leads) {
      const givenDate = istDateOfInstant(l.assigned_at)
      const late = istMinutesOfInstant(l.assigned_at) >= 17 * 60 + 30
      const deadline = late ? f.workingDates.find(d => d > givenDate) ?? null : givenDate
      if (!deadline) continue
      if (deadline > f.date || (deadline === f.date && !f.dayComplete && !l.first_attempt_at)) continue
      judged++
      if (l.first_attempt_at && Date.parse(l.first_attempt_at) <= endOfIstDate(deadline)) sameDay++
    }
    parts.push(part('lead_work', judged ? sameDay / judged : null, judged ? `${sameDay} of ${judged} new leads called in time` : 'No new lead yet this month'))
  }

  // ── Attendance & punctuality ── (a day still in progress counts only once there is a punch)
  const counted = f.workingDates.filter(d => !f.leaveDates.has(d) && (d < f.date || f.dayComplete || f.arrivals.has(d)))
  const present = counted.filter(d => f.arrivals.has(d))
  parts.push(part('present', counted.length ? present.length / counted.length : null,
    counted.length ? `${present.length} of ${counted.length} working days` : 'No working day yet'))
  const withArrival = present.filter(d => f.arrivals.get(d) !== null && f.arrivals.get(d) !== undefined)
  const onTime = withArrival.filter(d => (f.arrivals.get(d) as number) <= f.graceEndMinutes)
  parts.push(part('punctual', withArrival.length ? onTime.length / withArrival.length : null,
    withArrival.length ? `${onTime.length} of ${withArrival.length} days on time` : 'No punch-in yet'))

  // ── Discipline ── (strikes are written at night: today counts once the day is over)
  const since = f.dayClose.since
  const dcDays = since ? present.filter(d => d >= since && (d < f.date || f.dayComplete)) : []
  const planMissed = dcDays.filter(d => f.dayClose.planStrikeDates.has(d)).length
  const closeMissed = dcDays.filter(d => f.dayClose.closeStrikeDates.has(d)).length
  parts.push(part('plan_on_time', dcDays.length ? 1 - planMissed / dcDays.length : null,
    dcDays.length ? `${dcDays.length - planMissed} of ${dcDays.length} days` : since ? 'Counts from your first full day' : 'Day Close not switched on'))
  parts.push(part('closed_before_leaving', dcDays.length ? 1 - closeMissed / dcDays.length : null,
    dcDays.length ? `${dcDays.length - closeMissed} of ${dcDays.length} days` : since ? 'Counts from your first full day' : 'Day Close not switched on'))
  const asked = f.requestsInformed.filter(Boolean).length
  parts.push(part('informed_leave', f.requestsInformed.length ? asked / f.requestsInformed.length : 1,
    f.requestsInformed.length ? `${asked} of ${f.requestsInformed.length} requests asked in advance` : 'No request this month'))

  // ── Team vote, owner's rating, loyalty ──
  parts.push(part('team_vote', f.vote ? voteRatio(f.vote) : null, f.vote
    ? `${f.vote.received} ${f.vote.received === 1 ? 'vote' : 'votes'} from colleagues${f.vote.voted ? '; you voted' : '; you did not vote'}`
    : 'The vote is held in the last 3 days of the month'))
  parts.push(part('owner_rating', f.rating ? f.rating.value / 5 : null,
    f.rating ? `${f.rating.value} of 5: ${f.rating.reason}` : 'Given at the end of the month'))
  parts.push(part('loyalty', f.years === null ? null : Math.min(5, Math.max(0, f.years)) / 5,
    f.years === null ? 'Joining date not recorded' : `${f.years} ${f.years === 1 ? 'year' : 'years'} with BOE`))

  const counting = parts.filter(p => p.earned !== null)
  const earned = round2(counting.reduce((s, p) => s + (p.earned as number), 0))
  const possible = round2(counting.reduce((s, p) => s + p.max, 0))
  const score = possible >= MIN_POSSIBLE ? Math.round((100 * earned) / possible) : null
  return { score, band: score === null ? null : bandOf(score), earned, possible, parts }
}

/** The pillars, summed from the parts that count. */
export function pillarTotals(parts: Part[]): { pillar: Pillar; label: string; earned: number; possible: number }[] {
  const order: Pillar[] = ['results', 'attendance', 'discipline', 'team', 'owner', 'loyalty']
  return order.map(p => {
    const mine = parts.filter(x => x.pillar === p && x.earned !== null)
    return {
      pillar: p,
      label: PILLAR_LABEL[p],
      earned: round2(mine.reduce((s, x) => s + (x.earned as number), 0)),
      possible: round2(mine.reduce((s, x) => s + x.max, 0)),
    }
  }).filter(p => p.possible > 0)
}

const TIP: Partial<Record<PartKey, string>> = {
  tasks_on_time: 'Hand in your tasks by their due date: overdue ones cost the most.',
  role_target: 'Push your role target: it is counted against the days gone this month.',
  sales_value: 'Close and get approved one more PI this week.',
  lead_work: 'Call every new lead the day you get it.',
  present: 'Every working day you come in counts.',
  punctual: 'Punch in before the grace time tomorrow.',
  plan_on_time: 'File tomorrow’s plan by 10:30.',
  closed_before_leaving: 'Close your day before you punch out.',
  informed_leave: 'Ask for leave before the shift, not on the day.',
}

/** The single part where the most points are being lost, as one plain sentence. */
export function fastestTip(parts: Part[]): string | null {
  const losing = parts
    .filter(p => p.earned !== null && TIP[p.key] && p.max - (p.earned as number) >= 0.5)
    .sort((a, b) => (b.max - (b.earned as number)) - (a.max - (a.earned as number)))
  return losing.length ? (TIP[losing[0].key] as string) : null
}
