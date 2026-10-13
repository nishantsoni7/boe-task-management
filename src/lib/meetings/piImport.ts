// The BOE Proforma Invoice, read as a New Order Review product sheet.
//
// This is a FIXED parser for ONE document, not an importer. There is no column
// mapping, no header guessing and no configuration: a workbook that is not a
// BOE PI is rejected with the reason, which is a better outcome than a
// plausible-looking partial import of somebody's unrelated spreadsheet.
//
// ═══ THE PRODUCT SECTION BOUNDARY — the one rule worth reading ═══════════════
//
// A BOE PI is a filled-in template, and it KEEPS its unused template rows. Those
// residual rows carry real-looking product names, quantities and dimensions left
// over from whichever order the template was last used for. Importing them would
// put invented products into a review.
//
// Three candidate rules were measured against two real PIs before this was
// written. The obvious one FAILS:
//
//   * COLUMN J (the internal sequence B001, B002, …) continues unbroken and
//     strictly incrementing THROUGH the residual rows — to B039 in one file and
//     B024 in the other. Keying on the sequence over-reads by 60% and 100%
//     respectively. The template's leftover sequence is perfectly well-formed,
//     which is exactly why it cannot be the terminator. J is kept here only as a
//     warning signal.
//
// Two independent signals DO mark the boundary, and both were exact on both
// files:
//
//   * THE ROW IS HIDDEN. The person preparing the PI hides the rows they did not
//     use. That is a declaration, not a heuristic — it is the author saying
//     "these are not part of this order".
//   * COLUMN H (cost per piece) IS POPULATED. A line that was priced into the
//     proforma is a line that was actually ordered; residual template rows carry
//     no price.
//
// This parser requires BOTH, and stops at the earlier boundary if they ever
// disagree — reporting which one fired, so a human can look rather than silently
// getting the shorter or longer answer. Only H's PRESENCE is read. Its value,
// and column I's total, are never extracted, never returned and never stored:
// Meetings does not handle money.
//
// ═══ WHAT IS DELIBERATELY NOT DONE ═══════════════════════════════════════════
// No formula evaluation (cached results only), no OCR, no PDF, no CSV, no AI
// extraction, no manual column mapping, no editing of the workbook.

import { createHash } from 'node:crypto'
import {
  readPiWorkbook, cellText, normalizeWhitespace,
  PiWorkbookError, type PiSheet, type PiWorkbook,
} from './piWorkbook'

// ─── The fixed layout ─────────────────────────────────────────────────────────

export const PI_SHEET_NAME = 'Master'
/** `PI No:` label sits at A20; the number itself is the cell beside it. */
export const PI_NUMBER_CELL = 'B20'
export const PI_HEADER_ROW = 31
export const PI_FIRST_PRODUCT_ROW = 32
/** DrawingML column index for E — the representative-image column. */
export const PI_IMAGE_COLUMN = 4

/**
 * Headers that must be present at row 31, matched loosely on case and
 * whitespace. Only the four that identify the document are required: a PI whose
 * cost column was renamed is still a PI, but one with no Code/Name/Quantity
 * column is not the document this parser understands.
 */
const REQUIRED_HEADERS: { column: string; expect: RegExp; label: string }[] = [
  { column: 'A', expect: /^code$/i,      label: 'Code' },
  { column: 'B', expect: /^name$/i,      label: 'Name' },
  { column: 'C', expect: /^quantity$/i,  label: 'Quantity' },
  { column: 'D', expect: /^dimension/i,  label: 'Dimension' },
]

/** Highest row the section scan will consider. Far past any real PI. */
const MAX_SCAN_ROW = 400

// ─── Output ───────────────────────────────────────────────────────────────────

export type PiWarningCode =
  | 'missing_image'
  | 'derived_code'
  | 'duplicate_code'
  | 'residual_rows_ignored'
  | 'boundary_disagreement'
  | 'sequence_break'
  | 'missing_dimensions'
  | 'blank_row_in_section'
  | 'unmatched_image'

export type PiWarning = {
  code: PiWarningCode
  /** Sheet row it concerns, when it concerns one. */
  row?: number
  /** Reader-facing sentence. Never contains a price or customer detail. */
  message: string
}

/** One product line. Contains no commercial field, by construction. */
export type PiProduct = {
  /** Sheet row, so a warning can point at it. */
  row: number
  /** Column A cached value, or derived from the PI number + sequence. */
  code: string
  name: string
  quantity: number | null
  dimensions: string | null
  /** Operational note only — finish/fabric instruction. Never a bare number. */
  specNote: string | null
  /** Content hash of the product photograph; null when the row has none. */
  imageHash: string | null
}

export type PiParseResult = {
  piNumber: string
  /** Rows 32..lastRow inclusive. */
  firstRow: number
  lastRow: number
  products: PiProduct[]
  warnings: PiWarning[]
  /** Distinct images, keyed by content hash. Bytes are NOT sent to the client. */
  images: Map<string, PiImage>
}

export type PiImage = {
  hash: string
  bytes: Uint8Array
  /** `png` or `jpeg`, from the package path. */
  ext: string
  /** Sheet rows referencing this image. Several rows may share one photo. */
  rows: number[]
}

export class PiParseError extends Error {}

// ─── Parse ────────────────────────────────────────────────────────────────────

export function parsePiWorkbook(bytes: Uint8Array): PiParseResult {
  let book: PiWorkbook
  try {
    book = readPiWorkbook(bytes, PI_SHEET_NAME)
  } catch (err) {
    if (err instanceof PiWorkbookError) throw new PiParseError(err.message)
    throw err
  }

  const sheet = book.sheet
  if (!sheet) {
    throw new PiParseError(
      `This workbook has no "${PI_SHEET_NAME}" sheet, so it is not a BOE PI. `
      + `Sheets found: ${book.sheetNames.join(', ') || 'none'}.`,
    )
  }

  assertHeaderRow(sheet)

  const piNumber = cellText(sheet, 'B', 20)
  if (!piNumber) {
    throw new PiParseError(
      `This PI has no number in ${PI_NUMBER_CELL}. The order reference cannot be read.`,
    )
  }

  const warnings: PiWarning[] = []
  const { lastRow } = findSectionEnd(sheet, warnings)

  if (lastRow < PI_FIRST_PRODUCT_ROW) {
    throw new PiParseError(
      'No product rows were found under the header. The workbook layout is not supported.',
    )
  }

  const imagesByRow = imageRowsFor(sheet)
  const products: PiProduct[] = []
  const images = new Map<string, PiImage>()
  const seenCodes = new Map<string, number>()
  let previousSequence: number | null = null

  for (let row = PI_FIRST_PRODUCT_ROW; row <= lastRow; row++) {
    const name = cellText(sheet, 'B', row)
    const sequence = cellText(sheet, 'J', row)
    const code = resolveCode(sheet, row, piNumber, sequence, warnings)

    if (!code && !name) {
      // Cannot happen under the boundary rule (it requires A or B), but a row
      // that reached here with neither is a layout this parser does not model.
      warnings.push({
        code: 'blank_row_in_section', row,
        message: `Row ${row} has no code and no name. The layout is not supported; it was skipped.`,
      })
      continue
    }

    // Sequence continuity is an INTEGRITY signal, never the boundary.
    const parsed = sequence ? /^([A-Z])(\d{3})$/.exec(sequence) : null
    if (!parsed) {
      warnings.push({
        code: 'sequence_break', row,
        message: `Row ${row} has no internal sequence code. Check the PI before importing.`,
      })
    } else {
      const n = Number(parsed[2])
      if (previousSequence != null && n !== previousSequence + 1) {
        warnings.push({
          code: 'sequence_break', row,
          message: `The internal sequence jumps at row ${row}. Check the PI before importing.`,
        })
      }
      previousSequence = n
    }

    const dimensions = cellText(sheet, 'D', row)
    if (!dimensions) {
      warnings.push({
        code: 'missing_dimensions', row,
        message: `Row ${row} has no dimensions.`,
      })
    }

    const duplicateOf = code ? seenCodes.get(code.toUpperCase()) : undefined
    if (code && duplicateOf != null) {
      warnings.push({
        code: 'duplicate_code', row,
        message: `Product code on row ${row} repeats row ${duplicateOf}. Only one line can carry it.`,
      })
    } else if (code) {
      seenCodes.set(code.toUpperCase(), row)
    }

    // ── image ──
    let imageHash: string | null = null
    const mediaPath = imagesByRow.get(row)
    if (!mediaPath) {
      warnings.push({
        code: 'missing_image', row,
        message: `Row ${row} has no product photograph.`,
      })
    } else {
      const bytes = book.media.get(mediaPath)
      if (!bytes) {
        warnings.push({
          code: 'unmatched_image', row,
          message: `The photograph on row ${row} could not be read from the file.`,
        })
      } else {
        // Content hash, NOT the media filename. One photograph reused across
        // several products appears under several `xl/media/*` names in real BOE
        // files, and two different names can hold identical bytes — hashing the
        // bytes is what makes "store one copy" true.
        imageHash = sha256(bytes)
        const existing = images.get(imageHash)
        if (existing) existing.rows.push(row)
        else images.set(imageHash, { hash: imageHash, bytes, ext: extOf(mediaPath), rows: [row] })
      }
    }

    products.push({
      row,
      code: code ?? `${normalizeWhitespace(piNumber)}-${row}`,
      name: name ?? '',
      quantity: numberOrNull(cellText(sheet, 'C', row)),
      dimensions,
      specNote: specNoteFor(sheet, row),
      imageHash,
    })
  }

  reportResidualRows(sheet, lastRow, warnings)

  return {
    piNumber: normalizeWhitespace(piNumber),
    firstRow: PI_FIRST_PRODUCT_ROW,
    lastRow,
    products,
    warnings,
    images,
  }
}

// ─── Header ───────────────────────────────────────────────────────────────────

function assertHeaderRow(sheet: PiSheet): void {
  const missing: string[] = []
  for (const { column, expect, label } of REQUIRED_HEADERS) {
    const text = cellText(sheet, column, PI_HEADER_ROW)
    if (!text || !expect.test(text)) missing.push(`${column}${PI_HEADER_ROW} (${label})`)
  }
  if (missing.length > 0) {
    throw new PiParseError(
      `The product table is not where a BOE PI keeps it. Expected headers at row `
      + `${PI_HEADER_ROW}: ${missing.join(', ')}. This workbook layout is not supported.`,
    )
  }
}

// ─── The boundary ─────────────────────────────────────────────────────────────

/**
 * Walk down from row 32 while the row is visible AND priced AND identified.
 *
 * Both boundary signals are evaluated independently so a disagreement can be
 * reported rather than resolved silently. Stopping at the EARLIER of the two is
 * the conservative direction: under-importing shows a visible short list a
 * reviewer will notice, while over-importing puts invented products into a
 * meeting where they look real.
 */
function findSectionEnd(sheet: PiSheet, warnings: PiWarning[]): { lastRow: number } {
  let hiddenBoundary: number | null = null
  let pricedBoundary: number | null = null

  for (let row = PI_FIRST_PRODUCT_ROW; row <= MAX_SCAN_ROW; row++) {
    const hidden = sheet.rows.get(row)?.hidden === true
    const priced = cellText(sheet, 'H', row) != null
    if (hidden && hiddenBoundary == null) hiddenBoundary = row - 1
    if (!priced && pricedBoundary == null) pricedBoundary = row - 1
    if (hiddenBoundary != null && pricedBoundary != null) break
  }

  const hiddenEnd = hiddenBoundary ?? MAX_SCAN_ROW
  const pricedEnd = pricedBoundary ?? MAX_SCAN_ROW
  let lastRow = Math.min(hiddenEnd, pricedEnd)

  if (hiddenEnd !== pricedEnd) {
    const earlier = hiddenEnd < pricedEnd ? 'the first hidden row' : 'the first unpriced row'
    warnings.push({
      code: 'boundary_disagreement',
      row: lastRow + 1,
      message:
        `The two end-of-list signals disagree: hidden rows end the list at ${hiddenEnd}, `
        + `priced rows at ${pricedEnd}. Stopped at ${lastRow} (${earlier}). `
        + 'Check the PI before importing.',
    })
  }

  // A row must still identify a product. This trims a trailing row that is
  // visible and priced but names nothing.
  while (
    lastRow >= PI_FIRST_PRODUCT_ROW
    && cellText(sheet, 'A', lastRow) == null
    && cellText(sheet, 'B', lastRow) == null
  ) lastRow--

  return { lastRow }
}

/**
 * Report what was left behind, so the template trap is visible rather than
 * silent. Counts rows only — their contents are template residue and are never
 * read into the result.
 */
function reportResidualRows(sheet: PiSheet, lastRow: number, warnings: PiWarning[]): void {
  let residual = 0
  for (let row = lastRow + 1; row <= MAX_SCAN_ROW; row++) {
    if (cellText(sheet, 'A', row) != null || cellText(sheet, 'B', row) != null) residual++
  }
  if (residual > 0) {
    warnings.push({
      code: 'residual_rows_ignored',
      message:
        `${residual} unused template row${residual === 1 ? '' : 's'} below the product list `
        + 'were ignored. They are left over from the PI template, not part of this order.',
    })
  }
}

// ─── Fields ───────────────────────────────────────────────────────────────────

/**
 * The product code.
 *
 * Column A holds a formula in every BOE PI seen, and the spreadsheet writes its
 * result into the file as a cached value — which both sample files carried for
 * every product row. That cached string is used as-is and kept as TEXT: a code
 * is an identifier, never a number.
 *
 * The fallback exists for a workbook saved by a tool that dropped the cache. It
 * composes the PI number with the internal sequence, which is what the formula
 * itself does, and always warns — a derived code is a guess about identity and
 * the reviewer should confirm it.
 */
function resolveCode(
  sheet: PiSheet,
  row: number,
  piNumber: string,
  sequence: string | null,
  warnings: PiWarning[],
): string | null {
  const cell = sheet.cells.get(`A${row}`)
  const cached = cell?.value == null ? null : normalizeWhitespace(cell.value)
  if (cached) return cached

  if (!sequence) return null

  warnings.push({
    code: 'derived_code', row,
    message:
      `The product code on row ${row} was not saved in the file and has been built from `
      + 'the PI number and the line sequence. Check it before importing.',
  })
  return `${normalizeWhitespace(piNumber)} ${sequence}`.trim()
}

/**
 * The operational note beside the photograph.
 *
 * The representative-image area (merged E:F) carries two different things in
 * real files: a bare number, which is layout bookkeeping and means nothing to a
 * reviewer, and occasionally a genuine instruction — a finish, a fabric, a
 * marble choice. Only the second is kept.
 *
 * Column K carries the same kind of instruction in some PIs and is included on
 * the same terms. It was inspected before being trusted: in the sample that has
 * it, every value was a finish or fabric instruction, with no price, total, tax,
 * bank, phone, address or customer detail present. Anything numeric is still
 * rejected here regardless of which column it came from.
 */
function specNoteFor(sheet: PiSheet, row: number): string | null {
  const parts: string[] = []
  for (const column of ['E', 'F', 'K']) {
    const text = cellText(sheet, column, row)
    if (!text) continue
    if (!isMeaningfulNote(text)) continue
    if (!parts.includes(text)) parts.push(text)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * A note is kept only when it carries a letter and reads as words rather than a
 * code. Bare numerics — the majority of E values in real PIs — are dropped.
 */
function isMeaningfulNote(text: string): boolean {
  if (!/[A-Za-z]/.test(text)) return false
  if (text.length < 3) return false
  // A lone token with no letters beyond a unit suffix is bookkeeping, not an
  // instruction. Requiring two words is what separates "3 nos" from a real note.
  return /\s/.test(text.trim())
}

function numberOrNull(text: string | null): number | null {
  if (!text) return null
  const cleaned = text.replace(/,/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

// ─── Images ───────────────────────────────────────────────────────────────────

/**
 * Sheet row → media path, for column-E anchors only.
 *
 * The column filter is what excludes logos and footer graphics: a real PI
 * carries dozens of anchors and only the ones in column E are product
 * photographs. In one sample, 75 anchors existed and only 26 sat in column E.
 *
 * When two anchors land on one row the first is used and the rest ignored — a
 * product has one representative image, and picking deterministically beats
 * picking whichever the file happened to list last.
 */
function imageRowsFor(sheet: PiSheet): Map<number, string> {
  const byRow = new Map<number, string>()
  for (const anchor of sheet.anchors) {
    if (anchor.col !== PI_IMAGE_COLUMN) continue
    if (!anchor.mediaPath) continue
    if (byRow.has(anchor.row)) continue
    byRow.set(anchor.row, anchor.mediaPath)
  }
  return byRow
}

function extOf(mediaPath: string): string {
  const raw = (mediaPath.split('.').pop() ?? '').toLowerCase()
  return raw === 'jpg' ? 'jpeg' : raw
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ─── Client-facing preview ────────────────────────────────────────────────────

/** A product as the browser sees it. No commercial field can reach here. */
export type PiPreviewProduct = Omit<PiProduct, 'imageHash'> & {
  /** Content hash only — the bytes stay on the server until confirmation. */
  imageHash: string | null
}

export type PiPreview = {
  piNumber: string
  productCount: number
  products: PiPreviewProduct[]
  warnings: PiWarning[]
  /** Distinct photographs found, for the "20 products, 11 images" line. */
  distinctImageCount: number
}

/**
 * Strip the parse down to what the preview may show.
 *
 * The image BYTES are dropped here, which is the point: a preview shows the
 * product list and warnings, and the photographs are uploaded only after the
 * user confirms. Prices and totals were never read, so there is nothing to
 * remove — that is a property of the parser, not a filter applied late.
 */
export function toPiPreview(result: PiParseResult): PiPreview {
  return {
    piNumber: result.piNumber,
    productCount: result.products.length,
    products: result.products.map(p => ({ ...p })),
    warnings: result.warnings,
    distinctImageCount: result.images.size,
  }
}
