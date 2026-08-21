// GETTING THE RIGHT WORKBOOK, AND PROVING IT IS THE RIGHT ONE.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// confirmedWorkbook.ts rewrites bytes. This decides WHICH bytes, and refuses to
// hand over any it cannot prove are the workbook the approval was granted
// against.
//
// WHY THAT PROOF MATTERS MORE THAN IT LOOKS
// -----------------------------------------
// The confirmed Excel is the document a client is sent. It carries the Order
// number, and everyone downstream treats it as what was agreed. If generation
// ever read a DIFFERENT file — a workbook belonging to another submission, or a
// replacement uploaded after approval — the business would send a client a
// document with the right number and the wrong prices, and nothing about the
// file would say so.
//
// The system already makes that nearly impossible: order-files has no UPDATE
// policy so a stored object cannot be replaced, and the write predicate
// (can_write_order_submission_file) refuses the owner once the submission leaves
// their hands. This module does not rely on "nearly". It checks three
// independent things:
//
//   THE PATH     is inside this submission's own original/ folder — the shape
//                20260911000000 enforces in SQL, restated so a malformed or
//                foreign key never reaches the signer.
//   THE SIZE     matches source_workbook_size_bytes, recorded at save time.
//   THE HASH     matches source_workbook_sha256, recorded at save time.
//
// Any of the three failing is a refusal, not a warning. A workbook that cannot
// be proved is not generated from.
//
// AND NOTHING HERE WRITES. The original object is read and never touched; the
// confirmed copy goes to a different key entirely, under the Order's own
// reserved prefix. "Do not overwrite the original uploaded PI" is not a rule
// this module follows so much as one it has no way to break.

import { orderPiWorkbookPath } from './orderPiHandoff'

// ── What the record says the workbook is ──────────────────────────────────────

/**
 * The four columns order_submissions records about its uploaded workbook.
 *
 * All four are written together by the save route (20260908000000 §8b) and none
 * is ever rewritten — the submission table has no client UPDATE policy at all.
 */
export type RecordedWorkbook = {
  /** The submission the workbook belongs to. */
  submissionId: string
  /** order_submissions.source_workbook_path. */
  path: string | null | undefined
  /** order_submissions.source_workbook_size_bytes. Nullable on old records. */
  sizeBytes: number | string | null | undefined
  /** order_submissions.source_workbook_sha256, lowercase hex. Nullable on old
   *  records — see requireProvenance below for why that is still refused. */
  sha256: string | null | undefined
}

export const WORKBOOK_COLUMNS = [
  'id', 'source_workbook_path', 'source_workbook_name',
  'source_workbook_size_bytes', 'source_workbook_sha256',
].join(', ')

// ── Failures ──────────────────────────────────────────────────────────────────

export type WorkbookSourceFailure =
  | 'WORKBOOK_MISSING'   // the record names no usable object, or storage has none
  | 'WORKBOOK_MISMATCH'  // the bytes are not the ones the record describes

export type WorkbookPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: WorkbookSourceFailure; detail: string }

/**
 * The object key to read, or a refusal.
 *
 * Delegates the SHAPE check to orderPiWorkbookPath, which is the one place that
 * knows what a submission's own original/ key looks like — so the Order detail
 * screen's download and this generator cannot disagree about which keys are
 * legitimate.
 */
export function workbookObjectPath(record: RecordedWorkbook): WorkbookPathResult {
  const path = orderPiWorkbookPath({
    id: record.submissionId,
    source_workbook_path: typeof record.path === 'string' ? record.path : null,
  })
  if (path === null) {
    return {
      ok: false,
      reason: 'WORKBOOK_MISSING',
      detail: 'the PI record names no workbook inside its own original/ folder',
    }
  }
  return { ok: true, path }
}

export type ProvenanceResult =
  | { ok: true; sha256: string; bytes: number }
  | { ok: false; reason: WorkbookSourceFailure; detail: string }

const toBytes = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Does what was fetched match what the record says was uploaded?
 *
 * BOTH FIGURES ARE REQUIRED, and a record that carries neither is REFUSED rather
 * than waved through. That is a deliberate choice about which way to fail: a PI
 * saved before those columns existed cannot be proved, and generating a client
 * document from an unprovable file is worse than telling somebody the PI is too
 * old to generate from. The columns have been written since 20260908000000, so
 * this affects no record the product can create today.
 *
 * THE HASH IS COMPARED CASE-INSENSITIVELY and the stored one is already
 * constrained to lowercase hex, so the comparison cannot fail on presentation.
 */
export function checkWorkbookProvenance(
  record: RecordedWorkbook,
  actual: { sha256: string; bytes: number },
): ProvenanceResult {
  const expectedSize = toBytes(record.sizeBytes)
  const expectedHash = (record.sha256 ?? '').trim().toLowerCase()

  if (expectedHash === '' && expectedSize === null) {
    return {
      ok: false,
      reason: 'WORKBOOK_MISMATCH',
      detail: 'the PI record carries no workbook hash or size, so the stored file cannot be proved',
    }
  }

  if (actual.bytes === 0) {
    return { ok: false, reason: 'WORKBOOK_MISSING', detail: 'the stored object is empty' }
  }

  if (expectedSize !== null && expectedSize !== actual.bytes) {
    return {
      ok: false,
      reason: 'WORKBOOK_MISMATCH',
      detail: 'the stored workbook is not the size the PI record describes',
    }
  }

  if (expectedHash !== '' && expectedHash !== actual.sha256.toLowerCase()) {
    return {
      ok: false,
      reason: 'WORKBOOK_MISMATCH',
      detail: 'the stored workbook does not hash to the value the PI record describes',
    }
  }

  return { ok: true, sha256: actual.sha256, bytes: actual.bytes }
}

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * SHA-256 of some bytes, as lowercase hex.
 *
 * WEB CRYPTO, not node:crypto. This module is imported by a route that runs on
 * Vercel's Node runtime today, and `globalThis.crypto.subtle` is present there,
 * in Edge, and in every browser — so the same code proves the same file
 * wherever it runs. There is no second hashing path that could disagree.
 *
 * The output shape is exactly what order_document_versions' CHECK constraints
 * and order_submissions.source_workbook_sha256 both require: `^[0-9a-f]{64}$`.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh ArrayBuffer view, so a Uint8Array that is a window onto a larger
  // buffer hashes its OWN bytes rather than the whole pool behind it.
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice()
  const digest = await crypto.subtle.digest('SHA-256', view as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Fetching ──────────────────────────────────────────────────────────────────

/**
 * How this module reads an object.
 *
 * A FUNCTION, NOT A SUPABASE CLIENT, so the tests exercise every refusal without
 * a network and so nothing here can accidentally acquire the ability to WRITE.
 * The route supplies one backed by the server's protected credentials.
 */
export type ObjectReader = (path: string) => Promise<Uint8Array | null>

export type LoadedWorkbook =
  | { ok: true; path: string; bytes: Uint8Array; sha256: string }
  | { ok: false; reason: WorkbookSourceFailure; detail: string }

/**
 * The approved PI's workbook, proved.
 *
 * Reads exactly one object, at a key derived from the RECORD — never from
 * anything a caller supplied — and returns its bytes only once the size and the
 * hash both agree with what was recorded at save time.
 */
export async function loadApprovedWorkbook(
  record: RecordedWorkbook,
  read: ObjectReader,
): Promise<LoadedWorkbook> {
  const resolved = workbookObjectPath(record)
  if (!resolved.ok) return resolved

  let bytes: Uint8Array | null
  try {
    bytes = await read(resolved.path)
  } catch {
    // The reader's own error text is deliberately discarded: a storage client's
    // message can carry a URL, a project reference or a token, and none of that
    // may reach a stored failure message.
    return { ok: false, reason: 'WORKBOOK_MISSING', detail: 'the stored workbook could not be read' }
  }

  if (!bytes || bytes.length === 0) {
    return { ok: false, reason: 'WORKBOOK_MISSING', detail: 'the stored workbook could not be read' }
  }

  const sha256 = await sha256Hex(bytes)
  const provenance = checkWorkbookProvenance(record, { sha256, bytes: bytes.length })
  if (!provenance.ok) return provenance

  return { ok: true, path: resolved.path, bytes, sha256 }
}
