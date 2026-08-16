// The archive and cell layer beneath the BOE PI parser.
//
// WHY THIS EXISTS RATHER THAN SheetJS
// -----------------------------------
// The project already depends on xlsx@0.18.5 and uses it happily for
// header-driven imports (src/lib/attendance/punchParser.ts,
// src/app/api/meetings/import/route.ts). It is the wrong tool HERE, for three
// reasons that are specific to a PI:
//
//   1. A PI's payload includes PICTURES. SheetJS does not parse xl/media at all
//      — the point src/lib/xlsxMediaOptimizer.ts opens with — so the archive has
//      to be read as a ZIP regardless. Having opened it, reading the one sheet
//      we need from the same entry map is cheaper than parsing all five sheets,
//      56 KB of styles and a 56 KB calcChain a second time.
//   2. "A formula with no cached result" is a fact this parser must REPORT, and
//      it lives in the raw <c> element (an <f> with no <v>). Recovering it from
//      a normalised cell model means trusting that model's idea of emptiness.
//   3. Hidden rows and the hidden sequence column J decide which rows are real
//      products. Those attributes are on <row hidden="1"> and <col hidden="1">
//      in the sheet part, and SheetJS only surfaces them under cellStyles.
//
// So: fflate for the ZIP (same lazy-import idiom as the optimiser), and a small,
// explicit reader for the parts we actually need. The pure helpers the optimiser
// already exports — entry-name safety, archive structure, relationship
// resolution, image sniffing — are REUSED rather than rewritten.
//
// Everything here is read-only. No entry is ever rewritten, and the input bytes
// are never mutated.

import {
  isUnsafeEntryName,
  validateArchiveStructure,
  resolveRelTarget,
  MAX_ENTRY_COUNT,
  MAX_DECOMPRESSED_BYTES,
  MAX_COMPRESSION_RATIO,
  type ArchiveEntries,
} from '../xlsxMediaOptimizer'

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * Largest PI workbook this parser will accept: 10 MiB.
 *
 * Deliberately the SAME number as ORDER_REQ_ATTACHMENT_MAX_BYTES in
 * src/lib/orderRequestAttachments.ts and as the order-request-attachments
 * bucket's file_size_limit (10485760, migration 20260711000000). One product
 * rule; if it ever moves, all three move together.
 */
export const PI_MAX_WORKBOOK_BYTES = 10 * 1024 * 1024

// ── Archive ───────────────────────────────────────────────────────────────────

export type PiArchive = {
  entries: ArchiveEntries
  /** Entry names in archive order, kept separately so duplicates stay visible —
   *  a Record collapses them. */
  names: readonly string[]
}

export type PiArchiveFailure =
  | 'INPUT_TOO_LARGE'
  | 'INVALID_ZIP'
  | 'UNSAFE_ENTRY_NAME'
  | 'DUPLICATE_ENTRY'
  | 'TOO_MANY_ENTRIES'
  | 'DECOMPRESSED_TOO_LARGE'
  | 'MISSING_WORKBOOK_PARTS'

export type PiArchiveResult =
  | { ok: true; archive: PiArchive }
  | { ok: false; reason: PiArchiveFailure }

type UnzipFilter = (file: { name: string; size: number; originalSize: number }) => boolean

/** fflate is imported dynamically, matching xlsxMediaOptimizer: the ZIP machinery
 *  is only fetched when a workbook is actually opened. */
async function inflate(bytes: Uint8Array, filter: UnzipFilter): Promise<ArchiveEntries> {
  const { unzip, unzipSync } = await import('fflate')
  return new Promise<ArchiveEntries>((resolve, reject) => {
    const runSync = (fallbackErr: unknown) => {
      try { resolve(unzipSync(bytes, { filter })) } catch { reject(fallbackErr) }
    }
    try {
      unzip(bytes, { filter }, (err, data) => {
        if (err) runSync(err)
        else resolve(data)
      })
    } catch (err) {
      runSync(err)
    }
  })
}

/**
 * Open an untrusted .xlsx and hand back its inflated parts.
 *
 * Every ceiling is checked from the ZIP central directory DURING the unzip, so a
 * bomb is refused before its bytes are allocated — the same ordering the
 * optimiser uses. The input array is only ever read.
 */
export async function openPiArchive(bytes: Uint8Array): Promise<PiArchiveResult> {
  if (bytes.length > PI_MAX_WORKBOOK_BYTES) return { ok: false, reason: 'INPUT_TOO_LARGE' }
  if (bytes.length === 0) return { ok: false, reason: 'INVALID_ZIP' }

  const names: string[] = []
  let entryCount = 0
  let decompressed = 0
  let limitHit: PiArchiveFailure | null = null

  let entries: ArchiveEntries
  try {
    entries = await inflate(bytes, (file) => {
      if (limitHit) return false
      entryCount += 1
      if (entryCount > MAX_ENTRY_COUNT) { limitHit = 'TOO_MANY_ENTRIES'; return false }
      if (isUnsafeEntryName(file.name)) { limitHit = 'UNSAFE_ENTRY_NAME'; return false }
      decompressed += file.originalSize
      if (decompressed > MAX_DECOMPRESSED_BYTES) { limitHit = 'DECOMPRESSED_TOO_LARGE'; return false }
      names.push(file.name)
      return true
    })
  } catch {
    return { ok: false, reason: 'INVALID_ZIP' }
  }

  if (limitHit) return { ok: false, reason: limitHit }
  if (names.length === 0) return { ok: false, reason: 'INVALID_ZIP' }
  if (decompressed / bytes.length > MAX_COMPRESSION_RATIO) {
    return { ok: false, reason: 'DECOMPRESSED_TOO_LARGE' }
  }

  const structure = validateArchiveStructure(names, entries)
  if (!structure.ok) {
    return {
      ok: false,
      reason:
        structure.reason === 'missing_workbook_parts' ? 'MISSING_WORKBOOK_PARTS'
        : structure.reason === 'duplicate_entry'      ? 'DUPLICATE_ENTRY'
        :                                               'UNSAFE_ENTRY_NAME',
    }
  }

  return { ok: true, archive: { entries, names } }
}

// ── XML text ──────────────────────────────────────────────────────────────────

const decoder = new TextDecoder()

/** Decoded UTF-8 of one part, or '' when the part is absent. */
export function partText(entries: ArchiveEntries, name: string): string {
  const bytes = entries[name]
  return bytes ? decoder.decode(bytes) : ''
}

/**
 * XML entity decoding. `&amp;` is decoded LAST, so "&amp;lt;" comes back as the
 * literal text "&lt;" rather than being decoded twice into "<".
 *
 * `_x000D_` is Excel's own escape for a carriage return inside a shared string;
 * it always precedes a real newline, so dropping it leaves the line break intact
 * instead of producing a stray control character.
 */
export function decodeXml(raw: string): string {
  return raw
    .replace(/_x000D_/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try { return String.fromCodePoint(code) } catch { return '' }
}

/**
 * Whitespace normalisation for a cell's display text.
 *
 * Internal line breaks are MEANINGFUL in a PI — a dimensions cell routinely
 * reads "Standard Dimensions\nThree Seater - 72\"" — so they survive. What is
 * removed is only noise: horizontal whitespace runs inside a line, trailing and
 * leading spaces on each line, and blank lines at either end of the value.
 * Returns null for a cell that holds nothing but whitespace.
 */
export function normalizeCellText(raw: string): string | null {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\f\v ]+/g, ' ').trim())

  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const text = lines.join('\n')
  return text === '' ? null : text
}

/** Aggressive normalisation used ONLY for template-label comparison: every run
 *  of whitespace (newlines included) becomes one space, and case is ignored. */
export function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase()
}

// ── Shared strings ────────────────────────────────────────────────────────────

/**
 * The shared string table, one entry per <si> in declaration order.
 *
 * A rich-text <si> is a sequence of <r><t> runs and must be CONCATENATED — an
 * "Order no:-" that Excel split across two formatting runs is still one string.
 * Phonetic guide runs (<rPh>) also contain <t> and are NOT part of the value, so
 * they are stripped before the runs are collected.
 */
export function readSharedStrings(entries: ArchiveEntries): string[] {
  const xml = partText(entries, 'xl/sharedStrings.xml')
  if (!xml) return []

  const out: string[] = []
  const siRe = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = siRe.exec(xml)) !== null) {
    const body = m[1]
    if (body === undefined) { out.push(''); continue }
    out.push(collectTextRuns(body))
  }
  return out
}

function collectTextRuns(body: string): string {
  const withoutPhonetic = body.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')
  let text = ''
  const tRe = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g
  let m: RegExpExecArray | null
  while ((m = tRe.exec(withoutPhonetic)) !== null) {
    if (m[1] !== undefined) text += decodeXml(m[1])
  }
  return text
}

// ── Addresses ─────────────────────────────────────────────────────────────────

/** "A" → 0, "K" → 10, "AA" → 26. Returns -1 for anything that is not letters. */
export function columnToIndex(letters: string): number {
  if (!/^[A-Za-z]+$/.test(letters)) return -1
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 0 → "A", 10 → "K". */
export function indexToColumn(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** (0-based col, 1-based row) → "E32". */
export function cellRef(col: number, row: number): string {
  return `${indexToColumn(col)}${row}`
}

// ── Cells ─────────────────────────────────────────────────────────────────────

export type PiCellType = 'number' | 'string' | 'boolean' | 'error' | 'empty'

export type PiCell = {
  address: string
  /** 1-based. */
  row: number
  /** 0-based, so it lines up with drawing anchor columns. */
  col: number
  type: PiCellType
  /** Display text for string/boolean/error cells; null otherwise. */
  text: string | null
  /** Parsed number for numeric cells; null otherwise. */
  number: number | null
  hasFormula: boolean
  /** False when the cell carries an <f> but the workbook stored no <v>. */
  hasCachedValue: boolean
}

export type PiSheet = {
  cells: ReadonlyMap<string, PiCell>
  /** 1-based row numbers carrying hidden="1". */
  hiddenRows: ReadonlySet<number>
  /** 0-based column indexes carrying hidden="1". */
  hiddenCols: ReadonlySet<number>
  /** Highest 1-based row that carried any <row> element. */
  maxRow: number
}

/**
 * Read one worksheet part into an address→cell map.
 *
 * Only <sheetData> is interpreted. Styles, conditional formatting, merges,
 * data validation, print settings and every other part are left alone — this
 * parser reads values, it does not model a spreadsheet.
 */
export function readSheet(xml: string, sharedStrings: readonly string[]): PiSheet {
  const cells = new Map<string, PiCell>()
  const hiddenRows = new Set<number>()
  const hiddenCols = new Set<number>()
  let maxRow = 0

  for (const col of parseColElements(xml)) {
    if (!col.hidden) continue
    for (let i = col.min; i <= col.max; i++) hiddenCols.add(i)
  }

  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? ''
  const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(sheetData)) !== null) {
    const attrs = rowMatch[1] ?? rowMatch[2] ?? ''
    const body = rowMatch[3] ?? ''
    const rowNum = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? NaN)
    if (!Number.isInteger(rowNum) || rowNum < 1) continue
    if (rowNum > maxRow) maxRow = rowNum
    if (/\bhidden="(?:1|true)"/.test(attrs)) hiddenRows.add(rowNum)
    if (!body) continue

    for (const cell of parseCellElements(body, rowNum, sharedStrings)) {
      cells.set(cell.address, cell)
    }
  }

  return { cells, hiddenRows, hiddenCols, maxRow }
}

type ColSpan = { min: number; max: number; hidden: boolean }

function parseColElements(xml: string): ColSpan[] {
  const block = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1] ?? ''
  const out: ColSpan[] = []
  const colRe = /<col\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = colRe.exec(block)) !== null) {
    const attrs = m[1]
    const min = Number(/\bmin="(\d+)"/.exec(attrs)?.[1] ?? NaN)
    const max = Number(/\bmax="(\d+)"/.exec(attrs)?.[1] ?? NaN)
    if (!Number.isInteger(min) || !Number.isInteger(max)) continue
    // 1-based in the XML, 0-based here; clamp the "to the end of the sheet"
    // span that Excel always writes so it cannot produce a huge loop.
    out.push({
      min: min - 1,
      max: Math.min(max, 1024) - 1,
      hidden: /\bhidden="(?:1|true)"/.test(attrs),
    })
  }
  return out
}

function parseCellElements(
  rowBody: string,
  rowNum: number,
  sharedStrings: readonly string[],
): PiCell[] {
  const out: PiCell[] = []
  const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g
  let m: RegExpExecArray | null
  while ((m = cellRe.exec(rowBody)) !== null) {
    const attrs = m[1] ?? m[2] ?? ''
    const body = m[3] ?? ''
    const address = /\br="([A-Za-z]+\d+)"/.exec(attrs)?.[1]
    if (!address) continue
    const col = columnToIndex(/^[A-Za-z]+/.exec(address)?.[0] ?? '')
    if (col < 0) continue

    const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
    const hasFormula = /<f\b[^>]*(?:\/>|>)/.test(body)
    const vRaw = /<v\b[^>]*\/>|<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)
    // A <v/> or <v></v> is NOT a stored result. Treating an empty element as a
    // cached value would report `0` for a formula the workbook never evaluated,
    // which is precisely the silent substitution this parser refuses to make.
    const captured = vRaw?.[1]
    const value = captured !== undefined && captured.trim() !== '' ? captured : undefined
    const hasCachedValue = value !== undefined || inline !== null

    let type: PiCellType = 'empty'
    let text: string | null = null
    let num: number | null = null

    if (t === 'inlineStr' && inline) {
      const collected = collectTextRuns(inline[1])
      text = normalizeCellText(collected)
      type = text === null ? 'empty' : 'string'
    } else if (value !== undefined) {
      if (t === 's') {
        const idx = Number(value)
        const raw = Number.isInteger(idx) ? sharedStrings[idx] : undefined
        text = raw === undefined ? null : normalizeCellText(raw)
        type = text === null ? 'empty' : 'string'
      } else if (t === 'str') {
        text = normalizeCellText(decodeXml(value))
        type = text === null ? 'empty' : 'string'
      } else if (t === 'e') {
        text = decodeXml(value).trim() || null
        type = 'error'
      } else if (t === 'b') {
        text = value.trim() === '1' ? 'TRUE' : 'FALSE'
        type = 'boolean'
      } else {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) { num = parsed; type = 'number' }
      }
    }

    out.push({ address, row: rowNum, col, type, text, number: num, hasFormula, hasCachedValue })
  }
  return out
}

// ── Workbook / sheet resolution ───────────────────────────────────────────────

export type SheetResolution =
  | { ok: true; part: string; sheetNames: readonly string[] }
  | { ok: false; reason: 'MASTER_SHEET_MISSING' | 'MASTER_SHEET_UNREADABLE'; sheetNames: readonly string[] }

/**
 * Resolve a sheet BY NAME through xl/workbook.xml → r:id →
 * xl/_rels/workbook.xml.rels → part.
 *
 * The sheet order in workbook.xml has nothing to do with the numbering of
 * worksheets/sheetN.xml, and the relationship file is not sorted either — both
 * observed BOE workbooks list rId3 before rId1. Assuming "Master is sheet1" is
 * therefore a bug waiting for the first workbook that was edited in a different
 * order, so the relationship is always followed.
 */
export function resolveSheetPart(entries: ArchiveEntries, sheetName: string): SheetResolution {
  const wbXml = partText(entries, 'xl/workbook.xml')
  const sheetNames: string[] = []
  let wantedRid: string | null = null

  const sheetRe = /<(?:\w+:)?sheet\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = sheetRe.exec(wbXml)) !== null) {
    const attrs = m[1]
    const nameRaw = /\bname="([^"]*)"/.exec(attrs)?.[1]
    if (nameRaw === undefined) continue
    const name = decodeXml(nameRaw)
    sheetNames.push(name)
    // Exact match, deliberately: "master" or "Master " is a different sheet and
    // silently accepting it would be exactly the "silently map the wrong thing"
    // failure the template check exists to prevent.
    if (name === sheetName && wantedRid === null) {
      wantedRid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? null
    }
  }

  if (!sheetNames.includes(sheetName)) {
    return { ok: false, reason: 'MASTER_SHEET_MISSING', sheetNames }
  }
  if (!wantedRid) return { ok: false, reason: 'MASTER_SHEET_UNREADABLE', sheetNames }

  const relsXml = partText(entries, 'xl/_rels/workbook.xml.rels')
  const target = relationshipTarget(relsXml, wantedRid)
  if (!target) return { ok: false, reason: 'MASTER_SHEET_UNREADABLE', sheetNames }

  const part = resolveRelTarget('xl/_rels/workbook.xml.rels', target)
  if (!part || isUnsafeEntryName(part) || !(part in entries)) {
    return { ok: false, reason: 'MASTER_SHEET_UNREADABLE', sheetNames }
  }
  return { ok: true, part, sheetNames }
}

/** The Target of one relationship by Id, or null. Attribute order is not fixed
 *  by the spec, so Id and Target are read independently of each other. */
export function relationshipTarget(relsXml: string, id: string): string | null {
  const relRe = /<Relationship\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    if (/\bTargetMode="External"/i.test(m[0])) continue
    if (/\bId="([^"]+)"/.exec(m[0])?.[1] !== id) continue
    return /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? null
  }
  return null
}

/** All relationships in a .rels part as Id → raw Target. External targets are
 *  skipped: a picture that points outside the package has no bytes to extract. */
export function relationshipMap(relsXml: string): Map<string, string> {
  const out = new Map<string, string>()
  const relRe = /<Relationship\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    if (/\bTargetMode="External"/i.test(m[0])) continue
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1]
    if (id && target) out.set(id, target)
  }
  return out
}

/** The _rels path that belongs to a part: "xl/worksheets/sheet1.xml" →
 *  "xl/worksheets/_rels/sheet1.xml.rels". */
export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/')
  const dir = slash === -1 ? '' : part.slice(0, slash)
  const leaf = part.slice(slash + 1)
  return `${dir}/_rels/${leaf}.rels`
}

// ── Dates ─────────────────────────────────────────────────────────────────────

/** Excel's day 0 in the 1900 system, allowing for its deliberate 1900-leap-year
 *  bug: serial 1 is 1900-01-01, and serial 60 is the day that never existed. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000

/**
 * Excel date serial → "YYYY-MM-DD", or null when the number cannot be a date.
 *
 * Serials below 61 are refused rather than guessed at: that range is where the
 * 1900 leap-year bug lives, no BOE PI carries a January-1900 date, and a "1" or
 * "2" in a date cell is far more likely to be a quantity typed in the wrong
 * place than a real date. Fractional serials (a date with a time) keep their
 * DATE part; the time is dropped because none of these fields is a timestamp.
 */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial)) return null
  if (serial < 61 || serial > 2_958_465) return null
  const ms = EXCEL_EPOCH_UTC + Math.floor(serial) * MS_PER_DAY
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * A number as a person would read it, for cells that are semantically TEXT but
 * happen to be stored numerically — a phone number, a GST-adjacent reference, an
 * order number already printed on the sheet.
 *
 * `String(n)` is used rather than toLocaleString so no separators are invented,
 * and exponent notation is expanded so a ten-digit phone number can never come
 * back as "9.87654321e+9".
 */
export function numberToPlainText(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n)
  const s = String(n)
  if (!/e/i.test(s)) return s
  // Small/large magnitudes only: 20 decimal places is the most toFixed allows.
  const fixed = n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
  return fixed
}
