// Where a salesperson stands — the numbers and sentences behind the scoreboard
// on the Add Lead screen.
//
// The rows come from exhibition_lead_standings(): name, today, total, position
// and an is_me flag, already counted like the Admin ranking (immutable
// collector, India days, active leads inside the exhibition's dates). This file
// only re-ranks after a local change and decides what to say. No I/O.

export type StandingRow = {
  name: string
  total: number
  today: number
  /** 1-based, ties share a position; null while the person has no leads. */
  rank: number | null
  is_me: boolean
}

export type Standings = {
  exhibition_id: string
  today: string
  is_final: boolean
  participants: number
  rows: StandingRow[]
  /** Set when the board is not available and only my own counts are known. */
  degraded?: true
}

/** Highest total first, then name; positions 1, 2, 2, 4 …; nobody with 0 leads has one. */
export function rankRows(rows: readonly StandingRow[]): StandingRow[] {
  const sorted = [...rows].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return sorted.map(r => ({
    ...r,
    rank: r.total > 0 ? 1 + sorted.filter(o => o.total > r.total).length : null,
  }))
}

/**
 * The board with `delta` leads added to the signed-in person, re-ranked. Used
 * for leads that are saving right now, so the numbers move the moment Save is
 * tapped instead of after the round trip.
 */
export function withMyDelta(data: Standings | undefined, delta: number): Standings | undefined {
  if (!data || delta === 0) return data
  if (!data.rows.some(r => r.is_me)) return data
  const rows = rankRows(data.rows.map(r => (r.is_me
    ? { ...r, total: Math.max(0, r.total + delta), today: Math.max(0, r.today + delta) }
    : r)))
  return { ...data, rows }
}

export type Summary = {
  me: StandingRow | null
  /** Everyone tied on the highest total, or [] while nobody has a lead. */
  leaders: StandingRow[]
  /** Leads still needed to draw level with the leader (0 when leading). */
  gapToLeader: number
  /** The nearest person ahead of me, and how many leads it takes to draw level. */
  next: { name: string; gap: number } | null
  topToday: { names: string[]; count: number } | null
  /** One short sentence for the rank tile. */
  headline: string
}

export function summarise(data: Standings | undefined): Summary {
  const rows = data?.rows ?? []
  const me = rows.find(r => r.is_me) ?? null
  const best = rows.reduce((m, r) => Math.max(m, r.total), 0)
  const leaders = best > 0 ? rows.filter(r => r.total === best) : []

  const bestToday = rows.reduce((m, r) => Math.max(m, r.today), 0)
  const topToday = bestToday > 0
    ? { names: rows.filter(r => r.today === bestToday).map(r => r.name), count: bestToday }
    : null

  let gapToLeader = 0
  let next: Summary['next'] = null
  if (me && best > me.total) {
    gapToLeader = best - me.total
    const ahead = rows.filter(r => r.total > me.total)
    const nearest = ahead.reduce((m, r) => Math.min(m, r.total), Infinity)
    const who = ahead.find(r => r.total === nearest)
    if (who) next = { name: who.name, gap: nearest - me.total }
  }

  let headline: string
  if (!data) headline = ''
  else if (!me) headline = leaders.length ? `${joinNames(leaders.map(l => l.name))} leads` : 'No leads yet'
  else if (me.total === 0) headline = best > 0 ? 'Add a lead to join the board' : 'Be the first on the board'
  else if (leaders.some(l => l.is_me)) {
    const second = rows.filter(r => r.total < me.total).reduce((m, r) => Math.max(m, r.total), 0)
    headline = leaders.length > 1 ? 'Joint first' : second > 0 ? `Leading by ${me.total - second}` : 'You are leading'
  } else if (next) {
    headline = `${next.gap} more to pass ${next.name}`
  } else headline = ''

  return { me, leaders, gapToLeader, next, topToday, headline }
}

export type BoardRow = StandingRow & { gapBefore: boolean }

/**
 * The rows to show: the top few, plus the signed-in person when they are
 * further down (with a marker that rows were skipped). `all` shows everyone.
 */
export function boardRows(rows: readonly StandingRow[], limit: number, all: boolean): BoardRow[] {
  if (all || rows.length <= limit) return rows.map(r => ({ ...r, gapBefore: false }))
  const top = rows.slice(0, limit).map(r => ({ ...r, gapBefore: false }))
  const meIndex = rows.findIndex(r => r.is_me)
  if (meIndex < limit) return top
  const skipped = meIndex > limit
  return [...top, { ...rows[meIndex], gapBefore: skipped }]
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

/** '1st', '2nd', '3rd', '4th', '11th', '22nd' … */
export function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** Day N of M of the exhibition, or null outside its dates. */
export function exhibitionDay(
  e: { starts_on: string; ends_on: string }, today: string,
): { day: number; of: number } | null {
  if (today < e.starts_on || today > e.ends_on) return null
  const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
  const DAY = 86_400_000
  return { day: Math.round((ms(today) - ms(e.starts_on)) / DAY) + 1, of: Math.round((ms(e.ends_on) - ms(e.starts_on)) / DAY) + 1 }
}
