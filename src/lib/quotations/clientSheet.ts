// The plain Excel of a quotation that the salesperson can send to a client (owner, 13 Nov 2026: "Download Excel" in the Share card).
// Rows only; the browser writes the file (downloadWorkbook). It carries what the client already sees on the printed quotation: the room
// type, the product, its size, material and remarks, the quantity, the price, the amount and the totals. Never the Finish, the internal
// notes, the contact's phone or e-mail, or any cost. The totals come from computeTotals, the same function as the builder and the document.
import { computeTotals, type QuoteArea, type QuoteLine, type QuoteMoney } from './math'

export type SheetCell = string | number | null
export type ClientSheet = { name: string; rows: SheetCell[][] }

export type ClientSheetHead = {
  quoteNo: string
  clientName: string
  projectName: string
  issuedOn: string
  validUntilOn: string
  unit: string
  transportNote: string
  /** The notes the client sees (never the internal notes). */
  notes: string
}

export const CLIENT_SHEET_COLUMNS = ['Room type', 'Product', 'Size', 'Material', 'Remarks', 'Qty', 'Rate (₹)', 'GST %', 'Amount (₹)'] as const

const areaLabel = (a: QuoteArea) =>
  `${a.name}${a.style ? ` · ${a.style}` : ''}${a.multiplier > 1 ? ` × ${a.multiplier} ${a.unit_label}` : ''}`

/** One sheet: the quotation's details, the products grouped by room type (optional ones marked and kept out of the total), then the totals. */
export function clientSheet(head: ClientSheetHead, money: QuoteMoney, areas: readonly QuoteArea[], lines: readonly QuoteLine[]): ClientSheet {
  const t = computeTotals(money, areas, lines)
  const rows: SheetCell[][] = [
    ['Quotation', head.quoteNo],
    ['Prepared for', head.clientName],
    ['Project', head.projectName || null],
    ['Date', head.issuedOn],
    ['Valid until', head.validUntilOn],
    [],
    CLIENT_SHEET_COLUMNS.map((c, i) => (i === 2 ? `Size (${head.unit})` : c)),
  ]
  // The order of the page: each room type's products, then the products that belong to no room type.
  const known = new Set(areas.map(a => a.key))
  const groups: { label: string; lines: QuoteLine[] }[] = [
    ...areas.map(a => ({ label: areaLabel(a), lines: lines.filter(l => l.area_key === a.key) })),
    { label: '', lines: lines.filter(l => !l.area_key || !known.has(l.area_key)) },
  ]
  for (const g of groups) {
    for (const l of g.lines) {
      rows.push([
        g.label || null,
        l.is_optional ? `${l.name} (optional, not in the total)` : l.name,
        l.size_text || null,
        l.material || null,
        [l.spec, l.client_note].filter(x => x.trim()).join(' · ') || null,
        t.lineQty[l.key],
        l.unit_price,
        l.tax_rate,
        t.lineTotal[l.key],
      ])
    }
  }
  rows.push([])
  const total = (label: string, value: number) => rows.push([null, null, null, null, null, null, null, label, value])
  total('Subtotal', t.subtotal)
  if (t.discount > 0) total(`Discount (${money.discount_pct}%)`, -t.discount)
  if (money.fabric_amount > 0) total('Fabric', money.fabric_amount)
  if (money.packing_amount > 0) total('Packing', money.packing_amount)
  total('Taxable value', t.taxable)
  for (const g of t.gst) {
    if (g.cgst || g.sgst) { total(`CGST ${g.rate / 2}%`, g.cgst); total(`SGST ${g.rate / 2}%`, g.sgst) }
    else total(`IGST ${g.rate}%`, g.igst)
  }
  total('Total including GST', t.grand)
  if (head.transportNote.trim()) rows.push([], ['Transport', head.transportNote.trim()])
  if (head.notes.trim()) rows.push([], ['Notes', head.notes.trim()])
  return { name: 'Quotation', rows }
}

/** The file name: the quotation number, which is a plain code (QT-NS-01006), kept safe for every file system. */
export function clientSheetFileName(quoteNo: string): string {
  const safe = quoteNo.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'quotation'
  return `${safe} quotation.xlsx`
}
