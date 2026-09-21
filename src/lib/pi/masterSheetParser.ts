// The BOE Proforma Invoice parser.
//
// One entry point — parseBoePiWorkbook(bytes) — turns an employee's .xlsx into
// the header block, the genuine product lines, the commercial footer and the
// embedded product photographs, plus an honest list of everything a reviewer
// should look at before the submission is approved.
//
// THE TEMPLATE IS A CONTRACT, NOT A GUESS
// ---------------------------------------
// Every address below is FIXED by the BOE PI template: the header block sits at
// rows 20–28, the column headers at row 31, products from row 32, the commercial
// footer at rows 115–122. A parser that "found" these by searching for labels
// would quietly succeed on the wrong workbook and produce plausible, wrong
// numbers. So the addresses are constants, and row 31 is fingerprinted against
// the expected column headers BEFORE a single value is read. A template that
// does not match is a BLOCKING error — never a silent re-map onto whatever
// columns happen to be there.
//
// WHERE THE BUSINESS MEANING BEATS THE LABEL
// ------------------------------------------
// I115 is the DISCOUNT. Real workbooks label that row "Design Fees" in some
// files and "Discount" in others — both were observed in production PIs — and
// the amount means the same thing either way. The label is recorded for
// traceability and is deliberately not consulted. This is the one place where
// position outranks wording, and it is the reason the fingerprint exists: we can
// only trust a position because we proved the template first.
//
// WHAT THIS PARSER WILL NOT DO
// ----------------------------
//   * It never writes. No file, no bucket, no database, no network. Phase 1 is
//     read-only by construction; the input Uint8Array is only ever read from.
//   * It never allocates an official order number. B20 may already carry one
//     from whatever workbook the employee started from; that is SOURCE DATA and
//     is reported as such. Allocation belongs to approval, in a later phase.
//   * It never repairs a figure. Where quantity × rate disagrees with the stored
//     line total, or our subtotal disagrees with the workbook's, BOTH numbers
//     are reported and the WORKBOOK'S value is what is returned. Substituting
//     our arithmetic would make the import disagree with the document the client
//     was actually sent.

import {
  openPiArchive,
  PI_MAX_WORKBOOK_BYTES,
  partText,
  readSharedStrings,
  readSheet,
  resolveSheetPart,
  normalizeLabel,
  excelSerialToIso,
  numberToPlainText,
  cellRef,
  type PiArchiveFailure,
  type PiCell,
  type PiSheet,
} from './workbookReader'
import { harvestProductImages, resolveDrawingPart, type PiImageHarvest } from './drawingAnchors'
import { describeImageFormat, isStorableImageFormat, PI_ACCEPTED_IMAGE_LABEL } from './imageFormats'
import { DUE_DATE_FLOOR, isCalendarDate, plausibleDueDate } from '@/lib/orders/dueDate'
import type {
  PiAmountOrText,
  PiBlockingIssue,
  PiCommercialSummary,
  PiDateValue,
  PiError,
  PiHeader,
  PiParseResult,
  PiProduct,
  PiProductImage,
  PiTemplateCellCheck,
  PiWarning,
} from './types'

// ── The template ──────────────────────────────────────────────────────────────

export const MASTER_SHEET_NAME = 'Master'

/** Column headers live here and nowhere else. */
export const HEADER_ROW = 31
/** First row a product can occupy. */
export const FIRST_PRODUCT_ROW = 32
/**
 * Last row a product can occupy.
 *
 * The template lays out 80 numbered slots, B001–B080, in rows 32–111; row 112
 * begins the notes and dispatch block. Both production workbooks inspected while
 * this was written carry exactly that layout. This is the extent of the BAND,
 * not an assumption about how many products a PI has — how many of those rows
 * are genuine is decided per row, below.
 */
export const LAST_PRODUCT_ROW = 111

/** 0-based column indexes, matching the drawing anchors' own numbering. */
export const COL = {
  code: 0,          // A
  name: 1,          // B
  quantity: 2,      // C
  dimensions: 3,    // D
  image: 4,         // E
  material: 6,      // G
  costPerPiece: 7,  // H
  lineTotal: 8,     // I
  itemSequence: 9,  // J — hidden in the template
  customization: 10 // K
} as const

/**
 * Row 31 must read exactly like this, after whitespace collapsing and
 * case-folding. Anything else and the workbook is not a BOE PI — refused rather
 * than mapped onto columns that may mean something completely different.
 */
export const TEMPLATE_HEADERS: readonly { cell: string; expected: string }[] = [
  { cell: 'A31', expected: 'Code' },
  { cell: 'B31', expected: 'Name' },
  { cell: 'C31', expected: 'Quantity' },
  { cell: 'D31', expected: 'Dimension in inches & Shape' },
  { cell: 'E31', expected: 'Representative Image' },
  { cell: 'G31', expected: 'Material' },
  { cell: 'H31', expected: 'Cost per piece (INR)' },
  { cell: 'I31', expected: 'Total Cost (INR)' },
  { cell: 'K31', expected: 'Customization' },
]

/** Header block. Every one of these is a fixed template position. */
const HEADER_CELLS = {
  sourceOrderNumber:     'B20',
  creationDate:          'G20',
  createdBy:             'G21',
  boeGst:                'B22',
  contactNumber:         'G22',
  billToName:            'B25',
  billToPhone:           'B26',
  billToGst:             'B27',
  billingAddress:        'B28',
  shipToName:            'G25',
  shipToPhone:           'G26',
  shipToGst:             'G27',
  shippingAddress:       'G28',
  orderConfirmationDate: 'A113',
  dispatchCommitment:    'E113',
} as const

/** Commercial footer. Read by POSITION — see the note at the top of this file. */
const COMMERCIAL_CELLS = {
  discount:              'I115',
  discountLabel:         'G115',
  subtotalAfterDiscount: 'I116',
  fabricCost:            'I117',
  packingCost:           'I118',
  transportation:        'I119',
  totalBeforeGst:        'I120',
  gst:                   'I121',
  grandTotal:            'I122',
} as const

/**
 * Rupee tolerance for every arithmetic cross-check.
 *
 * Workbook money is stored to two decimal places, so a real discrepancy is
 * whole rupees. One paisa absorbs IEEE-754 drift from summing eighty lines
 * without ever hiding a genuine mistake.
 */
export const MONEY_EPSILON = 0.01

/**
 * The template's own shorthand for "nothing to charge here".
 *
 * A production PI writes a bare dash in the fabric-cost row where another leaves
 * the cell empty; both mean zero. Only a run of dash characters counts —
 * hyphen-minus, en dash, em dash — so "TBC", "n/a" or "to be confirmed" are NOT
 * silently read as zero. Those are genuinely unresolved and must stay visible.
 */
export function isNotApplicableMarker(value: string | null): boolean {
  if (value === null) return true
  const trimmed = value.trim()
  if (trimmed === '') return true
  return /^[-‐‑‒–—―]+$/.test(trimmed)
}

/**
 * The template's other shorthand for a zero charge: the charge exists, but it
 * is already inside another figure and is not billed again on this row.
 *
 * Exactly "inclusive" or "included" after whitespace collapsing and case
 * folding. Nothing looser: "inclusive of GST" is a qualification somebody needs
 * to read, "included?" is a question, and both must keep warning. The two bare
 * words are the ones a BOE PI actually uses.
 */
export function isIncludedMarker(value: string | null): boolean {
  if (value === null) return false
  const normalized = normalizeLabel(value)
  return normalized === 'inclusive' || normalized === 'included'
}

/**
 * How a commercial cell treats a value that is not a number.
 *
 *   strict     Any text is unexpected: preserved and warned about.
 *   wordedZero Blank or a dash means zero (isNotApplicableMarker), and
 *              "Inclusive"/"Included" means zero-because-already-charged
 *              (isIncludedMarker). Any other text is still unexpected,
 *              preserved and warned about.
 *
 * Only the two "as per actual" rows use `wordedZero`. Discount, subtotal, total
 * before GST, GST and the grand total stay `strict`: a grand total that says
 * "Inclusive" is not a zero grand total, it is a workbook somebody must look
 * at. Transportation is `strict` too, with warnings off — its text is expected
 * and is shown verbatim.
 */
type NonNumericPolicy = 'strict' | 'wordedZero'

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Parse one BOE PI workbook. Pure with respect to the caller's bytes: nothing is
 * written, nothing is uploaded, and `bytes` is never modified.
 *
 * A successful result may still carry blocking issues. That is deliberate: the
 * preview is what a reviewer needs in order to fix the workbook, so it is always
 * returned, and `blockingIssues` is what a later phase consults before allowing
 * a submission.
 */
export async function parseBoePiWorkbook(bytes: Uint8Array): Promise<PiParseResult> {
  const warnings: PiWarning[] = []
  const blockingIssues: PiBlockingIssue[] = []

  const opened = await openPiArchive(bytes)
  if (!opened.ok) {
    return { ok: false, warnings, errors: [archiveError(opened.reason)] }
  }
  const { entries } = opened.archive

  const resolution = resolveSheetPart(entries, MASTER_SHEET_NAME)
  if (!resolution.ok) {
    return {
      ok: false,
      warnings,
      errors: [{
        code: resolution.reason,
        message: resolution.reason === 'MASTER_SHEET_MISSING'
          ? `This workbook has no sheet named "${MASTER_SHEET_NAME}". Sheets found: ${resolution.sheetNames.join(', ') || '(none)'}.`
          : `The "${MASTER_SHEET_NAME}" sheet is declared but its worksheet part could not be resolved.`,
      }],
    }
  }

  const sheetXml = partText(entries, resolution.part)
  if (!sheetXml) {
    return {
      ok: false,
      warnings,
      errors: [{
        code: 'MASTER_SHEET_UNREADABLE',
        part: resolution.part,
        message: `The "${MASTER_SHEET_NAME}" worksheet part is empty or unreadable.`,
      }],
    }
  }

  const sheet = readSheet(sheetXml, readSharedStrings(entries))

  // ── The gate. Nothing below runs against an unrecognised template. ──
  const fingerprint = checkFingerprint(sheet)
  const failed = fingerprint.filter(f => !f.ok)
  if (failed.length > 0) {
    return {
      ok: false,
      warnings,
      errors: [{
        code: 'TEMPLATE_FINGERPRINT_MISMATCH',
        message:
          `Row ${HEADER_ROW} does not match the BOE PI template. `
          + failed.map(f => `${f.cell} expected "${f.expected}", found ${f.found === null ? 'nothing' : `"${f.found}"`}`).join('; ')
          + '.',
      }],
    }
  }

  // ── Products ──
  const drawingPart = resolveDrawingPart(entries, resolution.part)
  const harvest: PiImageHarvest = drawingPart
    ? harvestProductImages({
        entries,
        drawingPart,
        representativeColumn: COL.image,
        customizationColumn: COL.customization,
        firstRow: FIRST_PRODUCT_ROW,
        lastRow: LAST_PRODUCT_ROW,
      })
    : {
        representativeByRow: new Map<number, PiProductImage[]>(),
        customizationByRow: new Map<number, PiProductImage[]>(),
        issues: [],
      }

  // A rejected picture is reported under a code that says which KIND of picture
  // it was. The representative codes exist to explain a blocking
  // PRODUCT_IMAGE_REQUIRED; the customization codes exist to say "an
  // illustration of a change is missing, and the order is still fine".
  for (const issue of harvest.issues) {
    const unsafe = issue.code === 'PRODUCT_IMAGE_UNSAFE_PATH'
    const customization = issue.role === 'customization'
    const what = customization ? 'customization picture' : 'picture'
    warnings.push({
      code: customization
        ? (unsafe ? 'CUSTOMIZATION_IMAGE_UNSAFE_PATH' : 'CUSTOMIZATION_IMAGE_UNREADABLE')
        : issue.code,
      row: issue.row,
      part: issue.part,
      message: unsafe
        ? `Row ${issue.row}: the ${what} points at "${issue.part}", which is outside xl/media and was not read.`
        : `Row ${issue.row}: the ${what} relationship could not be resolved to any part in the workbook.`,
    })
  }

  const hiddenProductRows: number[] = []
  const genuineProductRows: number[] = []
  const products: PiProduct[] = []
  const representativeImages: PiProductImage[] = []
  const customizationImages: PiProductImage[] = []

  for (let row = FIRST_PRODUCT_ROW; row <= LAST_PRODUCT_ROW; row++) {
    const hidden = sheet.hiddenRows.has(row)
    const hasContent = rowHasProductContent(sheet, row)
    if (hidden) hiddenProductRows.push(row)

    if (hidden) {
      // Hidden means template scaffolding — the unused slots of an 80-row form.
      // Excluding a hidden row that nonetheless holds real content would drop a
      // product silently, so it is excluded AND said out loud.
      if (hasContent) {
        warnings.push({
          code: 'HIDDEN_ROW_WITH_CONTENT',
          row,
          message: `Row ${row} is hidden but carries product content. It was excluded as a template row — check whether it should be visible.`,
        })
      }
      continue
    }
    if (!hasContent) continue

    genuineProductRows.push(row)
    products.push(buildProduct({
      sheet,
      row,
      rowImages: harvest.representativeByRow.get(row) ?? [],
      rowCustomizationImages: harvest.customizationByRow.get(row) ?? [],
      warnings,
      blockingIssues,
      representativeImages,
      customizationImages,
    }))
  }

  if (products.length === 0) {
    return {
      ok: false,
      warnings,
      errors: [{
        code: 'NO_PRODUCT_ROWS',
        message: `The template matched but no genuine product rows were found between rows ${FIRST_PRODUCT_ROW} and ${LAST_PRODUCT_ROW}.`,
      }],
    }
  }

  if (!drawingPart) {
    warnings.push({
      code: 'DRAWING_PART_MISSING',
      message: `The "${MASTER_SHEET_NAME}" sheet references no drawing part, so no product image could be mapped.`,
    })
  }

  const header = readHeader(sheet, warnings)
  warnings.push(...headerRequirementWarnings(header))
  const commercial = readCommercial(sheet, products, warnings)

  return {
    ok: true,
    warnings,
    blockingIssues,
    data: {
      template: {
        sheetName: MASTER_SHEET_NAME,
        sheetPart: resolution.part,
        workbookSheetNames: resolution.sheetNames,
        drawingPart,
        headerRow: HEADER_ROW,
        firstProductRow: FIRST_PRODUCT_ROW,
        lastProductRow: LAST_PRODUCT_ROW,
        fingerprint,
        hiddenProductRows,
        genuineProductRows,
        workbookByteLength: bytes.length,
      },
      header,
      products,
      commercial,
      // What the workbook itself said about its terms and its fabric, when
      // it said anything this parser recognises. Prefill only — neither is
      // required here, and neither produces a diagnostic.
      piTerms: {
        fabricResponsibility: readFabricResponsibility(sheet),
        commercialTermsNote: readCommercialTermsNote(sheet),
      },
      representativeImages,
      customizationImages,
    },
  }
}

function archiveError(reason: PiArchiveFailure): PiError {
  const message: Record<PiArchiveFailure, string> = {
    INPUT_TOO_LARGE: `This workbook is larger than the ${PI_MAX_WORKBOOK_BYTES / (1024 * 1024)} MiB limit for a PI import.`,
    INVALID_ZIP: 'This file could not be opened as an .xlsx workbook.',
    UNSAFE_ENTRY_NAME: 'This workbook contains an entry whose name is not a valid package path.',
    DUPLICATE_ENTRY: 'This workbook contains the same part twice and cannot be read reliably.',
    TOO_MANY_ENTRIES: 'This workbook contains far more parts than a spreadsheet should.',
    DECOMPRESSED_TOO_LARGE: 'This workbook expands to more data than a PI ever should.',
    MISSING_WORKBOOK_PARTS: 'This file is missing the parts every .xlsx workbook must have.',
  }
  return { code: reason, message: message[reason] }
}

// ── Template fingerprint ──────────────────────────────────────────────────────

function checkFingerprint(sheet: PiSheet): PiTemplateCellCheck[] {
  return TEMPLATE_HEADERS.map(({ cell, expected }) => {
    const found = textOf(sheet.cells.get(cell))
    return {
      cell,
      expected,
      found,
      // Whitespace-collapsed and case-folded, so a header split across two lines
      // or typed with a double space still matches. Nothing else is forgiven.
      ok: found !== null && normalizeLabel(found) === normalizeLabel(expected),
    }
  })
}

// ── Cell readers ──────────────────────────────────────────────────────────────

function textOf(cell: PiCell | undefined): string | null {
  if (!cell) return null
  if (cell.type === 'number' && cell.number !== null) return numberToPlainText(cell.number)
  return cell.text
}

/** A number, whether the cell is numeric or a plainly-numeric string. Anything
 *  with letters, or with characters this cannot account for, returns null rather
 *  than a guess. */
function numberOf(cell: PiCell | undefined): number | null {
  if (!cell) return null
  if (cell.type === 'number') return cell.number
  if (cell.type === 'string' && cell.text) {
    const cleaned = cell.text.replace(/[,\s]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function hasAnyValue(cell: PiCell | undefined): boolean {
  if (!cell) return false
  if (cell.type === 'empty') return false
  return cell.text !== null || cell.number !== null
}

/** A formula whose result the workbook never stored. Reported, never computed. */
function noteMissingCachedValue(cell: PiCell | undefined, warnings: PiWarning[], what: string): void {
  if (!cell || !cell.hasFormula || cell.hasCachedValue) return
  warnings.push({
    code: 'FORMULA_WITHOUT_CACHED_VALUE',
    cell: cell.address,
    row: cell.row,
    message: `${what} (${cell.address}) holds a formula with no stored result, so the workbook never recorded a value for it.`,
  })
}

function readDateValue(cell: PiCell | undefined): PiDateValue | null {
  if (!cell) return null
  if (cell.type === 'number' && cell.number !== null) {
    const iso = excelSerialToIso(cell.number)
    return { iso, text: iso ?? numberToPlainText(cell.number), source: 'serial' }
  }
  const text = cell.text
  if (text === null || text === '') return null
  return { iso: null, text, source: 'text' }
}

/**
 * A DATE THE TEMPLATE WROTE AS WORDS, as an ISO date — or null.
 *
 * WHY THIS IS NEEDED AT ALL. G20 ("Date of Creation") is not a date cell in
 * the production template. The real workbook holds the STRING "26th Feb 2026",
 * so PiDateValue comes back with `iso: null` and only the text. Everything
 * downstream that wants a date — the stored creation_date column, the
 * finalization gate that requires one — would have seen nothing, and the save
 * path would have quietly stamped TODAY in its place. A PI drawn up in
 * February would then claim it was drawn up on the day somebody imported it,
 * which is a false statement about a commercial document and exactly the kind
 * this parser exists not to make.
 *
 * WHAT IT ACCEPTS, AND NOTHING ELSE:
 *
 *   26th Feb 2026   26 Feb 2026   26 February 2026   Feb 26, 2026   2026-02-26
 *
 * An ordinal suffix (st/nd/rd/th) is optional, the separator may be a space,
 * a comma, a hyphen or a slash, and the month must be an English month name or
 * its three-letter abbreviation. The YEAR MUST BE FOUR DIGITS.
 *
 * WHAT IT REFUSES, deliberately:
 *
 *   02/03/2026      ambiguous — 2 March or 3 February, depending on who typed
 *                   it. A PI is read by people in two hemispheres and there is
 *                   no safe answer, so there is no answer.
 *   Feb 2026        no day.
 *   yesterday       not a date.
 *
 * Nothing is computed and nothing is guessed: a value either matches one of
 * these shapes and is a real calendar day, or the result is null and the date
 * is asked for on screen. The final check re-spells the parsed date and
 * compares it, so 31 February is refused rather than rolled into March.
 */
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

export function parseWrittenDate(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (raw === '') return null

  // Normalised BEFORE the ISO check: isCalendarDate is a type guard, so
  // narrowing on it first would leave `raw` as `never` for the lines below.
  const text = raw.toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim()

  // Already ISO, and a real day.
  if (isCalendarDate(raw)) return raw

  // "26th feb 2026" / "26 february 2026"
  let m = text.match(/^(\d{1,2})(?:st|nd|rd|th)? [-/ ]?([a-z]+) [-/ ]?(\d{4})$/)
  // "feb 26 2026" / "february 26th 2026"
  if (!m) { const n = text.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/); if (n) m = [n[0], n[2], n[1], n[3]] as RegExpMatchArray }
  if (!m) return null

  const month = MONTHS[m[2]]
  if (month === undefined) return null

  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  // A real calendar day, not 31 February rolled into March.
  return isCalendarDate(iso) ? iso : null
}

/**
 * The DATE OF CREATION this PI states, as an ISO date, or null.
 *
 * The cell’s own serial when Excel stored one, then the written form the
 * production template actually uses. Null when the cell said nothing a date
 * can be read from — at which point the save path may fall back to the day it
 * is saving, which is honest only because it is not pretending to be the
 * document’s own date.
 */
export function creationDateIso(header: Pick<PiHeader, 'creationDate'>): string | null {
  const cell = header.creationDate
  if (!cell) return null
  if (isCalendarDate(cell.iso)) return cell.iso
  return parseWrittenDate(cell.text)
}
// ── What the PI says about its own terms ──────────────────────────────────────

/**
 * THE FABRIC ANSWER AND THE STANDARD NOTE, READ OUT OF THE WORKBOOK.
 *
 * The BOE template carries both, and a person filling one in has already
 * answered the questions the Draft PI asks. Re-typing them on screen would be
 * asking twice.
 *
 *   FABRIC RESPONSIBILITY  a data-validation dropdown on the fabric-cost row
 *                          (117), to the right of the amount in I117.
 *   COMMERCIAL TERMS       the red "Note:" block in column A beside the
 *                          commercial footer.
 *
 * ── THE CELLS, CONFIRMED AGAINST A PRODUCTION WORKBOOK ────────────────────
 *
 * Both were read out of a real BOE PI ("Revised PI Format.xlsx", 2026-09-21)
 * rather than guessed, and both are FIXED ADDRESSES like every other value in
 * this file:
 *
 *   K117  the fabric answer. The workbook carries a data-validation list on
 *         exactly this cell:
 *             <dataValidation type="list" sqref="K117"
 *              formula1="Under BOE Scope, Client will send Fabric, Not Selected">
 *         It sits one column right of the fabric AMOUNT in I117, past the
 *         G117:H117 merge that carries the label.
 *   A115  the commercial terms. A merged A115:F116 block holding the red
 *         "Note:" paragraph.
 *
 * ── AND WHY EACH IS STILL GATED ON VOCABULARY ─────────────────────────────
 *
 * Knowing the address is not enough to make a value safe to take. K117 is an
 * ordinary text cell with a dropdown ATTACHED, not a constrained one: Excel
 * offers the list, and nothing stops a person typing over it, and nothing
 * stops an older or hand-edited template putting something else there. A115
 * sits in a decorative band whose neighbouring rows carry other prose
 * entirely — row 127 opens "Fabric and Wood Finish Confirmations", and C137
 * contains the words "ex-factory" in a completely different sentence.
 *
 * So an address says WHERE TO LOOK and the vocabulary decides WHETHER TO TAKE
 * IT. A cell holding anything the template does not say is passed over and the
 * field stays empty for a person to answer. Both failure modes are the same
 * and both are harmless: no prefill. What cannot happen is a WRONG value,
 * which on a fabric answer would be a commercial position on a document a
 * client is sent, taken from a cell nobody meant as an answer.
 *
 * A SMALL NEIGHBOURHOOD IS STILL TRIED, after the named cell and only when the
 * named cell said nothing recognisable. Merged regions move by a column when a
 * template is revised, and the vocabulary gate means a neighbour can only ever
 * contribute a value the template itself defines. The named cell always wins.
 *
 * NEITHER IS A GATE. Nothing here produces a warning or a blocking issue: a
 * template without the dropdown is a template the person answers on screen.
 */

/**
 * K117 is the cell the production template puts the dropdown on. The rest are
 * the neighbours a revision could move it to, tried only afterwards.
 */
const FABRIC_CHOICE_CELLS = ['K117', 'J117', 'L117', 'M117'] as const

/** A115 is the note block’s anchor (merged A115:F116); the rest are fallbacks. */
const TERMS_NOTE_CELLS = ['A115', 'A114', 'A116', 'A117', 'A118', 'A119'] as const

/**
 * The template's own words for each answer, and what they mean.
 *
 * THE TEMPLATE'S VOCABULARY IS NOT THE PRODUCT'S. The sheet says "Under BOE";
 * the PI says "Fabric will be provided by BOE". Both wordings are kept, in the
 * one place that has to know they are the same thing — src/lib/orders/piTerms.ts
 * owns what is PRINTED, this owns what is RECOGNISED.
 *
 * Matched on a normalised form: lower-cased, with runs of whitespace collapsed,
 * so "Client will send Fabric" and "client will send fabric" are one phrase. A
 * phrase is matched WHOLE — no substring, no stemming, no near-miss. This is a
 * commercial position on a document a client is sent, and a fuzzy match here
 * would be the system guessing one.
 */
/**
 * THE TEMPLATE’S OWN LIST COMES FIRST, verbatim from the data validation on
 * K117: "Under BOE Scope, Client will send Fabric, Not Selected". The rest are
 * wordings a workbook in circulation is known to carry — the displayed value
 * "Fabric will be given by client" among them — and the product’s own labels,
 * so a PI exported from this system and re-imported reads back the same way.
 *
 * A BARE "boe" OR "client" IS NOT ACCEPTED. Those are the stored codes, not
 * anything a person types into a spreadsheet, and treating a cell reading
 * "client" as an answer would be the parser inferring a commercial position
 * from one ambiguous word.
 */
const FABRIC_CHOICE_WORDS: Record<string, 'boe' | 'client' | 'not_selected'> = {
  // The template’s list.
  'under boe scope': 'boe',
  'client will send fabric': 'client',
  'not selected': 'not_selected',

  // Wordings seen on workbooks in circulation, and the product’s own labels.
  'under boe': 'boe',
  'fabric under boe': 'boe',
  'boe scope': 'boe',
  'fabric will be provided by boe': 'boe',

  'fabric will be given by client': 'client',
  'client will provide fabric': 'client',
  'fabric will be provided by client': 'client',

  'not selected yet': 'not_selected',
  'fabric not selected yet': 'not_selected',
}

const normalizeChoice = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '')

/**
 * Which of the three the workbook chose, or null when it said nothing this
 * function recognises.
 *
 * NULL IS THE ORDINARY ANSWER for a template without the dropdown, and it is
 * not a defect. It means the same as it means everywhere else in this feature:
 * nobody has answered, and the person working on the draft is asked.
 */
export function readFabricResponsibility(sheet: PiSheet): 'boe' | 'client' | 'not_selected' | null {
  for (const address of FABRIC_CHOICE_CELLS) {
    const text = textOf(sheet.cells.get(address))
    if (text === null) continue
    const match = FABRIC_CHOICE_WORDS[normalizeChoice(text)]
    if (match !== undefined) return match
  }
  return null
}

/** The distinctive words of the BOE note, as the template prints them. */
const TERMS_NOTE_MARKER = 'ex-factory'

/**
 * The commercial terms the workbook printed, or null.
 *
 * THE LEADING "Note:" IS DROPPED. It is a heading on the sheet, where the block
 * has no label of its own; on the Draft PI and on the generated document the
 * text already sits under a "Commercial terms" heading, and carrying the word
 * through would print the heading twice.
 *
 * Nothing else is touched. Line breaks, wording and punctuation are the
 * document's own, because this text is the record of what the client was
 * quoted.
 */
export function readCommercialTermsNote(sheet: PiSheet): string | null {
  for (const address of TERMS_NOTE_CELLS) {
    const text = textOf(sheet.cells.get(address))
    if (text === null) continue
    if (!text.toLowerCase().includes(TERMS_NOTE_MARKER)) continue
    const withoutHeading = text.replace(/^\s*note\s*:?\s*/i, '').trim()
    if (withoutHeading !== '') return withoutHeading
  }
  return null
}

// ── Header ────────────────────────────────────────────────────────────────────

function readHeader(sheet: PiSheet, warnings: PiWarning[]): PiHeader {
  const at = (address: string) => sheet.cells.get(address)
  const text = (address: string, what: string) => {
    const cell = at(address)
    noteMissingCachedValue(cell, warnings, what)
    return textOf(cell)
  }
  const date = (address: string, what: string) => {
    const cell = at(address)
    noteMissingCachedValue(cell, warnings, what)
    return readDateValue(cell)
  }

  return {
    sourceOrderNumber:     text(HEADER_CELLS.sourceOrderNumber, 'The order number on the sheet'),
    creationDate:          date(HEADER_CELLS.creationDate, 'Date of creation'),
    createdBy:             text(HEADER_CELLS.createdBy, 'Created by'),
    boeGst:                text(HEADER_CELLS.boeGst, 'BOE GST'),
    contactNumber:         text(HEADER_CELLS.contactNumber, 'Contact number'),
    billToName:            text(HEADER_CELLS.billToName, 'Bill-to name'),
    billToPhone:           text(HEADER_CELLS.billToPhone, 'Bill-to phone'),
    billToGst:             text(HEADER_CELLS.billToGst, 'Bill-to GST'),
    billingAddress:        text(HEADER_CELLS.billingAddress, 'Billing address'),
    shipToName:            text(HEADER_CELLS.shipToName, 'Ship-to name'),
    shipToPhone:           text(HEADER_CELLS.shipToPhone, 'Ship-to phone'),
    shipToGst:             text(HEADER_CELLS.shipToGst, 'Ship-to GST'),
    shippingAddress:       text(HEADER_CELLS.shippingAddress, 'Shipping address'),
    orderConfirmationDate: date(HEADER_CELLS.orderConfirmationDate, 'Order confirmation date'),
    dispatchCommitment:    date(HEADER_CELLS.dispatchCommitment, 'Dispatch commitment'),
  }
}

/**
 * The three header cells a PI is expected to fill (owner decision 2026-09-18,
 * revised 2026-09-21).
 *
 * Sales Person: any real text — blank or a bare dash is not a name.
 * Confirmation date: a real calendar date (an Excel date, 2020 or later) —
 *   the Order stores order_confirmation_date only from one.
 * Dispatch date: exactly what the save path will keep as the due date —
 *   plausibleDueDate() (lib/orders/dueDate.ts), the SAME rule, so the reading
 *   here and the saved record can never disagree. A lead time ("6 weeks from
 *   date of confirmation", or a bare "90" that Excel turned into a 1900 date)
 *   is not a due date and does not become one.
 *
 * WARNINGS, NOT BLOCKING ISSUES, and the whole point of the distinction is the
 * door each one closes. A blocking issue refuses the UPLOAD, which said to
 * somebody holding an otherwise complete PI that the only way forward was back
 * into Excel — untrue, because all three land in ordinary editable draft
 * columns. So the upload takes the workbook, the preview says what is missing,
 * and FINALIZATION is what refuses: submit_pi_for_review checks the stored
 * columns, which a person may have since corrected by hand. See PiWarningCode.
 *
 * The messages name the cell and say the draft can carry the correction, so a
 * reader is never left thinking a re-import is the only route.
 */
export function headerRequirementWarnings(header: Pick<PiHeader,
  'createdBy' | 'creationDate' | 'orderConfirmationDate' | 'dispatchCommitment'>): PiWarning[] {
  const issues: PiWarning[] = []
  if (isNotApplicableMarker(header.createdBy)) {
    issues.push({
      code: 'PI_SALESPERSON_MISSING',
      message: 'Sales Person (cell G21) is empty. Name the salesperson on the draft, or enter it in the workbook and upload the PI again.',
      row: 21,
      cell: HEADER_CELLS.createdBy,
    })
  }

  const confirmed = header.orderConfirmationDate?.iso ?? null
  const confirmedOk = isCalendarDate(confirmed) && confirmed >= DUE_DATE_FLOOR
  if (!confirmedOk) {
    const read = header.orderConfirmationDate
    issues.push({
      code: 'PI_CONFIRMATION_DATE_MISSING',
      message: read
        ? `Date of Order Confirmation (cell A113) reads "${read.text}", which is not a date. Set the confirm date on the draft, or enter it as a date (for example 25/10/2026) and upload the PI again.`
        : 'Date of Order Confirmation (cell A113) is empty. Set the confirm date on the draft, or enter it in the workbook and upload the PI again.',
      row: 113,
      cell: HEADER_CELLS.orderConfirmationDate,
    })
  }

  const dispatch = header.dispatchCommitment
  const due = plausibleDueDate({
    candidate: dispatch?.iso ?? dispatch?.text ?? null,
    orderConfirmationDate: confirmed,
    creationDate: header.creationDate?.iso ?? null,
  })
  if (due === null) {
    issues.push({
      code: 'PI_DISPATCH_DATE_MISSING',
      message: !dispatch
        ? 'Dispatch Date Finalized (cell E113) is empty. Set the due date on the draft, or enter the dispatch date in the workbook and upload the PI again.'
        : confirmedOk && isCalendarDate(dispatch.iso) && dispatch.iso >= DUE_DATE_FLOOR
          ? `Dispatch Date Finalized (cell E113) is ${dispatch.text}, which is before the order confirmation date. Set the correct due date on the draft, or correct the workbook and upload the PI again.`
          : `Dispatch Date Finalized (cell E113) reads "${dispatch.text}", which is not a date. Set the due date on the draft, or enter the actual dispatch date (for example 25/12/2026) — not a lead time — in the workbook and upload the PI again.`,
      row: 113,
      cell: HEADER_CELLS.dispatchCommitment,
    })
  }
  return issues
}

// ── Products ──────────────────────────────────────────────────────────────────

/**
 * Is this row a real product, or one of the eighty empty slots the template
 * ships with?
 *
 * Column A is deliberately NOT consulted: in one production workbook every slot
 * — used and unused alike — carries a formula-derived code, so a row can look
 * populated in column A while holding no product at all. The same goes for the
 * cached line total in I and the pre-filled sequence in J. What actually
 * distinguishes a product is that somebody typed something about it: a name, a
 * quantity, dimensions, a material, or a price.
 */
function rowHasProductContent(sheet: PiSheet, row: number): boolean {
  const cols = [COL.name, COL.quantity, COL.dimensions, COL.material, COL.costPerPiece]
  return cols.some(col => hasAnyValue(sheet.cells.get(cellRef(col, row))))
}

type BuildProductInput = {
  sheet: PiSheet
  row: number
  /** Column-E pictures anchored to this row. Exactly one is required. */
  rowImages: readonly PiProductImage[]
  /** Column-K pictures anchored to this row. Any number, including none. */
  rowCustomizationImages: readonly PiProductImage[]
  warnings: PiWarning[]
  blockingIssues: PiBlockingIssue[]
  /** Flat accumulators for the workbook result. Appended to, never read. */
  representativeImages: PiProductImage[]
  customizationImages: PiProductImage[]
}

function buildProduct(input: BuildProductInput): PiProduct {
  const {
    sheet, row, rowImages, rowCustomizationImages,
    warnings, blockingIssues, representativeImages, customizationImages,
  } = input
  const at = (col: number) => sheet.cells.get(cellRef(col, row))

  const codeCell = at(COL.code)
  const quantityCell = at(COL.quantity)
  const costCell = at(COL.costPerPiece)
  const totalCell = at(COL.lineTotal)

  noteMissingCachedValue(codeCell, warnings, `Row ${row} product code`)
  noteMissingCachedValue(quantityCell, warnings, `Row ${row} quantity`)
  noteMissingCachedValue(costCell, warnings, `Row ${row} cost per piece`)
  noteMissingCachedValue(totalCell, warnings, `Row ${row} line total`)

  const quantity = numberOf(quantityCell)
  const costPerPiece = numberOf(costCell)
  const lineTotal = numberOf(totalCell)

  // ── Blocking: what an order cannot be approved without ──

  const productName = textOf(at(COL.name))
  if (productName === null) {
    blockingIssues.push({
      code: 'PRODUCT_NAME_MISSING',
      row,
      cell: cellRef(COL.name, row),
      message: `Row ${row} has no product name.`,
    })
  }

  // Zero and negative are refused alongside missing and non-numeric: an order
  // line for nought pieces, or at a negative rate, is not something an approver
  // can act on, and it would corrupt every total derived from it.
  const quantityOk = quantity !== null && quantity > 0
  if (!quantityOk) {
    blockingIssues.push({
      code: 'PRODUCT_QUANTITY_INVALID',
      row,
      cell: cellRef(COL.quantity, row),
      message: `Row ${row} needs a quantity greater than zero (${describeInvalidNumber(quantityCell, quantity)}).`,
    })
  }

  const costOk = costPerPiece !== null && costPerPiece > 0
  if (!costOk) {
    blockingIssues.push({
      code: 'PRODUCT_COST_INVALID',
      row,
      cell: cellRef(COL.costPerPiece, row),
      message: `Row ${row} needs a cost per piece greater than zero (${describeInvalidNumber(costCell, costPerPiece)}).`,
    })
  }

  const itemSequence = textOf(at(COL.itemSequence))
  if (itemSequence === null) {
    blockingIssues.push({
      code: 'PRODUCT_ITEM_SEQUENCE_MISSING',
      row,
      cell: cellRef(COL.itemSequence, row),
      message: `Row ${row} has no item sequence, so no product code can be formed for it when the order is numbered.`,
    })
  }

  let representativeImage: PiProductImage | null = null
  if (rowImages.length === 0) {
    // Covers "no picture was anchored" and "the one that was could not be read"
    // alike — either way this row has no usable image. When it was the latter, a
    // PRODUCT_IMAGE_UNREADABLE / PRODUCT_IMAGE_UNSAFE_PATH warning explains why.
    blockingIssues.push({
      code: 'PRODUCT_IMAGE_REQUIRED',
      row,
      cell: cellRef(COL.image, row),
      message: `Row ${row} has no usable representative image anchored in column ${indexToColumnLetter(COL.image)}.`,
    })
  } else if (rowImages.length > 1) {
    // Deliberately NOT "use the first and warn". Two pictures on one row is a
    // question only a person can answer, and quietly attaching the wrong
    // photograph to a commercial document is worse than refusing to choose.
    blockingIssues.push({
      code: 'PRODUCT_IMAGE_AMBIGUOUS',
      row,
      cell: cellRef(COL.image, row),
      message: `Row ${row} has ${rowImages.length} images anchored to it. Remove the ones that do not belong to this product.`,
    })
  } else if (!isStorableImageFormat(rowImages[0].format)) {
    // A FORMAT THAT CANNOT BE KEPT IS THE SAME OUTCOME AS NO IMAGE, and it is
    // the more dangerous of the two because the workbook looks perfectly fine.
    // GIF, BMP and TIFF are all sniffed correctly and all unusable here, so the
    // message names what was found and what to replace it with. The picture is
    // deliberately NOT assigned: nothing downstream may persist it, the preview
    // shows the same missing-image placeholder a reviewer would see for a truly
    // absent one, and the coverage count agrees with both.
    blockingIssues.push({
      code: 'PRODUCT_IMAGE_UNSUPPORTED_FORMAT',
      row,
      cell: cellRef(COL.image, row),
      message: `Row ${row}: the representative image is ${describeImageFormat(rowImages[0].format)}, `
             + `which cannot be stored. Replace it with ${PI_ACCEPTED_IMAGE_LABEL} and upload the PI again.`,
    })
  } else {
    representativeImage = rowImages[0]
    representativeImages.push(representativeImage)
  }

  // ── Customization images: optional, unlimited, never blocking ──
  //
  // Zero is the ordinary case and says nothing; several on one row is a client
  // asking for several changes and is equally ordinary.
  //
  // A format that cannot be stored IS reported, as a warning naming the row.
  // It is not blocking — a customization image is optional and the order is
  // still submittable without it — but it is not dropped in silence either:
  // the picture is left out of the product so that the preview, the saved
  // record and the count all agree, and the warning says which row lost one.
  //
  // The order the workbook anchored them in is preserved, so "customization
  // image 2 of 3" means the same thing to the reviewer as it does to the file.
  const storableCustomizationImages: PiProductImage[] = []
  for (const customizationImage of rowCustomizationImages) {
    if (!isStorableImageFormat(customizationImage.format)) {
      warnings.push({
        code: 'CUSTOMIZATION_IMAGE_UNSUPPORTED_FORMAT',
        row,
        cell: cellRef(COL.customization, row),
        message: `Row ${row}: a customization image is ${describeImageFormat(customizationImage.format)}, `
               + `which cannot be stored, so it was left out. Convert it to ${PI_ACCEPTED_IMAGE_LABEL} if it is needed.`,
      })
      continue
    }
    storableCustomizationImages.push(customizationImage)
    customizationImages.push(customizationImage)
  }

  // ── Non-blocking: description gaps and arithmetic ──

  const dimensions = textOf(at(COL.dimensions))
  if (dimensions === null) {
    warnings.push({
      code: 'PRODUCT_DIMENSIONS_MISSING',
      row,
      cell: cellRef(COL.dimensions, row),
      message: `Row ${row} has no dimensions.`,
    })
  }

  const material = textOf(at(COL.material))
  if (material === null) {
    warnings.push({
      code: 'PRODUCT_MATERIAL_MISSING',
      row,
      cell: cellRef(COL.material, row),
      message: `Row ${row} has no material.`,
    })
  }

  // The arithmetic check. A mismatch is REPORTED; the workbook's own figure is
  // what the product carries, because that is the number the client was quoted.
  // Skipped entirely when quantity or cost is already blocking — the reviewer is
  // told once what to fix, not twice.
  if (quantityOk && costOk) {
    if (lineTotal === null) {
      warnings.push({
        code: 'LINE_TOTAL_UNVERIFIABLE',
        row,
        cell: cellRef(COL.lineTotal, row),
        stored: null,
        computed: quantity * costPerPiece,
        message: `Row ${row}: the stored line total is missing or not numeric, so the arithmetic could not be cross-checked.`,
      })
    } else if (Math.abs(quantity * costPerPiece - lineTotal) > MONEY_EPSILON) {
      warnings.push({
        code: 'LINE_TOTAL_MISMATCH',
        row,
        cell: cellRef(COL.lineTotal, row),
        stored: lineTotal,
        computed: quantity * costPerPiece,
        message: `Row ${row}: quantity × cost per piece does not equal the stored line total. The workbook's figure has been kept.`,
      })
    }
  }

  return {
    row,
    sourceProductCode: textOf(codeCell),
    productName,
    quantity,
    dimensions,
    material,
    costPerPiece,
    lineTotal,
    itemSequence,
    // Kept in its own field, never folded into material: they answer different
    // questions and a later phase stores them in separate columns. Optional by
    // definition — a blank one is never a blocking issue. This is the TEXT in
    // column K; the pictures floating over that column are the separate field
    // below, and neither is ever read as the other.
    customization: textOf(at(COL.customization)),
    representativeImage,
    customizationImages: storableCustomizationImages,
  }
}

/** Says which of the three failure modes a required number hit, so the message
 *  tells a reviewer what to actually do. */
function describeInvalidNumber(cell: PiCell | undefined, parsed: number | null): string {
  if (parsed !== null) return `it is ${parsed}`
  if (!cell || cell.type === 'empty') return 'the cell is empty'
  return 'the cell is not a number'
}

function indexToColumnLetter(col: number): string {
  return cellRef(col, 1).replace(/\d+$/, '')
}

// ── Commercial footer ─────────────────────────────────────────────────────────

function readCommercial(
  sheet: PiSheet,
  products: readonly PiProduct[],
  warnings: PiWarning[],
): PiCommercialSummary {
  const amountOrText = (
    address: string,
    what: string,
    policy: NonNumericPolicy,
    warnOnText: boolean,
  ): PiAmountOrText => {
    const cell = sheet.cells.get(address)
    noteMissingCachedValue(cell, warnings, what)

    const amount = numberOf(cell)
    if (amount !== null) return { amount, text: null, zeroMeaning: null, cell: address }

    const text = textOf(cell)

    if (policy === 'wordedZero') {
      // "Nothing to charge here", written the way the template writes it.
      // Resolves to a real zero so callers can add it up, with the meaning
      // saying it was a dash or a blank rather than a typed 0.
      if (isNotApplicableMarker(text)) {
        return { amount: 0, text: null, zeroMeaning: 'notApplicable', cell: address }
      }
      // "There IS such a charge, and it is already inside another figure." Also
      // zero for arithmetic, and deliberately NOT the same fact as above — the
      // source wording is kept so the record says which word the workbook used.
      if (isIncludedMarker(text)) {
        return { amount: 0, text, zeroMeaning: 'included', cell: address }
      }
    }

    if (warnOnText && text !== null) {
      warnings.push({
        code: 'COMMERCIAL_VALUE_NON_NUMERIC',
        cell: address,
        message: `${what} (${address}) holds text rather than a number. The text has been kept and no amount was inferred.`,
      })
    }
    return { amount: null, text, zeroMeaning: null, cell: address }
  }

  // ── The discount. Position, not label. ──
  const discountCell = sheet.cells.get(COMMERCIAL_CELLS.discount)
  noteMissingCachedValue(discountCell, warnings, 'Discount')
  const discountAmount = numberOf(discountCell)
  let discount = 0
  if (discountAmount !== null) {
    discount = discountAmount
  } else if (hasAnyValue(discountCell)) {
    // Non-blank but not a number: worth saying. A BLANK cell is the ordinary
    // "this PI has no discount" case and needs no warning at all.
    warnings.push({
      code: 'DISCOUNT_NOT_NUMERIC',
      cell: COMMERCIAL_CELLS.discount,
      message: `The discount cell (${COMMERCIAL_CELLS.discount}) is not a number, so a discount of 0 has been used.`,
    })
  }

  const subtotalAfterDiscount = amountOrText(COMMERCIAL_CELLS.subtotalAfterDiscount, 'Sub total', 'strict', true)
  // Fabric and packing are the two "as per actual" rows, and the template has
  // two shorthands for them: a dash means there is no such charge, and
  // "Inclusive"/"Included" means the charge is already inside another figure.
  // Both are zero and neither is a problem; anything ELSE written there still
  // is. These are the ONLY two cells that accept either.
  const fabricCost = amountOrText(COMMERCIAL_CELLS.fabricCost, 'Fabric cost', 'wordedZero', true)
  const packingCost = amountOrText(COMMERCIAL_CELLS.packingCost, 'Packing cost', 'wordedZero', true)
  // Transportation is EXPECTED to be words as often as numbers ("as applicable"
  // is the standard BOE wording), so text here is not a warning — it is the
  // fact, and it is preserved verbatim rather than resolved to zero.
  const transportation = amountOrText(COMMERCIAL_CELLS.transportation, 'Transportation', 'strict', false)
  const totalBeforeGst = amountOrText(COMMERCIAL_CELLS.totalBeforeGst, 'Total before GST', 'strict', true)
  const gst = amountOrText(COMMERCIAL_CELLS.gst, 'GST', 'strict', true)
  const grandTotal = amountOrText(COMMERCIAL_CELLS.grandTotal, 'Grand total', 'strict', true)

  // ── Derived figures ──
  const grossProductAmount = products.reduce((sum, p) => {
    if (p.lineTotal !== null) return sum + p.lineTotal
    if (p.quantity !== null && p.costPerPiece !== null) return sum + p.quantity * p.costPerPiece
    return sum
  }, 0)

  // Subtracted HERE and only here. subtotalAfterDiscount is the workbook's own
  // post-discount figure and is never reduced again — doing so would take the
  // discount off twice and understate the order by exactly the discount.
  const expectedSubtotal = grossProductAmount - discount

  if (
    subtotalAfterDiscount.amount !== null &&
    Math.abs(expectedSubtotal - subtotalAfterDiscount.amount) > MONEY_EPSILON
  ) {
    warnings.push({
      code: 'SUBTOTAL_MISMATCH',
      cell: COMMERCIAL_CELLS.subtotalAfterDiscount,
      stored: subtotalAfterDiscount.amount,
      computed: expectedSubtotal,
      message: `The sum of the product lines less the discount does not equal the stored sub total. The workbook's figure has been kept.`,
    })
  }

  return {
    discount,
    discountLabel: textOf(sheet.cells.get(COMMERCIAL_CELLS.discountLabel)),
    subtotalAfterDiscount,
    fabricCost,
    packingCost,
    transportation,
    totalBeforeGst,
    gst,
    grandTotal,
    grossProductAmount,
    expectedSubtotal,
  }
}
