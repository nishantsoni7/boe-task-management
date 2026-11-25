// What the client's copy and the Excel print of the client choices (owner, 18 Nov 2026: layout 2, one table with a row per product,
// confirmed AND to-confirm rows both printed). Pure: shared by the PDF page, the client link and the Excel sheet.
// Client-safe by construction: the choice's own note ("anything the factory should know") is never read here.

import { CHOICE_KINDS, CHOICE_LABEL, choiceCounts, choiceKeys, choiceLabel, costingWords, formatDateIN, isFixedKind, type ChoiceKey, type ChoiceKind, type LineChoice, type QuoteArea, type QuoteLine } from './math'
import { groupsOf } from './documentPlan'

export type ChoiceRow = { line: QuoteLine; area: QuoteArea | null }

/** A product is on the page when it has a choice or a per-piece fabric or packing figure (PR 2). */
const onThePage = (l: QuoteLine): boolean => choiceCounts(l.choices).total > 0 || !!l.costingView

/** The products on the page, in the order of the products table (room type by room type). */
export function choiceRowsOf(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): ChoiceRow[] {
  return groupsOf(areas, lines).flatMap(g => g.lines.filter(onThePage).map(line => ({ line, area: g.area })))
}

export const hasChoices = (lines: readonly QuoteLine[]): boolean => lines.some(onThePage)

/** The line under the page's title: it speaks of prices only when a product has per-piece figures (otherwise nothing here changes the price). */
export const choicesIntro = (lines: readonly QuoteLine[]): string =>
  lines.some(l => !!l.costingView)
    ? 'What you chose for your products, with the price per piece of the fabric and the packing. Rows marked To confirm still wait for your decision. Fabric and packing are added to the total; the other choices have no charge.'
    : 'What you chose for your products: fabric, finish and anything else. Rows marked To confirm still wait for your decision. None of this changes the price.'

/** The per-piece words of a product: the fabric's price (printed in its cell) and the packing line (printed under the product). Empty when none. */
export const lineCostWords = (l: QuoteLine): { fabric: string; packing: string } => costingWords(l.costingView)

export const sourceText = (c: LineChoice): string => (c.source === 'client' ? 'Client’s own' : c.source === 'code' ? 'Client’s code, we source it' : 'From our catalog')
export const statusText = (c: LineChoice): string => (c.status === 'confirmed' ? (c.confirmed_on ? `Confirmed ${formatDateIN(c.confirmed_on)}` : 'Confirmed') : 'To confirm')

/** The words of one choice, a line each: the name, "code · supplier", and where it is used. Empty parts are left out. */
export function choiceWords(c: LineChoice): string[] {
  return [c.name ?? '', [c.code, c.supplier].filter(Boolean).join(' · '), c.used_for ? `For: ${c.used_for}` : ''].filter(Boolean)
}

export { CHOICE_KINDS, CHOICE_LABEL }
export type { ChoiceKind }

// ── The table's columns (20270828000000: a choice can have any name) ─────────────────────────────────
/** One column of the choices table. "Other choices" holds every choice the named columns do not, each with its name in front. */
export type ChoiceColumn = { id: string; label: string; other?: true }
/** The A4 page has room for four choice columns beside the product. */
export const CHOICE_COLUMNS_MAX = 4
const columnOf = (k: ChoiceKey, c: LineChoice): string => (isFixedKind(k) ? k : `x:${choiceLabel(k, c).toLowerCase()}`)
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Only the choices this document uses (a per-piece fabric figure counts as fabric): the four fixed kinds first, then the others by name
 *  (the same name on two products is one column) in the order they were first added. More than four: the fourth is "Other choices". */
export function choiceColumns(lines: readonly QuoteLine[], max = CHOICE_COLUMNS_MAX): ChoiceColumn[] {
  const found = new Map<string, { label: string; order: string }>()
  const see = (id: string, label: string, order: string) => { const had = found.get(id); if (!had || order < had.order) found.set(id, { label, order }) }
  for (const l of lines) {
    if (lineCostWords(l).fabric) see('fabric', CHOICE_LABEL.fabric, '0')
    for (const k of choiceKeys(l.choices)) see(columnOf(k, l.choices![k]!), choiceLabel(k, l.choices![k]), isFixedKind(k) ? String(CHOICE_KINDS.indexOf(k)) : `9${k}`)
  }
  const cols: ChoiceColumn[] = [...found].sort((a, b) => byText(a[1].order, b[1].order)).map(([id, v]) => ({ id, label: v.label }))
  return cols.length <= max ? cols : [...cols.slice(0, max - 1), { id: 'other', label: 'Other choices', other: true }]
}

/** The choices of a product that sit in a column, each with its name. */
export function cellChoices(line: QuoteLine, col: ChoiceColumn, cols: readonly ChoiceColumn[]): { label: string; c: LineChoice }[] {
  const named = new Set(cols.filter(x => !x.other).map(x => x.id))
  return choiceKeys(line.choices)
    .filter(k => (col.other ? !named.has(columnOf(k, line.choices![k]!)) : columnOf(k, line.choices![k]!) === col.id))
    .map(k => ({ label: choiceLabel(k, line.choices![k]), c: line.choices![k]! }))
}

// ── Which A4 page holds which rows ───────────────────────────────────────────────────────────────────
// Page units as in documentPlan.ts (1 unit = 1% of the page width; A4 is 141.4 tall). A row is the taller of the product column and
// the tallest of its cells; a cell is an optional swatch, the words (with four columns about 17 characters a line; fewer columns are
// wider, so the count stays generous) and the chip line. The last page also holds the two signature lines. MEASURED in the headless-Edge
// render and kept a little generous.
const CELL_CHARS = 17, PRODUCT_CHARS = 26, WORD_LINE = 2.0, SMALL_LINE = 1.85, SWATCH_UNITS = 7.5, CHIP_UNITS = 4.8, ROW_PAD = 3
const lines = (t: string, chars: number) => (t ? Math.max(1, Math.ceil(t.length / chars)) : 0)

export const cellUnits = (c: LineChoice | undefined, extra = ''): number => {
  if (!c) return extra ? lines(extra, CELL_CHARS + 3) * SMALL_LINE : SMALL_LINE
  const w = choiceWords(c)
  return (c.photo ? SWATCH_UNITS : 0) + lines(w[0] ?? '', CELL_CHARS) * WORD_LINE + w.slice(1).reduce((n, x) => n + lines(x, CELL_CHARS + 3), 0) * SMALL_LINE + lines(extra, CELL_CHARS + 3) * SMALL_LINE + CHIP_UNITS
}
export const choiceRowUnits = (r: ChoiceRow, cols: readonly ChoiceColumn[] = choiceColumns([r.line])): number => {
  const w = lineCostWords(r.line)
  const cell = (col: ChoiceColumn) => {
    const items = cellChoices(r.line, col, cols), extra = col.id === 'fabric' ? w.fabric : ''
    // a second choice in one cell sits under a rule (.chMore, 2.2 units); "Other choices" prints each one's name above it
    return items.length ? items.reduce((t, x, i) => t + cellUnits(x.c, i === 0 ? extra : '') + (col.other ? SMALL_LINE : 0) + (i ? 2.2 : 0), 0) : cellUnits(undefined, extra)
  }
  return ROW_PAD + Math.max(lines(r.line.name, PRODUCT_CHARS) * WORD_LINE + (r.area ? SMALL_LINE : 0) + (r.line.is_optional ? SMALL_LINE : 0) + lines(w.packing, PRODUCT_CHARS) * SMALL_LINE, ...cols.map(cell))
}

export const CHOICE_FIRST_UNITS = 90 // under the headline and the one-line explanation, the column heads taken off
export const CHOICE_NEXT_UNITS = 108
export const CHOICE_SIGN_UNITS = 18

/** Rows page by page. The signature lines go under the last rows; when they do not fit, the last row goes over with them, so they never stand alone. */
export function planChoicePages(rows: readonly ChoiceRow[], cols: readonly ChoiceColumn[] = choiceColumns(rows.map(r => r.line))): ChoiceRow[][] {
  const pages: ChoiceRow[][] = []
  const units = (r: ChoiceRow) => choiceRowUnits(r, cols)
  let i = 0
  while (i < rows.length) {
    const cap = pages.length === 0 ? CHOICE_FIRST_UNITS : CHOICE_NEXT_UNITS
    const rest = rows.slice(i).reduce((t, r) => t + units(r), 0)
    if (rest + CHOICE_SIGN_UNITS <= cap) { pages.push(rows.slice(i)); break }
    let used = 0, take = 0
    while (i + take < rows.length && used + units(rows[i + take]) <= cap) { used += units(rows[i + take]); take++ }
    if (take === 0) take = 1
    if (i + take >= rows.length && take > 1) take -= 1 // every row fits but the signature lines do not: the last row goes over with them
    pages.push(rows.slice(i, i + take))
    i += take
  }
  return pages
}
