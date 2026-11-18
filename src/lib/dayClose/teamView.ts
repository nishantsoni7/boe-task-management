// Team Today's "attention first" roster (owner, 2026-11-13): each person's punch and close states in
// words, and which group they fall in (Needs attention, On track, Away). Pure, so it is tested without a
// browser; the screen passes the minute of the IST day it is now.
//
// Nothing is red before it is due: "Not in yet" until 10:30 (or 30 minutes after a late arrival), "Closing
// open" from 6:00 pm and "Not closed" only after 6:30 pm. No morning plan and no strikes (owner, 2026-11-18).

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
  /** Where the person is today: In, Not in yet, No punch, No machine ID, Day off, On leave. */
  day: { tone: Tone; text: string }
  close: { tone: Tone; text: string } | null
  issues: string[]
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
    return { group: 'away', day: { tone: 'blue', text: 'On leave' }, close: null, issues: [] }
  }
  if (!ctx.workingDay) {
    return { group: 'on_track', day: { tone: 'grey', text: 'Day off' }, close: null, issues: row.overdueTasks > 0 ? [`${row.overdueTasks} overdue`] : [] }
  }

  // No morning plan any more (owner, 2026-11-18). The punch is expected by the old plan time (10:30, or 30
  // minutes after a late arrival); before then nothing is red.
  const expected = planDueMinutes(row.punch.checkInAt, ctx.date, ctx.planDue)
  const here = !!row.punch.checkInAt || !row.machineLinked
  const day: RosterStatus['day'] = row.punch.checkInAt
    ? { tone: 'green', text: 'In' }
    : !row.machineLinked ? { tone: 'grey', text: 'No machine ID' }
    : now < expected ? { tone: 'grey', text: 'Not in yet' }
    : { tone: 'red', text: 'No punch' }
  if (day.text === 'No punch') add('No punch')

  let close: RosterStatus['close'] = null
  const closedAt = row.plan?.closed_at ?? null
  if (closedAt) {
    const m = minuteOn(closedAt, ctx.date)
    close = { tone: 'green', text: m === null ? 'Closed' : `Closed ${clock(m)}` }
  } else if (here && now >= OFFICE_END_MINUTES) {
    close = { tone: 'red', text: 'Not closed' }
    add('Day not closed')
  } else if (here && now >= ctx.closeOpens) {
    close = { tone: 'grey', text: 'Closing open' }
  }

  if (row.overdueTasks > 0) add(`${row.overdueTasks} overdue`)

  return { group: issues.length ? 'attention' : 'on_track', day, close, issues }
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
