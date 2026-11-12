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

/** Dimensions in inches from "6'0\" x 6'6\"", "72 x 78 x 18", "1800 x 2000 mm", "180 x 200 cm". */
export function dimensionsInches(text: string | null | undefined): number[] | null {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (/['"’”]|\bft\b|\bfeet\b/i.test(t)) return sizeInInches(t.replace(/\bft\b|\bfeet\b/gi, "'"))
  const nums = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(n => n > 0).slice(0, 3)
  if (nums.length === 0) return null
  const unit = /\bmm\b/i.test(t) ? 1 / 25.4 : /\bcm\b/i.test(t) ? 1 / 2.54 : /\bm\b/i.test(t) && Math.max(...nums) < 10 ? 39.37
    : Math.max(...nums) > 300 ? 1 / 25.4 : 1 // bare numbers: inches, unless they can only be millimetres
  return nums.map(n => Math.round(n * unit * 100) / 100)
}

export function planArea(dims: number[] | null): number | null {
  if (!dims || dims.length < 2) return null
  const [a, b] = [...dims].sort((x, y) => y - x)
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
    area: planArea(dimensionsInches(l.size)),
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
