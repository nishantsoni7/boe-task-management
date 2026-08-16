// BOE Proforma Invoice (PI) workbook — the shapes the parser produces.
//
// Phase 1 is READ-ONLY and OFFLINE. Nothing in src/lib/pi writes a file, opens a
// network connection, touches Supabase, or allocates an official Order number.
// The parser turns one .xlsx into facts plus a list of things a human should
// look at, and stops there.
//
// THREE KINDS OF PROBLEM, kept apart on purpose:
//
//   PiError         FATAL. The workbook cannot be trusted as a BOE PI at all —
//                   wrong file, wrong template, no Master sheet, unsafe archive.
//                   The result carries no data, so a caller cannot accidentally
//                   read half-parsed values out of a failure.
//   PiBlockingIssue PARSED, BUT NOT FIT TO SUBMIT. The workbook read cleanly and
//                   the preview is complete and usable, but a specific product
//                   row is missing something an order cannot go to approval
//                   without — a name, a usable quantity or rate, its sequence,
//                   or exactly one representative image. The data is STILL
//                   RETURNED: the reviewer needs to see the preview in order to
//                   fix it, and hiding it would make the problem harder to
//                   correct, not easier.
//   PiWarning       NON-BLOCKING. Something needs a person's judgement but does
//                   not stop a submission — a line total that does not match
//                   quantity × rate, a missing material, a transportation cell
//                   that says "as applicable" rather than a number.
//
// The parser NEVER repairs a workbook figure. Where a computed value disagrees
// with a stored one, BOTH are reported and the stored one is what is returned.
// Silently substituting our arithmetic for the workbook's would make the import
// disagree with the document the client was actually sent.

// ── Diagnostics ───────────────────────────────────────────────────────────────

/** Blocking failures. Each one means "this is not a parseable BOE PI". */
export type PiErrorCode =
  /** Over PI_MAX_WORKBOOK_BYTES. Refused before the archive is opened. */
  | 'INPUT_TOO_LARGE'
  /** Not a ZIP, or truncated/corrupt beyond fflate's ability to read it. */
  | 'INVALID_ZIP'
  /** An entry name that escapes its directory or is otherwise malformed. */
  | 'UNSAFE_ENTRY_NAME'
  /** The same entry name twice — a Record<string,bytes> would silently lose one. */
  | 'DUPLICATE_ENTRY'
  /** More parts than any real workbook has. */
  | 'TOO_MANY_ENTRIES'
  /** Zip-bomb guard: declared inflated size (or ratio) is beyond the ceiling. */
  | 'DECOMPRESSED_TOO_LARGE'
  /** Missing [Content_Types].xml / workbook.xml / rels / any worksheet part. */
  | 'MISSING_WORKBOOK_PARTS'
  /** No sheet named exactly "Master". */
  | 'MASTER_SHEET_MISSING'
  /** Master is declared but its relationship or part cannot be resolved/read. */
  | 'MASTER_SHEET_UNREADABLE'
  /** Row 31 does not carry the expected BOE column headers. */
  | 'TEMPLATE_FINGERPRINT_MISMATCH'
  /** Template matched but not one genuine product row was found. */
  | 'NO_PRODUCT_ROWS'

/**
 * Per-row problems that must be fixed before an imported PI can be submitted
 * for approval.
 *
 * The line between these and PiWarning is "could an approver act on this order
 * as it stands?". A missing material is a gap in the description — the order can
 * still be placed and the gap filled in conversation. A missing QUANTITY is not:
 * there is no order to approve. A row without exactly one representative image
 * cannot become a numbered product line, because nothing downstream can choose
 * between zero pictures or two.
 *
 * Customization is NEVER here. It is optional by definition — most product rows
 * genuinely have none.
 */
export type PiBlockingIssueCode =
  /** Column B is empty. There is no product to order. */
  | 'PRODUCT_NAME_MISSING'
  /** Column C is missing, not a number, or zero/negative. */
  | 'PRODUCT_QUANTITY_INVALID'
  /** Column H is missing, not a number, or zero/negative. */
  | 'PRODUCT_COST_INVALID'
  /** Column J carries no sequence, so {orderNumber}-{sequence} cannot be formed
   *  when the order is eventually numbered. */
  | 'PRODUCT_ITEM_SEQUENCE_MISSING'
  /** No usable picture is anchored in column E for this row — either none was
   *  anchored, or the one that was could not be read (see the matching
   *  PRODUCT_IMAGE_UNREADABLE / PRODUCT_IMAGE_UNSAFE_PATH warning for why). */
  | 'PRODUCT_IMAGE_REQUIRED'
  /** Two or more pictures are anchored to this row. Blocking rather than a
   *  warning because the system cannot safely decide which one is the product:
   *  picking the first would silently attach the wrong photograph to a
   *  commercial document. A person has to remove the extra. */
  | 'PRODUCT_IMAGE_AMBIGUOUS'

/** Things a reviewer should see. None of these stops a submission. */
export type PiWarningCode =
  /** A cell holds a formula with no cached result, so the workbook never stored
   *  the number Excel would display. We report the gap rather than compute one. */
  | 'FORMULA_WITHOUT_CACHED_VALUE'
  /** quantity × costPerPiece disagrees with the stored line total. */
  | 'LINE_TOTAL_MISMATCH'
  /** The stored line total is missing or non-numeric while quantity and cost are
   *  both fine, so the arithmetic could not be cross-checked. Not raised when
   *  quantity or cost is already blocking — that is reported once, not twice. */
  | 'LINE_TOTAL_UNVERIFIABLE'
  /** Column D is empty. A description gap, not an obstacle to approval. */
  | 'PRODUCT_DIMENSIONS_MISSING'
  /** Column G is empty. Same reasoning as dimensions. */
  | 'PRODUCT_MATERIAL_MISSING'
  /** A REPRESENTATIVE picture's relationship resolves to a part that is not in
   *  the archive. Explains WHY a row may also carry PRODUCT_IMAGE_REQUIRED. */
  | 'PRODUCT_IMAGE_UNREADABLE'
  /** A REPRESENTATIVE picture's relationship target escapes the package or
   *  leaves xl/media. */
  | 'PRODUCT_IMAGE_UNSAFE_PATH'
  /**
   * A CUSTOMIZATION picture could not be read. Deliberately its own code rather
   * than reusing the two above: those two exist to explain a blocking
   * PRODUCT_IMAGE_REQUIRED, and a customization image can never cause one. A
   * reviewer seeing this needs to know the product is still submittable and
   * that what is missing is an illustration of a change.
   */
  | 'CUSTOMIZATION_IMAGE_UNREADABLE'
  /** A customization picture's target escapes the package or leaves xl/media.
   *  Non-blocking, for the same reason. */
  | 'CUSTOMIZATION_IMAGE_UNSAFE_PATH'
  /** The Master sheet declares no drawing part, so no picture can be mapped. */
  | 'DRAWING_PART_MISSING'
  /** A hidden row inside the product band carries real product content. The row
   *  is EXCLUDED (hidden means template scaffolding) and this says so out loud,
   *  because silently dropping a product would be the worse failure. */
  | 'HIDDEN_ROW_WITH_CONTENT'
  /** I115 holds something that is neither blank nor a number. Discount is 0. */
  | 'DISCOUNT_NOT_NUMERIC'
  /** grossProductAmount − discount disagrees with the stored subtotal (I116). */
  | 'SUBTOTAL_MISMATCH'
  /** A commercial cell that is normally a number holds unexpected text. Both the
   *  text and a null amount are returned; nothing is coerced. A blank or a dash
   *  in the fabric/packing cost cells is NOT this — see PiAmountOrText. */
  | 'COMMERCIAL_VALUE_NON_NUMERIC'

export type PiError = {
  code: PiErrorCode
  message: string
  /** A1-style address when the problem belongs to one cell. */
  cell?: string
  /** 1-based worksheet row when the problem belongs to one row. */
  row?: number
  /** Archive part name when the problem belongs to one ZIP entry. */
  part?: string
}

export type PiWarning = {
  code: PiWarningCode
  message: string
  cell?: string
  row?: number
  part?: string
  /** Present on the two arithmetic checks: what the workbook stored, and what
   *  the workbook's own inputs imply. Never used to overwrite anything. */
  stored?: number | null
  computed?: number | null
}

export type PiBlockingIssue = {
  code: PiBlockingIssueCode
  message: string
  /** Always present: every blocking issue belongs to one genuine product row. */
  row: number
  /** The A1 address a reviewer should go and fix. */
  cell?: string
}

// ── Values ────────────────────────────────────────────────────────────────────

/**
 * A date-bearing header cell.
 *
 * BOE PIs store some dates as real Excel serials and others as free text
 * ("6 weeks from date of confirmation"). Both are legitimate, so both survive:
 * `iso` is filled only when the cell was a genuine serial, and `text` always
 * carries what a reader would see. A caller that needs a date checks `iso`; a
 * caller that needs to show the commitment shows `text`.
 */
export type PiDateValue = {
  /** YYYY-MM-DD, only when the cell held an Excel date serial. */
  iso: string | null
  /** What the cell reads as. Never an empty string — an empty cell is null. */
  text: string
  source: 'serial' | 'text'
}

/**
 * A commercial figure that the template expects to be numeric but which a real
 * workbook sometimes fills in with words (transportation "as applicable").
 *
 * Exactly one of `amount` / `text` is meaningful. Both are null when the cell is
 * empty AND the cell is one where emptiness carries no agreed meaning.
 *
 * THE DASH. In the fabric-cost and packing-cost rows the template's own
 * convention for "nothing to charge" is a dash — a production workbook writes
 * "-" in I117 where another leaves the cell blank, and both mean the same
 * thing. For those two cells a blank, whitespace, or a dash resolves to
 * `amount: 0` with `zeroMeaning: 'notApplicable'`, and is NOT reported as
 * unexpected text.
 *
 * "INCLUSIVE". The same two cells also accept the words "Inclusive" or
 * "Included": the charge exists but is already inside another figure. That
 * resolves to `amount: 0` with `zeroMeaning: 'included'`, keeps the source
 * wording in `text` for audit, and is likewise not a warning.
 *
 * Any OTHER wording in those cells is still preserved verbatim and warned
 * about, because "to be confirmed" is neither zero nor included.
 *
 * PHASE 3B SCHEMA NOTE. 20260908000000 stores fabric_cost and packing_cost as
 * plain numerics, which cannot tell these three apart — a nil charge, a charge
 * folded into another line, and an unresolved note all become 0. Persisting a
 * PI faithfully needs the meaning alongside the number: a companion
 * classification column (or a small enum) per cost, plus the source text where
 * text was allowed. That migration is NOT touched in this phase.
 */
/**
 * Why a cell with no number in it nonetheless resolves to a zero charge.
 *
 * TWO DIFFERENT COMMERCIAL FACTS, and they must never be collapsed:
 *
 *   notApplicable  Blank or a dash. There is NO such charge on this order.
 *   included       "Inclusive" / "Included". There IS such a charge; it is
 *                  already inside another figure on the PI and is not billed
 *                  again here.
 *
 * Both add zero to the arithmetic, which is why both carry `amount: 0`. But a
 * client asking "was packing charged?" gets opposite answers, so a screen that
 * printed "Not applicable" for an "Inclusive" cell would misreport the
 * document. Only the two "as per actual" rows (fabric I117, packing I118) can
 * produce either; every other commercial cell treats the same words as
 * unexpected text and warns.
 */
export type PiZeroMeaning = 'notApplicable' | 'included'

export type PiAmountOrText = {
  amount: number | null
  text: string | null
  /**
   * Set when the cell stated a zero charge in words rather than in digits.
   * `amount` is 0 whenever this is non-null, so callers doing arithmetic need
   * not special-case it, while a caller rendering the PI can still show what
   * the workbook actually said.
   *
   * null when the cell held a real figure, unexpected text, or nothing at all.
   */
  zeroMeaning: PiZeroMeaning | null
  /** The cell this came from, so a reviewer can be pointed straight at it. */
  cell: string
}

// ── Header block (rows 20–28, plus the two commitment cells at row 113) ────────

export type PiHeader = {
  /**
   * B20. The number already printed on the supplied workbook.
   *
   * SOURCE DATA ONLY. Phase 1 allocates nothing, and this value must never be
   * treated as an official BOE order number — an imported PI arrives without
   * one, and the official number is allocated by approval in a later phase.
   */
  sourceOrderNumber: string | null
  /** G20 */
  creationDate: PiDateValue | null
  /** G21 */
  createdBy: string | null
  /** B22 — the BOE company GST, not the client's. */
  boeGst: string | null
  /** G22 */
  contactNumber: string | null

  /** B25 */
  billToName: string | null
  /** B26 */
  billToPhone: string | null
  /** B27 */
  billToGst: string | null
  /** B28 */
  billingAddress: string | null

  /** G25 */
  shipToName: string | null
  /** G26 */
  shipToPhone: string | null
  /** G27, when the template carries it. */
  shipToGst: string | null
  /** G28 */
  shippingAddress: string | null

  /** A113 */
  orderConfirmationDate: PiDateValue | null
  /** E113 — usually a lead time in words, occasionally a date. */
  dispatchCommitment: PiDateValue | null
}

// ── Products ──────────────────────────────────────────────────────────────────

/**
 * What a picture is FOR. Never inferred from the image itself — it is decided
 * by the column the anchor originates in, and nothing downstream may guess it.
 *
 *   representative  Column E. The product. Exactly one per row, required.
 *   customization   Column K. What should differ from the representative
 *                   image. Any number, including none.
 *
 * The two are kept in separate fields on every shape below rather than in one
 * array with a flag, because "the picture of the product" and "a picture of a
 * change to it" are different facts with different rules, and a single list
 * invites code that forgets which it is holding.
 */
export type PiImageRole = 'representative' | 'customization'

export type PiProductImage = {
  /** Which column this came from, and therefore what it means. */
  role: PiImageRole
  /** 1-based worksheet row the picture is anchored to. */
  row: number
  /** Archive part the bytes came from, e.g. "xl/media/image28.png". */
  part: string
  /** The image bytes. Shared by reference when one media part is anchored to
   *  several rows, so a reused picture is never copied. */
  bytes: Uint8Array
  byteLength: number
  /** Sniffed from magic bytes, never trusted from the file extension. */
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff' | 'unknown'
  /** null when the format is unknown — we do not invent a MIME type. */
  mimeType: string | null
  /** Lower-case extension as stored in the archive ("png", "jpeg"). */
  extension: string
  anchorKind: 'oneCellAnchor' | 'twoCellAnchor'
  /** 0-based anchor origin, as written in the drawing XML. */
  anchorFromCol: number
  anchorFromRow: number
}

export type PiProduct = {
  /** 1-based worksheet row, kept so every warning can point at the source. */
  row: number
  /** A — the code the supplied workbook already carries. Preserved separately
   *  from any future {orderNumber}-{itemSequence} product code, which Phase 1
   *  does not generate. */
  sourceProductCode: string | null
  /** B */
  productName: string | null
  /** C */
  quantity: number | null
  /** D — internal line breaks are preserved; only the surrounding whitespace
   *  of the whole value and of each line is trimmed. */
  dimensions: string | null
  /** G — stored separately from customization, deliberately. */
  material: string | null
  /** H */
  costPerPiece: number | null
  /** I, as the workbook stored it. Never replaced by our own arithmetic. */
  lineTotal: number | null
  /** J, from the hidden sequence column, e.g. "B001". */
  itemSequence: string | null
  /** K — optional; most rows have none. Text only; a picture anchored over
   *  column K is a customizationImage and is never read as this. */
  customization: string | null
  /** The picture anchored in column E on this row, when exactly one was found.
   *  Required: a row without one carries PRODUCT_IMAGE_REQUIRED. */
  representativeImage: PiProductImage | null
  /**
   * Pictures anchored over column K on this row, in document order.
   *
   * OPTIONAL AND UNLIMITED. Empty is the ordinary case and is never a warning
   * or a blocking issue. Several on one row is legitimate — a client asking for
   * three changes attaches three pictures — so unlike the representative image,
   * more than one is NOT an ambiguity and nothing here refuses to choose,
   * because there is nothing to choose between: all of them are kept.
   */
  customizationImages: readonly PiProductImage[]
}

// ── Commercial summary (rows 115–122) ─────────────────────────────────────────

/**
 * The footer block, read by FIXED BUSINESS MEANING rather than by its label.
 *
 * I115 is the discount. Real BOE workbooks label that row "Design Fees" in some
 * files and "Discount" in others; the label is recorded in `discountLabel` for
 * traceability and is deliberately NOT used to decide what the cell means.
 */
export type PiCommercialSummary = {
  /** I115. 0 when the cell is blank — a PI with no discount is the normal case. */
  discount: number
  /** Whatever G115 actually says ("Design Fees", "Discount", …). Never a gate. */
  discountLabel: string | null
  /** I116 */
  subtotalAfterDiscount: PiAmountOrText
  /** I117 */
  fabricCost: PiAmountOrText
  /** I118 */
  packingCost: PiAmountOrText
  /** I119 — routinely textual ("as applicable"). */
  transportation: PiAmountOrText
  /** I120 */
  totalBeforeGst: PiAmountOrText
  /** I121 — never recomputed. GST rules are not this parser's business. */
  gst: PiAmountOrText
  /** I122 */
  grandTotal: PiAmountOrText

  /** Σ of the genuine product line totals. Derived, not read from a cell. */
  grossProductAmount: number
  /** grossProductAmount − discount. Subtracted exactly ONCE, here and nowhere
   *  else; `subtotalAfterDiscount` is the workbook's own figure and is never
   *  reduced again. Compared against it, and any gap becomes a warning. */
  expectedSubtotal: number
}

// ── Template metadata ─────────────────────────────────────────────────────────

export type PiTemplateCellCheck = {
  cell: string
  expected: string
  found: string | null
  ok: boolean
}

export type PiTemplateInfo = {
  sheetName: string
  /** Archive part the Master sheet resolved to — never assumed to be sheet1. */
  sheetPart: string
  /** Every sheet name in declaration order, for provenance. */
  workbookSheetNames: readonly string[]
  /** The drawing part the Master sheet references, when it has one. */
  drawingPart: string | null
  headerRow: number
  firstProductRow: number
  lastProductRow: number
  /** Every fingerprint cell that was checked, passing and failing alike. */
  fingerprint: readonly PiTemplateCellCheck[]
  /** Rows inside the product band the workbook marks hidden. */
  hiddenProductRows: readonly number[]
  /** Rows that survived both gates and became products. */
  genuineProductRows: readonly number[]
  workbookByteLength: number
}

// ── Result ────────────────────────────────────────────────────────────────────

export type PiWorkbook = {
  template: PiTemplateInfo
  header: PiHeader
  products: readonly PiProduct[]
  commercial: PiCommercialSummary
  /**
   * Every column-E picture that became a product's representative image — one
   * entry per mapped product row. A media part anchored to several rows appears
   * once per row, sharing one byte buffer.
   *
   * A row whose pictures were rejected (none, or more than one) contributes
   * nothing here, which is why this can be shorter than `products`.
   */
  representativeImages: readonly PiProductImage[]
  /**
   * Every column-K picture, flattened across products in row order. One entry
   * per anchored picture, NOT per media part — a photograph reused on three
   * rows is three entries sharing one byte buffer.
   *
   * PHASE 3B SCHEMA NOTE. Persisting this needs a normalized child table —
   * order_submission_product_images(product_id, role, storage_path, position)
   * with role in ('representative','customization') — because a product may
   * carry any number of customization images. A single image column on the
   * product row cannot hold them, and the existing 20260908000000 migration
   * has no such table. That migration is NOT touched in this phase.
   */
  customizationImages: readonly PiProductImage[]
}

/**
 * Discriminated on `ok`, so the failure branch carries NO data field at all —
 * reading parsed values out of a failed parse is a type error rather than a
 * runtime surprise. Same shape discipline as fetchAllRows in
 * src/lib/supabasePaging.ts.
 *
 * `ok: true` means THE WORKBOOK WAS READ, not that it is ready to submit. A
 * result with a non-empty `blockingIssues` is a complete, usable preview of a PI
 * that still needs work; the caller shows the data and refuses the submission.
 * Only `ok: false` means there is nothing to show.
 */
export type PiParseResult =
  | {
      ok: true
      data: PiWorkbook
      /** Empty when the workbook is fit to submit for approval. */
      blockingIssues: readonly PiBlockingIssue[]
      warnings: readonly PiWarning[]
    }
  | { ok: false; errors: readonly PiError[]; warnings: readonly PiWarning[] }
