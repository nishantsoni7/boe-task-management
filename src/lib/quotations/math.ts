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
}

export type GstMode = 'igst' | 'cgst_sgst'

export type QuoteMoney = {
  gst_mode: GstMode
  discount_pct: number
  fabric_amount: number
  packing_amount: number
}

export type GstRow = { rate: number; base: number; igst: number; cgst: number; sgst: number }

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

export const GST_RATES = [0, 5, 12, 18, 28] as const

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
  const byRate = new Map<number, number>()
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
    byRate.set(l.tax_rate, (byRate.get(l.tax_rate) ?? 0) + total)
  }
  const pct = Math.min(100, Math.max(0, Number(money.discount_pct) || 0))
  const discount = Math.round((subtotal * pct) / 100)
  const extras = Math.max(0, Number(money.fabric_amount) || 0) + Math.max(0, Number(money.packing_amount) || 0)
  const taxable = subtotal - discount + extras
  // Fabric and packing are taxed with the furniture (18%). The discount is shared out across the rates.
  if (extras > 0) byRate.set(18, (byRate.get(18) ?? 0))
  const gst: GstRow[] = [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([rate, sum]) => {
    const base = Math.round(sum * (1 - pct / 100)) + (rate === 18 ? extras : 0)
    const half = Math.round((base * rate) / 200)
    return money.gst_mode === 'cgst_sgst'
      ? { rate, base, igst: 0, cgst: half, sgst: half }
      : { rate, base, igst: Math.round((base * rate) / 100), cgst: 0, sgst: 0 }
  }).filter(r => r.base > 0)
  const gstTotal = gst.reduce((s, r) => s + r.igst + r.cgst + r.sgst, 0)
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
