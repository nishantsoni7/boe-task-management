// Fair ranking — who collected the most leads, per day and overall.
//
// The numbers come from exhibition_lead_ranking() already counted by the
// IMMUTABLE collector, in Asia/Kolkata days, over active leads inside the
// exhibition's own dates. This file only decides who leads and what to call it.

export type RankingRow = {
  user_id: string
  name: string
  per_day: Record<string, number>
  total: number
}

export type RankingData = {
  exhibition: { id: string; name: string; starts_on: string; ends_on: string }
  today: string
  is_final: boolean
  days: string[]
  rows: RankingRow[]
}

export type Leaders = { names: string[]; count: number }

/**
 * Everyone tied on the highest count, or null when nobody has collected
 * anything — an all-zero day has no leader, not an arbitrary one.
 */
export function leadersOf(rows: readonly RankingRow[], countOf: (row: RankingRow) => number): Leaders | null {
  let best = 0
  for (const r of rows) best = Math.max(best, countOf(r))
  if (best <= 0) return null
  return { names: rows.filter(r => countOf(r) === best).map(r => r.name), count: best }
}

export function summariseRanking(data: RankingData) {
  const perDay = Object.fromEntries(
    data.days.map(d => [d, leadersOf(data.rows, r => r.per_day[d] ?? 0)]),
  ) as Record<string, Leaders | null>
  const overall = leadersOf(data.rows, r => r.total)
  return {
    perDay,
    overall,
    // After the last exhibition day has ended in India time the leader is final.
    overallLabel: data.is_final ? 'Fair leader' : 'Leader so far',
  }
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}
