// "How accurate is it" (Price Brain v2, phase 3A; owner approved 23 Nov 2026). The price model is examined on the prices
// it already has, never on the ones it learned from: each product type's prices are split into five groups, and each
// group is priced blind by a model fitted on all the others. The miss is compared with the noise floor: how much the
// SAME product's price already varies in BOE's own prices (no model can be more exact than that). "Teach next" ranks
// the types that are quoted most and missed most, so a person's teaching time goes where it helps most.
// Pure: the points in, the scores out. Runs in the browser on the price pool (the same points the suggestions use).

//
// Engine v3 (phase 3C): each type is examined twice on the SAME prices, by today's model (v2) and by v3 (photo facts and
// taught cases). v3 leads a type only when its blind miss is smaller; otherwise v2 stays. Taught cases are never tested
// (they are the owner's own workings, not prices a client paid), only learned by v3.

import { TYPE_LABEL } from './features'
import { fitType, pointFeatures, predict, type ModelPoint } from './model'

export const FOLDS = 5
/** A suggestion within this much of the real price counts as close (the owner's own prices spread about this much). */
export const CLOSE = 0.2
const YEAR = 365.25 * 86_400_000

export type Engine = 'v2' | 'v3'
export type TypeScore = {
  type: string; label: string
  /** Prices of this type the model may learn from (lost quotations are never learned). */
  prices: number
  /** How many of them came from quotations: how often the type is quoted. */
  quoted: number
  /** Prices priced blind, and the typical miss (median, as a %) and the share within CLOSE, by the engine that leads
   *  (the one quotations get). Null when too few to test. */
  tested: number; miss: number | null; close: number | null
  /** Each engine on the same prices, and which one leads this type. */
  v2: Score; v3: Score
  leader: Engine
}
type Score = { miss: number | null; close: number | null }
export type ExamResult = {
  types: TypeScore[]
  overall: { tested: number; miss: number | null; close: number | null }
  /** The noise floor: products priced 3+ times, and the median spread of their prices (as a %). */
  floor: { products: number; spread: number | null }
  /** The types to teach next, most useful first. */
  teachNext: (TypeScore & { why: string })[]
  /** Prices whose product type could not be read from the name. */
  untyped: number
}

const pct = (x: number) => Math.round(x * 1000) / 10
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** The blind misses (|log guess/price|) of one engine on `own`, five folds; `extra` is only ever learned from. */
function blindMisses(own: readonly ModelPoint[], extra: readonly ModelPoint[], type: string, now: number, withFacts: boolean): number[] {
  const misses: number[] = []
  for (let fold = 0; fold < FOLDS; fold++) {
    const fit = fitType([...own.filter((_, n) => n % FOLDS !== fold), ...extra], type, now, withFacts)
    if (!fit) continue
    own.forEach((pt, n) => {
      if (n % FOLDS !== fold) return
      const years = Math.max(0, (now - (Date.parse(pt.at) || now)) / YEAR)
      const guess = predict(fit, pointFeatures(pt, withFacts), years).price
      if (guess > 0) misses.push(Math.abs(Math.log(guess / Number(pt.p))))
    })
  }
  return misses
}
const score = (misses: number[]): Score => {
  const med = median(misses)
  return { miss: med === null ? null : pct(Math.exp(med) - 1), close: misses.length ? pct(misses.filter(m => Math.exp(m) - 1 <= CLOSE).length / misses.length) : null }
}
const learnableOf = (points: readonly ModelPoint[]) => points.filter(p => p.k !== 'lost' && p.k !== 'taught' && Number(p.p) > 0)
const nameType = (pt: ModelPoint) => pointFeatures(pt).type

/** Both engines on one type's prices (typed by name), v3 also learning the type's taught cases and the prices only their
 *  photo types. v3 leads only when it misses less, on the same prices. */
export function compareEngines(points: readonly ModelPoint[], type: string, now = Date.now()) {
  const own = learnableOf(points).filter(pt => nameType(pt) === type)
  const mine = new Set(own)
  const extra = points.filter(pt => !mine.has(pt) && pt.k !== 'lost' && Number(pt.p) > 0 && pointFeatures(pt, true).type === type)
  const v2 = blindMisses(own, [], type, now, false)
  // With no photo read and nothing taught, v3 IS v2 (no fact column, no extra price): skip the second exam.
  const v3 = extra.length || own.some(pt => pt.f) ? blindMisses(own, extra, type, now, true) : v2
  const leader: Engine = v3.length && v3.length === v2.length && median(v3)! < median(v2)! ? 'v3' : 'v2'
  return { own, v2: score(v2), v3: score(v3), leader, misses: leader === 'v3' ? v3 : v2 }
}

export function examine(points: readonly ModelPoint[], now = Date.now()): ExamResult {
  const learnable = learnableOf(points)
  const byType = new Set<string>()
  let untyped = 0
  learnable.forEach(pt => { const t = nameType(pt); if (t) byType.add(t); else untyped++ })

  const all: number[] = []
  const allClose: boolean[] = []
  const types: TypeScore[] = [...byType].map(type => {
    // Only this type's points: a fit reads nothing else, and this keeps the exam quick on thousands of prices.
    const { own, v2, v3, leader, misses } = compareEngines(points, type, now)
    misses.forEach(m => { all.push(m); allClose.push(Math.exp(m) - 1 <= CLOSE) })
    return {
      type, label: TYPE_LABEL[type] ?? type, prices: own.length,
      quoted: own.filter(pt => pt.k !== 'order').length,
      tested: misses.length, ...score(misses), v2, v3, leader,
    }
  }).sort((a, b) => b.prices - a.prices || a.label.localeCompare(b.label))

  // The noise floor: the same product name priced at least three times.
  const byName = new Map<string, number[]>()
  learnable.forEach(pt => byName.set(norm(pt.name), [...(byName.get(norm(pt.name)) ?? []), Math.log(Number(pt.p))]))
  const spreads = [...byName.values()].filter(v => v.length >= 3).map(v => {
    const mean = v.reduce((s, x) => s + x, 0) / v.length
    return Math.exp(Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1))) - 1
  })
  const floorMed = median(spreads)

  // Teach next: quoted often and missed most; a type quoted but too thin to test comes first.
  const need = (t: TypeScore) => (t.quoted + 1) * (t.miss === null ? 100 : t.miss)
  const teachNext = types
    .filter(t => t.quoted > 0 || t.miss === null || t.miss > CLOSE * 100)
    .sort((a, b) => need(b) - need(a))
    .slice(0, 5)
    .map(t => ({ ...t, why: t.miss === null ? `only ${t.prices} price${t.prices === 1 ? '' : 's'}: too few to learn from` : `misses by ${t.miss}% typically` }))

  const allMed = median(all)
  return {
    types,
    overall: { tested: all.length, miss: allMed === null ? null : pct(Math.exp(allMed) - 1), close: all.length ? pct(allClose.filter(Boolean).length / all.length) : null },
    floor: { products: spreads.length, spread: floorMed === null ? null : pct(floorMed) },
    teachNext, untyped,
  }
}
