// THE MONTHLY REVIEW: the final standings, the suggested awards and the private-review flags (owner,
// 2026-11-12). Pure.
//
//   Star Performer   the highest final score
//   Star Seller      the highest confirmed sales (approved PIs before GST) in the month (owner: "the sales
//                    person with highest sales in last month")
//   Most Improved    the biggest rise on last month's final score, ending Steady (55) or better
//   Team Player      the most votes from colleagues
//   Never Late       everybody with every working day present and on time
//
// Nobody with fewer than 10 counted working days in the month can win (new joiners, long leave): they keep
// their score. Ties go alphabetically, and the owner confirms or changes every pick before anything is
// announced. Praise in public, correct in private: the lowest scorer and anybody in the Red zone get a private
// 1:1 with written goals; 2 Red months in a row is a written warning, 3 a role and salary review. A low score is
// never announced.

export type AwardKey = 'star_performer' | 'star_seller' | 'most_improved' | 'team_player' | 'never_late'

export const AWARDS: { key: AwardKey; label: string; rule: string; many: boolean }[] = [
  { key: 'star_performer', label: 'Star Performer', rule: 'Highest score of the month', many: false },
  { key: 'star_seller', label: 'Star Seller', rule: 'Highest confirmed sales of the month', many: false },
  { key: 'most_improved', label: 'Most Improved', rule: 'Biggest rise on last month, ending Steady or better', many: false },
  { key: 'team_player', label: 'Team Player', rule: 'Most votes from colleagues', many: false },
  { key: 'never_late', label: 'Never Late', rule: 'Every working day present and on time', many: true },
]

export const MIN_DAYS_FOR_AWARD = 10
export const IMPROVED_MIN_SCORE = 55

export type FinalPart = { key: string; max: number; earned: number | null; note: string }

export type FinalRow = {
  id: string
  name: string
  track: 'general' | 'sales'
  score: number | null
  parts: FinalPart[]
}

/** Working days counted for attendance, read from the record ("18 of 20 working days" → 20). */
export function countedDays(parts: FinalPart[]): number {
  const p = parts.find(x => x.key === 'present')
  const m = p?.note.match(/of (\d+) working days/)
  return m ? Number(m[1]) : 0
}

function full(parts: FinalPart[], key: string): boolean {
  const p = parts.find(x => x.key === key)
  return !!p && p.earned !== null && p.earned >= p.max - 0.001
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

export type Suggestions = Record<AwardKey, string[]>

export function suggestAwards(input: {
  rows: FinalRow[]
  previous: ReadonlyMap<string, number | null>
  sales: ReadonlyMap<string, number>
  votes: ReadonlyMap<string, number>
}): Suggestions {
  const eligible = input.rows.filter(r => r.score !== null && countedDays(r.parts) >= MIN_DAYS_FOR_AWARD)
  const top = <T,>(items: T[], value: (t: T) => number, name: (t: T) => string): T | null =>
    items.filter(i => value(i) > 0).sort((a, b) => value(b) - value(a) || name(a).localeCompare(name(b)))[0] ?? null

  const star = top(eligible, r => r.score as number, r => r.name)
  const seller = top(eligible, r => input.sales.get(r.id) ?? 0, r => r.name)
  const improved = top(
    eligible.filter(r => (r.score as number) >= IMPROVED_MIN_SCORE && typeof input.previous.get(r.id) === 'number'),
    r => (r.score as number) - (input.previous.get(r.id) as number),
    r => r.name,
  )
  const player = top(eligible, r => input.votes.get(r.id) ?? 0, r => r.name)
  const neverLate = eligible.filter(r => full(r.parts, 'present') && full(r.parts, 'punctual')).sort(byName)

  return {
    star_performer: star ? [star.id] : [],
    star_seller: seller ? [seller.id] : [],
    most_improved: improved ? [improved.id] : [],
    team_player: player ? [player.id] : [],
    never_late: neverLate.map(r => r.id),
  }
}

export type ReviewFlag = { reason: 'lowest' | 'red'; redStreak: number; step: 'one_to_one' | 'written_warning' | 'role_salary_review' }

/**
 * Who gets a private review this month, and what step it is. `history` is the person's final score in the
 * two months before, oldest first (null when unknown).
 */
export function reviewFlags(rows: FinalRow[], history: ReadonlyMap<string, (number | null)[]>): Map<string, ReviewFlag> {
  const scored = rows.filter(r => r.score !== null)
  const out = new Map<string, ReviewFlag>()
  if (scored.length === 0) return out
  const lowest = Math.min(...scored.map(r => r.score as number))
  for (const r of scored) {
    const red = (r.score as number) < 40
    if (!red && r.score !== lowest) continue
    let streak = red ? 1 : 0
    if (red) {
      const past = [...(history.get(r.id) ?? [])].reverse()
      for (const s of past) {
        if (typeof s === 'number' && s < 40) streak++
        else break
      }
    }
    out.set(r.id, {
      reason: red ? 'red' : 'lowest',
      redStreak: streak,
      step: streak >= 3 ? 'role_salary_review' : streak === 2 ? 'written_warning' : 'one_to_one',
    })
  }
  return out
}

export const STEP_LABEL: Record<ReviewFlag['step'], string> = {
  one_to_one: 'Private 1:1 and 3 written goals',
  written_warning: '2nd Red month in a row: written warning',
  role_salary_review: '3rd Red month in a row: role and salary review',
}

export type Goals = { goals: string[]; checkin_on: string; warning: boolean; note: string | null }

export function validateGoals(body: Record<string, unknown>, month: string): { ok: true; value: Goals } | { ok: false; error: string } {
  const goals = (Array.isArray(body.goals) ? body.goals : [])
    .filter((g): g is string => typeof g === 'string').map(g => g.trim()).filter(g => g.length > 0)
  if (goals.length < 1 || goals.length > 3) return { ok: false, error: 'Write one to three goals.' }
  if (goals.some(g => g.length < 3 || g.length > 200)) return { ok: false, error: 'Each goal is a short sentence (3 to 200 characters).' }
  const checkin = typeof body.checkin_on === 'string' ? body.checkin_on : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || checkin <= month) return { ok: false, error: 'Choose a check-in date after the month.' }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null
  return { ok: true, value: { goals, checkin_on: checkin, warning: body.warning === true, note } }
}

/** The WhatsApp announcement, ready to paste: winners only, never a low score. */
export function announcement(monthLabel: string, winners: { award: AwardKey; names: string[]; note?: string | null }[]): string {
  const icon: Record<AwardKey, string> = { star_performer: '🛡', star_seller: '★', most_improved: '📈', team_player: '🤝', never_late: '⏰' }
  const lines = [`🏆 BOE Champions of ${monthLabel} 🏆`, '']
  for (const a of AWARDS) {
    const w = winners.find(x => x.award === a.key)
    if (!w || w.names.length === 0) continue
    lines.push(`${icon[a.key]} ${a.label}: ${w.names.join(', ')}${w.note ? ` – ${w.note}` : ''}`)
  }
  lines.push('', 'Congratulations, and thank you all. See you at the award meeting!')
  return lines.join('\n')
}
