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
}

export type LineRef = { path: string; kind: 'swatch' | 'drawing' | 'reference'; note?: string }
/** The database allows 8 (quotation_line_refs_ok). */
export const MAX_LINE_REFS = 8

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
