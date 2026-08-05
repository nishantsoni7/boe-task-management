// The one controlled BOE meeting-review spreadsheet.
//
// SCOPE, stated once: this parses ONE template. It does not attempt arbitrary
// spreadsheet mapping, column guessing, or fuzzy header matching beyond case
// and whitespace. A file whose headers do not match the template is rejected
// with the list of what was expected, which is a better outcome than a silent
// partial import.
//
// Everything here is pure — rows in, validated rows and errors out — so the
// validation and the (order number + SKU) matching can be asserted without a
// database or a file. The route (src/app/api/meetings/import/route.ts) turns a
// file into rows; the RPC (import_meeting_rows) re-checks and writes.

import type { MeetingType } from './types'

// ─── Template ─────────────────────────────────────────────────────────────────

/** A template column: its header text, and whether a row can omit it. */
export type TemplateColumn = {
  header: string
  field: ImportField
  required: boolean
  hint: string
}

export type ImportField =
  | 'order_number' | 'order_type' | 'customer_name' | 'expected_dispatch_date'
  | 'sku' | 'product_name' | 'quantity' | 'current_stage'
  | 'latest_update' | 'issue' | 'responsible_department' | 'next_follow_up_date'

/**
 * The template, in column order. Only four fields are required — the same four
 * without which a row means nothing: which order, which SKU, and what the
 * product is. Everything else can be filled in during the meeting.
 */
export const IMPORT_TEMPLATE_COLUMNS: readonly TemplateColumn[] = [
  { header: 'Order Number',           field: 'order_number',           required: true,  hint: 'Order or repair reference, e.g. 2041' },
  { header: 'Order Type',             field: 'order_type',             required: false, hint: 'New Order or Repair Order — defaults to the meeting type' },
  { header: 'Customer',               field: 'customer_name',          required: false, hint: 'Optional' },
  { header: 'Expected Dispatch Date', field: 'expected_dispatch_date', required: false, hint: 'DD/MM/YYYY or YYYY-MM-DD' },
  { header: 'SKU',                    field: 'sku',                    required: true,  hint: 'SKU or product reference' },
  { header: 'Product Name',           field: 'product_name',           required: true,  hint: 'Product description' },
  { header: 'Quantity',               field: 'quantity',               required: false, hint: 'Number, optional' },
  { header: 'Current Stage',          field: 'current_stage',          required: false, hint: 'e.g. Polishing, Packing' },
  { header: 'Current Update',         field: 'latest_update',          required: false, hint: 'Latest position on this SKU' },
  { header: 'Issue',                  field: 'issue',                  required: false, hint: 'Blocker, if any' },
  { header: 'Responsible Department', field: 'responsible_department', required: false, hint: 'e.g. Operations, Design' },
  { header: 'Next Follow-up Date',    field: 'next_follow_up_date',    required: false, hint: 'DD/MM/YYYY or YYYY-MM-DD' },
] as const

export const IMPORT_TEMPLATE_HEADERS: readonly string[] =
  IMPORT_TEMPLATE_COLUMNS.map(c => c.header)

/** Header text → field, tolerant of case, spacing and the hyphen in "Follow-up". */
const normalizeHeader = (raw: string): string =>
  raw.toLowerCase().replace(/[\s_-]+/g, '')

const FIELD_BY_HEADER: Map<string, ImportField> = new Map(
  IMPORT_TEMPLATE_COLUMNS.map(c => [normalizeHeader(c.header), c.field]),
)

// ─── Parsed row shapes ────────────────────────────────────────────────────────

/** One row exactly as it will be sent to `import_meeting_rows`. */
export type ImportRow = {
  order_number: string
  order_type: MeetingType | null
  customer_name: string | null
  expected_dispatch_date: string | null
  sku: string
  product_name: string
  quantity: number | null
  current_stage: string | null
  latest_update: string | null
  issue: string | null
  responsible_department: string | null
  next_follow_up_date: string | null
}

export type ImportRowError = {
  /** 1-based row number as the user sees it in the spreadsheet (header = 1). */
  rowNumber: number
  message: string
}

export type ImportPreview = {
  /** Rows that will be imported. */
  valid: ImportRow[]
  /** Rows that will not, each with the reason. */
  errors: ImportRowError[]
  /** Headers present in the file that the template does not define. Ignored, not fatal. */
  unknownHeaders: string[]
  /** Required template headers missing from the file. Fatal — nothing imports. */
  missingHeaders: string[]
  /** Distinct order numbers across the valid rows. */
  orderCount: number
}

// ─── Cell coercion ────────────────────────────────────────────────────────────

/** Everything a sheet cell can arrive as. */
type Cell = string | number | boolean | Date | null | undefined

function cellText(value: Cell): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).trim()
}

/**
 * A date cell, as an IST business date (`YYYY-MM-DD`).
 *
 * Three shapes reach here and all three are real in BOE files:
 *   * a `Date` — xlsx parsed a real date cell (the route asks for `cellDates`);
 *   * a number — an Excel serial, from a sheet where the column is General;
 *   * a string — typed by hand, in DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD.
 *
 * DD/MM is assumed for the ambiguous `03/04/2026`, because BOE writes Indian
 * dates. Returns null for anything unparseable, and the caller decides whether
 * that is an error (it is, when the cell was not empty).
 */
export function parseSheetDate(value: Cell): string | null {
  if (value == null || value === '') return null

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    // Read the UTC parts: xlsx builds date cells at UTC midnight, and reading
    // local parts in any timezone west of UTC would shift the day back one.
    return value.toISOString().slice(0, 10)
  }

  if (typeof value === 'number') {
    // Excel's serial epoch is 1899-12-30 (it treats 1900 as a leap year).
    if (!Number.isFinite(value) || value <= 0) return null
    const ms = Math.round(value) * 86_400_000 + Date.UTC(1899, 11, 30)
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
  }

  const text = String(value).trim()
  if (text === '') return null

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return isoOrNull(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (dmy) return isoOrNull(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))

  return null
}

/** Rejects 31/02 rather than rolling it forward into March. */
function isoOrNull(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return d.toISOString().slice(0, 10)
}

/** `New Order` / `new_order` / `repair` → a meeting type, or null. */
export function parseOrderType(value: Cell): MeetingType | null {
  const text = cellText(value).toLowerCase().replace(/[\s_-]+/g, '')
  if (text === '') return null
  if (text.startsWith('new')) return 'new_order'
  if (text.startsWith('repair')) return 'repair_order'
  return null
}

function parseQuantity(value: Cell): { value: number | null; invalid: boolean } {
  const text = cellText(value)
  if (text === '') return { value: null, invalid: false }
  const n = Number(text.replace(/,/g, ''))
  if (!Number.isFinite(n) || n < 0) return { value: null, invalid: true }
  return { value: n, invalid: false }
}

// ─── Parse + validate ─────────────────────────────────────────────────────────

/** A raw sheet row: header text → cell value, as `sheet_to_json` produces. */
export type RawSheetRow = Record<string, Cell>

/**
 * Turn raw sheet rows into a preview.
 *
 * Every row is reported on: a bad row does not abort the import, it is listed
 * with its reason so the user can see exactly which lines will not go in before
 * confirming. That is the whole point of a preview step.
 *
 * `rowOffset` is the sheet row the first data row occupies — 2 for a normal
 * file with one header row — so the row numbers in the error list match what
 * the user sees in Excel.
 */
export function buildImportPreview(rows: readonly RawSheetRow[], rowOffset = 2): ImportPreview {
  const present = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) present.add(normalizeHeader(key))

  const missingHeaders = IMPORT_TEMPLATE_COLUMNS
    .filter(c => c.required && !present.has(normalizeHeader(c.header)))
    .map(c => c.header)

  const unknownHeaders = [...present]
    .filter(h => !FIELD_BY_HEADER.has(h))
    .map(h => h)

  // Without the required headers there is nothing to validate row by row, and
  // reporting "order number is required" on every one of 200 rows would bury
  // the actual problem: this is the wrong file.
  if (missingHeaders.length > 0) {
    return { valid: [], errors: [], unknownHeaders, missingHeaders, orderCount: 0 }
  }

  const valid: ImportRow[] = []
  const errors: ImportRowError[] = []
  // (order + SKU) is the matching key against the database, so it is also the
  // key that cannot repeat within one file — two rows for the same SKU would
  // mean the second silently overwrites the first.
  const seen = new Map<string, number>()

  rows.forEach((raw, index) => {
    const rowNumber = index + rowOffset
    const get = (field: ImportField): Cell => {
      for (const [key, value] of Object.entries(raw)) {
        if (FIELD_BY_HEADER.get(normalizeHeader(key)) === field) return value
      }
      return null
    }

    const orderNumber = cellText(get('order_number'))
    const sku         = cellText(get('sku'))
    const productName = cellText(get('product_name'))

    // A trailing blank row is normal in a hand-edited sheet and is not an
    // error — it is simply not a row.
    if (orderNumber === '' && sku === '' && productName === '') return

    const problems: string[] = []
    if (orderNumber === '') problems.push('Order Number is required')
    if (sku === '')         problems.push('SKU is required')
    if (productName === '') problems.push('Product Name is required')

    const rawOrderType = cellText(get('order_type'))
    const orderType = parseOrderType(get('order_type'))
    if (rawOrderType !== '' && orderType === null) {
      problems.push(`Order Type "${rawOrderType}" is not New Order or Repair Order`)
    }

    const rawDispatch = cellText(get('expected_dispatch_date'))
    const dispatch = parseSheetDate(get('expected_dispatch_date'))
    if (rawDispatch !== '' && dispatch === null) {
      problems.push(`Expected Dispatch Date "${rawDispatch}" is not a valid date`)
    }

    const rawFollowUp = cellText(get('next_follow_up_date'))
    const followUp = parseSheetDate(get('next_follow_up_date'))
    if (rawFollowUp !== '' && followUp === null) {
      problems.push(`Next Follow-up Date "${rawFollowUp}" is not a valid date`)
    }

    const quantity = parseQuantity(get('quantity'))
    if (quantity.invalid) problems.push(`Quantity "${cellText(get('quantity'))}" is not a number`)

    const key = `${orderNumber.toUpperCase()}||${sku.toUpperCase()}`
    if (orderNumber !== '' && sku !== '') {
      const first = seen.get(key)
      if (first !== undefined) {
        problems.push(`Duplicate of row ${first} — same order number and SKU`)
      } else {
        seen.set(key, rowNumber)
      }
    }

    if (problems.length > 0) {
      errors.push({ rowNumber, message: problems.join('; ') })
      return
    }

    valid.push({
      order_number: orderNumber,
      order_type: orderType,
      customer_name: cellText(get('customer_name')) || null,
      expected_dispatch_date: dispatch,
      sku,
      product_name: productName,
      quantity: quantity.value,
      current_stage: cellText(get('current_stage')) || null,
      latest_update: cellText(get('latest_update')) || null,
      issue: cellText(get('issue')) || null,
      responsible_department: cellText(get('responsible_department')).toLowerCase() || null,
      next_follow_up_date: followUp,
    })
  })

  return {
    valid,
    errors,
    unknownHeaders,
    missingHeaders,
    orderCount: new Set(valid.map(r => r.order_number.toUpperCase())).size,
  }
}

// ─── Matching against what is already in the meeting ──────────────────────────

export type ExistingItemKey = { orderNumber: string; sku: string }

export type ImportMatchSummary = {
  /** Order+SKU pairs already in the meeting: these will be UPDATED. */
  updates: number
  /** Pairs not yet in the meeting: these will be ADDED. */
  additions: number
}

const matchKey = (orderNumber: string, sku: string): string =>
  `${orderNumber.trim().toUpperCase()}||${sku.trim().toUpperCase()}`

/**
 * What the confirm step promises will happen — computed with exactly the
 * normalisation the database uses (`upper(btrim(...))`), so the preview cannot
 * say "2 new" and the import then produce 1.
 *
 * Nothing in this summary is ever a deletion: an import adds and updates, and
 * a line already in the meeting but absent from the sheet is left alone
 * together with its history and its linked task.
 */
export function summarizeImportMatches(
  rows: readonly ImportRow[],
  existing: readonly ExistingItemKey[],
): ImportMatchSummary {
  const known = new Set(existing.map(e => matchKey(e.orderNumber, e.sku)))
  let updates = 0
  let additions = 0
  for (const row of rows) {
    if (known.has(matchKey(row.order_number, row.sku))) updates += 1
    else additions += 1
  }
  return { updates, additions }
}
