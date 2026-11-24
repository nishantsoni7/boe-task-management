// Pricing > Training: how one element of a price is worked out, when it is more than "an amount" or "quantity × rate"
// (Price Brain v2, phase 1; owner approved 23 Nov 2026). Four ways:
//   wood     a cut list in cubic feet, plus the conversion waste, × the wood rate, + labour + hardware = the raw structure
//   metal    profiles weighed as galaluminium.in / maiak-m.bg do it, plus cut loss, × ₹/kg, + fabrication, + coating by area;
//            or, when a vendor makes the frame and buys the steel (24 Nov 2026), the finished kg × his all-in ₹/kg, + coating;
//            a weighed bare frame (kg on the scale) replaces the calculated kg
//   area     a face of the product (top, top and sides, all faces) from the case's own size, × ₹/sq ft
//   percent  a % of the cost (every row that is not a %, added) or of everything above it (stacked)
// The quantities are kept, not only the rupees, so a later rate change can re-price a case honestly.
// Pure: no network, no React. Numbers stay text while typed (like the rest of a case) and become numbers when saved.

import { METALS, PROFILES, isProfile, partWeight, type LengthUnit, type ProfileKey } from '@/lib/pricing/costing/metal'
import { cutList } from '@/lib/pricing/costing/wood'

export type WoodPart = { name: string; qty: string; length: string; width: string; thick: string }
export type WoodCalc = { type: 'wood'; waste_pct: string; rate: string; labour: string; hardware: string; parts: WoodPart[] }
export type MetalPartRow = { name: string; profile: ProfileKey; a: string; b: string; t: string; unit: 'mm' | 'in'; gauge: string; corners: 'round' | 'sharp'; length: string; length_unit: LengthUnit; qty: string }
/** vendor: the frame is bought finished at one rate per kg (steel, cutting and making included): no cut loss, no fabrication. weighed_kg: what the bare frame weighed on the scale; blank = use the calculated kg. */
export type MetalCalc = { type: 'metal'; metal: string; density: string; rate: string; loss_pct: string; fab_per_kg: string; coat_per_sqft: string; vendor: boolean; weighed_kg: string; parts: MetalPartRow[] }
export type Faces = 'top' | 'top_sides' | 'all'
export type AreaCalc = { type: 'area'; faces: Faces; rate: string }
export type PercentCalc = { type: 'percent'; pct: string; of: 'cost' | 'above' }
export type Calc = WoodCalc | MetalCalc | AreaCalc | PercentCalc
export type CalcType = Calc['type']

export const CALC_LABEL: Record<CalcType, string> = { wood: 'Wood cut list', metal: 'Metal weight', area: 'Area of the product', percent: 'Percentage' }
export const FACES_LABEL: Record<Faces, string> = { top: 'The top only', top_sides: 'Top and four sides', all: 'All six faces' }
export const MAX_PARTS = 40

/** A typed number, or null (the same rule as the rest of a case: commas, spaces and ₹ are fine). */
export function n(text: string | number | null | undefined): number | null {
  const t = String(text ?? '').replace(/[,\s₹]/g, '')
  return t === '' || !/^\d+(\.\d+)?$/.test(t) ? null : Number(t)
}
const r2 = (x: number) => Math.round(x * 100) / 100
const inr = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`
const fix = (x: number, d: number) => x.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })

export const emptyWoodPart = (): WoodPart => ({ name: '', qty: '1', length: '', width: '', thick: '' })
export const emptyMetalPart = (): MetalPartRow => ({ name: '', profile: 'sqtube', a: '', b: '', t: '', unit: 'mm', gauge: '', corners: 'round', length: '', length_unit: 'm', qty: '1' })
export const MS_DENSITY = String(METALS[0].density)

/** A new way of working an element out, with nothing typed yet. */
export function newCalc(type: CalcType): Calc {
  switch (type) {
    case 'wood': return { type, waste_pct: '', rate: '', labour: '', hardware: '', parts: [emptyWoodPart()] }
    case 'metal': return { type, metal: METALS[0].label, density: MS_DENSITY, rate: '', loss_pct: '', fab_per_kg: '', coat_per_sqft: '', vendor: false, weighed_kg: '', parts: [emptyMetalPart()] }
    case 'area': return { type, faces: 'top', rate: '' }
    case 'percent': return { type, pct: '', of: 'cost' }
  }
}

/** The product's size in inches, as the case gives it; area needs it. */
export type Size = { width: number | null; depth: number | null; height: number | null }

/** Square feet of the faces asked for. Null when a needed size is missing. */
export function faceArea(faces: Faces, s: Size): number | null {
  const { width: w, depth: d, height: h } = s
  if (!w || !d || (faces !== 'top' && !h)) return null
  const top = w * d
  const sides = faces === 'top' ? 0 : 2 * (w + d) * h!
  return (faces === 'all' ? 2 * top + sides : top + sides) / 144
}

export type Worked = {
  amount: number
  /** For a wood cut list: what the wood alone costs (the structure's wood share). */
  wood?: number
  /** What the row holds as quantity × rate, where that is exactly its amount (area): kept in the row's own columns. */
  quantity?: number; unit?: string; rate?: number
  /** The working in words, e.g. "0.556 cu ft in the piece, 0.722 bought (30% waste) × ₹2,200". */
  note: string
  /** What stops this row from being worked out. */
  problem?: string
}

function wood(c: WoodCalc): Worked {
  const parts = c.parts.map(p => ({ qty: n(p.qty) ?? 0, length: n(p.length) ?? 0, width: n(p.width) ?? 0, thick: n(p.thick) ?? 0 }))
  const waste = n(c.waste_pct) ?? 0
  const { net, gross } = cutList(parts, waste)
  const rate = n(c.rate) ?? 0, labour = n(c.labour) ?? 0, hardware = n(c.hardware) ?? 0
  const woodCost = r2(gross * rate)
  const problem = net <= 0 ? 'Give the sizes of at least one part of the cut list.' : rate <= 0 ? 'Give the wood rate per cu ft.' : undefined
  return {
    amount: r2(woodCost + labour + hardware), wood: woodCost, problem,
    note: `${fix(net, 3)} cu ft in the piece, ${fix(gross, 3)} bought (${waste}% waste) × ${inr(rate)} = ${inr(woodCost)}, + labour ${inr(labour)} + hardware ${inr(hardware)}`,
  }
}

/** Each metal part's weight, or what is wrong with it. */
export function metalParts(c: MetalCalc) {
  const density = n(c.density) ?? 0
  return c.parts.map(p => partWeight({
    profile: p.profile, a: n(p.a) ?? 0, b: n(p.b), t: n(p.t), unit: p.unit, gauge: n(p.gauge), corners: p.corners,
    length: n(p.length), lengthUnit: p.length_unit, qty: n(p.qty) ?? 0,
  }, density))
}

/** The calculator's kg against the scale's, when the bare frame has been weighed (null when it has not, or nothing is calculated yet). */
export function weighedGap(c: MetalCalc): { calculated: number; weighed: number; pct: number } | null {
  const weighed = n(c.weighed_kg)
  const calculated = metalParts(c).reduce((s, p) => s + ('error' in p ? 0 : p.kg), 0)
  return weighed && weighed > 0 && calculated > 0 ? { calculated, weighed, pct: (weighed - calculated) / calculated * 100 } : null
}

function metal(c: MetalCalc): Worked {
  const parts = metalParts(c)
  const bad = parts.findIndex(p => 'error' in p)
  const calculated = parts.reduce((s, p) => s + ('error' in p ? 0 : p.kg), 0)
  const sqft = parts.reduce((s, p) => s + ('error' in p ? 0 : p.sqft), 0)
  const gap = weighedGap(c)
  const kg = gap ? gap.weighed : calculated
  const loss = c.vendor ? 0 : n(c.loss_pct) ?? 0
  const kgBought = kg * (1 + loss / 100)
  const rate = n(c.rate) ?? 0, fab = c.vendor ? 0 : n(c.fab_per_kg) ?? 0, coat = n(c.coat_per_sqft) ?? 0
  const metalCost = r2(kgBought * rate), fabCost = r2(kgBought * fab), coatCost = r2(sqft * coat)
  const problem = bad >= 0 ? `Part ${bad + 1}: ${(parts[bad] as { error: string }).error}` : calculated <= 0 ? 'Add at least one part of the frame.' : rate <= 0 ? 'Give the rate per kg.' : undefined
  const kgWords = gap ? `${fix(gap.weighed, 2)} kg weighed (calculated ${fix(gap.calculated, 2)} kg, ${gap.pct >= 0 ? '+' : '−'}${fix(Math.abs(gap.pct), 1)}%)` : `${fix(kg, 2)} kg`
  const coating = `coating ${fix(sqft, 1)} sq ft = ${inr(coatCost)}`
  return {
    amount: r2(metalCost + fabCost + coatCost), problem,
    note: c.vendor
      ? `${kgWords} × ${inr(rate)} from the vendor = ${inr(metalCost)}, + ${coating}`
      : `${kgWords} + ${loss}% cut loss = ${fix(kgBought, 2)} kg × ${inr(rate)} = ${inr(metalCost)}, + fabrication ${inr(fabCost)} + ${coating}`,
  }
}

function area(c: AreaCalc, size: Size): Worked {
  const sqft = faceArea(c.faces, size)
  const rate = n(c.rate) ?? 0
  if (sqft === null) return { amount: 0, note: '', problem: `Give the product's width and depth${c.faces === 'top' ? '' : ' and height'} first.` }
  return { amount: r2(sqft * rate), quantity: r2(sqft), unit: 'sq ft', rate, note: `${FACES_LABEL[c.faces].toLowerCase()}: ${fix(sqft, 2)} sq ft × ${inr(rate)}`, problem: rate <= 0 ? 'Give the rate per sq ft.' : undefined }
}

function percent(c: PercentCalc, base: { cost: number; above: number }): Worked {
  const pct = n(c.pct)
  const of = c.of === 'cost' ? base.cost : base.above
  if (pct === null) return { amount: 0, note: '', problem: 'Give the percentage.' }
  return { amount: r2(of * pct / 100), note: `${pct}% of ${c.of === 'cost' ? 'the cost' : 'everything above'} ${inr(of)}`, problem: pct > 500 ? 'A percentage above 500 looks like a slip.' : undefined }
}

/** One row worked out. A percentage needs the rows around it: use `workLines` for a whole case. */
export function workCalc(c: Calc, size: Size, base = { cost: 0, above: 0 }): Worked {
  switch (c.type) {
    case 'wood': return wood(c)
    case 'metal': return metal(c)
    case 'area': return area(c, size)
    case 'percent': return percent(c, base)
  }
}

/**
 * Every row of a case worked out in order. `plain(i)` is the amount of a row with no calc. A percentage "of the cost" is a
 * share of every row that is not itself a percentage, wherever it stands (so 20% + 20% are added); "of everything above"
 * includes the percentages above it (so they stack).
 */
export function workLines(calcs: readonly (Calc | null)[], plain: (i: number) => number, size: Size): Worked[] {
  const first = calcs.map((c, i) => (c === null ? { amount: plain(i), note: '' } : c.type === 'percent' ? null : workCalc(c, size)))
  const cost = first.reduce((s, w) => s + (w?.amount ?? 0), 0)
  let above = 0
  return calcs.map((c, i) => {
    const w = first[i] ?? workCalc(c!, size, { cost, above })
    above += w.amount
    return w
  })
}

// ── saved form ──────────────────────────────────────────────────────────────
const num = (t: string) => n(t)
const str = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '')
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const UNITS = ['m', 'mm', 'ft', 'in'] as const

/** What the database keeps: the same shape, numbers as numbers (null when blank). */
export function packCalc(c: Calc | null) {
  if (!c) return null
  switch (c.type) {
    case 'wood': return { type: c.type, waste_pct: num(c.waste_pct), rate: num(c.rate), labour: num(c.labour), hardware: num(c.hardware),
      parts: c.parts.slice(0, MAX_PARTS).map(p => ({ name: p.name.trim().slice(0, 60), qty: num(p.qty), length: num(p.length), width: num(p.width), thick: num(p.thick) })) }
    case 'metal': return { type: c.type, metal: c.metal.trim().slice(0, 60), density: num(c.density), rate: num(c.rate), loss_pct: num(c.loss_pct), fab_per_kg: num(c.fab_per_kg), coat_per_sqft: num(c.coat_per_sqft), vendor: c.vendor, weighed_kg: num(c.weighed_kg),
      parts: c.parts.slice(0, MAX_PARTS).map(p => ({ name: p.name.trim().slice(0, 60), profile: p.profile, a: num(p.a), b: num(p.b), t: num(p.t), unit: p.unit, gauge: num(p.gauge), corners: p.corners, length: num(p.length), length_unit: p.length_unit, qty: num(p.qty) })) }
    case 'area': return { type: c.type, faces: c.faces, rate: num(c.rate) }
    case 'percent': return { type: c.type, pct: num(c.pct), of: c.of }
  }
}

/** A saved calc back into typed text. Anything that is not one of the four shapes is dropped (null). */
export function unpackCalc(v: unknown): Calc | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const parts = (Array.isArray(o.parts) ? o.parts : []).slice(0, MAX_PARTS).filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
  switch (o.type) {
    case 'wood': return { type: 'wood', waste_pct: str(o.waste_pct), rate: str(o.rate), labour: str(o.labour), hardware: str(o.hardware),
      parts: parts.map(p => ({ name: text(p.name, 60), qty: str(p.qty), length: str(p.length), width: str(p.width), thick: str(p.thick) })) }
    case 'metal': return { type: 'metal', metal: text(o.metal, 60), density: str(o.density), rate: str(o.rate), loss_pct: str(o.loss_pct), fab_per_kg: str(o.fab_per_kg), coat_per_sqft: str(o.coat_per_sqft), vendor: o.vendor === true, weighed_kg: str(o.weighed_kg),
      parts: parts.map(p => ({ name: text(p.name, 60), profile: isProfile(p.profile) ? p.profile : 'sqtube', a: str(p.a), b: str(p.b), t: str(p.t), unit: pick(p.unit, ['mm', 'in'], 'mm'), gauge: str(p.gauge),
        corners: pick(p.corners, ['round', 'sharp'], 'round'), length: str(p.length), length_unit: pick(p.length_unit, UNITS, 'm'), qty: str(p.qty) })) }
    case 'area': return { type: 'area', faces: pick(o.faces, ['top', 'top_sides', 'all'], 'top'), rate: str(o.rate) }
    case 'percent': return { type: 'percent', pct: str(o.pct), of: pick(o.of, ['cost', 'above'], 'cost') }
    default: return null
  }
}

/** A short name for a metal part, e.g. "Square tube 25 × 25 × 1.6 mm" or "… × 18 SWG". */
export function metalPartLabel(p: MetalPartRow): string {
  const s = PROFILES[p.profile]
  const sizes = [p.a, s.sizes[1] ? p.b : null, s.sizes[2] && !p.gauge ? p.t : null].filter((x): x is string => x !== null && x !== '')
  return `${s.label} ${sizes.join(' × ')} ${p.unit}${s.sizes[2] && p.gauge ? ` × ${p.gauge} SWG` : ''}`.trim()
}
