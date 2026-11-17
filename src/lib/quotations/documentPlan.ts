// The premium client quotation document (owner-approved 14 Nov 2026): everything that is DECIDED, not drawn. Pure and
// testable: the project types and the lead-time rules, the amounts in words, the plan of which table rows go
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

// The unit box of a room type is free text (a new room type and Import both say "rooms"). These words mean a room a guest can book;
// "area", "hall", "counter" and the like do not. A blank label counts as "rooms".
const ROOM_UNIT = /^(room|suite|villa|cottage|cabin|key|chalet|bungalow|tent|unit|apartment)s?$/i
export const isRoomUnit = (label: string | null | undefined): boolean => ROOM_UNIT.test((label ?? '').trim() || 'rooms')

/**
 * Rooms on the quotation: the sum of the multipliers of the room types that are really rooms, so a lobby or a restaurant (unit "area")
 * does not make "47 rooms" of 46. When no room type uses a room word at all, every room type counts, as it always did.
 * shortcut: a lobby left on the unit "rooms" still counts; upgrade = an explicit "counts as rooms" tick on each room type (a database column).
 */
export const roomsOf = (areas: readonly (Pick<QuoteArea, 'multiplier'> & { unit_label?: string | null })[]): number => {
  const sum = (list: typeof areas) => list.reduce((t, a) => t + Math.max(0, Math.floor(Number(a.multiplier) || 0)), 0)
  const rooms = areas.filter(a => isRoomUnit(a.unit_label))
  return sum(rooms.length ? rooms : areas)
}

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
// the page numbers are known. Heights are in page units (1 unit = 1% of the page width; an A4 page is 141.4 units tall).
// The estimates are deliberately a little generous; the headless-browser check reads the result back (nothing overflows).

export type Group = { area: QuoteArea | null; lines: QuoteLine[] }

export function groupsOf(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): Group[] {
  return [
    ...areas.map(a => ({ area: a, lines: lines.filter(l => l.area_key === a.key) })),
    { area: null, lines: lines.filter(l => !l.area_key || !areas.some(a => a.key === l.area_key)) },
  ].filter(g => g.lines.length > 0)
}

// ── Products and prices: ONE table (owner, 18 Nov 2026) ──────────────────────────────────────────────────────────────
// "We have separate pages for product images and the list of product with pricing ... we want it to be shown at one place
// only ... a modern table neatly laid out ... a lot of empty spacing ... keep it standard." So every product is one row:
// its picture (a fixed thumbnail, so every row with a picture is the same height), the name and what it is made of, the
// quantity, the rate and the amount. A room type is a heading row inside the same table, not a new page; a page that
// starts in the middle of a room type repeats its heading as "continued". The summary follows the last row.

/** Characters of a product name that fit one line of the product column; capitals count 1.3. MEASURED on a live quotation (18 Nov 2026):
 * the column is 41.4 units wide and the name (1.9 units) wraps at about 44 characters: 160 took 4 lines, 62 and 50 took 2, 37 took 1. */
export const NAME_LINE_CHARS = 42
export const nameLines = (name: string): number => Math.max(1, Math.ceil((name.length + 0.3 * (name.match(/[A-Z]/g) || []).length) / NAME_LINE_CHARS))
/** Characters of a size, material or remark line in the product column (1.2-unit type). */
export const SPEC_LINE_CHARS = 52
const specLines = (t: string | null | undefined) => (t ?? '').split('\n').reduce((k, x) => k + (x.trim() ? Math.ceil(x.length / SPEC_LINE_CHARS) : 0), 0)
/** The picture thumbnail's height; the row's padding; a line of the name; a line of the details. */
export const THUMB_UNITS = 10
// measured: a row's padding and rule 2.7, a name line 2.4 plus 0.4 under the name, a details line 1.8; each is rounded up
const ROW_PAD = 2.8, NAME_LINE = 2.8, SPEC_LINE = 1.85

/** A product row: the taller of its picture and its words. `perUnit`: it also prints "2 per room × 40 rooms". */
export const lineUnits = (l: QuoteLine, perUnit = false): number => {
  const words = nameLines(l.name) * NAME_LINE + SPEC_LINE * (
    (l.size_text ? Math.ceil((l.size_text.length * 1.6 + 6) / SPEC_LINE_CHARS) : 0) + specLines(l.material) + specLines(l.spec)
    + specLines(l.client_note ? `Note: ${l.client_note}` : '') + (perUnit ? 1 : 0) + (l.is_optional ? 1 : 0))
  return ROW_PAD + Math.max(l.image_path ? THUMB_UNITS : 0, words)
}
export const GROUP_UNITS = 6.4
export type TableRow = { kind: 'group'; area: QuoteArea; continued?: boolean } | { kind: 'line'; line: QuoteLine; area: QuoteArea | null }
export type TablePage = { rows: TableRow[]; summary: boolean }
/** Room for rows on the first page (under its headline) and on the pages after it, with the column heads taken off. MEASURED in the
 * real A4 render (18 Nov 2026): 107.5 and 114.4 units; about 3 are kept in reserve. A picture row measured 12.7, one with two lines of remarks 14.5. */
export const TABLE_FIRST_UNITS = 105
export const TABLE_NEXT_UNITS = 112
const perUnitOf = (l: QuoteLine, a: QuoteArea | null) => l.qty_mode === 'per_unit' && !!a && a.multiplier > 1
export const rowUnits = (r: TableRow): number => r.kind === 'group' ? GROUP_UNITS : lineUnits(r.line, perUnitOf(r.line, r.area))

/**
 * What the summary under the last row needs, in page units: the subtotal-to-total lines, the amount in words, the 70 / 30
 * bar and the timeline. Measured: 51.3 with five sum lines (planned 53).
 */
export const summaryUnits = (sumRows: number): number => 36 + 3.4 * sumRows

/**
 * Page by page: rows until a page is full; the summary goes under the last rows when it fits. When it does not, the last
 * product moves to the next page with it, so the totals never stand on a page of their own (unless even that cannot fit).
 */
export function planTablePages(groups: readonly Group[], summary: number): TablePage[] {
  const rows: TableRow[] = []
  for (const g of groups) {
    if (g.area) rows.push({ kind: 'group', area: g.area })
    for (const l of g.lines) rows.push({ kind: 'line', line: l, area: g.area })
  }
  // the rows from `from` to the end, with the "continued" heading a page starting there repeats
  const units = (from: number) => (rows[from]?.kind === 'line' && rows[from].area ? GROUP_UNITS : 0) + rows.slice(from).reduce((t, r) => t + rowUnits(r), 0)
  const pages: TablePage[] = []
  let i = 0
  while (true) {
    const cap = pages.length === 0 ? TABLE_FIRST_UNITS : TABLE_NEXT_UNITS
    const head = rows[i]
    const lead: TableRow[] = head?.kind === 'line' && head.area ? [{ kind: 'group', area: head.area, continued: true }] : []
    if (i >= rows.length || units(i) + summary <= cap) { pages.push({ rows: [...lead, ...rows.slice(i)], summary: true }); break }
    let used = lead.length ? GROUP_UNITS : 0, take = 0
    while (i + take < rows.length && used + rowUnits(rows[i + take]) <= cap) { used += rowUnits(rows[i + take]); take++ }
    if (take === 0) take = 1
    if (i + take === rows.length) {
      // every row fits but the summary does not: the last product goes over with it
      let c = rows.length - 1
      if (c > i && rows[c - 1].kind === 'group') c -= 1
      if (c > i && units(c) + summary <= TABLE_NEXT_UNITS) take = c - i
    }
    // a room-type heading is never the last row of a page
    if (take > 1 && i + take < rows.length && rows[i + take - 1].kind === 'group') take -= 1
    pages.push({ rows: [...lead, ...rows.slice(i, i + take)], summary: false })
    i += take
  }
  return pages
}

/** The notes print on the Terms and acceptance page, which has room for about this many lines of them; longer notes get a page of their own. */
export const NOTES_ON_TERMS_LINES = 10
export const noteLinesOf = (notes: string | null | undefined, transport: string | null | undefined): number =>
  (notes ? notes.split('\n').reduce((k, x) => k + Math.max(1, Math.ceil(x.length / 85)), 0) : 0) + (transport ? 1 : 0)

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
