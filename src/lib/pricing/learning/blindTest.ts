// Price learning, piece 1: the blind test. Before a batch is learned, every line in it is priced by the model using only
// what the model already knows, as of the PI's own date, and compared with the price in the PI. That is the honest score:
// the model has not seen these answers. Pure functions over the lines and the price pool; the page fetches the pool.

import { lineFeatures, productType, TYPE_LABEL } from '../features'
import { fitType, predict, type Fit, type ModelPoint, type ModelSuggestion } from '../model'

export type TestLine = {
  /** Which PI of the batch it is from (an index the page understands). */
  pi: number
  name: string
  size: string
  material: string
  customization: string
  qty: number
  price: number
  /** The PI's date, ISO. */
  date: string
  clientType: string | null
}
export type TestedLine = TestLine & {
  /** The model's price, or null when it could not price the line (a new design, or too few prices of its type). */
  model: ModelSuggestion | null
  /** (model − PI) ÷ PI, in percent: negative when the model said less than the PI. */
  missPct: number | null
}
export type BlindTest = {
  lines: TestedLine[]
  priced: number
  unpriced: number
  /** Average distance from the PI price, in percent (one decimal), over the lines the model priced. */
  avgMiss: number | null
  /** Share of priced lines within ±10% of the PI price, in percent (rounded). */
  hitRate: number | null
  /** The model's value against the PI's, quantity × price, over the priced lines. */
  orderModel: number
  orderReal: number
  orderGapPct: number | null
  byType: { type: string; label: string; n: number; avgMiss: number }[]
  /** The biggest misses, worst first. */
  worst: TestedLine[]
}

const YEAR = 365.25 * 86_400_000
const round1 = (n: number) => Math.round(n * 10) / 10

/** The product types in these lines: the page fetches one price pool for each. */
export const typesOf = (lines: readonly Pick<TestLine, 'name'>[]) => [...new Set(lines.map(l => productType(l.name)).filter((t): t is string => !!t))].sort()

/** `poolFor(type)` is every recorded price of that product type (what fetchPool returns for its words). */
export function blindTest(lines: readonly TestLine[], poolFor: (type: string) => readonly ModelPoint[], now = Date.now(), worstCount = 6): BlindTest {
  const fits = new Map<string, Fit | null>()
  const fitOf = (type: string) => {
    if (!fits.has(type)) fits.set(type, fitType(poolFor(type), type, now))
    return fits.get(type)!
  }
  const tested: TestedLine[] = lines.map(l => {
    const f = lineFeatures({ name: l.name, size: l.size, material: l.material, finish: l.customization, qty: l.qty, clientType: l.clientType })
    const fit = f.type ? fitOf(f.type) : null
    if (!fit) return { ...l, model: null, missPct: null }
    const yearsAgo = (now - (Date.parse(l.date) || now)) / YEAR
    const model = predict(fit, f, yearsAgo)
    return { ...l, model, missPct: ((model.price - l.price) / l.price) * 100 }
  })
  const priced = tested.filter((l): l is TestedLine & { model: ModelSuggestion; missPct: number } => l.model !== null && l.missPct !== null)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const avgMiss = avg(priced.map(l => Math.abs(l.missPct)))
  const orderModel = priced.reduce((s, l) => s + l.qty * l.model.price, 0)
  const orderReal = priced.reduce((s, l) => s + l.qty * l.price, 0)
  const byType = new Map<string, number[]>()
  for (const l of priced) byType.set(l.model.type, [...(byType.get(l.model.type) ?? []), Math.abs(l.missPct)])
  return {
    lines: tested, priced: priced.length, unpriced: tested.length - priced.length,
    avgMiss: avgMiss === null ? null : round1(avgMiss),
    hitRate: priced.length ? Math.round((priced.filter(l => Math.abs(l.missPct) <= 10).length / priced.length) * 100) : null,
    orderModel: Math.round(orderModel), orderReal: Math.round(orderReal),
    orderGapPct: orderReal > 0 ? round1(((orderModel - orderReal) / orderReal) * 100) : null,
    byType: [...byType.entries()].map(([type, xs]) => ({ type, label: TYPE_LABEL[type] ?? type, n: xs.length, avgMiss: round1(avg(xs)!) })).sort((a, b) => a.avgMiss - b.avgMiss),
    worst: [...priced].sort((a, b) => Math.abs(b.missPct) - Math.abs(a.missPct)).slice(0, worstCount),
  }
}
