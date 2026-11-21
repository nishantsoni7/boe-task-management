// Quotation arithmetic, shared by the builder, the printable quotation and the client link. Money is whole
// rupees. The database sums the same way for the list (quotation_value_before_gst in 20270614000000):
// line total = round(qty × price); optional lines are not counted; discount = round(subtotal × % / 100);
// value before GST = subtotal − discount + fabric + packing.

export type QtyMode = 'per_unit' | 'fixed'

export type QuoteArea = { key: string; name: string; style: string; multiplier: number; unit_label: string }

export type QuoteLine = {
  key: string
  area_key: string | null
  name: string
  size_text: string
  spec: string
  material: string
  finish: string
  category: string
  qty_mode: QtyMode
  qty: number | null
  unit_price: number | null
  tax_rate: number
  image_path: string | null
  is_optional: boolean
  client_note: string
  internal_note: string
  /** Its other pictures (20270721000000): a swatch, a drawing, another reference. Internal: never on the client's copy. */
  references?: LineRef[]
  /** What the client picked for this product (20270808000100): fabric, finish, stone, rope weave. Internal for now; never changes a price. */
  choices?: LineChoices
  /** Fabric and packing priced per piece (20270819000000); finish has no price, only its code and picture in `choices`. */
  costing?: LineCosting
}

export type LineRef = { path: string; kind: 'swatch' | 'drawing' | 'reference'; note?: string }
/** The database allows 8 (quotation_line_refs_ok). */
export const MAX_LINE_REFS = 8

// ── client choices (20270808000100) ──────────────────────────────────────────────────────────────
export const CHOICE_KINDS = ['fabric', 'finish', 'stone', 'rope_weave'] as const
export type ChoiceKind = (typeof CHOICE_KINDS)[number]
export const CHOICE_LABEL: Record<ChoiceKind, string> = { fabric: 'Fabric', finish: 'Finish', stone: 'Stone', rope_weave: 'Rope weave' }
/** 'catalog' = picked from our catalog; 'client' = the client's own (name is then their description, supplier who supplies it);
 *  'code' = the client sends a code and BOE sources the fabric (20270819000000). */
export type LineChoice = {
  source: 'catalog' | 'client' | 'code'
  name?: string; code?: string; supplier?: string; used_for?: string; note?: string
  /** A swatch picture in quotation-images, same shape as a product's picture path. */
  photo?: string | null
  status: 'to_confirm' | 'confirmed'
  /** YYYY-MM-DD, only when confirmed. */
  confirmed_on?: string
}
export type LineChoices = Partial<Record<ChoiceKind, LineChoice>>
/** The longest each text may be (quotation_line_choices_ok). */
export const CHOICE_MAX = { name: 200, code: 80, supplier: 120, used_for: 160, note: 400 } as const

/** What is saved: only the kinds that are in use, and only the fields that have something in them (the database allows strings only). */
export function cleanChoices(c: LineChoices | undefined): LineChoices {
  const out: LineChoices = {}
  for (const k of CHOICE_KINDS) {
    const v = c?.[k]
    if (!v) continue
    const o: LineChoice = { source: v.source, status: v.status }
    for (const f of ['name', 'code', 'supplier', 'used_for', 'note'] as const) {
      const t = (v[f] ?? '').trim().slice(0, CHOICE_MAX[f])
      if (t) o[f] = t
    }
    if (v.photo) o.photo = v.photo
    if (v.status === 'confirmed' && v.confirmed_on) o.confirmed_on = v.confirmed_on
    out[k] = o
  }
  return out
}

/** How many choices a product has and how many still wait for the client. */
export function choiceCounts(c: LineChoices | undefined): { total: number; open: number } {
  const all = CHOICE_KINDS.map(k => c?.[k]).filter((v): v is LineChoice => !!v)
  return { total: all.length, open: all.filter(v => v.status !== 'confirmed').length }
}

// ── costing: fabric and packing per product (20270819000000) ─────────────────────────────────────
/**
 * Fabric and packing each carry a price PER PIECE on every product, multiplied by that product's quantity (owner, 21 Nov 2026:
 * "per piece packing cost of a product multiplied by total quantities"). Fabric = metres per piece × rupees per metre. Finish has no price:
 * it is only a code and a picture, which live in the client choices. The two sums are written into the header's fabric_amount and
 * packing_amount on every save, so everything that already reads those two keys (totals, list value, PDF, Excel, PI draft) keeps working.
 */
export type LineCosting = { fabric?: { metres?: number; rate?: number }; packing?: { type?: string; per_piece?: number } }
/** The longest packing type the database allows (quotation_line_costing_ok). */
export const PACKING_TYPE_MAX = 80

const typed = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** What is saved: only numbers that were typed (whole rupees, metres to two decimals), and an empty object when nothing is left. */
export function cleanCosting(c: LineCosting | undefined): LineCosting {
  const out: LineCosting = {}
  const metres = typed(c?.fabric?.metres), rate = typed(c?.fabric?.rate)
  if (metres !== undefined || rate !== undefined) {
    out.fabric = {}
    if (metres !== undefined) out.fabric.metres = Math.min(999.99, Math.round(metres * 100) / 100)
    if (rate !== undefined) out.fabric.rate = Math.min(10_000_000, Math.round(rate))
  }
  const type = (c?.packing?.type ?? '').trim().slice(0, PACKING_TYPE_MAX), per = typed(c?.packing?.per_piece)
  if (type || per !== undefined) {
    out.packing = {}
    if (type) out.packing.type = type
    if (per !== undefined) out.packing.per_piece = Math.min(10_000_000, Math.round(per))
  }
  return out
}

/** none = not used; ok = costed; wait = picked but no price yet; metres = a rate but no metres per piece. */
export type CostState = 'none' | 'ok' | 'wait' | 'metres'
/** per = rupees per piece, total = rupees for the quantity, priced = a number was typed (a client's own fabric with no rate is ok at ₹0 but not priced). */
export type CostPart = { state: CostState; per: number; total: number; priced: boolean }
export type LineCost = { fabric: CostPart; packing: CostPart; per: number; total: number }

const NONE: CostPart = { state: 'none', per: 0, total: 0, priced: false }

/** The fabric of a product is "in use" once it has a name or a code, or any number has been typed for it. */
export function fabricInUse(line: Pick<QuoteLine, 'choices' | 'costing'>): boolean {
  const f = line.choices?.fabric
  return !!(f && ((f.name ?? '').trim() || (f.code ?? '').trim())) || line.costing?.fabric?.metres !== undefined || line.costing?.fabric?.rate !== undefined
}

/** One product's fabric and packing for `qty` pieces: price per piece × quantity (rounded to a whole rupee per part). */
export function lineCost(line: Pick<QuoteLine, 'choices' | 'costing'>, qty: number): LineCost {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 0
  let fabric = NONE
  if (fabricInUse(line)) {
    const metres = line.costing?.fabric?.metres, rate = line.costing?.fabric?.rate
    if (rate === undefined) {
      // a client's own fabric costs nothing until a rate is typed; a catalog fabric or a code waits for its price
      fabric = line.choices?.fabric?.source === 'client' ? { state: 'ok', per: 0, total: 0, priced: false } : { state: 'wait', per: 0, total: 0, priced: false }
    } else if (!metres) {
      fabric = { state: 'metres', per: 0, total: 0, priced: true }
    } else {
      fabric = { state: 'ok', per: Math.round(metres * rate * 100) / 100, total: Math.round(q * metres * rate), priced: true }
    }
  }
  let packing = NONE
  const p = line.costing?.packing
  if (p && ((p.type ?? '').trim() || p.per_piece !== undefined)) {
    packing = p.per_piece === undefined ? { state: 'wait', per: 0, total: 0, priced: false } : { state: 'ok', per: p.per_piece, total: Math.round(q * p.per_piece), priced: true }
  }
  const parts = [fabric, packing].filter(x => x.state === 'ok')
  return { fabric, packing, per: parts.reduce((t, x) => t + x.per, 0), total: parts.reduce((t, x) => t + x.total, 0) }
}

export type CostWaiting = { key: string; name: string; what: 'fabric' | 'packing'; state: 'wait' | 'metres' }

/**
 * The two sums for the whole quotation (optional products are shown but not counted, as in the subtotal), and which pieces are still waiting for a price.
 * `any` = at least one price was typed: only then do the sums replace the typed Fabric and Packing boxes of the totals.
 */
export function costingSums(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): { fabric: number; packing: number; any: boolean; waiting: CostWaiting[] } {
  let fabric = 0, packing = 0, any = false
  const waiting: CostWaiting[] = []
  for (const l of lines) {
    if (l.is_optional) continue
    const c = lineCost(l, lineQty(l, areas))
    fabric += c.fabric.total; packing += c.packing.total
    if (c.fabric.priced || c.packing.priced) any = true
    for (const what of ['fabric', 'packing'] as const) {
      const st = c[what].state
      if (st === 'wait' || st === 'metres') waiting.push({ key: l.key, name: l.name.trim() || 'a product', what, state: st })
    }
  }
  return { fabric, packing, any, waiting }
}

/** "Bar stool fabric (price to come)" for the note under the totals. */
export const costWaitingText = (w: CostWaiting): string => `${w.name} ${w.what} (${w.state === 'wait' ? 'price to come' : 'metres per piece missing'})`

export type GstMode = 'igst' | 'cgst_sgst'

export type QuoteMoney = {
  gst_mode: GstMode
  discount_pct: number
  fabric_amount: number
  packing_amount: number
}

// One GST amount per rate (owner, 18 Nov 2026: "GST @18%, no division: this is a PI and we are not sure whether it will be the same state
// or a different state delivery"). The split into CGST + SGST or IGST is decided later, on the invoice; the header's gst_mode only goes on the PI draft.
export type GstRow = { rate: number; base: number; gst: number }

export type Totals = {
  lineQty: Record<string, number>
  lineTotal: Record<string, number>
  areaTotal: Record<string, number>
  pieces: number
  subtotal: number
  discount: number
  taxable: number
  gst: GstRow[]
  gstTotal: number
  grand: number
}

/** Everything is billed at 18% (owner, 18 Nov 2026: "we bill everything at 18%, so there is no need to divide it into GST slabs"). */
export const GST_RATE = 18

/** The quantity a line stands for: a fixed number, or so many per room × the rooms of its room type. */
export function lineQty(line: Pick<QuoteLine, 'qty_mode' | 'qty' | 'area_key'>, areas: readonly QuoteArea[]): number {
  const q = Number(line.qty) || 0
  if (q <= 0) return 0
  if (line.qty_mode === 'fixed' || !line.area_key) return q
  const area = areas.find(a => a.key === line.area_key)
  return Math.round(q * Math.max(1, Number(area?.multiplier) || 1) * 100) / 100
}

export function computeTotals(money: QuoteMoney, areas: readonly QuoteArea[], lines: readonly QuoteLine[]): Totals {
  const lineQtyMap: Record<string, number> = {}
  const lineTotal: Record<string, number> = {}
  const areaTotal: Record<string, number> = {}
  let subtotal = 0
  let pieces = 0
  for (const l of lines) {
    const qty = lineQty(l, areas)
    const total = Math.round(qty * (Number(l.unit_price) || 0))
    lineQtyMap[l.key] = qty
    lineTotal[l.key] = total
    if (l.is_optional) continue
    subtotal += total
    pieces += qty
    const ak = l.area_key ?? ''
    areaTotal[ak] = (areaTotal[ak] ?? 0) + total
  }
  const pct = Math.min(100, Math.max(0, Number(money.discount_pct) || 0))
  const discount = Math.round((subtotal * pct) / 100)
  const extras = Math.max(0, Number(money.fabric_amount) || 0) + Math.max(0, Number(money.packing_amount) || 0)
  const taxable = subtotal - discount + extras
  // One GST line: 18% of the value before GST (products less discount, plus fabric and packing). A line's own tax_rate is not used.
  const gst: GstRow[] = taxable > 0 ? [{ rate: GST_RATE, base: taxable, gst: Math.round((taxable * GST_RATE) / 100) }] : []
  const gstTotal = gst.reduce((s, r) => s + r.gst, 0)
  return { lineQty: lineQtyMap, lineTotal, areaTotal, pieces, subtotal, discount, taxable, gst, gstTotal, grand: taxable + gstTotal }
}

/** Indian states and union territories, for the place of supply. */
export const SUPPLY_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry', 'Outside India (export)',
] as const

/** BOE is registered in Rajasthan: a Rajasthan client pays CGST + SGST, anybody else IGST. */
export function gstModeForState(state: string | null | undefined): GstMode {
  return (state ?? '').trim().toLowerCase() === 'rajasthan' ? 'cgst_sgst' : 'igst'
}

const PART = /^\s*(?:(\d+(?:\.\d+)?)\s*(?:'|’|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|”|''|in|inch(?:es)?)?)?|(\d+(?:\.\d+)?)\s*(?:"|”|''|in|inch(?:es)?))\s*(?:\([^)]*\))?\s*$/i

/**
 * Sizes as clients write them, in inches: 6'0"×6'6"×1'6" → [72, 78, 18]; 48"(Length) x 56"(Height) → [48, 56];
 * "30x18x16 inches" → [30, 18, 16]. Null when any part has no unit we can trust (a bare 30 could be cm).
 */
export function sizeInInches(text: string | null | undefined): number[] | null {
  if (!text) return null
  let t = text.trim()
  const allInches = /\binch(?:es)?\s*$/i.test(t)
  t = t.replace(/\binch(?:es)?\s*$/i, '').replace(/\bQTY\b.*$/i, '').trim()
  const parts = t.split(/\s*[x×X*]\s*/).filter(Boolean)
  if (parts.length < 1 || parts.length > 3) return null
  const out: number[] = []
  for (const p of parts) {
    if (allInches && /^\d+(?:\.\d+)?$/.test(p.trim())) { out.push(Number(p)); continue }
    const m = PART.exec(p)
    if (!m) return null
    out.push(m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 12 + (m[2] !== undefined ? Number(m[2]) : 0))
  }
  return out.map(n => Math.round(n * 100) / 100)
}

/** One dimensions unit for the whole quotation (20270714000000). Switching it only changes the label: the numbers stay as typed. */
export type DimensionUnit = 'in' | 'cm'
export const DIMENSION_UNITS: readonly { value: DimensionUnit; label: string }[] = [{ value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimetres' }]
export const toDimensionUnit = (v: unknown): DimensionUnit => (v === 'cm' ? 'cm' : 'in')

const OWN_UNIT = /['"’”]|\b(?:ft|feet|foot|in|inch(?:es)?|cm|mm|m|mtr|meters?|metres?)\b/i
/** The size as typed, with the quotation's unit after it unless the text already carries one ("83 × 68" → "83 × 68 in"; 6'0" × 6'6" stays). */
export function sizeWithUnit(text: string | null | undefined, unit: DimensionUnit): string {
  const t = (text ?? '').trim()
  return !t || !/\d/.test(t) || OWN_UNIT.test(t) ? t : `${t} ${unit}`
}

const NUM = String.raw`(\d+(?:\.\d+)?)`
const FT = String.raw`(?:'|’|ft|feet|foot)`
const IN = String.raw`(?:"|”|''|in|inch(?:es)?)`
const FEET_INCHES = new RegExp(String.raw`^${NUM}\s*${FT}\s*${NUM}\s*${IN}?$`, 'i')
const WITH_UNIT = new RegExp(String.raw`^${NUM}\s*(mm|cm|mtrs?|meters?|metres?|m|${FT}|${IN})?$`, 'i')
const TO_INCHES: Record<string, number> = { mm: 1 / 25.4, cm: 0, m: 1 / 0.0254, ft: 12, in: 1 }
const unitKey = (u: string): string => {
  const x = u.toLowerCase()
  if (x === 'mm' || x === 'cm') return x
  if (/^(mtrs?|meters?|metres?|m)$/.test(x)) return 'm'
  if (/^('|’|ft|feet|foot)$/.test(x)) return 'ft'
  return 'in'
}

/**
 * A size written in mm, metres or feet, in inches rounded to the nearest 0.5 (owner, 18 Nov 2026: 8.3 → 8.5, 8.2 → 8):
 * "2000 x 900 x 450 mm" → "78.5 × 35.5 × 17.5"; 6'6" x 3' → "78 × 36". Null when there is nothing to convert: inches,
 * centimetres, a part with no unit (it may be the quotation's own), or text this cannot read; that text stays as typed.
 */
export function sizeToInches(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\([^)]*\)/g, ' ').trim()
  if (!t) return null
  const parts = t.split(/\s*[x×X*]\s*/).filter(Boolean)
  if (parts.length < 1 || parts.length > 3) return null
  const read: { n: number; unit: string | null }[] = []
  for (const p of parts) {
    const fi = FEET_INCHES.exec(p.trim())
    if (fi) { read.push({ n: Number(fi[1]) * 12 + Number(fi[2]), unit: 'in' }); continue }
    const m = WITH_UNIT.exec(p.trim())
    if (!m) return null
    read.push({ n: Number(m[1]), unit: m[2] ? unitKey(m[2]) : null })
  }
  // "2000 x 900 x 450 mm": a unit written once at the end is every part's.
  const last = read[read.length - 1].unit
  const units = read.map(r => r.unit ?? last)
  if (units.some(u => u === null || u === 'cm')) return null
  const wasFeetOrInches = parts.some(p => FEET_INCHES.test(p.trim()))
  if (units.every(u => u === 'in') && !wasFeetOrInches) return null
  const half = (n: number) => Math.round(n * 2) / 2
  return read.map((r, i) => String(half(r.n * TO_INCHES[units[i] as string]))).join(' × ')
}

/** A wa.me link with the message filled in; the person presses send in WhatsApp (no API, no cost). */
export function whatsappLink(phone: string | null | undefined, text: string): string {
  let digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 10) digits = '91' + digits
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

/** The last day the quotation holds (IST date), from the day it was sent (or made, if never sent). */
export function validUntil(issuedAtIsoDate: string, validDays: number): string {
  const d = new Date(issuedAtIsoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + Math.max(1, validDays))
  return d.toISOString().slice(0, 10)
}

export function formatDateIN(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
