// Pricing > Training: Overhead % and Margin % of a case, as two boxes beside the running total (owner, 24 Nov 2026).
// They are not a new kind of data: each box is an ordinary percentage row (calc.ts `percent`, kind overhead / margin) kept
// OUT of the elements list on the screen and put back at the END of the rows when the case is worked out and saved. So a
// percentage "of the cost" counts every row that is not a percentage, and "of everything above" (margin on cost plus
// overhead) counts the elements, then the overhead. Nothing in the database or the estimator changes.
// Pure: no network, no React.

import { KINDS, KIND_LABEL, emptyLine, num, totals, workCase, type Kind, type Line } from './doc'
import type { Size } from './calc'
import { productType } from '@/lib/pricing/features'

export type BoxKind = 'overhead' | 'margin'
export const BOX_KINDS: readonly BoxKind[] = ['overhead', 'margin']
/** Each box is the row it saves as. A blank percentage means no row. */
export type Boxes = Record<BoxKind, Line>

const round2 = (n: number) => Math.round(n * 100) / 100
const boxLine = (kind: BoxKind): Line => ({ ...emptyLine(), element: KIND_LABEL[kind], kind, calc: { type: 'percent', pct: '', of: 'cost' } })
export const emptyBoxes = (): Boxes => ({ overhead: boxLine('overhead'), margin: boxLine('margin') })
/** A new case for a chair starts with 20% factory expense and 20% margin on the cost, what the owner has used for every chair (notes of 23 and 28 Nov 2026); both can be changed. */
export const startBoxes = (name: string): Boxes => {
  const b = emptyBoxes()
  return productType(name) === 'chair' ? { overhead: withPct(b.overhead, '20'), margin: withPct(b.margin, '20') } : b
}

/** The percentage typed in a box, as text ('' when the row is not a percentage). */
export const boxPct = (l: Line): string => (l.calc?.type === 'percent' ? l.calc.pct : '')
/** What the percentage is worked on: the cost of the elements, or everything above it (the margin on cost plus overhead). */
export const boxOf = (l: Line): 'cost' | 'above' => (l.calc?.type === 'percent' ? l.calc.of : 'cost')
/** A box counts only with a percentage above zero. */
export const boxIsSet = (l: Line): boolean => { const p = num(boxPct(l)); return p !== null && p > 0 }

export const withPct = (l: Line, pct: string): Line => ({ ...l, calc: { type: 'percent', pct, of: boxOf(l) } })
export const withOf = (l: Line, of: 'cost' | 'above'): Line => ({ ...l, calc: { type: 'percent', pct: boxPct(l), of } })

/** The elements with the boxes that are set after them, overhead first. This is the list that is worked out and saved. */
export function mergeBoxes(lines: readonly Line[], boxes: Boxes): Line[] {
  return [...lines, ...BOX_KINDS.map(k => boxes[k]).filter(boxIsSet)]
}

const sameTotals = (a: ReturnType<typeof totals>, b: ReturnType<typeof totals>) =>
  Math.abs(a.total - b.total) < 0.005 && KINDS.every(k => Math.abs(a.byKind[k] - b.byKind[k]) < 0.005)

/**
 * The rows of a saved case into elements and boxes. The LAST overhead percentage row and the LAST margin percentage row
 * move into their boxes, but only when that changes no figure of the case (a margin "of everything above" that has
 * elements below it must stay where it is). Everything else stays a row, so opening an old case never changes its price.
 */
export function splitBoxes(all: readonly Line[], size: Size): { lines: Line[]; boxes: Boxes } {
  const want = totals(all, size)
  let lines = [...all]
  const boxes = emptyBoxes()
  // Margin first: it is the last row, and a margin on cost plus overhead must still come after the overhead when put back.
  for (const kind of [...BOX_KINDS].reverse()) {
    let i = -1
    lines.forEach((l, k) => { if (l.kind === kind && l.calc?.type === 'percent') i = k })
    if (i < 0) continue
    const rest = lines.filter((_, k) => k !== i)
    const next = { ...boxes, [kind]: lines[i] }
    if (sameTotals(totals(mergeBoxes(rest, next), size), want)) { boxes[kind] = lines[i]; lines = rest }
  }
  return { lines, boxes }
}

/** What stops the boxes from being saved, in the words shown to the person. */
export function boxProblems(boxes: Boxes): string[] {
  const out: string[] = []
  for (const k of BOX_KINDS) {
    const text = boxPct(boxes[k]).trim()
    if (text === '') continue
    const p = num(text)
    if (p === null) out.push(`${KIND_LABEL[k]}: the percentage must be a number.`)
    else if (p > 500) out.push(`${KIND_LABEL[k]}: ${p}% looks like a slip.`)
  }
  return out
}

export type BuildUp = {
  /** The cost of making: every element that is not a percentage, by kind. */
  byKind: Record<Kind, number>
  cost: number
  /** Percentage rows left in the elements list (an old case's, or one typed there). */
  extra: number
  overhead: number
  margin: number
  /** What a margin "of everything above" is worked on: the cost, those percentages and the overhead. */
  above: number
  total: number
}

/** The running total of a case: cost, then overhead, then margin, from the elements and the two boxes. */
export function buildUp(lines: readonly Line[], boxes: Boxes, size: Size): BuildUp {
  const worked = workCase(mergeBoxes(lines, boxes), size)
  const byKind = Object.fromEntries(KINDS.map(k => [k, 0])) as Record<Kind, number>
  let cost = 0, extra = 0
  lines.forEach((l, i) => {
    if (l.calc?.type === 'percent') extra += worked[i].amount
    else { byKind[l.kind] += worked[i].amount; cost += worked[i].amount }
  })
  let at = lines.length
  const overhead = boxIsSet(boxes.overhead) ? worked[at++].amount : 0
  const margin = boxIsSet(boxes.margin) ? worked[at++].amount : 0
  for (const k of KINDS) byKind[k] = round2(byKind[k])
  return { byKind, cost: round2(cost), extra: round2(extra), overhead, margin, above: round2(cost + extra + overhead), total: round2(cost + extra + overhead + margin) }
}
