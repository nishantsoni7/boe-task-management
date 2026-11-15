// Pricing model v2: the parameters of a product line, read from its own words (name, size, material, finish).
// Used the same way for past price points and for the line being priced, so they are compared like for like.

import { sizeInInches } from '@/lib/quotations/math'

/** Product types, most specific first: the first type whose phrase appears in the name wins. */
export const PRODUCT_TYPES: { type: string; label: string; phrases: string[] }[] = [
  { type: 'sofa_bed', label: 'Sofa cum bed', phrases: ['sofa cum bed', 'sofa bed', 'sofa-cum-bed'] },
  { type: 'bedside', label: 'Bedside table', phrases: ['bedside', 'bed side', 'nightstand', 'night stand'] },
  { type: 'luggage_rack', label: 'Luggage rack', phrases: ['luggage'] },
  { type: 'tv_unit', label: 'TV unit', phrases: ['tv unit', 'tv console', 'tv cabinet', 'tv panel', 'tv'] },
  { type: 'headboard', label: 'Headboard', phrases: ['headboard', 'head board', 'back panel', 'bed back'] },
  { type: 'bed', label: 'Bed', phrases: ['bed', 'cot', 'divan'] },
  { type: 'coffee_table', label: 'Coffee table', phrases: ['coffee table', 'center table', 'centre table', 'teapoy'] },
  { type: 'side_table', label: 'Side table', phrases: ['side table', 'end table', 'corner table'] },
  { type: 'dining_table', label: 'Dining table', phrases: ['dining table', 'restaurant table'] },
  { type: 'desk', label: 'Desk / console', phrases: ['desk', 'console', 'study table', 'writing table', 'work table'] },
  { type: 'table', label: 'Table', phrases: ['table'] },
  { type: 'wardrobe', label: 'Wardrobe', phrases: ['wardrobe', 'almirah', 'closet'] },
  { type: 'sofa', label: 'Sofa', phrases: ['sofa', 'couch', 'settee', 'loveseat', 'love seat'] },
  { type: 'lounge_chair', label: 'Lounge / arm chair', phrases: ['lounge chair', 'arm chair', 'armchair', 'accent chair', 'easy chair', 'lounger'] },
  { type: 'bar_stool', label: 'Bar stool', phrases: ['bar stool', 'barstool', 'stool'] },
  { type: 'chair', label: 'Chair', phrases: ['chair'] },
  { type: 'bench', label: 'Bench / ottoman', phrases: ['bench', 'ottoman', 'pouf', 'pouffe'] },
  { type: 'mirror', label: 'Mirror', phrases: ['mirror'] },
  { type: 'cabinet', label: 'Cabinet / chest', phrases: ['cabinet', 'chest', 'drawer', 'sideboard', 'credenza', 'dresser'] },
  { type: 'shelf', label: 'Shelf / rack', phrases: ['shelf', 'shelves', 'rack', 'bookcase'] },
  { type: 'lamp', label: 'Lamp', phrases: ['lamp', 'light'] },
]
export const TYPE_LABEL: Record<string, string> = Object.fromEntries(PRODUCT_TYPES.map(t => [t.type, t.label]))

/** Materials, most specific first. */
const MATERIALS: [string, RegExp][] = [
  ['teak', /\bteak\b/], ['sheesham', /\b(sheesham|shisham|rosewood)\b/], ['mango', /\bmango\b/], ['acacia', /\bacacia\b/],
  ['oak', /\boak\b/], ['walnut', /\bwalnut\b/], ['ash', /\bash\s*(wood)?\b/], ['rubberwood', /\brubber\s*wood\b/], ['pine', /\bpine\b/],
  ['cane', /\b(cane|rattan|wicker)\b/], ['marble', /\b(marble|stone|granite)\b/], ['glass', /\bglass\b/],
  ['metal', /\b(metal|ms|mild steel|iron|steel|ss|stainless|aluminium|aluminum|brass)\b/],
  ['mdf', /\bmdf\b/], ['plywood', /\b(ply|plywood|bwp|mr\s*grade)\b/], ['particle', /\b(particle|pre-?lam)\b/],
  ['upholstered', /\b(fabric|upholster\w*|velvet|leatherette|leather|cushion\w*)\b/],
]
const FINISHES: [string, RegExp][] = [
  ['pu', /\b(pu|polyurethane|lacquer)\b/], ['duco', /\bduco\b/], ['laminate', /\blaminat\w*\b/], ['veneer', /\bveneer\b/],
  ['powder', /\bpowder\s*coat\w*\b/], ['paint', /\b(paint\w*|enamel)\b/], ['natural', /\b(natural|oil\w*|wax\w*)\b/], ['polish', /\bpolish\w*\b/],
]

export type LineFeatures = {
  type: string | null
  /** Plan area in square inches (the two largest dimensions), when the size can be read. */
  area: number | null
  material: string
  finish: string
  qtyBand: 'q1' | 'q11' | 'q51'
  clientType: string
}

const norm = (s: string | null | undefined) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

/** The type whose phrase comes EARLIEST in the name ("King bed with headboard" is a bed, "Headboard for a king bed"
 *  a headboard); at the same place the more specific type (earlier in PRODUCT_TYPES) wins. */
export function productType(name: string): string | null {
  // Drop a "Room type · " prefix written by the PI generator.
  const n = norm(String(name ?? '').replace(/^.*·/, ''))
  let best: { type: string; at: number } | null = null
  for (const t of PRODUCT_TYPES) {
    for (const p of t.phrases) {
      const at = n.indexOf(` ${p.replace(/[^a-z0-9]+/g, ' ')} `)
      if (at >= 0 && (!best || at < best.at)) best = { type: t.type, at }
    }
  }
  return best?.type ?? null
}

// A unit may be glued to its number ("180cm", "250mm"): a plain \b would miss it and read the size as inches.
const MM = /(?:\b|\d)mm\b/i
const CM = /(?:\b|\d)cm\b/i

/** Dimensions in inches from "6'0\" x 6'6\"", "72 x 78 x 18", "1800 x 2000 mm", "180 x 200 cm". */
export function dimensionsInches(text: string | null | undefined): number[] | null {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (/['"’”]|\bft\b|\bfeet\b/i.test(t)) return sizeInInches(t.replace(/\bft\b|\bfeet\b/gi, "'"))
  const nums = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(n => n > 0).slice(0, 3)
  if (nums.length === 0) return null
  const unit = MM.test(t) ? 1 / 25.4 : CM.test(t) ? 1 / 2.54 : /\bm\b/i.test(t) && Math.max(...nums) < 10 ? 39.37
    : Math.max(...nums) > 300 ? 1 / 25.4 : 1 // bare numbers: inches, unless they can only be millimetres
  return nums.map(n => Math.round(n * unit * 100) / 100)
}

export function planArea(dims: number[] | null): number | null {
  if (!dims || dims.length < 2) return null
  const [a, b] = [...dims].sort((x, y) => y - x)
  const area = a * b
  return area >= 4 && area <= 100_000 ? area : null
}

// ── plan size ───────────────────────────────────────────────────────────────
// What a price depends on is the footprint, not the height. PIs write the size in several ways: plain numbers ("78 x 84 x 42"),
// labelled ("Length - 72 Breadth - 24 Height - 30"), with the height marked ("36 × 24 × 30(H)", "24 x 18 x 30h"), or
// `60" Length Standard Dimension (Seating Height 18")`. The first blind test on the owner's PIs (14 Nov 2026) showed the old rule
// reading a labelled length / breadth / height as the two largest numbers, and a sofa's seat height as its depth.
// Measured on all of the owner's old PI lines (4,874 in rupees): this reading finds a footprint on 2,072 of 3,998 lines of the
// product types (1,771 before) and lowers the typical error of the fit from 44.1% to 42.5%. Plain numbers keep the old rule (the
// two largest): reading them as the template's "W x D x H" (first two) was tried and fitted no better (44.5%).

type Role = 'length' | 'breadth' | 'width' | 'depth' | 'height' | 'diameter'
// Whole words only (and the typos seen in real PIs), so "Brass 3" is not a breadth.
const ROLE: [Role, RegExp][] = [
  ['diameter', /^(dia|diameter)$/],
  ['length', /^(l|len|length|lenght|lentgh|lentdh|lenth|lengh)$/],
  ['breadth', /^(b|breadth|bredth|brth)$/],
  ['width', /^(w|wid|width|widht)$/],
  ['depth', /^(d|dep|depth)$/],
  ['height', /^(h|ht|height|hight|heigth|heght|heigh)$/],
]
const roleOf = (w: string): Role | null => ROLE.find(([, re]) => re.test(w.toLowerCase()))?.[0] ?? null
const FEET = /\d\s*'(?!')|\bft\b|\bfeet\b/i
const NUMBER = /\d+(?:\.\d+)?/g

type Found = { role: Role; value: number; at: number }
const PLAN_ROLES: Role[] = ['length', 'breadth', 'width', 'depth']

/** The two sides a reading gives: a diameter twice, or the first two different sides in the order written. */
function sidesOf(list: Found[]): number[] | null {
  const dia = list.find(f => f.role === 'diameter')
  if (dia) return [dia.value, dia.value]
  const sides = PLAN_ROLES.map(r => list.find(f => f.role === r)).filter((s): s is Found => !!s).sort((a, b) => a.at - b.at)
  return sides.length >= 2 ? [sides[0].value, sides[1].value] : null
}

/** Labelled sizes. `undefined`: read the text the plain way (no label gives a footprint); `null`: labelled, but the footprint
 *  is not given (only a length, or a seat height); a number: two labelled sides (or a diameter), in square inches. */
function labelledPlan(t: string): number | null | undefined {
  if (FEET.test(t)) return undefined
  const label: Found[] = [] // label then number: "Length - 72", "Breadth- 24", "Seating Height 18"
  for (const m of t.matchAll(/\b([a-z]+)\s*[-:=.]?\s*(\d+(?:\.\d+)?)/gi)) {
    const role = roleOf(m[1])
    if (role) label.push({ role, value: Number(m[2]), at: m.index! + m[0].length - m[2].length })
  }
  const number: Found[] = [] // number then label: `60" Length`, "78 length 60 width", "24h"
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:"|”|''|in(?:ch(?:es)?)?\b)?\s*([a-z]+)\b/gi)) {
    const role = roleOf(m[2])
    if (role) number.push({ role, value: Number(m[1]), at: m.index! })
  }
  // A text that starts with a number is read number-then-label; one with a label before its first number, label-then-number.
  const lead = t.slice(0, Math.max(0, t.search(/\d/)))
  const startsWithLabel = roleOf(/([a-z]+)\W*$/i.exec(lead)?.[1] ?? '') !== null
  const pair = (startsWithLabel ? [label, number] : [number, label]).map(sidesOf).find(p => p !== null) ?? null
  if (!pair) {
    // Only a height is labelled ("24 x 18 x 30h"): the plain way. One side labelled and the other numbers not (`L 72*24*30`): the plain way too.
    // One side labelled and nothing else to read (`Length - 56 Standard Seating Height - 18`): no footprint is given.
    const claimed = new Set([...label, ...number].map(f => f.at))
    if (![...label, ...number].some(f => PLAN_ROLES.includes(f.role))) return undefined
    const nums = (t.match(NUMBER) ?? []).map(Number)
    if (nums.length - claimed.size < 2) return null
    // A length written first ("L 72*24*30") names the order L x B x H: the first two numbers are the footprint.
    const lone = [...label, ...number].find(f => PLAN_ROLES.includes(f.role))
    return lone?.role === 'length' && lone.value === nums[0] ? footprint([nums[0], nums[1]], t) : undefined
  }
  return footprint(pair, t)
}

/** Square inches of two sides written in the unit the text uses (millimetres, centimetres, or inches). */
function footprint(pair: number[], t: string): number | null {
  const unit = MM.test(t) || Math.max(...pair) > 300 ? 1 / 25.4 : CM.test(t) ? 1 / 2.54 : 1
  const area = pair[0] * unit * pair[1] * unit
  return area >= 4 && area <= 100_000 ? area : null
}

/** The footprint in square inches from the size as a PI writes it, or null when it cannot be read. */
export function planAreaOf(text: string | null | undefined): number | null {
  const t = String(text ?? '').trim()
  if (!t) return null
  const labelled = labelledPlan(t)
  if (labelled !== undefined) return labelled
  const dims = dimensionsInches(t)
  if (!dims) return null
  // "36 x 24 x 30(H)" or "24 x 18 x 30h": the number marked as the height is not part of the footprint, wherever it stands.
  const mark = !FEET.test(t) ? /(\d+(?:\.\d+)?)\s*["”']*\s*(?:\(\s*h(?:t|eight)?\s*\)|h(?:t|eight)?\b)/i.exec(t) : null
  if (mark) {
    const at = (t.slice(0, mark.index).match(NUMBER) ?? []).length
    if (at < dims.length) dims.splice(at, 1)
  }
  // Plain numbers: the two largest, as before. Once a marked height is taken out, two numbers are left.
  const [a, b] = (mark ? dims : [...dims].sort((x, y) => y - x)).slice(0, 2)
  if (a === undefined || b === undefined) return null
  const area = a * b
  return area >= 4 && area <= 100_000 ? area : null
}

const pick = (list: [string, RegExp][], text: string) => list.find(([, re]) => re.test(text))?.[0] ?? 'unknown'

export function qtyBand(q: number | null | undefined): LineFeatures['qtyBand'] {
  const n = Number(q) || 1
  return n > 50 ? 'q51' : n > 10 ? 'q11' : 'q1'
}

export function lineFeatures(l: { name: string; size?: string | null; material?: string | null; finish?: string | null; spec?: string | null; qty?: number | null; clientType?: string | null }): LineFeatures {
  const words = norm(`${l.name} ${l.material ?? ''} ${l.spec ?? ''}`)
  return {
    type: productType(l.name),
    area: planAreaOf(l.size),
    material: pick(MATERIALS, words),
    finish: pick(FINISHES, norm(`${l.finish ?? ''} ${l.spec ?? ''} ${l.material ?? ''}`)),
    qtyBand: qtyBand(l.qty),
    clientType: l.clientType || 'unknown',
  }
}

/** The single words the database should look for to fetch every past point of a product type. */
export function fetchWordsFor(type: string): string[] {
  const t = PRODUCT_TYPES.find(x => x.type === type)
  if (!t) return []
  return [...new Set(t.phrases.flatMap(p => p.split(/[^a-z0-9]+/).filter(w => w.length >= 2)))]
}
