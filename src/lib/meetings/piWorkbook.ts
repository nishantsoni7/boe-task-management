// Reading the parts of an .xlsx package that a BOE PI needs.
//
// WHY THIS EXISTS AND WHY IT IS NOT `xlsx`
// ---------------------------------------
// The project already depends on `xlsx`, and the meeting-review import uses it.
// It cannot be used here, for two reasons that are properties of the format
// rather than of the library:
//
//   1. PRODUCT PHOTOGRAPHS ARE NOT CELL VALUES. They are DrawingML objects in
//      xl/drawings/*.xml, anchored to a row and column, with the bytes in
//      xl/media/*. A cell-value parser cannot see them at all.
//   2. THE ROW `hidden` FLAG IS THE SECTION BOUNDARY. A BOE PI keeps its unused
//      template rows in the sheet and HIDES them, and that flag is the only
//      thing that reliably separates a real order line from template residue
//      (see piImport.ts for the evidence). `sheet_to_json` discards it.
//
// So this reads the package directly with `fflate`, which is already a
// dependency. It is deliberately a READER, with no BOE rules in it: everything
// about what a PI means lives in piImport.ts, so the format knowledge and the
// business knowledge can be tested apart.
//
// XML IS READ WITH REGULAR EXPRESSIONS. That is a real constraint and worth
// stating plainly rather than discovering later: it is safe here only because
// the input is one fixed, machine-generated format from one spreadsheet
// application, the values are extracted from attributes and simple text nodes,
// and nothing is evaluated. It would not be safe for arbitrary user XML. Adding
// an XML parser dependency for one fixed template was the worse trade.
//
// NOTHING HERE EXECUTES A FORMULA. A formula cell is reported with its CACHED
// value — the result the spreadsheet application last wrote — and a flag saying
// the cache was present. Evaluating spreadsheet formulas server-side is not
// something this module will ever do.

import { unzipSync, strFromU8 } from 'fflate'

// ─── Shapes ───────────────────────────────────────────────────────────────────

export type PiCell = {
  /** Cached/stored value as text. Null when the cell is empty. */
  value: string | null
  /** The cell carries a formula. */
  hasFormula: boolean
  /** A `<v>` cached result was present. False on a formula whose cache is missing. */
  hasCachedValue: boolean
}

export type PiRowMeta = {
  /** `hidden="1"` on the `<row>` element. The PI's section boundary. */
  hidden: boolean
}

/** One drawing anchored to a cell, resolved to its media part. */
export type PiAnchor = {
  /** 0-based column from `<xdr:from><xdr:col>`. Column E is 4. */
  col: number
  /** 1-based sheet row, already converted from the 0-based anchor. */
  row: number
  /** Package path of the image, e.g. `xl/media/image7.png`. Null if unresolved. */
  mediaPath: string | null
}

export type PiSheet = {
  name: string
  /** `A32` → cell. Only non-empty cells are present. */
  cells: Map<string, PiCell>
  /** Row number → metadata. Only rows present in the XML appear. */
  rows: Map<number, PiRowMeta>
  anchors: PiAnchor[]
}

export type PiWorkbook = {
  sheetNames: string[]
  /** The named sheet, or null when the workbook does not contain it. */
  sheet: PiSheet | null
  /** Media bytes by package path, for the anchors that reference them. */
  media: Map<string, Uint8Array>
}

export class PiWorkbookError extends Error {}

// ─── Entities ─────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
}

function decodeXml(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, m => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * Open an .xlsx package and read one named sheet.
 *
 * `sheetName` is matched case-insensitively after trimming, because "Master",
 * "master" and "Master " are the same sheet to the person who made the file.
 */
export function readPiWorkbook(bytes: Uint8Array, sheetName: string): PiWorkbook {
  let zip: Record<string, Uint8Array>
  try {
    zip = unzipSync(bytes)
  } catch {
    // A .xls, a CSV renamed, or a corrupt upload all land here.
    throw new PiWorkbookError('This file is not a readable .xlsx workbook.')
  }

  const text = (path: string): string | null =>
    zip[path] ? strFromU8(zip[path]) : null

  const workbookXml = text('xl/workbook.xml')
  const workbookRels = text('xl/_rels/workbook.xml.rels')
  if (!workbookXml || !workbookRels) {
    throw new PiWorkbookError('This file is not a readable .xlsx workbook.')
  }

  const relTarget = new Map(
    [...workbookRels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map(m => [m[1], m[2]]),
  )

  const sheetEntries = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .map(m => ({ name: decodeXml(m[1]), rid: m[2] }))

  const sheetNames = sheetEntries.map(s => s.name)
  const wanted = sheetEntries.find(
    s => s.name.trim().toLowerCase() === sheetName.trim().toLowerCase(),
  )

  const media = new Map<string, Uint8Array>()
  for (const path of Object.keys(zip)) {
    if (path.startsWith('xl/media/')) media.set(path, zip[path])
  }

  if (!wanted) return { sheetNames, sheet: null, media }

  const target = relTarget.get(wanted.rid)
  if (!target) return { sheetNames, sheet: null, media }
  const sheetPath = `xl/${target.replace(/^\/?xl\//, '').replace(/^\/+/, '')}`
  const sheetXml = text(sheetPath)
  if (!sheetXml) return { sheetNames, sheet: null, media }

  const shared = readSharedStrings(text('xl/sharedStrings.xml'))
  const { cells, rows } = readCells(sheetXml, shared)
  const anchors = readAnchors(text, sheetPath, sheetXml)

  return { sheetNames, sheet: { name: wanted.name, cells, rows, anchors }, media }
}

function readSharedStrings(xml: string | null): string[] {
  if (!xml) return []
  const out: string[] = []
  // A shared string can be split across several <t> runs when it carries rich
  // text; concatenating them is what recovers the value the user actually sees.
  for (const item of xml.split('<si>').slice(1)) {
    const runs = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1]))
    out.push(runs.join(''))
  }
  return out
}

function readCells(
  sheetXml: string,
  shared: string[],
): { cells: Map<string, PiCell>; rows: Map<number, PiRowMeta> } {
  const cells = new Map<string, PiCell>()
  const rows = new Map<number, PiRowMeta>()

  // `<row ...>…</row>` and the self-closing `<row .../>` an empty styled row
  // produces. Both must be seen: a hidden empty row is still a boundary.
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const attrs = rowMatch[1] ?? ''
    const body = rowMatch[2] ?? ''
    const rowNumber = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0)
    if (!rowNumber) continue

    rows.set(rowNumber, { hidden: /\bhidden="(1|true)"/.test(attrs) })

    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = cellMatch[1] ?? ''
      const cellBody = cellMatch[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(cellAttrs)?.[1]
      if (!ref) continue

      const type = /\bt="([^"]+)"/.exec(cellAttrs)?.[1] ?? 'n'
      const hasFormula = /<f[\s/>]/.test(cellBody)
      const cached = /<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1] ?? null
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cellBody)?.[1] ?? null

      let value: string | null
      if (type === 's' && cached != null) value = shared[Number(cached)] ?? ''
      else if (type === 'inlineStr') value = inline == null ? null : decodeXml(inline)
      else value = cached == null ? null : decodeXml(cached)

      if (value != null && value.trim() === '') value = null

      cells.set(ref, { value, hasFormula, hasCachedValue: cached != null })
    }
  }

  return { cells, rows }
}

/**
 * Resolve the sheet's drawing part and read every anchor in it.
 *
 * The chain is worksheet → its `_rels` → the drawing part → the drawing's own
 * `_rels` → the media file. Each hop is a separate file in the package, which
 * is why an image cannot be found from the sheet XML alone.
 *
 * `oneCellAnchor` and `twoCellAnchor` are both real in BOE files and both carry
 * `<xdr:from>`, which is the only anchor point this needs. `absoluteAnchor` has
 * no cell reference at all and is skipped — a floating logo, never a product.
 */
function readAnchors(
  text: (path: string) => string | null,
  sheetPath: string,
  sheetXml: string,
): PiAnchor[] {
  const drawingRid = /<drawing\b[^>]*r:id="([^"]+)"/.exec(sheetXml)?.[1]
  if (!drawingRid) return []

  const sheetRelsPath = sheetPath.replace(
    /^(xl\/worksheets\/)(.+)$/, '$1_rels/$2.rels',
  )
  const sheetRels = text(sheetRelsPath)
  if (!sheetRels) return []

  const drawingTarget = new RegExp(`Id="${drawingRid}"[^>]*Target="([^"]+)"`)
    .exec(sheetRels)?.[1]
  if (!drawingTarget) return []

  const drawingPath = normalizePart(drawingTarget, 'xl/worksheets')
  const drawingXml = text(drawingPath)
  if (!drawingXml) return []

  const drawingRelsPath = drawingPath.replace(/^(xl\/drawings\/)(.+)$/, '$1_rels/$2.rels')
  const drawingRels = text(drawingRelsPath) ?? ''
  const embedTarget = new Map(
    [...drawingRels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map(m => [m[1], normalizePart(m[2], 'xl/drawings')]),
  )

  const anchors: PiAnchor[] = []
  for (const match of drawingXml.matchAll(
    /<xdr:(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:\1>/g,
  )) {
    const block = match[0]
    const from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(block)?.[1]
    if (!from) continue
    const col = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(from)?.[1] ?? -1)
    const row0 = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(from)?.[1] ?? -1)
    if (col < 0 || row0 < 0) continue

    const embedId = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(block)?.[1]
      ?? /r:embed="([^"]+)"/.exec(block)?.[1]
    const mediaPath = embedId ? embedTarget.get(embedId) ?? null : null

    // +1: DrawingML rows are 0-based, sheet rows are 1-based.
    anchors.push({ col, row: row0 + 1, mediaPath })
  }

  return anchors
}

/** Resolve a relationship Target (often `../media/x.png`) to a package path. */
function normalizePart(target: string, baseDir: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '')
  const segments = `${baseDir}/${target}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

// ─── Cell addressing ──────────────────────────────────────────────────────────

/** `A`,32 → `A32`. Column letters only; this format never needs more. */
export function cellRef(column: string, row: number): string {
  return `${column}${row}`
}

/** The trimmed text of a cell, or null when empty. */
export function cellText(sheet: PiSheet, column: string, row: number): string | null {
  const value = sheet.cells.get(cellRef(column, row))?.value
  if (value == null) return null
  const trimmed = normalizeWhitespace(value)
  return trimmed === '' ? null : trimmed
}

/**
 * Collapse runs of whitespace, including the CRLF a wrapped cell carries, to a
 * single space. Applied to every text field read from a PI.
 *
 * This changes presentation only. It never alters a product code, which is
 * matched and stored exactly as written apart from surrounding blanks.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
