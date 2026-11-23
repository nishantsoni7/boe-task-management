import type { BriefCase } from './sixMonth'

// What happened to each search in the brief's rankings, counted the same way everywhere on the page so the summary,
// the category headings and the table's "Since" column can never disagree. Pure, so it is tested without a screen.

type Row = BriefCase['quarters']['rows'][number]

/** A position from fewer showings than this moves by chance, so it is left out of every comparison. */
export const FEW_SHOWINGS = 20

export type Move = 'up' | 'same' | 'down' | 'out' | 'new' | 'thin'
export const MOVES: readonly Move[] = ['up', 'same', 'down', 'out', 'new', 'thin']
export type Tally = Record<Move, number> & { total: number; avgDown: number | null; avgUp: number | null }

const firm = (row: Row, i: number) => (row.values[i] !== null && (row.shown?.[i] ?? FEW_SHOWINGS) >= FEW_SHOWINGS ? row.values[i] : null)

/**
 * One search: the first column against its newest firm reading in the last two columns ("now"). A first reading that
 * was firm with none since is `out` (Google stopped showing it), not a blank: a drop to nothing is a fall.
 * Under 2 places either way is `same`. `places` is positive when the position got worse.
 */
export function moveOf(row: Row): { move: Move; places: number | null } {
  const first = firm(row, 0)
  let now: number | null = null
  for (let i = row.values.length - 1; i >= Math.max(1, row.values.length - 2) && now === null; i--) now = firm(row, i)
  if (first === null) return { move: now === null ? 'thin' : 'new', places: null }
  if (now === null) return { move: 'out', places: null }
  const places = now - first
  return { move: Math.abs(places) < 2 ? 'same' : places > 0 ? 'down' : 'up', places }
}

/** How far a search moved, or null when it did not have two firm readings to compare. */
export function positionChange(row: Row): number | null {
  return moveOf(row).places
}

export function tally(rows: Row[]): Tally {
  const t: Tally = { up: 0, same: 0, down: 0, out: 0, new: 0, thin: 0, total: rows.length, avgDown: null, avgUp: null }
  let down = 0
  let up = 0
  for (const row of rows) {
    const { move, places } = moveOf(row)
    t[move]++
    if (move === 'down') down += places as number
    if (move === 'up') up -= places as number
  }
  if (t.down) t.avgDown = down / t.down
  if (t.up) t.avgUp = up / t.up
  return t
}

/** One tally per category, in the order the categories first appear. Searches with no category are left out. */
export function tallyByGroup(rows: Row[]): { group: string; tally: Tally }[] {
  const groups = [...new Set(rows.flatMap(row => (row.group ? [row.group] : [])))]
  return groups.map(group => ({ group, tally: tally(rows.filter(row => row.group === group)) }))
}

/** "40 fell or dropped out" as a whole percentage of all searches, or 0 for none. */
export const share = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0)
