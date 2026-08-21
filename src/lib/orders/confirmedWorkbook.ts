// THE CONFIRMED WORKBOOK — the approved PI, with its Order number in it.
//
// WHAT THIS IS, AND WHAT IT IS NOT
// --------------------------------
// When a PI becomes an Order, the business needs the SAME workbook the client
// agreed to, carrying the Order number the approval allocated. Not a rendering
// of it, not a reconstruction from the database — the file itself, with one cell
// filled in.
//
// So this is not a spreadsheet writer. It is ZIP SURGERY: open the stored
// workbook, rewrite the six-hundred bytes of one worksheet part that describe
// cell B20, put every other entry back with its bytes untouched, and prove
// afterwards that nothing else moved.
//
// WHY NOT SheetJS, WHICH THIS PROJECT ALREADY DEPENDS ON
// ------------------------------------------------------
// Because a round trip through any spreadsheet library rebuilds the file from
// its own model of a workbook, and a BOE PI is mostly things that model does not
// carry: anchored product photographs, merged header blocks, print setup, column
// widths, hidden rows, conditional formats and the drawing relationships that
// tie the pictures to their rows. Reading and rewriting would silently return a
// file that opens, looks approximately right, and has lost the images.
//
// The one thing that must change is one cell. Everything else must be the bytes
// that were there before — so everything else IS the bytes that were there
// before, and section 4 refuses to publish a workbook where that stopped being
// true.
//
// WHAT "UNCHANGED" MEANS PRECISELY
// --------------------------------
// ZIP stores entries COMPRESSED, and recompressing necessarily produces
// different compressed bytes. What is compared — and what matters — is the
// DECOMPRESSED content of every entry. A part whose inflated bytes are identical
// is the same part, however it happens to be stored. That is the same definition
// src/lib/xlsxMediaOptimizer.ts works to, and it is checked here the same way.
//
// THE ORIGINAL IS NEVER TOUCHED. This function takes bytes and returns bytes.
// The stored object is read and nothing else; order-files has no UPDATE policy,
// so even a caller that wanted to overwrite it could not.

import {
  MASTER_SHEET_NAME,
} from '@/lib/pi/masterSheetParser'
import {
  openPiArchive,
  partText,
  resolveSheetPart,
} from '@/lib/pi/workbookReader'
import {
  bytesEqual,
  collectInternalRelTargets,
  countFormulas,
  isUnsafeEntryName,
  readSheetNames,
  validateArchiveStructure,
  type ArchiveEntries,
} from '@/lib/xlsxMediaOptimizer'

// ── The cell ──────────────────────────────────────────────────────────────────

/**
 * WHERE THE CONFIRMED ORDER NUMBER GOES.
 *
 * B20 is the template's `sourceOrderNumber` cell — see HEADER_CELLS in
 * masterSheetParser.ts. It is where the workbook already says what order this
 * is, which is why filling it in produces a document a person recognises rather
 * than one with a number bolted onto it.
 *
 * The parser reports whatever B20 already held as SOURCE DATA and never treats
 * it as an allocation. This overwrites it, because after approval the confirmed
 * number is the answer and whatever the employee's starting file happened to
 * carry is not.
 */
export const CONFIRMED_NUMBER_CELL = 'B20'

/** The sheet that cell lives on. Resolved BY NAME through workbook.xml, never by
 *  assuming Master is sheet1 — the two observed BOE workbooks list their
 *  relationships in different orders. */
export const CONFIRMED_SHEET_NAME = MASTER_SHEET_NAME

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * The largest confirmed workbook that may be stored.
 *
 * The order-files bucket's own file_size_limit, 10 MiB (20260908000000 §9). A
 * copy is within a few hundred bytes of its original, so this can only be hit by
 * an original that was already at the edge — and refusing at that edge is better
 * than a storage rejection that arrives after the PDF has also been rendered.
 */
export const CONFIRMED_WORKBOOK_MAX_BYTES = 10 * 1024 * 1024

/** The one mimetype order-files admits for a workbook. */
export const CONFIRMED_WORKBOOK_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ── Failures ──────────────────────────────────────────────────────────────────

/**
 * Every way this can refuse, as a stable code.
 *
 * Each maps to a prewritten sentence in orderDocuments.ts. NOTHING FROM AN
 * EXCEPTION IS EVER CARRIED THROUGH: a code is chosen here, and the sentence a
 * person reads was written in advance.
 */
export type ConfirmedWorkbookFailure =
  | 'WORKBOOK_MISSING'      // no bytes at all
  | 'WORKBOOK_TOO_LARGE'    // the source, or the copy, exceeds the bucket limit
  | 'WORKBOOK_UNREADABLE'   // not a readable .xlsx package
  | 'WORKBOOK_UNSUPPORTED'  // readable, but not a shape this may safely rewrite

export type ConfirmedWorkbookResult =
  | {
      ok: true
      bytes: Uint8Array
      /**
       * The worksheet part that was rewritten — the ONLY entry that differs.
       *
       * Null when the cell already read exactly the confirmed number, in which
       * case NO part differs and the output is a faithful recompression of the
       * original. See buildConfirmedWorkbook.
       */
      changedPart: string | null
      /** Every other entry name, proved decompressed-identical. */
      unchangedCount: number
    }
  | { ok: false; reason: ConfirmedWorkbookFailure; detail: string }

const fail = (reason: ConfirmedWorkbookFailure, detail: string): ConfirmedWorkbookResult =>
  ({ ok: false, reason, detail })

// ── 1. XML: writing one cell ──────────────────────────────────────────────────

/** The five characters that must not appear raw in XML text. */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** `B20` → { column: 'B', row: 20 }. Null for anything that is not a plain
 *  A1 reference — this never accepts a range, an absolute `$B$20`, or a
 *  cross-sheet reference. */
export function parseCellRef(ref: string): { column: string; row: number } | null {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref)
  if (!m) return null
  return { column: m[1], row: Number(m[2]) }
}

/** Column letters to a 1-based index, for ordering cells within a row. */
export function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export type CellWriteResult =
  | { ok: true; xml: string; replaced: boolean }
  | { ok: false; reason: ConfirmedWorkbookFailure; detail: string }

/**
 * Put a text value into one cell of a worksheet part.
 *
 * AN INLINE STRING, NOT A SHARED ONE, and that is the whole reason this is safe.
 * A shared string would mean editing xl/sharedStrings.xml — changing its `count`
 * and `uniqueCount`, and appending an entry whose index every other cell's <v>
 * is measured against. Getting that subtly wrong shifts unrelated text all over
 * the workbook. `t="inlineStr"` carries its own text and touches no other part.
 *
 * THE STYLE IS KEPT. `s="12"` is the cell's format — the font, the border, the
 * number format the template designer chose for this box. Dropping it would put
 * the number in the right place looking wrong.
 *
 * A FORMULA CELL IS REFUSED. If B20 carries an <f>, overwriting it would delete
 * a calculation the workbook depends on and leave xl/calcChain.xml naming a cell
 * that no longer computes. That is a workbook shape this must not rewrite, and
 * saying so is better than producing a file that opens with a repair prompt.
 */
export function setCellInlineString(xml: string, ref: string, value: string): CellWriteResult {
  const target = parseCellRef(ref)
  if (!target) return { ok: false, reason: 'WORKBOOK_UNSUPPORTED', detail: `bad cell reference ${ref}` }

  const text = escapeXmlText(value)
  const cellXml = `<c r="${ref}"{{STYLE}} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`

  // ── Locate <sheetData> ──
  const openRe = /<sheetData\b([^>]*?)(\/?)>/
  const open = openRe.exec(xml)
  if (!open) return { ok: false, reason: 'WORKBOOK_UNSUPPORTED', detail: 'no sheetData element' }

  // A self-closing <sheetData/> is a legitimately empty sheet. It becomes an open
  // pair carrying exactly one row.
  if (open[2] === '/') {
    const row = `<row r="${target.row}">${cellXml.replace('{{STYLE}}', '')}</row>`
    return {
      ok: true,
      replaced: false,
      xml: xml.slice(0, open.index)
        + `<sheetData${open[1]}>${row}</sheetData>`
        + xml.slice(open.index + open[0].length),
    }
  }

  const bodyStart = open.index + open[0].length
  const closeAt = xml.indexOf('</sheetData>', bodyStart)
  if (closeAt < 0) return { ok: false, reason: 'WORKBOOK_UNSUPPORTED', detail: 'unterminated sheetData' }

  const before = xml.slice(0, bodyStart)
  const body = xml.slice(bodyStart, closeAt)
  const after = xml.slice(closeAt)

  // ── Find the row ──
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  let m: RegExpExecArray | null
  let rowStart = -1
  let rowEnd = -1
  let rowAttrs = ''
  let rowBody: string | null = null
  /** Where a NEW row would be inserted to keep rows in ascending order. */
  let insertAt = body.length

  let seen = -1
  while ((m = rowRe.exec(body)) !== null) {
    const n = Number(/\br="(\d+)"/.exec(m[1])?.[1] ?? NaN)
    if (!Number.isInteger(n)) continue
    // Rows out of order would make "insert in the right place" meaningless, and
    // a workbook that writes them that way is not one to rewrite blind.
    if (n <= seen) return { ok: false, reason: 'WORKBOOK_UNSUPPORTED', detail: 'rows are not in ascending order' }
    seen = n

    if (n === target.row) {
      rowStart = m.index
      rowEnd = m.index + m[0].length
      rowAttrs = m[1]
      rowBody = m[2] ?? ''
      break
    }
    if (n < target.row) insertAt = m.index + m[0].length
  }

  // ── The row is absent: insert it, in order ──
  if (rowBody === null) {
    const row = `<row r="${target.row}">${cellXml.replace('{{STYLE}}', '')}</row>`
    return {
      ok: true,
      replaced: false,
      xml: before + body.slice(0, insertAt) + row + body.slice(insertAt) + after,
    }
  }

  // ── The row is there: find the cell ──
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let cm: RegExpExecArray | null
  let cellStart = -1
  let cellEnd = -1
  let style = ''
  let cellInsertAt = rowBody.length
  let hasCell = false

  while ((cm = cellRe.exec(rowBody)) !== null) {
    const r = /\br="([A-Z]{1,3}\d+)"/.exec(cm[1])?.[1]
    if (!r) continue
    if (r === ref) {
      if (/<f\b/.test(cm[2] ?? '')) {
        return {
          ok: false,
          reason: 'WORKBOOK_UNSUPPORTED',
          detail: `${ref} carries a formula; overwriting it would break the workbook's calculation chain`,
        }
      }
      hasCell = true
      cellStart = cm.index
      cellEnd = cm.index + cm[0].length
      const s = /\bs="(\d+)"/.exec(cm[1])?.[1]
      style = s === undefined ? '' : ` s="${s}"`
      break
    }
    const parsed = parseCellRef(r)
    if (parsed && columnIndex(parsed.column) < columnIndex(target.column)) {
      cellInsertAt = cm.index + cm[0].length
    }
  }

  const written = cellXml.replace('{{STYLE}}', style)
  const newRowBody = hasCell
    ? rowBody.slice(0, cellStart) + written + rowBody.slice(cellEnd)
    : rowBody.slice(0, cellInsertAt) + written + rowBody.slice(cellInsertAt)

  // The row's own attributes are carried through untouched — its height, its
  // custom-format flag, and its `hidden` state.
  const newRow = `<row${rowAttrs}>${newRowBody}</row>`

  return {
    ok: true,
    replaced: hasCell,
    xml: before + body.slice(0, rowStart) + newRow + body.slice(rowEnd) + after,
  }
}

/** What one cell currently reads, as text. Used to PROVE the write landed —
 *  never to parse a workbook, which is masterSheetParser's job. */
export function readInlineCell(xml: string, ref: string): string | null {
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1]
  if (!sheetData) return null
  const rowNum = parseCellRef(ref)?.row
  if (rowNum === undefined) return null

  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(sheetData)) !== null) {
    if (Number(/\br="(\d+)"/.exec(m[1])?.[1] ?? NaN) !== rowNum) continue
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(m[2] ?? '')) !== null) {
      if (/\br="([A-Z]{1,3}\d+)"/.exec(cm[1])?.[1] !== ref) continue
      const t = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(cm[2] ?? '')?.[1]
      if (t === undefined) return null
      return t.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    }
    return null
  }
  return null
}

// ── 2. ZIP ────────────────────────────────────────────────────────────────────

/**
 * fflate, imported dynamically — the same idiom the optimiser and the workbook
 * reader use, so the ZIP machinery is only fetched when a workbook is actually
 * being rewritten.
 *
 * The async entry point does its work off the main thread; if a Worker cannot be
 * created it falls back to the synchronous path rather than failing outright.
 */
async function deflate(files: Record<string, [Uint8Array, { level: 0 | 6 }]>): Promise<Uint8Array> {
  const { zip, zipSync } = await import('fflate')
  return new Promise<Uint8Array>((resolve, reject) => {
    const runSync = (fallback: unknown) => {
      try { resolve(zipSync(files)) } catch { reject(fallback) }
    }
    try {
      zip(files, {}, (err, data) => (err ? runSync(err) : resolve(data)))
    } catch (err) {
      runSync(err)
    }
  })
}

/** Media is already-compressed data: deflating it again burns CPU and can make
 *  it larger, so those entries are STORED. XML compresses well and keeps 6. */
const MEDIA_PREFIX = 'xl/media/'

// ── 3. The rewrite ────────────────────────────────────────────────────────────

export type ConfirmedWorkbookInput = {
  /** The stored original, read from private storage. Only ever read from. */
  bytes: Uint8Array
  /** The confirmed Order number, exactly as it will appear. */
  orderNumber: string
}

/**
 * The approved PI workbook, with the confirmed Order number in B20.
 *
 * Every entry but one comes back with the bytes it went in with, and section 4
 * proves it before this returns.
 */
export async function buildConfirmedWorkbook(
  input: ConfirmedWorkbookInput,
): Promise<ConfirmedWorkbookResult> {
  const number = input.orderNumber?.trim() ?? ''
  if (number === '') return fail('WORKBOOK_UNSUPPORTED', 'no Order number to write')

  if (!input.bytes || input.bytes.length === 0) {
    return fail('WORKBOOK_MISSING', 'the stored workbook has no bytes')
  }
  if (input.bytes.length > CONFIRMED_WORKBOOK_MAX_BYTES) {
    return fail('WORKBOOK_TOO_LARGE', 'the stored workbook exceeds the bucket limit')
  }

  const opened = await openPiArchive(input.bytes)
  if (!opened.ok) {
    // openPiArchive's refusals are already a closed set. INPUT_TOO_LARGE and
    // DECOMPRESSED_TOO_LARGE are size answers; everything else means the package
    // is not one this may rewrite.
    return opened.reason === 'INPUT_TOO_LARGE' || opened.reason === 'DECOMPRESSED_TOO_LARGE'
      ? fail('WORKBOOK_TOO_LARGE', opened.reason)
      : fail('WORKBOOK_UNREADABLE', opened.reason)
  }

  const { entries, names } = opened.archive

  const sheet = resolveSheetPart(entries, CONFIRMED_SHEET_NAME)
  if (!sheet.ok) {
    return fail('WORKBOOK_UNSUPPORTED',
      `the "${CONFIRMED_SHEET_NAME}" sheet could not be resolved (${sheet.reason})`)
  }

  const originalXml = partText(entries, sheet.part)
  if (originalXml === '') {
    return fail('WORKBOOK_UNREADABLE', 'the worksheet part is empty')
  }

  const written = setCellInlineString(originalXml, CONFIRMED_NUMBER_CELL, number)
  if (!written.ok) return fail(written.reason, written.detail)

  /**
   * THE CELL MAY ALREADY READ CORRECTLY, and that is not an error.
   *
   * B20 is the template's `sourceOrderNumber`: the parser reports whatever the
   * employee's starting file happened to carry, and after the number cycle
   * resets to 0001 a workbook whose B20 already says `0001` is entirely
   * plausible. Re-running over a copy this module produced does it too.
   *
   * So a rewrite that changed nothing is a legitimate outcome HERE — but only
   * here, and only because the cell is then already right. §4 is told which case
   * this is, and in this one it requires EVERY part to be identical rather than
   * relaxing the "the rewrite did nothing" check, which is what catches a
   * genuine silent no-op.
   */
  const alreadyCorrect = written.xml === originalXml

  // PROVE THE WRITE LANDED before anything is compressed. A rewrite that
  // silently did nothing would produce a valid workbook with no Order number in
  // it, which is the one failure a reader could not see.
  if (readInlineCell(written.xml, CONFIRMED_NUMBER_CELL) !== number) {
    return fail('WORKBOOK_UNSUPPORTED', `${CONFIRMED_NUMBER_CELL} does not read back as the number written`)
  }

  const rebuiltEntries: ArchiveEntries = {}
  for (const name of names) rebuiltEntries[name] = entries[name]
  rebuiltEntries[sheet.part] = new TextEncoder().encode(written.xml)

  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const name of names) {
    files[name] = [rebuiltEntries[name], { level: name.startsWith(MEDIA_PREFIX) ? 0 : 6 }]
  }

  let bytes: Uint8Array
  try {
    bytes = await deflate(files)
  } catch {
    return fail('WORKBOOK_UNREADABLE', 'the rewritten package could not be compressed')
  }

  if (bytes.length > CONFIRMED_WORKBOOK_MAX_BYTES) {
    return fail('WORKBOOK_TOO_LARGE', 'the confirmed workbook exceeds the bucket limit')
  }

  // ── 4. Prove it ──
  //
  // Re-open what was actually produced, rather than trusting the map that went
  // into the compressor. A validator that checked its own input would not catch
  // a compressor that dropped an entry.
  const reopened = await openPiArchive(bytes)
  if (!reopened.ok) {
    return fail('WORKBOOK_UNREADABLE', `the confirmed workbook did not re-open (${reopened.reason})`)
  }

  const problem = validateConfirmedRebuild(
    entries, [...names],
    reopened.archive.entries, [...reopened.archive.names],
    alreadyCorrect ? null : sheet.part,
  )
  if (problem) return fail('WORKBOOK_UNSUPPORTED', `the confirmed workbook failed validation: ${problem}`)

  if (readInlineCell(partText(reopened.archive.entries, sheet.part), CONFIRMED_NUMBER_CELL) !== number) {
    return fail('WORKBOOK_UNSUPPORTED', 'the Order number did not survive the round trip')
  }

  return {
    ok: true,
    bytes,
    changedPart: alreadyCorrect ? null : sheet.part,
    unchangedCount: alreadyCorrect ? names.length : names.length - 1,
  }
}

// ── 4. The safety gate ────────────────────────────────────────────────────────

export type ConfirmedRebuildProblem =
  | 'entry_count_changed'
  | 'entry_names_changed'
  | 'duplicate_entry'
  | 'unsafe_entry_name'
  | 'missing_workbook_parts'
  | 'unexpected_part_modified'
  | 'expected_part_unchanged'
  | 'media_modified'
  | 'sheet_names_changed'
  | 'formula_count_changed'
  | 'broken_relationship'

/**
 * Proves the rebuilt archive differs from the original in EXACTLY the one
 * worksheet part that was rewritten, and in nothing else.
 *
 * Deliberately its own function rather than xlsxMediaOptimizer's
 * validateRebuiltArchive: that one treats every worksheet as a part that must
 * not change, which is right for an image optimiser and exactly wrong here. What
 * is shared is the DEFINITION of a change — decompressed bytes — and every
 * structural helper it uses.
 *
 * WHAT EACH CHECK IS ACTUALLY PROTECTING:
 *
 *   entry names/count   nothing was added, dropped or renamed. A dropped
 *                       xl/media/image7.png is a product photograph gone.
 *   media_modified      not one image byte moved. They are copied, never
 *                       re-encoded, so any difference is a defect.
 *   sheet_names         the workbook still has the same sheets, in order.
 *   formula_count       EVERY FORMULA SURVIVED. This is what makes "preserve
 *                       formulas" checkable rather than asserted: the count is
 *                       taken across the whole package, before and after.
 *   relationships       every internal r:id still resolves to a part that
 *                       exists — which is what ties drawings to images and
 *                       sheets to drawings.
 *   expected_part_...   the sheet ACTUALLY changed. A no-op rewrite that
 *                       produced a valid workbook with no Order number in it is
 *                       the one failure nobody would see.
 *
 * Merged cells, styles, column widths, hidden rows, print settings and
 * conditional formats are not enumerated because they do not need to be: they
 * live in parts that are required to be byte-identical, and within the one
 * changed sheet they live outside <sheetData>, which this never touches.
 */
export function validateConfirmedRebuild(
  original: ArchiveEntries,
  originalNames: string[],
  rebuilt: ArchiveEntries,
  rebuiltNames: string[],
  /**
   * The one part allowed to differ — or NULL, meaning none may.
   *
   * Null is the "the cell already read correctly" case, and it is the STRICTER
   * demand, not a relaxation: every entry must be identical. It exists so that
   * `expected_part_unchanged` can keep meaning "the rewrite silently did
   * nothing" in the case where the rewrite was supposed to do something.
   */
  changedPart: string | null,
): ConfirmedRebuildProblem | null {
  for (const name of rebuiltNames) {
    if (isUnsafeEntryName(name)) return 'unsafe_entry_name'
  }
  if (new Set(rebuiltNames).size !== rebuiltNames.length) return 'duplicate_entry'
  if (rebuiltNames.length !== originalNames.length) return 'entry_count_changed'
  for (let i = 0; i < originalNames.length; i++) {
    if (originalNames[i] !== rebuiltNames[i]) return 'entry_names_changed'
  }

  const structure = validateArchiveStructure(rebuiltNames, rebuilt)
  if (!structure.ok) {
    return structure.reason === 'missing_workbook_parts' ? 'missing_workbook_parts' : 'unsafe_entry_name'
  }

  let sawChange = false
  for (const name of originalNames) {
    const before = original[name]
    const after = rebuilt[name]
    if (!after) return 'entry_names_changed'

    const same = bytesEqual(before, after)
    if (name === changedPart) {
      if (same) return 'expected_part_unchanged'
      sawChange = true
      continue
    }
    if (!same) {
      return name.startsWith(MEDIA_PREFIX) ? 'media_modified' : 'unexpected_part_modified'
    }
  }
  if (changedPart !== null && !sawChange) return 'expected_part_unchanged'

  const beforeSheets = readSheetNames(original)
  const afterSheets = readSheetNames(rebuilt)
  if (beforeSheets.length !== afterSheets.length) return 'sheet_names_changed'
  for (let i = 0; i < beforeSheets.length; i++) {
    if (beforeSheets[i] !== afterSheets[i]) return 'sheet_names_changed'
  }

  if (countFormulas(original) !== countFormulas(rebuilt)) return 'formula_count_changed'

  for (const { resolved } of collectInternalRelTargets(rebuilt)) {
    if (!(resolved in rebuilt)) return 'broken_relationship'
  }
  return null
}
