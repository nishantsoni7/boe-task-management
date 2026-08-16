// Turning a parsed PI into something a person can read.
//
// Phase 3A shows an uploaded workbook back to the employee who chose it, and
// stops there. Nothing here writes a file, opens a network connection, touches
// Supabase, or allocates an official Order number — exactly like src/lib/pi's
// parser, and for the same reason: a preview is a reading of a document, not a
// record of one.
//
// WHY A SEPARATE MODULE FROM THE PAGE. Everything below is a pure function of
// its inputs (the one exception, object-URL creation, takes its impure half as
// an INJECTED factory). That is what makes the rules a reviewer actually cares
// about — how money is written, what a parse failure says to a human, what
// counts as blocking, the fact that the number printed on the supplied workbook
// is NOT an order number — testable under `node --test` without rendering a
// component or mocking a browser.
//
// THREE RULES THIS MODULE DOES NOT BEND:
//
//   1. It never repairs or recomputes a workbook figure. The parser already
//      refuses to; a formatter that "fixed" a total would reintroduce exactly
//      the disagreement the parser exists to surface. The only arithmetic here
//      is the 40% advance, which is derived FROM the grand total and labelled
//      as a requirement, never as a payment.
//   2. It never presents `sourceOrderNumber` as an order number. See
//      describeSourceReference.
//   3. Text out of a workbook is returned as text. Nothing here builds markup,
//      and no caller may pass these strings to dangerouslySetInnerHTML.

import { PI_MAX_WORKBOOK_BYTES } from './workbookReader'
import type {
  PiAmountOrText,
  PiBlockingIssue,
  PiCommercialSummary,
  PiDateValue,
  PiError,
  PiHeader,
  PiImageRole,
  PiProductImage,
  PiWarning,
} from './types'

// ── File acceptance ───────────────────────────────────────────────────────────

/** The only extension accepted. Checked case-insensitively. */
export const PI_ACCEPTED_EXTENSION = '.xlsx'

/** The `accept` attribute for the file input. Extension AND media type, because
 *  Windows and macOS file pickers filter on different ones. */
export const PI_FILE_INPUT_ACCEPT =
  '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type PiFileRejectionReason =
  /** Not a .xlsx by extension. .xls, .xlsm, .csv and .pdf all land here. */
  | 'NOT_XLSX'
  /** Over PI_MAX_WORKBOOK_BYTES — refused before a byte is read. */
  | 'TOO_LARGE'
  /** Zero bytes. A file picker can hand back an empty placeholder. */
  | 'EMPTY'

export type PiFileCheck =
  | { ok: true }
  | { ok: false; reason: PiFileRejectionReason; title: string; message: string }

/** 10485760 → "10 MB". Integer MiB only; that is all this limit ever is. */
export function formatByteLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/**
 * Decide whether a chosen file is worth opening, from its name and size alone.
 *
 * EXTENSION IS AUTHORITATIVE, not the browser's media type: the same .xlsx
 * arrives as the OOXML type on one machine, as application/octet-stream on
 * another, and as '' from a drag-and-drop on a third. Keying on `type` would
 * reject genuine workbooks on ordinary desktops. The archive itself is
 * validated a moment later by openPiArchive, which is the check that actually
 * establishes the file is a workbook — this one only avoids reading 10 MB of
 * something that was never going to be one.
 */
export function checkPiFile(file: { name: string; size: number }): PiFileCheck {
  const name = file.name ?? ''
  if (!name.toLowerCase().endsWith(PI_ACCEPTED_EXTENSION)) {
    return {
      ok: false,
      reason: 'NOT_XLSX',
      title: 'That is not an Excel workbook',
      message: `Only ${PI_ACCEPTED_EXTENSION} files can be read. Open the PI in Excel and save it as .xlsx, then try again.`,
    }
  }
  if (file.size <= 0) {
    return {
      ok: false,
      reason: 'EMPTY',
      title: 'That file is empty',
      message: 'The selected file contains no data. Check the file and select it again.',
    }
  }
  if (file.size > PI_MAX_WORKBOOK_BYTES) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      title: 'That file is too large',
      message: `The PI must be ${formatByteLimit(PI_MAX_WORKBOOK_BYTES)} or smaller. Compress the images in the workbook and save it again.`,
    }
  }
  return { ok: true }
}

// ── Money ─────────────────────────────────────────────────────────────────────

/**
 * Indian digit grouping: last three digits, then pairs.
 *
 * Written out rather than delegated to toLocaleString('en-IN') on purpose. The
 * result of this function ends up beside figures a client has already been
 * sent, so it must be identical on every machine and in every test run,
 * regardless of which ICU data the runtime happens to carry.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

/**
 * A rupee figure: Indian grouping, and paise ONLY when there are paise.
 *
 * BOE prices in whole rupees almost everywhere, and a column of ₹5,200.00 /
 * ₹1,10,000.00 spends two characters per line saying "nothing after the point".
 * Trailing zeroes are dropped, so ₹5,200 reads as ₹5,200 — and ₹3,50,625.20
 * still shows its paise, because there the fraction is part of the figure.
 *
 * Rounded to paise BEFORE the decision, so a float artefact such as
 * 40000.000000001 is a whole-rupee ₹40,000 rather than ₹40,000.00. A non-finite
 * input returns the em dash rather than "₹NaN".
 */
export function formatInr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—'
  const negative = amount < 0
  const [int, frac] = Math.abs(amount).toFixed(2).split('.')
  const rupees = `${negative ? '−' : ''}₹${groupIndian(int)}`
  return frac === '00' ? rupees : `${rupees}.${frac}`
}

export type PiValueKind = 'amount' | 'text' | 'notApplicable' | 'included' | 'missing'

export type PiValueDisplay = {
  kind: PiValueKind
  /** What to render. Always a non-empty string. */
  display: string
  /** The number, when there is one. Callers doing arithmetic use this and
   *  never re-parse `display`. */
  amount: number | null
}

/** What the two worded zeroes read as on screen. */
export const NOT_APPLICABLE_TEXT = 'Not applicable'
export const INCLUDED_TEXT = 'Included'

/**
 * Render one commercial cell as the workbook meant it.
 *
 * The cases are the parser's, unchanged and in its order of precedence: the two
 * worded zeroes first (their `amount` is already 0), then a real figure, then
 * preserved text such as transportation's "as applicable", then an empty cell
 * that means nothing at all.
 *
 * NEITHER WORDED ZERO IS SHOWN AS ₹0. A reviewer must be able to tell a
 * deliberate nil charge from a typed zero — and, more importantly, to tell
 * "Not applicable" from "Included". Both add nothing to the total, but one says
 * the client is not being charged for packing and the other says they are,
 * inside another line. Printing the same words for both would misreport the
 * document the client was sent, so they render as their own distinct strings
 * and the source wording stays on the record for audit.
 */
export function formatPiValue(value: PiAmountOrText | null | undefined): PiValueDisplay {
  if (!value) return { kind: 'missing', display: '—', amount: null }
  if (value.zeroMeaning === 'notApplicable') {
    return { kind: 'notApplicable', display: NOT_APPLICABLE_TEXT, amount: value.amount ?? 0 }
  }
  if (value.zeroMeaning === 'included') {
    return { kind: 'included', display: INCLUDED_TEXT, amount: value.amount ?? 0 }
  }
  if (value.amount !== null) return { kind: 'amount', display: formatInr(value.amount), amount: value.amount }
  if (value.text !== null && value.text !== '') return { kind: 'text', display: value.text, amount: null }
  return { kind: 'missing', display: '—', amount: null }
}

// ── Dates ─────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * A header date, formatted from its ISO string WITHOUT constructing a Date.
 *
 * `new Date('2026-08-16')` is parsed as UTC midnight and then rendered in the
 * viewer's zone, which turns a 16 August PI into 15 August for anyone west of
 * Greenwich. The parser already resolved the serial to a calendar date; this
 * only re-spells it, so the string is the same in Jaipur and in a CI runner.
 *
 * A cell that held words rather than a serial keeps its words — "6 weeks from
 * date of confirmation" is the commitment, and it is shown as written.
 */
export function formatPiDate(value: PiDateValue | null | undefined): string {
  if (!value) return '—'
  if (value.iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.iso)
    if (m) {
      const month = MONTHS[Number(m[2]) - 1]
      if (month) return `${Number(m[3])} ${month} ${m[1]}`
    }
  }
  return value.text && value.text.trim() !== '' ? value.text : '—'
}

/** Any optional text cell: the em dash stands in for "the PI says nothing". */
export function orDash(text: string | null | undefined): string {
  return text !== null && text !== undefined && text.trim() !== '' ? text : '—'
}

/**
 * Customization is optional BY DESIGN — most product rows genuinely have none,
 * which is why the parser never raises a blocking issue for it. An em dash here
 * would read as "unknown"; "No customization" says the PI was checked and there
 * is none, which is the fact.
 */
export const NO_CUSTOMIZATION_TEXT = 'No customization'

export function formatCustomization(text: string | null | undefined): string {
  return text !== null && text !== undefined && text.trim() !== '' ? text : NO_CUSTOMIZATION_TEXT
}

// ── Header summary ────────────────────────────────────────────────────────────

export type PiSummaryRow = {
  key: string
  label: string
  value: string
}

/**
 * The compact "what is this PI" block.
 *
 * Names only. Phone numbers, GST registrations and full postal addresses are
 * parsed and available, and are deliberately NOT put on this screen: the
 * reviewer's question at this step is "is this the right client and the right
 * commitment", and every extra personal field is one more thing on a shared
 * office monitor for no decision it helps make.
 *
 * `header.sourceOrderNumber` (B20) IS NOT HERE, and must not be added. The
 * number printed on a supplied workbook is source data the parser keeps for
 * audit; on screen it can only be read as an order number, and an imported PI
 * has none until management approval allocates one. Showing it with a
 * disclaimer was tried and was still read as a number, so it is not shown at
 * all. A test asserts its absence from what this function returns.
 */
export function buildHeaderRows(header: PiHeader): PiSummaryRow[] {
  return [
    { key: 'client',     label: 'Client',              value: orDash(header.billToName) },
    { key: 'created',    label: 'PI created',          value: formatPiDate(header.creationDate) },
    { key: 'createdBy',  label: 'Created by',          value: orDash(header.createdBy) },
    { key: 'billTo',     label: 'Bill to',             value: orDash(header.billToName) },
    { key: 'shipTo',     label: 'Ship to',             value: orDash(header.shipToName) },
    { key: 'confirmed',  label: 'Order confirmed',     value: formatPiDate(header.orderConfirmationDate) },
    { key: 'dispatch',   label: 'Dispatch commitment', value: formatPiDate(header.dispatchCommitment) },
  ]
}

// ── Commercial summary ────────────────────────────────────────────────────────

/** The standard advance BOE requires against a confirmed order. */
export const PI_ADVANCE_PERCENT = 40

export const ADVANCE_NOT_A_PAYMENT_NOTE =
  'Required advance only. No payment has been recorded or requested.'

export type PiAmountRow = PiSummaryRow & {
  kind: PiValueKind
  /** Rendered heavier: the grand total and the advance. */
  emphasis?: 'total' | 'advance'
  note?: string
}

/**
 * 40% of the grand total.
 *
 * Computable only when the grand total is a real figure. A workbook whose
 * I122 holds text has no grand total to take a percentage of, and the honest
 * answer there is an em dash — not a number derived from a guess.
 *
 * Rounded to paise so the figure is a payable amount rather than a float
 * artefact (₹1,00,000.00 × 0.4 must not print as ₹40,000.000000001).
 */
export function computeRequiredAdvance(grandTotal: PiAmountOrText | null | undefined): number | null {
  const total = formatPiValue(grandTotal)
  if (total.kind !== 'amount' || total.amount === null) return null
  return Math.round(total.amount * PI_ADVANCE_PERCENT) / 100
}

/**
 * Every commercial line, in the order the PI itself lays them out.
 *
 * `grossProductAmount` and the advance are the only derived rows. The other
 * eight are the workbook's own cells, formatted and not touched — including the
 * ones that disagree with each other, which the warnings panel reports
 * separately rather than this function silently reconciling.
 */
export function buildCommercialRows(commercial: PiCommercialSummary): PiAmountRow[] {
  const rows: PiAmountRow[] = [
    {
      key: 'gross',
      label: 'Gross product amount',
      value: formatInr(commercial.grossProductAmount),
      kind: 'amount',
    },
    {
      // ALWAYS "Discount", never the workbook's own wording.
      //
      // The template labels this row "Design Fees" in some files and "Discount"
      // in others, for the same cell with the same meaning. Echoing the label
      // produced "Discount (Discount)" on half the PIs and "Discount (Design
      // Fees)" on the rest — noise on one and, on the other, an invitation to
      // read a design fee as something other than the deduction it is. The
      // parser keeps `discountLabel` for audit; the screen states the meaning.
      key: 'discount',
      label: 'Discount',
      value: formatInr(commercial.discount),
      kind: 'amount',
    },
  ]

  const cells: { key: string; label: string; value: PiAmountOrText }[] = [
    { key: 'subtotal',       label: 'Subtotal after discount', value: commercial.subtotalAfterDiscount },
    { key: 'fabric',         label: 'Fabric cost',             value: commercial.fabricCost },
    { key: 'packing',        label: 'Packing cost',            value: commercial.packingCost },
    { key: 'transportation', label: 'Transportation',          value: commercial.transportation },
    { key: 'beforeGst',      label: 'Total before GST',        value: commercial.totalBeforeGst },
    { key: 'gst',            label: 'GST',                     value: commercial.gst },
  ]
  for (const cell of cells) {
    const shown = formatPiValue(cell.value)
    rows.push({ key: cell.key, label: cell.label, value: shown.display, kind: shown.kind })
  }

  const grand = formatPiValue(commercial.grandTotal)
  rows.push({
    key: 'grandTotal',
    label: 'Grand Total',
    value: grand.display,
    kind: grand.kind,
    emphasis: 'total',
  })

  const advance = computeRequiredAdvance(commercial.grandTotal)
  rows.push({
    key: 'advance',
    label: `Required advance (${PI_ADVANCE_PERCENT}%)`,
    value: advance === null ? '—' : formatInr(advance),
    kind: advance === null ? 'missing' : 'amount',
    emphasis: 'advance',
    note: ADVANCE_NOT_A_PAYMENT_NOTE,
  })

  return rows
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export const BLOCKING_PANEL_TITLE = 'Must be fixed before submission'
export const WARNING_PANEL_TITLE = 'Worth checking'
export const READY_TITLE = 'PI ready for submission'

export type PiDiagnosticEntry = {
  code: string
  message: string
  /** "Row 34", "Row 34 · C34", "Cell I117", or null for a whole-workbook note. */
  location: string | null
  /** Kept for sorting and for scrolling a caller to the product row. */
  row: number | null
}

export type PiDiagnosticGroups = {
  /** Every one of these stops a submission. Never merged with the warnings. */
  blocking: PiDiagnosticEntry[]
  /** Judgement calls. Shown, never hidden, never promoted. */
  warnings: PiDiagnosticEntry[]
  /** True only when `blocking` is empty. Says nothing about the warnings —
   *  a PI with five warnings and no blocking issue is submittable. */
  readyToSubmit: boolean
}

function locationOf(item: { row?: number | null; cell?: string | null }): string | null {
  const row = item.row ?? null
  const cell = item.cell ?? null
  if (row !== null && cell) return `Row ${row} · ${cell}`
  if (row !== null) return `Row ${row}`
  if (cell) return `Cell ${cell}`
  return null
}

/** Row-bearing entries first and in row order; whole-workbook notes last. A
 *  reviewer works down the product table, so the list should follow it. */
function byRowThenCode(a: PiDiagnosticEntry, b: PiDiagnosticEntry): number {
  if (a.row !== b.row) {
    if (a.row === null) return 1
    if (b.row === null) return -1
    return a.row - b.row
  }
  return a.code.localeCompare(b.code)
}

/**
 * Split what the parser reported into the two panels the screen shows.
 *
 * The split is the parser's, not this function's: a PiBlockingIssue is blocking
 * and a PiWarning is not. Nothing here reclassifies one as the other, because
 * the decision about what stops an order belongs with the rules that define it.
 */
export function groupPiDiagnostics(input: {
  blockingIssues: readonly PiBlockingIssue[]
  warnings: readonly PiWarning[]
}): PiDiagnosticGroups {
  const blocking = input.blockingIssues
    .map<PiDiagnosticEntry>(issue => ({
      code: issue.code,
      message: issue.message,
      location: locationOf(issue),
      row: issue.row,
    }))
    .sort(byRowThenCode)

  const warnings = input.warnings
    .map<PiDiagnosticEntry>(warning => ({
      code: warning.code,
      message: warning.message,
      location: locationOf(warning),
      row: warning.row ?? null,
    }))
    .sort(byRowThenCode)

  return { blocking, warnings, readyToSubmit: blocking.length === 0 }
}

// ── Parse failures ────────────────────────────────────────────────────────────

/** Which of the five things went wrong, so the screen can say the right one. */
export type PiFailureCategory =
  | 'file_type'
  | 'file_size'
  | 'unreadable'
  | 'master_sheet'
  | 'template'
  | 'content'

export type PiFailureDisplay = {
  category: PiFailureCategory
  title: string
  message: string
  /** Codes and parser detail, for the collapsed "Technical details" area. Kept
   *  available because a template mismatch is only fixable if you can see which
   *  header cell disagreed. */
  technical: string[]
}

const FAILURE_BY_CODE: Record<string, { category: PiFailureCategory; title: string; message: string }> = {
  INPUT_TOO_LARGE: {
    category: 'file_size',
    title: 'That file is too large',
    message: `The PI must be ${formatByteLimit(PI_MAX_WORKBOOK_BYTES)} or smaller. Compress the images in the workbook and save it again.`,
  },
  INVALID_ZIP: {
    category: 'file_type',
    title: 'This file could not be opened as an Excel workbook',
    message: 'It may be damaged, incomplete, or saved in an older format. Open it in Excel, save it again as .xlsx, and upload the new file.',
  },
  MISSING_WORKBOOK_PARTS: {
    category: 'unreadable',
    title: 'This workbook is incomplete',
    message: 'Parts that every Excel file must contain are missing, so it cannot be read. Open it in Excel and save a fresh copy.',
  },
  UNSAFE_ENTRY_NAME: {
    category: 'unreadable',
    title: 'This workbook could not be opened safely',
    message: 'It contains entries that do not belong in an Excel file and was not read. Save a fresh copy from Excel and upload that.',
  },
  DUPLICATE_ENTRY: {
    category: 'unreadable',
    title: 'This workbook could not be opened safely',
    message: 'It contains repeated internal parts and was not read. Save a fresh copy from Excel and upload that.',
  },
  TOO_MANY_ENTRIES: {
    category: 'unreadable',
    title: 'This workbook could not be opened safely',
    message: 'It contains far more internal parts than a PI does and was not read. Check that this is the right file.',
  },
  DECOMPRESSED_TOO_LARGE: {
    category: 'unreadable',
    title: 'This workbook could not be opened safely',
    message: 'Its contents expand to far more than a PI should and it was not read. Check that this is the right file.',
  },
  MASTER_SHEET_MISSING: {
    category: 'master_sheet',
    title: 'No “Master” sheet in this workbook',
    message: 'A BOE PI keeps its order on a sheet named Master. Check that you selected the finalized PI and not another workbook.',
  },
  MASTER_SHEET_UNREADABLE: {
    category: 'master_sheet',
    title: 'The “Master” sheet could not be read',
    message: 'The sheet is listed in the workbook but its contents could not be opened. Open the PI in Excel and save a fresh copy.',
  },
  TEMPLATE_FINGERPRINT_MISMATCH: {
    category: 'template',
    title: 'This is not the current BOE PI template',
    message: 'The product table headings do not match. Rebuild the PI from the current BOE template, or check that the columns have not been moved or renamed.',
  },
  NO_PRODUCT_ROWS: {
    category: 'content',
    title: 'No products found in this PI',
    message: 'The template matched but not one product row was filled in. Check the workbook and upload it again.',
  },
}

const UNKNOWN_FAILURE = {
  category: 'unreadable' as const,
  title: 'This PI could not be read',
  message: 'The workbook could not be processed. Check that it is the finalized BOE PI and try again.',
}

/**
 * The user-facing account of a failed parse.
 *
 * The FIRST error decides what the screen says. The parser returns at the first
 * fatal problem it hits, so there is normally exactly one; when there is more
 * than one, the leading error is the one that stopped it and the rest are
 * context, which is where they go.
 */
export function describePiFailure(errors: readonly PiError[]): PiFailureDisplay {
  const first = errors[0]
  const known = first ? FAILURE_BY_CODE[first.code] : undefined
  const chosen = known ?? UNKNOWN_FAILURE
  return {
    category: chosen.category,
    title: chosen.title,
    message: chosen.message,
    technical: errors.map(e => {
      const where = [e.cell, e.row !== undefined ? `row ${e.row}` : null, e.part]
        .filter(Boolean)
        .join(' · ')
      return `${e.code}${where ? ` (${where})` : ''}: ${e.message}`
    }),
  }
}

/** A rejection from checkPiFile, in the same shape the screen renders a parse
 *  failure in, so the empty state has one error component and not two. */
export function describeFileRejection(
  rejection: Extract<PiFileCheck, { ok: false }>,
): PiFailureDisplay {
  return {
    category: rejection.reason === 'TOO_LARGE' ? 'file_size' : 'file_type',
    title: rejection.title,
    message: rejection.message,
    technical: [rejection.reason],
  }
}

// ── Product images as object URLs ─────────────────────────────────────────────

/**
 * The impure half of image display, isolated so the rest is testable.
 *
 * Object URLs rather than data URLs: a 12-product PI carries megabytes of
 * photographs, and base64 would inflate every one by a third and hold both the
 * bytes and their encoding in memory for as long as the page is open. A blob
 * URL hands the browser the bytes it already has — and, unlike a data URL, it
 * can be RELEASED, which is the point of revokeAll.
 */
export type PiObjectUrlFactory = {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

export const browserObjectUrlFactory: PiObjectUrlFactory = {
  create: blob => URL.createObjectURL(blob),
  revoke: url => URL.revokeObjectURL(url),
}

export type PiImageUrls = {
  /** Worksheet row → the representative picture's URL. A row is absent when it
   *  had no usable picture, which the placeholder in the table stands in for. */
  representativeByRow: ReadonlyMap<number, string>
  /**
   * Worksheet row → its customization pictures' URLs, in workbook order.
   *
   * A LIST, not a single URL: a product may carry several. Two entries may hold
   * the SAME url when one photograph illustrates two changes — that is one blob
   * and two customization images, and both counts are correct.
   */
  customizationByRow: ReadonlyMap<number, readonly string[]>
  /** Distinct URLs handed out, for assertions and for the cleanup contract. */
  urls: readonly string[]
  /** Idempotent. Safe to call on unmount AND on file replacement, in any order
   *  and any number of times. */
  revokeAll: () => void
}

/**
 * One object URL per distinct media part, across BOTH roles.
 *
 * A PI routinely uses one photograph for several lines, and occasionally uses
 * the same file as a product shot and as a customization illustration. The
 * parser already shares those bytes by reference; creating a blob per image
 * would undo that, allocating the same picture several times and leaving
 * several URLs to leak. Keyed on the archive part name, which is what identity
 * means here — so `urls` is what must be revoked, and revoking it releases
 * everything exactly once.
 */
export function createPiImageUrls(
  images: {
    representativeImages: readonly PiProductImage[]
    customizationImages: readonly PiProductImage[]
  },
  factory: PiObjectUrlFactory = browserObjectUrlFactory,
): PiImageUrls {
  const byPart = new Map<string, string>()
  const representativeByRow = new Map<number, string>()
  const customizationByRow = new Map<number, string[]>()

  /** The URL for a part, created once. null when the format was unsniffable. */
  const urlFor = (image: PiProductImage): string | null => {
    // No sniffed format means no MIME type we are willing to assert. An <img>
    // fed application/octet-stream renders a broken icon; the table's
    // placeholder says "no preview" honestly instead.
    if (!image.mimeType) return null
    let url = byPart.get(image.part)
    if (url === undefined) {
      url = factory.create(new Blob([image.bytes as unknown as BlobPart], { type: image.mimeType }))
      byPart.set(image.part, url)
    }
    return url
  }

  for (const image of images.representativeImages) {
    const url = urlFor(image)
    if (url !== null) representativeByRow.set(image.row, url)
  }

  for (const image of images.customizationImages) {
    const url = urlFor(image)
    if (url === null) continue
    const list = customizationByRow.get(image.row)
    if (list) list.push(url)
    else customizationByRow.set(image.row, [url])
  }

  const urls = [...byPart.values()]
  let revoked = false

  return {
    representativeByRow,
    customizationByRow,
    urls,
    revokeAll: () => {
      if (revoked) return
      revoked = true
      for (const url of urls) factory.revoke(url)
    },
  }
}

// ── Image coverage ────────────────────────────────────────────────────────────

export type PiImageCoverage = {
  /** Product ROWS that have a representative picture to show. */
  matched: number
  /** Genuine product rows in the PI. */
  total: number
  /** "12 of 12 representative images matched". */
  label: string
  complete: boolean
}

/**
 * How many products actually have a picture.
 *
 * COUNTED PER PRODUCT ROW, NOT PER MEDIA FILE. A PI routinely anchors one
 * photograph to several lines — a set of four chairs is four products and one
 * picture — so counting distinct media parts would report "1 of 4 images
 * matched" for a workbook that is completely correct. Every row that resolves
 * to a picture counts, whether or not it shares the bytes with its neighbour.
 *
 * Counted against the RENDERABLE map rather than the parser's image list, so
 * the number agrees with what is on the screen: a picture whose format could
 * not be sniffed shows the placeholder, and is honestly counted as unmatched.
 */
export function describeImageCoverage(
  products: readonly { row: number }[],
  representativeUrls: ReadonlyMap<number, string>,
): PiImageCoverage {
  const total = products.length
  const matched = products.reduce((n, p) => (representativeUrls.has(p.row) ? n + 1 : n), 0)
  return {
    matched,
    total,
    label: `${matched} of ${total} representative image${total === 1 ? '' : 's'} matched`,
    complete: total > 0 && matched === total,
  }
}

export type PiCustomizationImageCount = {
  count: number
  /** "4 customization images". Absent entirely when there are none. */
  label: string
}

/**
 * How many customization images the PI carries, in total.
 *
 * NOT "x of y". Customization images are OPTIONAL: a 12-product PI with 4 of
 * them is complete, and "4 of 12" would read as eight missing files and send a
 * reviewer looking for something that was never meant to exist. A plain total
 * is the only honest shape.
 *
 * Counted PER IMAGE, not per product and not per media part. Three changes
 * illustrated on one product are three customization images; one photograph
 * used for two of them is still two.
 */
export function describeCustomizationImageCount(
  customizationImages: readonly { row: number }[],
): PiCustomizationImageCount {
  const count = customizationImages.length
  return {
    count,
    label: `${count} customization image${count === 1 ? '' : 's'}`,
  }
}

// ── Full-image viewer ─────────────────────────────────────────────────────────

export type PiViewerItem = {
  /** Stable identity across renders: role, row and position. */
  key: string
  /** Worksheet row, so the viewer and the table agree on which product this is. */
  row: number
  role: PiImageRole
  /**
   * What this picture IS, spelled for the reader: "Representative image", or
   * "Customization image 2 of 3". Always shown in the viewer — a reviewer
   * stepping through a sequence must never have to guess whether they are
   * looking at the product or at a requested change to it.
   */
  roleLabel: string
  sequence: string
  name: string
  url: string
  /** The thumbnail button's accessible name. */
  label: string
}

/**
 * Every picture a reviewer can open full size, in one ordered sequence.
 *
 * ORDER: product by product, and within a product the representative image
 * first, then its customization images in workbook order. Stepping therefore
 * walks the table the way the eye does, and the role label changes as it goes.
 *
 * Only pictures that actually resolved to a URL. Navigating into a placeholder
 * would be a dead frame with nothing to look at, so the indices stay dense —
 * which is also what makes the end-of-list checks simple enough to be obviously
 * right.
 */
export function buildImageViewerItems(
  products: readonly { row: number; itemSequence: string | null; productName: string | null }[],
  urls: Pick<PiImageUrls, 'representativeByRow' | 'customizationByRow'>,
): PiViewerItem[] {
  const items: PiViewerItem[] = []

  for (const product of products) {
    const sequence = product.itemSequence?.trim() ?? ''
    const name = product.productName?.trim() ?? ''
    const who = [sequence, name].filter(Boolean).join(' ') || `the product on row ${product.row}`
    const shared = {
      row: product.row,
      sequence: sequence || '—',
      name: name || '—',
    }

    const representative = urls.representativeByRow.get(product.row)
    if (representative) {
      items.push({
        ...shared,
        key: `representative-${product.row}`,
        role: 'representative',
        roleLabel: 'Representative image',
        url: representative,
        label: `View full image for ${who}`,
      })
    }

    const customization = urls.customizationByRow.get(product.row) ?? []
    customization.forEach((url, index) => {
      // "Customization image" alone when there is one; numbered when there are
      // several, because "2 of 3" is only meaningful against a total.
      const position = customization.length > 1
        ? `Customization image ${index + 1} of ${customization.length}`
        : 'Customization image'
      items.push({
        ...shared,
        key: `customization-${product.row}-${index}`,
        role: 'customization',
        roleLabel: position,
        url,
        label: `View ${position.toLowerCase()} for ${who}`,
      })
    })
  }

  return items
}

export type PiViewerNav = {
  canPrev: boolean
  canNext: boolean
  /** null at the ends, so a caller cannot step off either edge. */
  prevIndex: number | null
  nextIndex: number | null
  /** "3 of 12" */
  position: string
}

/** Where the viewer is and where it may go. Out-of-range indices yield a nav
 *  that permits nothing, rather than one that wraps around into a surprise. */
export function viewerNav(index: number, count: number): PiViewerNav {
  const valid = Number.isInteger(index) && index >= 0 && index < count
  const canPrev = valid && index > 0
  const canNext = valid && index < count - 1
  return {
    canPrev,
    canNext,
    prevIndex: canPrev ? index - 1 : null,
    nextIndex: canNext ? index + 1 : null,
    position: valid ? `${index + 1} of ${count}` : '',
  }
}
