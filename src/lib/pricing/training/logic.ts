// Pricing > Price logic: the submitted training cases side by side, one row per element. Pure.
// The cases are the ones pricing_training_library sends to people who may open Pricing (they come with `lines`).

import { KINDS } from './doc'
import { sameElement, type TaughtCase } from './match'

export type LogicRow = {
  element: string; kind: string
  /** What the element costs on each case, in the order of the cases; null when the case does not have it. */
  cells: (number | null)[]
  /** The same element costs clearly different amounts on two cases: worth a look. */
  varies: boolean
}

/** The highest amount is more than this much above the lowest (owner default, 16 Nov 2026: 20%). */
export const VARIES_ABOVE = 1.2

/** One row per element name (capitals ignored), grouped by kind in the order of the Training screen. */
export function logicRows(cases: readonly TaughtCase[]): LogicRow[] {
  const rows: LogicRow[] = []
  cases.forEach((c, ci) => {
    for (const l of c.lines ?? []) {
      let row = rows.find(r => r.kind === l.kind && sameElement(r.element, l.element))
      if (!row) { row = { element: l.element, kind: l.kind, cells: cases.map(() => null), varies: false }; rows.push(row) }
      row.cells[ci] = (row.cells[ci] ?? 0) + Number(l.amount)   // a case that lists an element twice: its sum
    }
  })
  for (const r of rows) {
    const has = r.cells.filter((x): x is number => x !== null)
    r.varies = has.length > 1 && Math.max(...has) > Math.min(...has) * VARIES_ABOVE
  }
  const order = (k: string) => { const i = (KINDS as readonly string[]).indexOf(k); return i < 0 ? KINDS.length : i }
  return rows.map((r, i) => ({ r, i })).sort((a, b) => order(a.r.kind) - order(b.r.kind) || a.i - b.i).map(x => x.r)
}
