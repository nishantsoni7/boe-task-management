// Team Today's "attention first" roster (owner, 2026-11-13): each person's plan, close and punch states in
// words, and which group they fall in (Needs attention, On track, Away). Pure, so it is tested without a
// browser; the screen passes the minute of the IST day it is now.
//
// A plan that is not yet due is never red: before 10:30 (or 30 minutes after a late arrival) the chip
// says "Plan due 10:30" in grey.

import { istDateOf, istMinutesOfDay } from '@/lib/istDate'
import { clock, planDueMinutes } from './rules'

export const OFFICE_START_MINUTES = 10 * 60
export const OFFICE_END_MINUTES = 18 * 60 + 30

export type Tone = 'red' | 'amber' | 'green' | 'grey' | 'blue'
export type Group = 'attention' | 'on_track' | 'away'

export type RosterInput = {
  name: string
  machineLinked: boolean
  onLeave: boolean
  punch: { checkInAt: string | null; checkOutAt: string | null }
  plan: { submitted_at: string | null; closed_at: string | null } | null
  overdueTasks: number
  strikes: { kind: string; status: string }[]
}

export type RosterContext = {
  date: string
  today: string
  /** The minute of the IST day now (only used when date is today). */
  nowMinutes: number
  workingDay: boolean
  planDue: number
  closeOpens: number
}

export type RosterStatus = {
  group: Group
  plan: { tone: Tone; text: string }
  close: { tone: Tone; text: string } | null
  issues: string[]
}

const STRIKE_WORDS: Record<string, string> = {
  no_plan: 'No plan',
  plan_late: 'Plan late',
  day_not_closed: 'Day not closed',
  closed_after_leaving: 'Closed after leaving',
}

function minuteOn(instant: string, date: string): number | null {
  return istDateOf(instant) === date ? istMinutesOfDay(instant) : null
}

export function rosterStatus(row: RosterInput, ctx: RosterContext): RosterStatus {
  const dayOver = ctx.date < ctx.today
  const now = dayOver ? 24 * 60 : ctx.nowMinutes
  const issues: string[] = []
  const add = (words: string) => { if (!issues.includes(words)) issues.push(words) }

  if (row.onLeave) {
    return { group: 'away', plan: { tone: 'blue', text: 'On leave' }, close: null, issues: [] }
  }

  const due = planDueMinutes(row.punch.checkInAt, ctx.date, ctx.planDue)
  let plan: RosterStatus['plan']
  const filedAt = row.plan?.submitted_at ?? null
  if (filedAt) {
    const m = minuteOn(filedAt, ctx.date)
    const late = m === null || m > due
    plan = late ? { tone: 'amber', text: `Plan ${clock(m ?? 0)} · late` } : { tone: 'green', text: `Plan ${clock(m)}` }
    if (late && ctx.workingDay) add('Plan late')
  } else if (!ctx.workingDay) {
    plan = { tone: 'grey', text: 'Day off' }
  } else if (now < due) {
    plan = { tone: 'grey', text: `Plan due ${clock(due)}` }
  } else {
    plan = { tone: 'red', text: 'No plan' }
    add('No plan')
  }

  let close: RosterStatus['close'] = null
  const closedAt = row.plan?.closed_at ?? null
  if (closedAt) {
    const m = minuteOn(closedAt, ctx.date)
    close = { tone: 'green', text: m === null ? 'Closed' : `Closed ${clock(m)}` }
  } else if (filedAt && ctx.workingDay && now >= OFFICE_END_MINUTES) {
    close = { tone: 'red', text: 'Not closed' }
    add('Day not closed')
  } else if (filedAt && ctx.workingDay && now >= ctx.closeOpens) {
    close = { tone: 'grey', text: 'Closing open' }
  }

  if (ctx.workingDay && row.machineLinked && !row.punch.checkInAt && now >= due) add('No punch')
  if (row.overdueTasks > 0) add(`${row.overdueTasks} overdue`)
  for (const s of row.strikes) {
    if (s.status !== 'waived') add(STRIKE_WORDS[s.kind] ?? s.kind)
  }

  return { group: issues.length ? 'attention' : 'on_track', plan, close, issues }
}

/** Needs attention first (most issues first), then on track, then away; by name within each. */
export function sortRoster<T extends { name: string; status: RosterStatus }>(rows: readonly T[]): T[] {
  const rank: Record<Group, number> = { attention: 0, on_track: 1, away: 2 }
  return [...rows].sort((a, b) =>
    rank[a.status.group] - rank[b.status.group]
    || (a.status.group === 'attention' ? b.status.issues.length - a.status.issues.length : 0)
    || a.name.localeCompare(b.name))
}

/** How far through the office day (10:00 to 6:30) "now" is, 0 to 1. */
export function dayProgress(nowMinutes: number): number {
  return Math.min(1, Math.max(0, (nowMinutes - OFFICE_START_MINUTES) / (OFFICE_END_MINUTES - OFFICE_START_MINUTES)))
}
