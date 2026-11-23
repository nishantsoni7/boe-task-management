// Pricing model v2 (owner approved 2026-11-12): for each product type, learn from every recorded price how each
// parameter moves the price (size, material, finish, quantity band, client type, and time), then price a line for its
// own parameters, with a range, a confidence and the reasons. It is refitted from the points every time it is used,
// so each new approved PI, won or lost quotation and desk approval changes it: nothing is stored that could go stale.
//
// The fit: log(price) = intercept + Σ effects, weighted least squares with a small ridge penalty (so a material seen
// twice cannot swing the price), weights by how strong the evidence is. Lost quotations are not fitted (a client said
// no to that price); approved PIs and taught cases count most.
//
// Engine v3 (Price Brain v2, phase 3C; owner approved 23 Nov 2026) is the same fit with the photo facts as more yes/no
// effects (arms, back, seat, base, top, visible metal, carving), a photo's kind of product typing a price whose name
// says none, and the submitted Training cases learned as prices (kind 'taught'). `withFacts` switches it on; without it
// every result is exactly v2's. Which of the two leads for a product type is decided by the blind exam (exam.ts).

import { lineFeatures, TYPE_LABEL, type LineFeatures } from './features'
import { roundPrice, type Confidence, type PricePoint } from './suggest'
import { FACT_KEYS, FACT_LABEL, factText, type FactKey } from './photoFacts'

export type ModelPoint = Omit<PricePoint, 'k'> & {
  /** The pool also answers 'approved' (a desk-approved quotation) and 'taught' (a submitted Training case, 20270826000000). */
  k: PricePoint['k'] | 'approved' | 'taught'
  name: string; dims?: string | null; material?: string | null; finish?: string | null; client_type?: string | null
  /** The photo facts of the price's product, when its photo has been read (20270826000000). */
  f?: Partial<Record<FactKey, string>> | null
}
export type ModelSuggestion = {
  price: number; low: number; high: number; confidence: Confidence
  reasons: string[]; basis: string; n: number; type: string
  /** Which engine priced it. */
  engine?: 'v2' | 'v3'
}
export type Effect = { label: string; pct: number }
export type Fit = {
  type: string; n: number; sigma: number; r2: number
  columns: string[]; coef: number[]
  areaMean: number | null; ref: Record<string, string>
  seen: Record<string, Set<string>>
  /** Engine v3: the photo facts are effects too. */
  facts: boolean
}
/** A line's features, with its photo facts when v3 prices it. */
export type Features = LineFeatures & Partial<Record<FactKey, string>>

const KIND_WEIGHT: Record<string, number> = { order: 1, taught: 1, won: 0.8, approved: 0.6, quote: 0.25, lost: 0 }
const MIN_POINTS = 8
const LAMBDA = 0.5
const YEAR = 365.25 * 86_400_000
const QTY_LABEL: Record<string, string> = { q1: '1–10 pieces', q11: '11–50 pieces', q51: '51+ pieces' }
/** The photo facts that are effects (the kind of product types the price instead). */
const PHOTO_KEYS: readonly FactKey[] = FACT_KEYS.filter(k => k !== 'kind')
const BASE_KEYS = ['material', 'finish', 'qtyBand', 'clientType'] as const
const SEEN_KEYS = ['material', 'finish', 'clientType'] as const
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
const pctOf = (c: number) => Math.round((Math.exp(c) - 1) * 100)

/** A price's features: from its words, and, for v3, its photo facts (unknown when the photo was not read). */
export function pointFeatures(pt: Pick<ModelPoint, 'name' | 'dims' | 'material' | 'finish' | 'q' | 'client_type' | 'f'>, withFacts = false): Features {
  const f: Features = lineFeatures({ name: pt.name, size: pt.dims, material: pt.material, finish: pt.finish, qty: pt.q, clientType: pt.client_type })
  if (!withFacts) return f
  const facts = pt.f ?? {}
  for (const k of PHOTO_KEYS) f[k] = typeof facts[k] === 'string' ? facts[k]! : 'unknown'
  // A name that names no product type is typed by its photo.
  if (!f.type && typeof facts.kind === 'string' && facts.kind !== 'other' && TYPE_LABEL[facts.kind]) f.type = facts.kind
  return f
}

type Row = { f: Features; y: number; w: number; years: number }

function rowsFor(points: readonly ModelPoint[], type: string, now: number, withFacts: boolean): Row[] {
  return points.flatMap(pt => {
    // Taught cases are engine v3's: today's model (v2) learns exactly what it learned before.
    const w = pt.k === 'taught' && !withFacts ? 0 : KIND_WEIGHT[pt.k] ?? 0
    const p = Number(pt.p)
    if (!w || !(p > 0)) return []
    const f = pointFeatures(pt, withFacts)
    if (f.type !== type) return []
    const years = Math.max(0, (now - (Date.parse(pt.at) || now)) / YEAR)
    return [{ f, y: Math.log(p), w, years }]
  })
}

const mostCommon = (xs: string[]) => {
  const c = new Map<string, number>()
  xs.forEach(x => c.set(x, (c.get(x) ?? 0) + 1))
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'unknown'
}

/** Solve A x = b (A square, small) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = M[r][c] / M[c][c]
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]
    }
  }
  return M.map((r, i) => r[n] / r[i])
}

function design(f: Features, years: number, fit: Pick<Fit, 'columns' | 'areaMean'>): number[] {
  return fit.columns.map(col => {
    if (col === '1') return 1
    if (col === 'logArea') return f.area && fit.areaMean !== null ? Math.log(f.area) - fit.areaMean : 0
    if (col === 'noArea') return f.area ? 0 : 1
    if (col === 'years') return years
    const [k, v] = col.split(':')
    return (f as unknown as Record<string, string>)[k] === v ? 1 : 0
  })
}

export function fitType(points: readonly ModelPoint[], type: string, now = Date.now(), withFacts = false): Fit | null {
  const rows = rowsFor(points, type, now, withFacts)
  if (rows.length < MIN_POINTS) return null
  const withArea = rows.filter(r => r.f.area)
  const areaMean = withArea.length >= 5 ? withArea.reduce((s, r) => s + Math.log(r.f.area!), 0) / withArea.length : null
  const keys: string[] = [...BASE_KEYS, ...(withFacts ? PHOTO_KEYS : [])]
  const valueOf = (r: Row, k: string) => (r.f as unknown as Record<string, string>)[k]
  // The reference of a photo fact is "unknown" when any price lacks it, so an unread photo changes nothing.
  const ref: Record<string, string> = { qtyBand: 'q1' }
  for (const k of keys) if (k !== 'qtyBand') ref[k] = PHOTO_KEYS.includes(k as FactKey) && rows.some(r => valueOf(r, k) === 'unknown') ? 'unknown' : mostCommon(rows.map(r => valueOf(r, k)))
  const levels = (k: string) => [...new Set(rows.map(r => valueOf(r, k)))].filter(v => v !== ref[k]).sort().map(v => `${k}:${v}`)
  const columns = ['1',
    ...(areaMean !== null ? ['logArea'] : []), ...(areaMean !== null && withArea.length < rows.length ? ['noArea'] : []),
    ...(new Set(rows.map(r => Math.round(r.years * 4))).size > 2 ? ['years'] : []),
    ...keys.flatMap(levels)]
  const shape = { columns, areaMean }
  const X = rows.map(r => design(r.f, r.years, shape))
  const k = columns.length
  // The ridge penalty holds back yes/no effects seen only a few times (a material on two lines); size and time are
  // left free, since their values are small numbers and a penalty would flatten them.
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j && columns[i].includes(':') ? LAMBDA : 0)))
  const b = new Array(k).fill(0)
  rows.forEach((r, n) => {
    for (let i = 0; i < k; i++) {
      b[i] += r.w * X[n][i] * r.y
      for (let j = 0; j < k; j++) A[i][j] += r.w * X[n][i] * X[n][j]
    }
  })
  const coef = solve(A, b)
  if (!coef) return null
  const W = rows.reduce((s, r) => s + r.w, 0)
  const yMean = rows.reduce((s, r) => s + r.w * r.y, 0) / W
  let ssRes = 0, ssTot = 0
  rows.forEach((r, n) => {
    const yhat = X[n].reduce((s, x, i) => s + x * coef[i], 0)
    ssRes += r.w * (r.y - yhat) ** 2
    ssTot += r.w * (r.y - yMean) ** 2
  })
  const seen: Record<string, Set<string>> = {}
  for (const key of [...SEEN_KEYS, ...(withFacts ? PHOTO_KEYS : [])]) seen[key] = new Set(rows.map(r => valueOf(r, key)))
  return {
    type, n: rows.length, sigma: Math.sqrt(ssRes / W), r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    columns, coef, areaMean, ref, seen, facts: withFacts,
  }
}

/** A column's effect in words: "Teak instead of Mango", "51+ pieces instead of 1–10 pieces", "Back cane instead of unknown". */
function effectLabel(k: string, v: string, ref: string): string {
  if (k === 'qtyBand') return `${QTY_LABEL[v]} instead of ${QTY_LABEL[ref]}`
  if (PHOTO_KEYS.includes(k as FactKey)) return `${FACT_LABEL[k as FactKey]} ${factText(k as FactKey, v)} instead of ${factText(k as FactKey, ref)} (photo)`
  return `${cap(v)} instead of ${cap(ref)}`
}

/** Every learned effect, as "+18%" against the typical product of the type, for the "How prices are made" view. */
export function explainFit(fit: Fit): Effect[] {
  const out: Effect[] = []
  fit.columns.forEach((col, i) => {
    const c = fit.coef[i]
    if (col === '1' || col === 'noArea') return
    if (col === 'logArea') out.push({ label: 'Twice the plan area', pct: pctOf(c * Math.LN2) })
    else if (col === 'years') out.push({ label: 'Price change per year', pct: pctOf(-c) })
    else {
      const [k, v] = col.split(':')
      out.push({ label: effectLabel(k, v, fit.ref[k]), pct: pctOf(c) })
    }
  })
  return out
}

/** `yearsAgo` prices the line as of an earlier date (the blind test of an old PI); a quotation line is priced for today (0). */
export function predict(fit: Fit, f: Features, yearsAgo = 0): ModelSuggestion {
  const unseen: string[] = []
  const g: Features = { ...f }
  for (const k of Object.keys(fit.seen)) {
    const v = (g as unknown as Record<string, string>)[k] ?? 'unknown'
    if (!fit.seen[k].has(v)) {
      // Each unseen kind says what it was priced as: a finish is priced as the usual finish, not as a material.
      // A photo fact not seen before is simply priced as unknown, without a word.
      if (v !== 'unknown' && SEEN_KEYS.includes(k as typeof SEEN_KEYS[number])) unseen.push(`${cap(v)} ${k === 'clientType' ? 'client type' : k} not seen before: priced as ${fit.ref[k] === 'unknown' ? 'the usual (none stated)' : cap(fit.ref[k])}`)
      ;(g as unknown as Record<string, string>)[k] = fit.ref[k]
    }
  }
  const x = design(g, Math.max(0, yearsAgo), fit)
  const yhat = x.reduce((s, v, i) => s + v * fit.coef[i], 0)
  // Reasons: the biggest effects of THIS line against the typical product of the type.
  const parts: Effect[] = []
  fit.columns.forEach((col, i) => {
    const c = fit.coef[i] * x[i]
    if (col === '1' || col === 'years' || col === 'noArea' || Math.abs(c) < 0.02) return
    if (col === 'logArea') parts.push({ label: `its size against a typical ${TYPE_LABEL[fit.type]?.toLowerCase() ?? 'one'}`, pct: pctOf(c) })
    else {
      const [k, v] = col.split(':')
      parts.push({ label: k === 'qtyBand' ? `${QTY_LABEL[v]} (volume)` : effectLabel(k, v, fit.ref[k]), pct: pctOf(c) })
    }
  })
  parts.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  const reasons = parts.slice(0, 3).map(p => `${p.pct > 0 ? '+' : ''}${p.pct}% ${p.label}`)
  if (!f.area && fit.columns.includes('logArea')) reasons.push('size not read: priced at a typical size')
  reasons.push(...unseen)

  let confidence: Confidence = fit.n >= 20 && fit.sigma <= 0.15 ? 'high' : fit.n >= 10 && fit.sigma <= 0.3 ? 'medium' : 'low'
  if (unseen.length && confidence === 'high') confidence = 'medium'
  return {
    price: roundPrice(Math.exp(yhat)), low: roundPrice(Math.exp(yhat - fit.sigma)), high: roundPrice(Math.exp(yhat + fit.sigma)),
    confidence, reasons, n: fit.n, type: fit.type, engine: fit.facts ? 'v3' : 'v2',
    basis: `the price model${fit.facts ? ' with photo facts' : ''} for ${TYPE_LABEL[fit.type] ?? fit.type} (${fit.n} prices, typical error ±${Math.round((Math.exp(fit.sigma) - 1) * 100)}%)`,
  }
}

/**
 * A line priced by the model; null when its type is unknown or has too few prices (the caller falls back to v1).
 * `fits` keeps one fit per product type between calls: the fit depends on the points and the type, never on the line,
 * so a caller that prices again on every keystroke passes one Map per pool and the pool is read once, not once per line.
 * `facts` (engine v3): the line's own photo facts; `useFacts(type)` says whether v3 leads for that type (exam.ts).
 */
export function priceLine(points: readonly ModelPoint[], line: Parameters<typeof lineFeatures>[0], now = Date.now(), fits?: Map<string, Fit | null>,
  v3?: { facts: ModelPoint['f']; useFacts: (type: string) => boolean }): ModelSuggestion | null {
  const plain = lineFeatures(line)
  const withPhoto: Features | null = v3 ? { ...pointFeatures({ name: line.name, dims: line.size, q: line.qty ?? null, client_type: line.clientType, f: v3.facts }, true),
    material: plain.material, finish: plain.finish } : null // the words in Remarks (spec) still reach the material and finish, as in v2
  const type = plain.type ?? withPhoto?.type
  if (!type) return null
  const withFacts = !!withPhoto && v3!.useFacts(type)
  // A name with no product type is priced by its photo's kind only where v3 leads; elsewhere it stays unpriced, as in v2.
  if (!plain.type && !withFacts) return null
  const f = withFacts ? withPhoto! : plain
  const key = withFacts ? `${type}:v3` : type
  let fit = fits?.get(key)
  if (fit === undefined) { fit = fitType(points, type, now, withFacts); fits?.set(key, fit) }
  return fit ? predict(fit, f) : null
}
