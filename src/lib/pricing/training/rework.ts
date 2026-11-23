// Price Brain v2, phase 2 (owner approved 23 Nov 2026): a taught case worked out again for ONE quotation line: the line's
// own size (area rows), the line's wood (a cut list at that wood's rate, or a structure's wood share swapped), and today's
// wood and metal rates; percentages follow the new cost. Rows with a plain amount stay as taught, and so does a cut list's
// or a metal frame's quantity (they are exact, not scaled). Pure: the server route feeds it the case, the line and the rates,
// so the rows, rates and margins never reach a person who may only quote.

import { num, toLine, totals, workCase, type Line } from './doc'
import type { Calc, Size } from './calc'
import { sizeFields } from './prefill'

export type SavedRow = { element: string; kind: string; material: string | null; quantity: number | null; unit: string | null; rate: number | null; amount: number; wood_amount: number | null; calc: unknown }
export type ReworkCase = { case_no: number; name: string; width_in: number | null; depth_in: number | null; height_in: number | null; per_set: number | null; rows: SavedRow[] }
/** Today's rates by lower-case name: only woods and metals that have a rate. */
export type RateBook = { woods: Map<string, { name: string; rate: number }>; metals: Map<string, { name: string; rate: number }> }
export type ForLine = { size: string | null; wood: string | null }
export type Reworked = {
  caseNo: number
  /** The case's total as it was taught. */
  taught: number
  /** The case worked out for this line. */
  price: number
  /** The line's own size was used. */
  sized: boolean
  /** The wood the structure is priced in for this line. */
  wood: string | null
  /** For people with Pricing only: each row worked out, and what changed from the taught case. */
  rows: { element: string; kind: string; amount: number; note: string }[]
  changes: string[]
}

const r2 = (x: number) => Math.round(x * 100) / 100
const inr = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`
const low = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

/** A rate book from the two lists as the database keeps them (a wood or metal without a rate is left out). */
export function rateBook(woods: readonly { name: string; rate: number | string | null }[], metals: readonly { name: string; rate: number | string | null }[]): RateBook {
  const map = (xs: readonly { name: string; rate: number | string | null }[]) => new Map(xs.filter(x => x.rate !== null && Number(x.rate) > 0).map(x => [low(x.name), { name: x.name.trim(), rate: Number(x.rate) }]))
  return { woods: map(woods), metals: map(metals) }
}

export function rework(c: ReworkCase, line: ForLine, rates: RateBook): Reworked {
  const lines: Line[] = c.rows.map(r => toLine({ ...r, reasoning: null, from_ai: false }))
  const taught = r2(c.rows.reduce((s, r) => s + Number(r.amount), 0))
  const changes: string[] = []

  // The line's size when it gives at least a width and a depth; otherwise the case's own.
  const caseSize: Size = { width: c.width_in, depth: c.depth_in, height: c.height_in }
  const ls = sizeFields(line.size)
  const lineSize: Size | null = num(ls.width_in) && num(ls.depth_in) ? { width: num(ls.width_in), depth: num(ls.depth_in), height: num(ls.height_in) ?? c.height_in } : null
  const hasArea = lines.some(l => l.calc?.type === 'area')
  const sized = !!lineSize && hasArea && (lineSize.width !== caseSize.width || lineSize.depth !== caseSize.depth || lineSize.height !== caseSize.height)
  const size = sized ? lineSize! : caseSize
  if (sized) {
    const dims = (s: Size) => [s.width, s.depth, s.height].filter(x => x !== null).join(' × ')
    changes.push(`Area worked out for ${dims(size)} in (taught at ${dims(caseSize) || 'no size'})`)
  }

  const wanted = line.wood ? rates.woods.get(low(line.wood)) ?? null : null
  let wood: string | null = null
  lines.forEach((l, i) => {
    const calc: Calc | null = l.calc
    if (l.kind === 'structure' && calc?.type === 'wood') {
      const own = l.material.trim()
      const target = wanted && low(wanted.name) !== low(own) ? wanted : null
      if (line.wood && !wanted && low(line.wood) !== low(own)) changes.push(`No rate for ${line.wood} yet: priced in ${own || 'the taught wood'}`)
      const today = (target ?? rates.woods.get(low(own)) ?? null)?.rate ?? null
      const was = num(calc.rate)
      if (target) { lines[i] = { ...l, material: target.name }; changes.push(`${l.element}: ${target.name} instead of ${own || 'the taught wood'}`) }
      if (today !== null && today !== was) {
        lines[i] = { ...lines[i], calc: { ...calc, rate: String(today) } }
        changes.push(`${l.element}: ${target?.name ?? own} at ${inr(today)} per cu ft today (taught at ${was === null ? 'no rate' : inr(was)})`)
      }
      wood = wood ?? (target?.name ?? (own || null))
    } else if (l.kind === 'structure' && !calc) {
      // One structure price with a wood share: in another wood only the wood share changes (owner rule, 16 Nov 2026).
      const own = l.material.trim()
      const share = num(l.wood)
      const ownRate = rates.woods.get(low(own))?.rate ?? null
      if (wanted && low(wanted.name) !== low(own) && share !== null && ownRate) {
        const amount = (num(l.amount) ?? c.rows[i].amount) - share + share * wanted.rate / ownRate
        lines[i] = { ...l, material: wanted.name, quantity: '', rate: '', amount: String(r2(amount)), wood: String(r2(share * wanted.rate / ownRate)) }
        changes.push(`${l.element}: ${wanted.name} instead of ${own}, only its wood share changes`)
        wood = wood ?? wanted.name
      } else {
        if (line.wood && low(line.wood) !== low(own) && own) changes.push(`${l.element}: no ${share === null ? 'wood share' : 'rate'} to price it in ${line.wood}, so as taught`)
        wood = wood ?? (own || null)
      }
    } else if (calc?.type === 'metal') {
      const today = rates.metals.get(low(calc.metal))?.rate ?? null
      const was = num(calc.rate)
      if (today !== null && today !== was) {
        lines[i] = { ...l, calc: { ...calc, rate: String(today) } }
        changes.push(`${l.element}: ${calc.metal} at ${inr(today)} per kg today (taught at ${was === null ? 'no rate' : inr(was)})`)
      }
    }
  })

  const worked = workCase(lines, size)
  return {
    caseNo: c.case_no, taught, price: Math.round(totals(lines, size).total), sized, wood,
    rows: lines.map((l, i) => ({ element: l.element, kind: l.kind, amount: worked[i].amount, note: worked[i].note })),
    changes,
  }
}
