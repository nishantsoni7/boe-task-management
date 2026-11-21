// What the client's copy and the Excel print of the client choices (owner, 18 Nov 2026: layout 2, one table with a row per product,
// confirmed AND to-confirm rows both printed). Pure: shared by the PDF page, the client link and the Excel sheet.
// Client-safe by construction: the choice's own note ("anything the factory should know") is never read here.

import { CHOICE_KINDS, CHOICE_LABEL, choiceCounts, formatDateIN, type ChoiceKind, type LineChoice, type QuoteArea, type QuoteLine } from './math'
import { groupsOf } from './documentPlan'

export type ChoiceRow = { line: QuoteLine; area: QuoteArea | null }

/** The products that have at least one choice, in the order of the products table (room type by room type). */
export function choiceRowsOf(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): ChoiceRow[] {
  return groupsOf(areas, lines).flatMap(g => g.lines.filter(l => choiceCounts(l.choices).total > 0).map(line => ({ line, area: g.area })))
}

export const hasChoices = (lines: readonly QuoteLine[]): boolean => lines.some(l => choiceCounts(l.choices).total > 0)

export const sourceText = (c: LineChoice): string => (c.source === 'client' ? 'Client’s own' : c.source === 'code' ? 'Client’s code, we source it' : 'From our catalog')
export const statusText = (c: LineChoice): string => (c.status === 'confirmed' ? (c.confirmed_on ? `Confirmed ${formatDateIN(c.confirmed_on)}` : 'Confirmed') : 'To confirm')

/** The words of one choice, a line each: the name, "code · supplier", and where it is used. Empty parts are left out. */
export function choiceWords(c: LineChoice): string[] {
  return [c.name ?? '', [c.code, c.supplier].filter(Boolean).join(' · '), c.used_for ? `For: ${c.used_for}` : ''].filter(Boolean)
}

export { CHOICE_KINDS, CHOICE_LABEL }
export type { ChoiceKind }

// ── Which A4 page holds which rows ───────────────────────────────────────────────────────────────────
// Page units as in documentPlan.ts (1 unit = 1% of the page width; A4 is 141.4 tall). A row is the taller of the product column and
// the tallest of its four cells; a cell is an optional swatch, the words (the columns are narrow, so about 17 characters a line)
// and the chip line. The last page also holds the two signature lines. MEASURED in the headless-Edge render and kept a little generous.
const CELL_CHARS = 17, PRODUCT_CHARS = 26, WORD_LINE = 2.0, SMALL_LINE = 1.85, SWATCH_UNITS = 7.5, CHIP_UNITS = 4.8, ROW_PAD = 3
const lines = (t: string, chars: number) => (t ? Math.max(1, Math.ceil(t.length / chars)) : 0)

export const cellUnits = (c: LineChoice | undefined): number => {
  if (!c) return SMALL_LINE
  const w = choiceWords(c)
  return (c.photo ? SWATCH_UNITS : 0) + lines(w[0] ?? '', CELL_CHARS) * WORD_LINE + w.slice(1).reduce((n, x) => n + lines(x, CELL_CHARS + 3), 0) * SMALL_LINE + CHIP_UNITS
}
export const choiceRowUnits = (r: ChoiceRow): number =>
  ROW_PAD + Math.max(lines(r.line.name, PRODUCT_CHARS) * WORD_LINE + (r.area ? SMALL_LINE : 0) + (r.line.is_optional ? SMALL_LINE : 0), ...CHOICE_KINDS.map(k => cellUnits(r.line.choices?.[k])))

export const CHOICE_FIRST_UNITS = 90 // under the headline and the one-line explanation, the column heads taken off
export const CHOICE_NEXT_UNITS = 108
export const CHOICE_SIGN_UNITS = 18

/** Rows page by page. The signature lines go under the last rows; when they do not fit, the last row goes over with them, so they never stand alone. */
export function planChoicePages(rows: readonly ChoiceRow[]): ChoiceRow[][] {
  const pages: ChoiceRow[][] = []
  let i = 0
  while (i < rows.length) {
    const cap = pages.length === 0 ? CHOICE_FIRST_UNITS : CHOICE_NEXT_UNITS
    const rest = rows.slice(i).reduce((t, r) => t + choiceRowUnits(r), 0)
    if (rest + CHOICE_SIGN_UNITS <= cap) { pages.push(rows.slice(i)); break }
    let used = 0, take = 0
    while (i + take < rows.length && used + choiceRowUnits(rows[i + take]) <= cap) { used += choiceRowUnits(rows[i + take]); take++ }
    if (take === 0) take = 1
    if (i + take >= rows.length && take > 1) take -= 1 // every row fits but the signature lines do not: the last row goes over with them
    pages.push(rows.slice(i, i + take))
    i += take
  }
  return pages
}
