// Pricing model v2 (owner approved 2026-11-12): for each product type, learn from every recorded price how each
// parameter moves the price (size, material, finish, quantity band, client type, and time), then price a line for its
// own parameters, with a range, a confidence and the reasons. It is refitted from the points every time it is used,
// so each new approved PI, won or lost quotation and desk approval changes it: nothing is stored that could go stale.
//
// The fit: log(price) = intercept + Σ effects, weighted least squares with a small ridge penalty (so a material seen
// twice cannot swing the price), weights by how strong the evidence is. Lost quotations are not fitted (a client said
// no to that price); approved PIs count most.

import { lineFeatures, TYPE_LABEL, type LineFeatures } from './features'
import { roundPrice, type Confidence, type PricePoint } from './suggest'

export type ModelPoint = PricePoint & {
  name: string; dims?: string | null; material?: string | null; finish?: string | null; client_type?: string | null
}
export type ModelSuggestion = {
  price: number; low: number; high: number; confidence: Confidence
  reasons: string[]; basis: string; n: number; type: string
}
export type Effect = { label: string; pct: number }
export type Fit = {
  type: string; n: number; sigma: number; r2: number
  columns: string[]; coef: number[]
  areaMean: number | null; ref: Record<'material' | 'finish' | 'qtyBand' | 'clientType', string>
  seen: Record<'material' | 'finish' | 'clientType', Set<string>>
}

const KIND_WEIGHT: Record<string, number> = { order: 1, won: 0.8, approved: 0.6, quote: 0.25, lost: 0 }
const MIN_POINTS = 8
const LAMBDA = 0.5
const YEAR = 365.25 * 86_400_000
const QTY_LABEL: Record<string, string> = { q1: '1–10 pieces', q11: '11–50 pieces', q51: '51+ pieces' }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
const pctOf = (c: number) => Math.round((Math.exp(c) - 1) * 100)

type Row = { f: LineFeatures; y: number; w: number; years: number }

function rowsFor(points: readonly ModelPoint[], type: string, now: number): Row[] {
  return points.flatMap(pt => {
    const w = KIND_WEIGHT[pt.k] ?? 0
    const p = Number(pt.p)
    if (!w || !(p > 0)) return []
    const f = lineFeatures({ name: pt.name, size: pt.dims, material: pt.material, finish: pt.finish, qty: pt.q, clientType: pt.client_type })
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

function design(f: LineFeatures, years: number, fit: Pick<Fit, 'columns' | 'areaMean'>): number[] {
  return fit.columns.map(col => {
    if (col === '1') return 1
    if (col === 'logArea') return f.area && fit.areaMean !== null ? Math.log(f.area) - fit.areaMean : 0
    if (col === 'noArea') return f.area ? 0 : 1
    if (col === 'years') return years
    const [k, v] = col.split(':')
    return (f as unknown as Record<string, string>)[k] === v ? 1 : 0
  })
}

export function fitType(points: readonly ModelPoint[], type: string, now = Date.now()): Fit | null {
  const rows = rowsFor(points, type, now)
  if (rows.length < MIN_POINTS) return null
  const withArea = rows.filter(r => r.f.area)
  const areaMean = withArea.length >= 5 ? withArea.reduce((s, r) => s + Math.log(r.f.area!), 0) / withArea.length : null
  const ref = {
    material: mostCommon(rows.map(r => r.f.material)), finish: mostCommon(rows.map(r => r.f.finish)),
    qtyBand: 'q1', clientType: mostCommon(rows.map(r => r.f.clientType)),
  }
  const levels = (k: 'material' | 'finish' | 'qtyBand' | 'clientType') =>
    [...new Set(rows.map(r => r.f[k]))].filter(v => v !== ref[k]).sort().map(v => `${k}:${v}`)
  const columns = ['1',
    ...(areaMean !== null ? ['logArea'] : []), ...(areaMean !== null && withArea.length < rows.length ? ['noArea'] : []),
    ...(new Set(rows.map(r => Math.round(r.years * 4))).size > 2 ? ['years'] : []),
    ...levels('material'), ...levels('finish'), ...levels('qtyBand'), ...levels('clientType')]
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
  return {
    type, n: rows.length, sigma: Math.sqrt(ssRes / W), r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    columns, coef, areaMean, ref,
    seen: { material: new Set(rows.map(r => r.f.material)), finish: new Set(rows.map(r => r.f.finish)), clientType: new Set(rows.map(r => r.f.clientType)) },
  }
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
      const vs = fit.ref[k as keyof Fit['ref']]
      const name = k === 'qtyBand' ? QTY_LABEL[v] : cap(v)
      const base = k === 'qtyBand' ? QTY_LABEL[vs] : cap(vs)
      out.push({ label: `${name} instead of ${base}`, pct: pctOf(c) })
    }
  })
  return out
}

/** `yearsAgo` prices the line as of an earlier date (the blind test of an old PI); a quotation line is priced for today (0). */
export function predict(fit: Fit, f: LineFeatures, yearsAgo = 0): ModelSuggestion {
  const unseen: string[] = []
  const g: LineFeatures = { ...f }
  for (const k of ['material', 'finish', 'clientType'] as const) {
    if (!fit.seen[k].has(g[k])) { if (g[k] !== 'unknown') unseen.push(`${cap(g[k])} ${k === 'clientType' ? 'client type' : k}`); g[k] = fit.ref[k] }
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
      const vs = fit.ref[k as keyof Fit['ref']]
      parts.push({ label: k === 'qtyBand' ? `${QTY_LABEL[v]} (volume)` : `${cap(v)} instead of ${cap(vs)}`, pct: pctOf(c) })
    }
  })
  parts.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  const reasons = parts.slice(0, 3).map(p => `${p.pct > 0 ? '+' : ''}${p.pct}% ${p.label}`)
  if (!f.area && fit.columns.includes('logArea')) reasons.push('size not read: priced at a typical size')
  if (unseen.length) reasons.push(`${unseen.join(', ')} not seen before: priced as ${cap(fit.ref.material)}`)

  let confidence: Confidence = fit.n >= 20 && fit.sigma <= 0.15 ? 'high' : fit.n >= 10 && fit.sigma <= 0.3 ? 'medium' : 'low'
  if (unseen.length && confidence === 'high') confidence = 'medium'
  return {
    price: roundPrice(Math.exp(yhat)), low: roundPrice(Math.exp(yhat - fit.sigma)), high: roundPrice(Math.exp(yhat + fit.sigma)),
    confidence, reasons, n: fit.n, type: fit.type,
    basis: `the price model for ${TYPE_LABEL[fit.type] ?? fit.type} (${fit.n} prices, typical error ±${Math.round((Math.exp(fit.sigma) - 1) * 100)}%)`,
  }
}

/** A line priced by the model; null when its type is unknown or has too few prices (the caller falls back to v1). */
export function priceLine(points: readonly ModelPoint[], line: Parameters<typeof lineFeatures>[0], now = Date.now()): ModelSuggestion | null {
  const f = lineFeatures(line)
  if (!f.type) return null
  const fit = fitType(points, f.type, now)
  return fit ? predict(fit, f) : null
}
