// Turning a SERVER-SIDE parse of a PI workbook into what the database stores.
//
// WHERE THIS SITS. The browser parses a workbook to show a preview; that result
// is a convenience for the person looking at it and is never persisted. When an
// employee saves a draft, the server downloads the same workbook from private
// storage, runs the SAME parser again, and hands the output to this module,
// which shapes it for replace_order_submission_parse. Nothing here ever sees a
// value the browser computed.
//
// EVERYTHING HERE IS PURE. Deterministic ids, path construction, commercial
// meaning and the RPC payload are all functions of the parse result and the
// submission id — no clock, no randomness, no network, no database. That is
// what makes the two properties this phase depends on testable offline:
//
//   IDEMPOTENCY. Item ids are derived from (submission_id, source_row), so
//   re-processing the same draft produces the same ids, therefore the same
//   image object keys, therefore an overwrite instead of a second set of
//   orphaned files. A retry after a partial failure converges.
//
//   NO INVENTED MONEY. Every figure is the parser's. The one derived value is
//   a line total the workbook itself left empty, and it is documented at the
//   point it happens.

import { createHash } from 'node:crypto'
import type { PiAmountOrText, PiImageRole, PiProduct, PiProductImage, PiWorkbook } from '../pi/types'
import type { PiBlockingIssue, PiWarning } from '../pi/types'

// ── Storage keys ──────────────────────────────────────────────────────────────

/**
 * The uploaded workbook: submissions/{submission_id}/original/{uuid}.xlsx
 *
 * A single opaque uuid rather than the employee's filename. A PI is named after
 * the client it was written for, and an object key is visible in logs, in
 * signed URLs and in storage listings; there is no reason for a client's name
 * to travel there. The original filename is stored in a database column
 * instead, where it is behind RLS.
 */
export const WORKBOOK_PATH_PATTERN =
  /^submissions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/original\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xlsx$/

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * Is this exactly the workbook key of THIS submission?
 *
 * Both halves matter. The shape check refuses traversal, backslashes, absolute
 * keys and anything outside original/; the id comparison refuses a perfectly
 * well-formed key belonging to somebody else's draft. A caller supplies this
 * path, so it is the classic IDOR surface and is treated as hostile.
 */
export function isWorkbookPathFor(path: string, submissionId: string): boolean {
  if (typeof path !== 'string' || !WORKBOOK_PATH_PATTERN.test(path)) return false
  if (!isUuid(submissionId)) return false
  return path.startsWith(`submissions/${submissionId}/original/`)
}

export function buildWorkbookPath(submissionId: string, objectId: string): string {
  return `submissions/${submissionId}/original/${objectId}.xlsx`
}

/** The extension an image is stored under, decided by its SNIFFED type. */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** The three types the bucket and the schema accept. Anything else is dropped
 *  rather than stored under a type we would be guessing at. */
export function storableImageMime(mimeType: string | null): string | null {
  if (!mimeType) return null
  return mimeType in MIME_EXTENSION ? mimeType : null
}

/**
 * submissions/{submission_id}/images/{item_id}/{role}/{position}-{sha256}.{ext}
 *
 * CONTENT-ADDRESSED, AND THEREFORE IMMUTABLE. The hash of the bytes is part of
 * the key, so an object at a given key can only ever hold one set of bytes.
 * That is what makes the whole save safe to retry:
 *
 *   * different bytes are a different key, so processing a changed workbook
 *     CREATES objects and never overwrites one the current rows still point at.
 *     A database failure afterwards leaves the old rows describing old objects
 *     that are still exactly what they said they were;
 *   * identical bytes are the same key, so an honest retry finds the object
 *     already there and reuses it instead of writing a second copy;
 *   * an obsolete key is only deleted once the rows referencing it are gone.
 *
 * The same string the database CHECK constraint rebuilds from the row's own
 * columns, hash included. Two independent constructions of one rule: if this
 * function ever drifts, the insert fails rather than storing a key that names
 * bytes the row does not claim.
 */
export function buildImagePath(input: {
  submissionId: string
  itemId: string
  role: PiImageRole
  position: number
  mimeType: string
  sha256: string
}): string {
  const ext = MIME_EXTENSION[input.mimeType]
  if (!ext) throw new Error('unsupported image type')
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('a lowercase hex sha256 is required')
  return `submissions/${input.submissionId}/images/${input.itemId}/${input.role}`
    + `/${input.position}-${input.sha256}.${ext}`
}

// ── Deterministic identity ────────────────────────────────────────────────────

/**
 * The item id for one product line, derived from the submission and the
 * worksheet row it came from.
 *
 * WHY DERIVED AND NOT RANDOM. The image keys contain the item id and the
 * objects are uploaded BEFORE the database rows exist, so the id has to be
 * known in advance. Making it a function of (submission, row) additionally
 * makes the whole operation replayable: processing the same draft twice writes
 * the same keys and the same primary keys, so a retry after a half-finished
 * attempt overwrites rather than accumulating a second set of files nobody
 * points at.
 *
 * A SHA-256 truncated into UUID shape, with the version and variant bits set so
 * the value is a well-formed UUID that no random generator will collide with.
 * Not a security boundary — it names a row inside one submission, and the
 * database still proves that row belongs to that submission.
 */
export function deterministicItemId(submissionId: string, sourceRow: number): string {
  const digest = createHash('sha256')
    .update(`order-submission-item:${submissionId}:${sourceRow}`)
    .digest()

  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x80 // version 8: name-based, custom
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant

  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-')
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ── Verifying an object that is already there ─────────────────────────────────

/** The most a single stored product image may be. The bucket's own ceiling, so
 *  nothing larger can have been written through it in the first place. */
export const MAX_IMAGE_OBJECT_BYTES = 10 * 1024 * 1024

export type ImageVerificationFailure =
  | 'TOO_LARGE'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'PATH_HASH_MISMATCH'
  | 'FORMAT_MISMATCH'

export type ImageVerification =
  | { ok: true; sha256: string }
  | { ok: false; reason: ImageVerificationFailure }

/** The hash a content-addressed key claims, or null when the key has none. */
export function hashFromImagePath(path: string): string | null {
  return /\/\d+-([0-9a-f]{64})\.(png|jpg|jpeg|webp)$/.exec(path)?.[1] ?? null
}

/**
 * Is the object already stored at a content-addressed key genuinely the picture
 * this attempt is holding?
 *
 * SIZE AND CONTENT TYPE ARE NOT EVIDENCE. Storage reports the length and the
 * type it was TOLD at upload; neither is derived from the bytes. Two different
 * images of the same length, both uploaded as image/png, are indistinguishable
 * by metadata — and a truncated or substituted object can carry a perfectly
 * correct-looking content type. Reusing on that basis would let a database row
 * point at bytes nobody verified, which is precisely the integrity property
 * content-addressing exists to provide.
 *
 * So the bytes themselves are hashed, and the digest must agree with BOTH the
 * hash of the freshly parsed image and the hash written into the key. The
 * format is then sniffed from the magic bytes and must agree with the MIME type
 * this attempt would store and with the extension the key carries.
 *
 * Any disagreement is a refusal, never an overwrite: the caller aborts the
 * attempt rather than replacing an object it cannot account for.
 */
export function verifyStoredImageBytes(input: {
  bytes: Uint8Array
  expectedSha256: string
  expectedMimeType: string
  storagePath: string
  sniff: (bytes: Uint8Array) => string
  /** The length of the picture this attempt holds, when it is known. */
  expectedLength?: number
  maxBytes?: number
}): ImageVerification {
  const limit = input.maxBytes ?? MAX_IMAGE_OBJECT_BYTES
  if (input.bytes.byteLength > limit) return { ok: false, reason: 'TOO_LARGE' }

  // A cheap refusal before hashing: the stored object cannot be these bytes if
  // it is not even the same length.
  const expectedLength = input.expectedLength
  if (expectedLength !== undefined && input.bytes.byteLength !== expectedLength) {
    return { ok: false, reason: 'SIZE_MISMATCH' }
  }

  const sha256 = sha256Hex(input.bytes)
  if (sha256 !== input.expectedSha256) return { ok: false, reason: 'HASH_MISMATCH' }
  if (sha256 !== hashFromImagePath(input.storagePath)) {
    return { ok: false, reason: 'PATH_HASH_MISMATCH' }
  }

  // Sniffed, not declared. A PNG content type over JPEG bytes is refused.
  const format = input.sniff(input.bytes)
  const mimeType = FORMAT_MIME[format] ?? null
  if (!mimeType || mimeType !== input.expectedMimeType) {
    return { ok: false, reason: 'FORMAT_MISMATCH' }
  }
  if (!input.storagePath.endsWith(`.${MIME_EXTENSION[mimeType]}`)) {
    return { ok: false, reason: 'FORMAT_MISMATCH' }
  }

  return { ok: true, sha256 }
}

/** Sniffed raster format → the MIME type this system stores it as. */
const FORMAT_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

// ── Commercial meaning ────────────────────────────────────────────────────────

export type CommercialMeaning = 'numeric' | 'not_applicable' | 'included' | 'text'

export type PersistedCost = {
  meaning: CommercialMeaning
  /** null only for `text`, and for a `numeric` cell the workbook left empty. */
  amount: number | null
  /** Required by the schema for `included` and `text`; null otherwise. */
  text: string | null
}

/**
 * One "as per actual" cost cell, in the shape the columns store.
 *
 * The four cases are the parser's, and the mapping is deliberately total:
 *
 *   included        amount 0, and the WORDING is kept. The client WAS charged;
 *                   the charge sits inside another figure.
 *   not_applicable  amount 0, no wording worth keeping. The client was NOT
 *                   charged. Never merged with the case above — they are
 *                   opposite answers that happen to add the same zero.
 *   numeric         the figure, or null when nothing has been parsed yet.
 *   text            no amount could be inferred; the words are kept and the
 *                   parser has already warned.
 *
 * The `included` fallback wording is unreachable — the parser only classifies a
 * cell that way after matching the word — and exists so the database's
 * non-blank requirement can never be violated by a future parser change.
 */
export function persistedCost(value: PiAmountOrText | null | undefined): PersistedCost {
  if (!value) return { meaning: 'numeric', amount: null, text: null }

  if (value.zeroMeaning === 'included') {
    const wording = value.text?.trim()
    return { meaning: 'included', amount: 0, text: wording && wording !== '' ? wording : 'Included' }
  }
  if (value.zeroMeaning === 'notApplicable') {
    return { meaning: 'not_applicable', amount: 0, text: null }
  }
  if (value.amount !== null) {
    return { meaning: 'numeric', amount: value.amount, text: null }
  }
  const text = value.text?.trim()
  if (text && text !== '') {
    return { meaning: 'text', amount: null, text }
  }
  return { meaning: 'numeric', amount: null, text: null }
}

// ── The plan ──────────────────────────────────────────────────────────────────

/** One image to upload, and the row that will point at it. */
export type PlannedImage = {
  itemId: string
  role: PiImageRole
  position: number
  storagePath: string
  mimeType: string
  sha256: string
  sourceMediaPath: string
  anchorRow: number
  /** The bytes to PUT. Shared by reference with the parse result. */
  bytes: Uint8Array
}

export type SubmissionPlan = {
  /** Every image object this attempt must store, in a stable order. */
  images: readonly PlannedImage[]
  /** The exact argument for replace_order_submission_parse. */
  payload: Record<string, unknown>
  counts: {
    items: number
    representativeImages: number
    customizationImages: number
    /** Images the parser produced but whose format could not be sniffed, so
     *  there is no MIME type we are willing to assert. Reported, not stored. */
    skippedImages: number
  }
}

export type SubmissionSource = {
  workbookPath: string
  workbookName: string | null
  workbookSizeBytes: number
  workbookSha256: string
  templateVersion: string | null
}

const isoOrNull = (value: { iso: string | null } | null | undefined): string | null =>
  value?.iso ?? null

const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed && trimmed !== '' ? trimmed : null
}

/**
 * The dispatch commitment is stored as TEXT, not a date.
 *
 * It is a lead time as often as a date — "6 weeks from date of confirmation" —
 * and the column is text for that reason. Whatever the cell read as is what is
 * stored, including when it happened to be a real date.
 */
const commitmentText = (value: { iso: string | null; text: string } | null | undefined): string | null =>
  textOrNull(value?.text ?? null)

function planImagesForProduct(
  submissionId: string,
  itemId: string,
  product: PiProduct,
): { images: PlannedImage[]; skipped: number } {
  const images: PlannedImage[] = []
  let skipped = 0

  const add = (image: PiProductImage, role: PiImageRole, position: number) => {
    const mimeType = storableImageMime(image.mimeType)
    // No sniffed type means no type we are willing to assert. The bucket would
    // refuse the upload and the schema would refuse the row, so the picture is
    // counted as skipped rather than stored under a guess.
    if (!mimeType) { skipped += 1; return }
    const sha256 = sha256Hex(image.bytes)
    images.push({
      itemId,
      role,
      position,
      storagePath: buildImagePath({ submissionId, itemId, role, position, mimeType, sha256 }),
      mimeType,
      sha256,
      sourceMediaPath: image.part,
      anchorRow: image.row,
      bytes: image.bytes,
    })
  }

  if (product.representativeImage) add(product.representativeImage, 'representative', 0)

  // POSITION IS THE INDEX AFTER SKIPPING, so the stored positions are always
  // 0,1,2… with no gap — a gap would make "image 2 of 3" point at the wrong
  // picture. An unreadable one is counted and left out entirely.
  let position = 0
  for (const image of product.customizationImages) {
    const before = images.length
    add(image, 'customization', position)
    if (images.length > before) position += 1
  }

  return { images, skipped }
}

/**
 * Everything the server needs in order to persist one parse, derived from the
 * parse alone.
 *
 * Call this ONLY with a workbook parsed on the server. It performs no
 * authorization and makes no judgement about whether the submission may be
 * written — that is the RPC's job, and it re-derives it from the database.
 */
export function buildSubmissionPlan(input: {
  submissionId: string
  workbook: PiWorkbook
  warnings: readonly PiWarning[]
  blockingIssues: readonly PiBlockingIssue[]
  source: SubmissionSource
}): SubmissionPlan {
  const { submissionId, workbook, source } = input

  const images: PlannedImage[] = []
  let skippedImages = 0

  const items = workbook.products.map((product, index) => {
    const itemId = deterministicItemId(submissionId, product.row)
    const planned = planImagesForProduct(submissionId, itemId, product)
    images.push(...planned.images)
    skippedImages += planned.skipped

    const representative = planned.images.find(i => i.role === 'representative') ?? null

    // THE ONE DERIVED FIGURE. total_amount is NOT NULL in the schema, and a
    // workbook occasionally stores a formula it never evaluated, leaving the
    // line total empty. Where the workbook HAS a total it is stored exactly as
    // read and never recomputed — the parser's whole discipline. Where it has
    // none, quantity × rate is stored so the line can exist at all, and the
    // parser's LINE_TOTAL_UNVERIFIABLE warning travels with the record to say
    // the number was not read from the document.
    const lineTotal = product.lineTotal ?? ((product.quantity ?? 0) * (product.costPerPiece ?? 0))

    return {
      id: itemId,
      source_row: product.row,
      item_sequence: textOrNull(product.itemSequence),
      source_product_code: textOrNull(product.sourceProductCode),
      product_name: textOrNull(product.productName),
      quantity: product.quantity,
      dimensions: textOrNull(product.dimensions),
      // Separate fields. Never merged, at any layer.
      material: textOrNull(product.material),
      customization: textOrNull(product.customization),
      cost_per_piece: product.costPerPiece,
      total_amount: lineTotal,
      // Legacy compatibility columns, written from the representative image so
      // anything still reading them sees the same file the child row names.
      image_storage_path: representative?.storagePath ?? null,
      image_mime_type: representative?.mimeType ?? null,
      image_sha256: representative?.sha256 ?? null,
      image_anchor_row: representative?.anchorRow ?? null,
      sort_order: index,
    }
  })

  const header = workbook.header
  const commercial = workbook.commercial
  const fabric = persistedCost(commercial.fabricCost)
  const packing = persistedCost(commercial.packingCost)
  const transportation = commercial.transportation

  const payload: Record<string, unknown> = {
    header: {
      // The client name is the bill-to name: it is the party the PI is
      // addressed to, and it is what a reviewer scans a list for.
      client_name: textOrNull(header.billToName),
      creation_date: isoOrNull(header.creationDate),
      source_created_by: textOrNull(header.createdBy),
      boe_gst: textOrNull(header.boeGst),
      contact_number: textOrNull(header.contactNumber),
      bill_to_name: textOrNull(header.billToName),
      bill_to_phone: textOrNull(header.billToPhone),
      bill_to_gst: textOrNull(header.billToGst),
      billing_address: textOrNull(header.billingAddress),
      ship_to_name: textOrNull(header.shipToName),
      ship_to_phone: textOrNull(header.shipToPhone),
      ship_to_gst: textOrNull(header.shipToGst),
      shipping_address: textOrNull(header.shippingAddress),
      order_confirmation_date: isoOrNull(header.orderConfirmationDate),
      dispatch_commitment: commitmentText(header.dispatchCommitment),
      // Provenance only. It is never shown as an order number and never seeds
      // one; the column comment in 20260908000000 says so too.
      source_order_number: textOrNull(header.sourceOrderNumber),
    },
    commercial: {
      gross_product_amount: commercial.grossProductAmount,
      discount_amount: commercial.discount,
      subtotal_after_discount: commercial.subtotalAfterDiscount.amount,

      fabric_cost: fabric.amount,
      fabric_cost_meaning: fabric.meaning,
      fabric_cost_text: fabric.text,
      packing_cost: packing.amount,
      packing_cost_meaning: packing.meaning,
      packing_cost_text: packing.text,

      // Transportation keeps the amount/text pair it has always had.
      transportation_amount: transportation.amount,
      transportation_text: textOrNull(transportation.text),

      total_before_gst: commercial.totalBeforeGst.amount,
      gst_amount: commercial.gst.amount,
      grand_total: commercial.grandTotal.amount,
    },
    source: {
      workbook_path: source.workbookPath,
      workbook_name: source.workbookName,
      workbook_size_bytes: source.workbookSizeBytes,
      workbook_sha256: source.workbookSha256,
      template_version: source.templateVersion,
    },
    parse: {
      warnings: input.warnings,
      blocking_issues: input.blockingIssues,
    },
    items,
    item_images: images.map(image => ({
      item_id: image.itemId,
      role: image.role,
      position: image.position,
      storage_path: image.storagePath,
      mime_type: image.mimeType,
      sha256: image.sha256,
      source_media_path: image.sourceMediaPath,
      anchor_row: image.anchorRow,
    })),
  }

  // The replay marker. A hash of everything the server is about to write, so
  // the RPC can tell "the same attempt again" from "a genuinely different
  // reading of a document" and refuse to invent audit history for the first.
  // Computed AFTER the payload is complete and added to it, so it covers the
  // items, the images, the commercial figures and the workbook reference.
  payload.fingerprint = sha256Hex(new TextEncoder().encode(JSON.stringify(payload)))

  return {
    images,
    payload,
    counts: {
      items: items.length,
      representativeImages: images.filter(i => i.role === 'representative').length,
      customizationImages: images.filter(i => i.role === 'customization').length,
      skippedImages,
    },
  }
}
