// Price learning, piece 1: a forgiving reader for the PIs BOE has already made. The strict PI reader (src/lib/pi) only
// accepts the current template; old PIs use older headings ("Original price (INR)"), a sheet called "Master " with a
// trailing space, extra price columns, or a different layout altogether. This reader finds the table by its column
// NAMES, reads what is there, and proves the reading with arithmetic (quantity × price against the total column and
// the file's own Sub Total). It never repairs a figure silently: what it works out or doubts is flagged for a person.
// Pure functions over a grid of cells, so they run the same in the browser and in tests.

import { dimensionsInches } from '../features'

export type Cell = string | number | boolean | null | undefined

export type LineFlag = 'price_derived' | 'qty_derived' | 'total_differs' | 'size_unreadable' | 'qty_fraction' | 'price_unusual' | 'name_short'
export type PiLine = {
  /** 1-based row in the sheet. */
  row: number
  name: string
  size: string
  material: string
  customization: string
  qty: number
  price: number
  total: number
  /** A sample piece: its price is not a production price, so it is left out unless a person puts it back. */
  sample: boolean
  flags: LineFlag[]
}
export type PiFooter = { subtotal: number | null; discount: number | null; grandTotal: number | null }
export type ReadProblem = 'NO_TABLE' | 'NO_LINES'
export type PiReading = {
  sheet: string | null
  headerRow: number | null
  currency: 'INR' | 'USD' | 'unknown'
  lines: PiLine[]
  footer: PiFooter
  /** ISO date found near the top of the sheet, or null. */
  piDate: string | null
  /** Sum of quantity × price over every line read, sample lines included (what the file's Sub Total is compared with). */
  sumOfLines: number
  /** Rows with a name and a quantity but no price and no total: a quantities-only list, not a priced PI. */
  unpricedRows: number
  problem: ReadProblem | null
}

const norm = (v: Cell) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const text = (v: Cell) => String(v ?? '').replace(/\s+/g, ' ').trim()

export function numberOf(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = String(v ?? '').replace(/[,₹$\s]|rs\.?/gi, '')
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
}
const r2 = (n: number) => Math.round(n * 100) / 100

// ── columns ────────────────────────────────────────────────────────────────

type Key = 'name' | 'qty' | 'dims' | 'material' | 'custom' | 'price' | 'total'
const COLS: [Key, RegExp][] = [
  ['name', /^(name|product name|item name|description|item|particulars)\b/],
  ['qty', /^(quantity|qty)\b/],
  ['dims', /^(dimensions?|lxdxh|size)\b/],
  ['material', /^(material|details|specification)\b/],
  ['custom', /^(customi[sz]ation|remarks?)\b/],
  ['price', /^(cost per piece|original price|unit price|price|rate)\b/],
  ['total', /^total( cost)?( \(|$)/],
]
/** A second price column is an alternative offer ("material suggested by us", "additional PU cost"), not the price. */
const NOT_THE_PRICE = /(additional|sample|suggest|alternative|fabric|recommended|production)/

function columnsOf(row: readonly Cell[]): Partial<Record<Key, number>> | null {
  const cells = row.map(norm)
  const map: Partial<Record<Key, number>> = {}
  const taken = new Set<number>()
  for (const [key, re] of COLS) {
    const i = cells.findIndex((c, ix) => c && !taken.has(ix) && re.test(c) && !(key === 'price' && NOT_THE_PRICE.test(c)))
    if (i >= 0) { map[key] = i; taken.add(i) }
  }
  return map.name !== undefined && map.qty !== undefined && (map.price !== undefined || map.total !== undefined) ? map : null
}

function currencyOf(row: readonly Cell[], map: Partial<Record<Key, number>>): PiReading['currency'] {
  const t = [map.price, map.total].map(i => (i === undefined ? '' : norm(row[i]))).join(' ')
  if (/\(usd\)|\busd\b|\$/.test(t)) return 'USD'
  if (/\(inr\)|\binr\b|₹|\brs\b/.test(t)) return 'INR'
  return 'unknown'
}

// ── dates ──────────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}

/** A date written in a PI: an Excel date number, 12/02/2025, 12-2-25, 12 Feb 2025, Feb 12, 2025 or 2025-02-12. */
export function dateOf(v: Cell, today = new Date()): string | null {
  let out: string | null = null
  if (typeof v === 'number') {
    if (v > 36_500 && v < 60_000) out = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000).toISOString().slice(0, 10)
  } else {
    const t = text(v).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
    if (m) out = iso(+m[1], +m[2], +m[3])
    else if ((m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/))) out = iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
    else if ((m = t.match(/\b(\d{1,2})[ \-,]*([a-z]{3})[a-z]*[ \-,]*(\d{2,4})\b/)) && MONTHS.includes(m[2])) out = iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS.indexOf(m[2]) + 1, +m[1])
    else if ((m = t.match(/\b([a-z]{3})[a-z]*[ \-]*(\d{1,2})[ ,\-]+(\d{4})\b/)) && MONTHS.includes(m[1])) out = iso(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2])
  }
  if (!out) return null
  const limit = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10)
  return out >= '2015-01-01' && out <= limit ? out : null
}

const DATE_LABEL = /^(pi date|date of (the )?(pi|invoice|proforma)|invoice date|proforma date|creation date|date)\b\s*[:\-]?\s*(.*)$/

function piDateOf(grid: readonly (readonly Cell[])[], headerRow: number, today: Date): string | null {
  for (let r = 0; r < Math.min(grid.length, Math.max(headerRow, 45)); r++) {
    const row = grid[r] ?? []
    for (let c = 0; c < row.length; c++) {
      const m = typeof row[c] === 'string' ? norm(row[c]).match(DATE_LABEL) : null
      if (!m) continue
      for (const cand of [m[4], row[c + 1], row[c + 2], row[c + 3], (grid[r + 1] ?? [])[c]]) {
        const d = dateOf(cand, today)
        if (d) return d
      }
    }
  }
  return null
}

// ── the table ──────────────────────────────────────────────────────────────

const FOOTER_LABEL = /\b(sub ?total|grand total|total amount|discount|gst|igst|cgst|sgst|transport|packing|advance)\b/

function lastAmount(row: readonly Cell[]): number | null {
  for (let i = row.length - 1; i >= 0; i--) {
    const n = numberOf(row[i])
    if (n !== null && Math.abs(n) >= 1) return Math.abs(n)
  }
  return null
}

function readSheet(name: string, grid: readonly (readonly Cell[])[], today: Date): PiReading {
  const empty: PiReading = { sheet: name, headerRow: null, currency: 'unknown', lines: [], footer: { subtotal: null, discount: null, grandTotal: null }, piDate: null, sumOfLines: 0, unpricedRows: 0, problem: 'NO_TABLE' }
  let header = -1
  let map: Partial<Record<Key, number>> | null = null
  for (let r = 0; r < Math.min(grid.length, 80); r++) {
    map = columnsOf(grid[r] ?? [])
    if (map) { header = r; break }
  }
  if (header < 0 || !map) return empty
  const cols = map
  const col = (row: readonly Cell[], k: Key) => (cols[k] === undefined ? null : row[cols[k]!])

  const lines: PiLine[] = []
  const footer: PiFooter = { subtotal: null, discount: null, grandTotal: null }
  let seenFooter = false
  let unpricedRows = 0
  for (let r = header + 1; r < Math.min(grid.length, header + 600); r++) {
    const row = grid[r] ?? []
    const label = row.map(norm).join(' | ')
    const name = text(col(row, 'name'))
    let q = numberOf(col(row, 'qty'))
    let p = numberOf(col(row, 'price'))
    let t = numberOf(col(row, 'total'))
    const known = [q, p, t].filter(v => v !== null && v > 0).length
    // A footer row has its label in some column and no product in the name column.
    if (FOOTER_LABEL.test(label) && (!name || FOOTER_LABEL.test(norm(name))) && known < 3) {
      seenFooter = true
      const amount = lastAmount(row)
      if (/sub ?total/.test(label) && footer.subtotal === null) footer.subtotal = amount
      else if (/grand total/.test(label) && footer.grandTotal === null) footer.grandTotal = amount
      else if (/discount/.test(label) && footer.discount === null) footer.discount = amount
      continue
    }
    if (seenFooter && footer.subtotal !== null) continue
    if (!name || norm(name) === norm(col(grid[header] ?? [], 'name'))) continue
    if (known < 2) { if (q !== null && q > 0 && !(p !== null && p > 0) && !(t !== null && t > 0)) unpricedRows++; continue }

    const flags: LineFlag[] = []
    if (q !== null && q > 0 && p !== null && p > 0) {
      if (t !== null && t > 0 && Math.abs(t - q * p) > Math.max(1, q * p * 0.005)) flags.push('total_differs')
      t = r2(q * p)
    } else if (q !== null && q > 0 && t !== null && t > 0) {
      p = r2(t / q); flags.push('price_derived')
    } else if (p !== null && p > 0 && t !== null && t > 0) {
      q = r2(t / p); flags.push('qty_derived')
      if (Math.abs(q - Math.round(q)) < 0.02) q = Math.round(q)
    } else continue

    const size = text(col(row, 'dims'))
    const custom = text(col(row, 'custom'))
    if (q! % 1 !== 0) flags.push('qty_fraction')
    // "Standard dimensions, seating height 18"" has no plan size to read, and that is fine; two numbers we cannot place are worth a look.
    if (size && (size.match(/\d+(?:\.\d+)?/g) ?? []).length >= 2 && dimensionsInches(size) === null) flags.push('size_unreadable')
    if (p! < 50 || p! > 5_000_000) flags.push('price_unusual')
    if (name.length < 3) flags.push('name_short')
    lines.push({
      row: r + 1, name, size, material: text(col(row, 'material')), customization: custom,
      qty: q!, price: p!, total: r2(q! * p!), sample: /\bsample\b/i.test(name), flags,
    })
  }

  return {
    sheet: name, headerRow: header + 1, currency: currencyOf(grid[header] ?? [], cols), lines, footer,
    piDate: piDateOf(grid, header, today), sumOfLines: r2(lines.reduce((s, l) => s + l.total, 0)), unpricedRows,
    problem: lines.length === 0 ? 'NO_LINES' : null,
  }
}

/** Every sheet is tried; the one that gives the most product lines wins (a sheet named "Master" breaks a tie). */
export function readPiGrids(sheets: readonly { name: string; grid: readonly (readonly Cell[])[] }[], today = new Date()): PiReading {
  let best: PiReading | null = null
  for (const s of sheets) {
    const r = readSheet(s.name, s.grid, today)
    const better = !best || r.lines.length > best.lines.length || (r.lines.length === best.lines.length && r.lines.length > 0 && /^master/i.test(s.name) && !/^master/i.test(best.sheet ?? ''))
    if (better) best = r
  }
  return best ?? { sheet: null, headerRow: null, currency: 'unknown', lines: [], footer: { subtotal: null, discount: null, grandTotal: null }, piDate: null, sumOfLines: 0, unpricedRows: 0, problem: 'NO_TABLE' }
}

// ── judging a reading ──────────────────────────────────────────────────────

export type PiVerdict = {
  status: 'ready' | 'check' | 'left_out'
  /** Why it is left out, or what to look at. */
  reasons: string[]
  /** Doubtful cells on lines, plus a Sub Total that does not match and a missing date. */
  toCheck: number
}

const tolerance = (n: number) => Math.max(2, n * 0.002)

/** Sub Total in the file against the lines read: true / false, or null when the file has no Sub Total. */
export function subtotalMatches(r: PiReading): boolean | null {
  return r.footer.subtotal === null ? null : Math.abs(r.footer.subtotal - r.sumOfLines) <= tolerance(r.sumOfLines)
}

export function judge(r: PiReading, hasDate: boolean): PiVerdict {
  if (r.problem === 'NO_TABLE') return { status: 'left_out', reasons: ['No product table was found (no heading row with Name, Quantity and a price).'], toCheck: 0 }
  if (r.problem === 'NO_LINES') return { status: 'left_out', reasons: [r.unpricedRows > 0 ? 'The table has quantities but no prices filled in, so there is nothing to learn.' : 'The product table has no lines with a quantity and a price.'], toCheck: 0 }
  if (r.currency === 'USD') return { status: 'left_out', reasons: ['The prices are in US dollars, and the model learns rupee prices.'], toCheck: 0 }
  const reasons: string[] = []
  // A worked-out figure is exact arithmetic, and a size we cannot place only costs the model the plan area: both are shown, neither blocks.
  const SOFT: LineFlag[] = ['price_derived', 'qty_derived', 'size_unreadable']
  const cells = r.lines.filter(l => !l.sample).reduce((n, l) => n + l.flags.filter(f => !SOFT.includes(f)).length, 0)
  if (cells) reasons.push(`${cells} cell${cells === 1 ? '' : 's'} to check`)
  if (subtotalMatches(r) === false) reasons.push(`The file's Sub Total (${Math.round(r.footer.subtotal!).toLocaleString('en-IN')}) differs from the lines (${Math.round(r.sumOfLines).toLocaleString('en-IN')})`)
  if (!hasDate) reasons.push('The PI date was not found: enter it')
  return { status: reasons.length ? 'check' : 'ready', reasons, toCheck: cells + (subtotalMatches(r) === false ? 1 : 0) + (hasDate ? 0 : 1) }
}

// ── order facts and fingerprints ───────────────────────────────────────────

export type OrderFacts = { pieces: number; designs: number; subtotal: number; discount: number | null; valueBeforeGst: number }

/** What the whole order looked like, from the lines that will be learned (sample lines and unticked lines are not). */
export function orderFacts(kept: readonly Pick<PiLine, 'name' | 'qty' | 'price'>[], discount: number | null): OrderFacts {
  const subtotal = r2(kept.reduce((s, l) => s + l.qty * l.price, 0))
  return {
    pieces: r2(kept.reduce((s, l) => s + l.qty, 0)),
    designs: new Set(kept.map(l => norm(l.name))).size,
    subtotal, discount, valueBeforeGst: r2(subtotal - (discount ?? 0)),
  }
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export const hashBytes = (bytes: Uint8Array) => sha256Hex(bytes)

/** The same PI saved under another file name has the same lines: this is what two copies share. */
export const contentPrint = (lines: readonly Pick<PiLine, 'name' | 'qty' | 'price'>[]) =>
  sha256Hex(lines.map(l => `${norm(l.name)}|${l.qty}|${l.price}`).sort().join('\n'))

/** Two PIs of one project: most product names in common. The older one is the revision to leave out. */
export function sameProject(a: readonly Pick<PiLine, 'name'>[], b: readonly Pick<PiLine, 'name'>[]): boolean {
  const A = new Set(a.map(l => norm(l.name))), B = new Set(b.map(l => norm(l.name)))
  const shared = [...A].filter(n => B.has(n)).length
  return shared >= 4 && shared / Math.min(A.size, B.size) >= 0.7
}
