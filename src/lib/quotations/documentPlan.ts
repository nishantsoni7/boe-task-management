// The premium client quotation document (owner-approved 14 Nov 2026): everything that is DECIDED, not drawn. Pure and
// testable: the project types and the lead-time rules, the amounts in words, the plan of which product and table rows go
// on which A4 page, and the facts the document prints about BOE itself.

import type { QuoteArea, QuoteLine } from './math'
import type { TermBlock } from './terms'

// ── What kind of venue the quotation is for (NOT the client type, which says who the client is) ──────────────────────

export const PROJECT_TYPES = [
  ['hotel', 'Hotel'], ['resort', 'Resort'], ['restaurant', 'Restaurant'], ['cafe', 'Café'], ['brewery', 'Brewery'], ['other', 'Other'],
] as const
export type ProjectType = (typeof PROJECT_TYPES)[number][0]
export const toProjectType = (v: unknown): ProjectType | null => PROJECT_TYPES.some(([k]) => k === v) ? v as ProjectType : null
export const projectTypeLabel = (v: unknown) => PROJECT_TYPES.find(([k]) => k === v)?.[1] ?? ''
/** Rooms count for these (they come from the room types); seats count for the next kind. */
export const countsRooms = (t: ProjectType | null) => t === 'hotel' || t === 'resort'
export const countsSeats = (t: ProjectType | null) => t === 'restaurant' || t === 'cafe' || t === 'brewery'

// ── Lead time, from the day the advance is received (owner, 13 Nov 2026; edges and groupings confirmed 14 Nov) ──────────
// A resort follows the hotel rows; a café and a brewery follow the restaurant rows; "Other" and an unknown size print nothing.
// The owner's bands overlap at their edges (30 and 100 rooms, 200 and 500 seats): the lower band keeps its edge.
//   hotel, resort      up to 30 rooms 10 wks · 31 to 100 rooms 14 wks · 101 and more 16 wks
//   restaurant, café, brewery   up to 200 seats 8 wks (also below 50 seats) · 201 to 500 10 wks · 501 and more 12 wks

export type LeadTime = { weeks: number; basis: string }

/** Rooms on the quotation: the sum of the room-type multipliers. */
export const roomsOf = (areas: readonly Pick<QuoteArea, 'multiplier'>[]): number => areas.reduce((t, a) => t + Math.max(0, Math.floor(Number(a.multiplier) || 0)), 0)

export function leadTimeRule(type: ProjectType | null, rooms: number, seats: number | null): LeadTime | null {
  if (countsRooms(type)) {
    if (!(rooms > 0)) return null
    const noun = projectTypeLabel(type)
    return rooms <= 30 ? { weeks: 10, basis: `${noun}, ${rooms} rooms (up to 30 rooms)` }
      : rooms <= 100 ? { weeks: 14, basis: `${noun}, ${rooms} rooms (31 to 100 rooms)` }
      : { weeks: 16, basis: `${noun}, ${rooms} rooms (more than 100 rooms)` }
  }
  if (countsSeats(type)) {
    if (!seats || !(seats > 0)) return null
    const noun = projectTypeLabel(type)
    return seats <= 200 ? { weeks: 8, basis: `${noun}, ${seats} seats (up to 200 seats)` }
      : seats <= 500 ? { weeks: 10, basis: `${noun}, ${seats} seats (201 to 500 seats)` }
      : { weeks: 12, basis: `${noun}, ${seats} seats (more than 500 seats)` }
  }
  return null
}

// ── Amounts and counts in words ───────────────────────────────────────────────────────────────────────────────────────

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const below100 = (n: number) => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '')
const below1000 = (n: number) => n < 100 ? below100(n) : ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + below100(n % 100) : '')

/** A whole number in words, Indian grouping: 6325036 → "sixty-three lakh twenty-five thousand thirty-six". Up to 999 crore. */
export function numberInWords(n: number): string {
  const v = Math.floor(Math.abs(n))
  if (v === 0) return 'zero'
  if (v >= 1e11) return String(v)
  const parts: string[] = []
  const crore = Math.floor(v / 1e7), lakh = Math.floor((v % 1e7) / 1e5), thousand = Math.floor((v % 1e5) / 1e3), rest = v % 1e3
  if (crore) parts.push(below1000(crore) + ' crore')
  if (lakh) parts.push(below100(lakh) + ' lakh')
  if (thousand) parts.push(below100(thousand) + ' thousand')
  if (rest) parts.push(below1000(rest))
  return parts.join(' ')
}

/** "Rupees sixty-three lakh twenty-five thousand and thirty-six only". The "and" goes before the last group of words. */
export function rupeesInWords(n: number): string {
  const v = Math.floor(Math.abs(n))
  if (v === 0) return 'Rupees zero only'
  const tail = v % 1000, head = v - tail
  return `Rupees ${head && tail ? `${numberInWords(head)} and ${below1000(tail)}` : numberInWords(v)} only`
}

export const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** ₹63,25,036 → { value: '63.3', unit: 'Lakh' }; ₹2,38,12,164 → { '2.38', 'Crore' }; below a lakh stays in rupees. */
export function compactAmount(n: number): { value: string; unit: string } {
  const v = Math.round(n)
  const lakh = Math.round(v / 1e4) / 10
  if (v >= 1e7 || lakh >= 100) return { value: String(Math.round(v / 1e5) / 100), unit: 'Crore' }
  if (v >= 1e5) return { value: String(lakh), unit: 'Lakh' }
  return { value: v.toLocaleString('en-IN'), unit: 'Rupees' }
}

// ── The facts the document prints about Best of Exports ───────────────────────────────────────────────────────────────
// Proof numbers: given by the owner, 13 Nov 2026. The address and the workshop line are the catalogue's own words
// (Best of Exports Catalogue 2026, last pages). Nothing else is promised that the PI terms do not already say.

export const PROOF = [
  { value: '2,500+', label: 'Projects across the world' },
  { value: '4.5', label: 'Rated on Google', star: true },
  { value: '70K+', label: 'Followers on Instagram' },
] as const
export const WORKSHOP_LINE = 'Made in our own Jodhpur workshop and delivered across India.'
export const WEBSITE = 'bestofexports.com'
export const ADDRESS = ['290-291/17, Ganpati Vihar, Tanwara Phanta,', 'Near Suncity Warehouse, Salawas Road,', 'Jodhpur 342013, Rajasthan, India'] as const
export const ADVANCE_PCT = 70 // the PI terms: 70% at confirmation, 30% before dispatch

/** The file name the browser offers for the saved PDF: it takes the page title. */
export const documentFileName = (quoteNo: string, project: string | null | undefined, client: string): string =>
  `${quoteNo} ${(project || client).trim()}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)

// ── Which A4 page holds what ──────────────────────────────────────────────────────────────────────────────────────────
// Pages are planned here, not left to the browser, so the same pages show on a screen and come out of Save as PDF, and
// the page numbers are known. The budgets are in "row units" and are deliberately generous; src/components/quotations/
// documentPlan.render.test.tsx and the headless-browser check read the result back.

export type Group = { area: QuoteArea | null; lines: QuoteLine[] }

export function groupsOf(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): Group[] {
  return [
    ...areas.map(a => ({ area: a, lines: lines.filter(l => l.area_key === a.key) })),
    { area: null, lines: lines.filter(l => !l.area_key || !areas.some(a => a.key === l.area_key)) },
  ].filter(g => g.lines.length > 0)
}

export type ProductPage = { area: QuoteArea | null; lines: QuoteLine[]; continued: boolean }

/**
 * Products: two to a row, as many rows as fit one page (usually two rows, four products), a new page for every room type.
 * A card's height is estimated in page-width units (1 unit = 1% of the page width): the picture, the name (a long one wraps),
 * the size and material lines, the remarks (about 52 characters to a line) and the quantity line; a row is as tall as its
 * taller card. The estimate is deliberately a little generous.
 */
export const PRODUCT_PAGE_UNITS = 104
const PRODUCT_ROW_GAP = 3
export const cardUnits = (l: QuoteLine): number => {
  const text = 1 + Math.max(1, Math.ceil((l.material || '').length / 52)) + Math.ceil(((l.spec || '').length + (l.size_text || '').length * 0.2) / 52) + Math.ceil((l.client_note || '').length / 52)
  return 30.3 + 5.6 + 3.5 + (l.name.length > 27 ? 6.4 : 3.2) + text * 2.05 // measured at a picture ratio of .66: an ordinary card is 42.9, one with a two-line name 46.7
}
export function planProductPages(groups: readonly Group[]): ProductPage[] {
  const pages: ProductPage[] = []
  for (const g of groups) {
    let rows: QuoteLine[][] = [], height = 0, first = true
    const rowH = (r: QuoteLine[]) => Math.max(...r.map(cardUnits))
    const flush = () => { if (rows.length) { pages.push({ area: g.area, lines: rows.flat(), continued: !first }); first = false; rows = []; height = 0 } }
    for (const l of g.lines) {
      const open = rows[rows.length - 1]
      if (open && open.length < 2) {
        const grown = height - rowH(open) + Math.max(rowH(open), cardUnits(l))
        if (grown <= PRODUCT_PAGE_UNITS) { open.push(l); height = grown; continue }
      }
      const add = cardUnits(l) + (rows.length ? PRODUCT_ROW_GAP : 0)
      if (rows.length && height + add > PRODUCT_PAGE_UNITS) flush()
      rows.push([l]); height += cardUnits(l) + (rows.length > 1 ? PRODUCT_ROW_GAP : 0)
    }
    flush()
  }
  return pages
}

/** The price table: a row per product, a heading row per room type. The summary (subtotal to total, payment split, timeline) follows the last row, and then the extras (optional products, notes). */
export type InvRow = { kind: 'group'; area: QuoteArea } | { kind: 'line'; line: QuoteLine; area: QuoteArea | null }
export type InvestmentPage = { rows: InvRow[]; summary: boolean; extras: boolean }
export const INV_FIRST_UNITS = 16
export const INV_NEXT_UNITS = 17
/** At most this many optional products are listed under the total; the rest are on the product pages. */
export const OPTIONAL_LISTED = 12
/**
 * What the summary under the last row needs, in table-row units (measured: a quotation with a subtotal, IGST, one optional
 * product and two lines of notes takes 10.1; the estimate is a little generous). `main`: the total row, the amount in words, the
 * 70 / 30 bar and the timeline, and a row for every line of the sum table. `extras`: a box for the optional products and a box for the notes.
 */
export const summaryUnits = (a: { sumRows: number; optionalLines: number; noteLines: number }): { main: number; extras: number } => ({
  main: 5.5 + 0.55 * a.sumRows,
  extras: (a.optionalLines ? 1.45 + 0.55 * Math.min(a.optionalLines, OPTIONAL_LISTED + 1) : 0) + (a.noteLines ? 1.65 + 0.8 * a.noteLines : 0),
})
/** A row is one unit; a heading row a little more, and a product name that wraps onto a second line costs another unit. */
const rowUnits = (r: InvRow) => r.kind === 'group' ? 1.2 : (r.line.name.length > 46 ? 1.9 : 1)

/** Page by page: rows until a page is full; the summary goes under the last rows if it fits, else on a page of its own; extras that do not fit with it get a last page. */
export function planInvestmentPages(groups: readonly Group[], need: { main: number; extras: number }): InvestmentPage[] {
  const rows: InvRow[] = []
  for (const g of groups) {
    const lines = g.lines.filter(l => !l.is_optional)
    if (!lines.length) continue
    if (g.area) rows.push({ kind: 'group', area: g.area })
    for (const l of lines) rows.push({ kind: 'line', line: l, area: g.area })
  }
  const pages: InvestmentPage[] = []
  let i = 0
  while (true) {
    const cap = pages.length === 0 ? INV_FIRST_UNITS : INV_NEXT_UNITS
    let rest = 0
    for (let k = i; k < rows.length; k++) rest += rowUnits(rows[k])
    if (rest + need.main + need.extras <= cap || (i >= rows.length && need.extras === 0)) { pages.push({ rows: rows.slice(i), summary: true, extras: true }); break }
    if (rest + need.main <= cap || i >= rows.length) {
      pages.push({ rows: rows.slice(i), summary: true, extras: false })
      if (need.extras > 0) pages.push({ rows: [], summary: false, extras: true })
      break
    }
    let used = 0, take = 0
    while (i + take < rows.length && used + rowUnits(rows[i + take]) <= cap) { used += rowUnits(rows[i + take]); take++ }
    if (take === 0) take = 1
    // a room-type heading is never the last row of a page
    if (take > 1 && i + take < rows.length && rows[i + take - 1].kind === 'group') take -= 1
    pages.push({ rows: rows.slice(i, i + take), summary: false, extras: false })
    i += take
  }
  return pages
}

/** The standard terms, split over as many annex pages as their length needs (characters, with a weight for each title). */
export const TERMS_PAGE_CHARS = 7400
export type TermsSegment = { heading?: string; items: TermBlock[] }
export function planTermsPages(blocks: readonly { heading: string; items: readonly TermBlock[] }[]): TermsSegment[][] {
  const pages: TermsSegment[][] = []
  let page: TermsSegment[] = [], used = 0
  for (const b of blocks) {
    let seg: TermsSegment | null = null
    let heading: string | undefined = b.heading
    for (const t of b.items) {
      const w = t.text.length + t.title.length + 90
      if (used + w > TERMS_PAGE_CHARS && used > 0) {
        if (seg) page.push(seg)
        pages.push(page); page = []; used = 0; seg = null
      }
      if (!seg) { seg = { heading, items: [] }; used += heading ? heading.length + 60 : 0; heading = undefined }
      seg.items.push(t); used += w
    }
    if (seg) page.push(seg)
  }
  if (page.length) pages.push(page)
  return pages
}
