// Embedded-picture extraction for the BOE PI Master sheet.
//
// A PI's representative product image is not a cell value. It is a floating
// DrawingML picture, anchored to a cell, living in xl/drawings/drawingN.xml and
// pointing through xl/drawings/_rels/drawingN.xml.rels at bytes under xl/media/.
// SheetJS does not read any of that (see the header of
// src/lib/xlsxMediaOptimizer.ts), so this module walks the chain directly:
//
//   xl/worksheets/sheetN.xml   <drawing r:id="rIdX"/>
//     → xl/worksheets/_rels/sheetN.xml.rels    rIdX → ../drawings/drawing1.xml
//       → xl/drawings/drawing1.xml             anchors, each with r:embed="rIdY"
//         → xl/drawings/_rels/drawing1.xml.rels rIdY → ../media/image28.png
//           → xl/media/image28.png             the bytes
//
// WHAT COUNTS AS A PRODUCT IMAGE. Only a picture anchor whose ORIGIN cell is in
// one of the two image columns and inside the product row band. That single
// rule is what keeps the BOE logo (row 1), the signature block (row 7) and the
// footer artwork (rows 124+) out of the product data, without maintaining a list
// of things to ignore. Text typed into either column is a cell value and is not
// a picture; it is never mistaken for one because this module never looks at
// cells.
//
// TWO COLUMNS, TWO MEANINGS. Column E carries the representative image — the
// product — and a row must have exactly one. Column K carries customization
// images: pictures of what should DIFFER from the representative image. A row
// may have none, one, or several, and several is not an ambiguity because
// nothing has to be chosen between them. Column K also holds the customization
// TEXT, which is a cell value and therefore invisible to this module.
//
// The role is decided by the anchor's origin column and by nothing else. No
// heuristic reads the picture, its size, its name or its order to guess what it
// is for, because a wrong guess attaches the wrong photograph to a commercial
// document.
//
// Both anchor kinds are handled and both are real in production workbooks: one
// observed BOE file mixes 51 twoCellAnchor and 11 oneCellAnchor elements, and
// its product pictures use both. absoluteAnchor carries no cell reference at all
// — it is positioned in EMUs on the page — so it can never be attributed to a
// row and is ignored by construction.

import { isUnsafeEntryName, resolveRelTarget, sniffImageFormat, type ArchiveEntries } from '../xlsxMediaOptimizer'
import { partText, relationshipMap, relationshipTarget, relsPathFor } from './workbookReader'
import type { PiImageRole, PiProductImage } from './types'

/** Media MUST live here. A relationship that resolves anywhere else is not a
 *  picture we are willing to read, however the drawing describes it. */
const MEDIA_PREFIX = 'xl/media/'

const FORMAT_MIME: Record<string, string> = {
  png:  'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
  bmp:  'image/bmp',
  tiff: 'image/tiff',
}

// ── Anchors ───────────────────────────────────────────────────────────────────

export type PiAnchorKind = 'oneCellAnchor' | 'twoCellAnchor'

export type PiAnchor = {
  kind: PiAnchorKind
  /** 0-based, exactly as the drawing XML stores it. */
  fromCol: number
  fromRow: number
  /** Present on twoCellAnchor only. */
  toCol: number | null
  toRow: number | null
  /** The r:embed of the picture's blip, or null when the anchor holds a shape,
   *  a text box, a chart or a group rather than a picture. */
  embedId: string | null
  isPicture: boolean
}

/**
 * Every cell-anchored element in a drawing part, in document order.
 *
 * Tag prefixes are matched loosely ((?:\w+:)?) because the xdr: prefix is a
 * convention, not a requirement — a producer may bind the DrawingML spreadsheet
 * namespace to any prefix, or to the default. Element NAMES are fixed by the
 * schema, so they are what the patterns key on.
 */
export function parseDrawingAnchors(xml: string): PiAnchor[] {
  const out: PiAnchor[] = []
  if (!xml) return out

  const anchorRe = /<(?:\w+:)?(oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(xml)) !== null) {
    const kind = m[1] as PiAnchorKind
    const body = m[0]

    const from = readCellRef(body, 'from')
    if (!from) continue

    const to = kind === 'twoCellAnchor' ? readCellRef(body, 'to') : null
    const isPicture = /<(?:\w+:)?pic\b/.test(body)
    const embedId = isPicture ? (/\br:embed="([^"]+)"/.exec(body)?.[1] ?? null) : null

    out.push({
      kind,
      fromCol: from.col,
      fromRow: from.row,
      toCol: to?.col ?? null,
      toRow: to?.row ?? null,
      embedId,
      isPicture,
    })
  }
  return out
}

/** <from>/<to> hold <col> and <row> alongside <colOff>/<rowOff>. The patterns
 *  require the closing angle bracket immediately after the element name, so
 *  <colOff> can never be read as <col>. */
function readCellRef(body: string, which: 'from' | 'to'): { col: number; row: number } | null {
  const block = new RegExp(`<(?:\\w+:)?${which}>([\\s\\S]*?)</(?:\\w+:)?${which}>`).exec(body)?.[1]
  if (!block) return null
  const col = Number(/<(?:\w+:)?col>(-?\d+)<\/(?:\w+:)?col>/.exec(block)?.[1] ?? NaN)
  const row = Number(/<(?:\w+:)?row>(-?\d+)<\/(?:\w+:)?row>/.exec(block)?.[1] ?? NaN)
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return null
  return { col, row }
}

// ── Drawing part resolution ───────────────────────────────────────────────────

/** The drawing part a worksheet references, or null when it has none (a Master
 *  sheet with no pictures at all is unusual but not malformed). */
export function resolveDrawingPart(entries: ArchiveEntries, sheetPart: string): string | null {
  const sheetXml = partText(entries, sheetPart)
  const rid = /<(?:\w+:)?drawing\b[^>]*\br:id="([^"]+)"/.exec(sheetXml)?.[1]
  if (!rid) return null

  const relsPath = relsPathFor(sheetPart)
  const target = relationshipTarget(partText(entries, relsPath), rid)
  if (!target) return null

  const part = resolveRelTarget(relsPath, target)
  if (!part || isUnsafeEntryName(part) || !(part in entries)) return null
  return part
}

// ── Extraction ────────────────────────────────────────────────────────────────

export type PiImageIssueCode =
  | 'PRODUCT_IMAGE_UNSAFE_PATH'
  | 'PRODUCT_IMAGE_UNREADABLE'

export type PiImageIssue = {
  code: PiImageIssueCode
  /** 1-based worksheet row the rejected picture was anchored to. */
  row: number
  /** The resolved part name, or the raw relationship target when it could not
   *  be resolved at all. */
  part: string
  /** Which column the rejected picture came from. The caller turns this into
   *  the right warning code: a representative failure explains a blocking
   *  issue, a customization failure never does. */
  role: PiImageRole
}

export type PiImageHarvest = {
  /** 1-based row → the column-E pictures anchored there, in document order.
   *  A row with two entries is a genuine ambiguity the caller must report. */
  representativeByRow: ReadonlyMap<number, PiProductImage[]>
  /** 1-based row → the column-K pictures anchored there, in document order.
   *  Several on one row is normal and is NOT an ambiguity. */
  customizationByRow: ReadonlyMap<number, PiProductImage[]>
  issues: readonly PiImageIssue[]
}

export type HarvestOptions = {
  entries: ArchiveEntries
  drawingPart: string
  /** 0-based column the representative image is anchored in (E → 4). */
  representativeColumn: number
  /** 0-based column customization images are anchored in (K → 10). The same
   *  column also holds the customization TEXT; a cell value is never a picture
   *  and this module never looks at cells, so the two cannot collide. */
  customizationColumn: number
  /** Inclusive 1-based product row band. Anything outside is decorative. */
  firstRow: number
  lastRow: number
}

/**
 * Collect the product pictures out of one drawing part.
 *
 * REUSED MEDIA. A PI routinely anchors the SAME media part to several rows —
 * five chairs of one model share one photograph. Each row gets its own
 * PiProductImage record (it has its own row and anchor), but they all share one
 * Uint8Array: the bytes are read from the archive once, cached by part name, and
 * handed out by reference. Nothing is copied and nothing is decoded twice.
 */
export function harvestProductImages(opts: HarvestOptions): PiImageHarvest {
  const { entries, drawingPart, representativeColumn, customizationColumn, firstRow, lastRow } = opts

  const anchors = parseDrawingAnchors(partText(entries, drawingPart))
  const rels = relationshipMap(partText(entries, relsPathFor(drawingPart)))
  const relsPath = relsPathFor(drawingPart)

  const representativeByRow = new Map<number, PiProductImage[]>()
  const customizationByRow = new Map<number, PiProductImage[]>()
  const issues: PiImageIssue[] = []
  // ONE cache across BOTH columns. A workbook that uses the same photograph as
  // a product shot and as a customization illustration reads and sniffs those
  // bytes once, and the two records share the buffer by reference.
  const mediaCache = new Map<string, MediaFacts>()

  for (const anchor of anchors) {
    if (!anchor.isPicture) continue

    // The column decides the role, and nothing else does. Any other column is
    // decoration and is dropped here — the same single rule that keeps the
    // logo, the signature block and the footer artwork out.
    const role: PiImageRole | null =
      anchor.fromCol === representativeColumn ? 'representative'
      : anchor.fromCol === customizationColumn ? 'customization'
      : null
    if (!role) continue

    const row = anchor.fromRow + 1
    if (row < firstRow || row > lastRow) continue

    const target = anchor.embedId ? rels.get(anchor.embedId) : undefined
    if (!target) {
      issues.push({ code: 'PRODUCT_IMAGE_UNREADABLE', row, part: anchor.embedId ?? '(no r:embed)', role })
      continue
    }

    const resolved = resolveRelTarget(relsPath, target)
    if (!resolved || isUnsafeEntryName(resolved) || !resolved.startsWith(MEDIA_PREFIX)) {
      issues.push({ code: 'PRODUCT_IMAGE_UNSAFE_PATH', row, part: resolved ?? target, role })
      continue
    }
    if (!(resolved in entries)) {
      issues.push({ code: 'PRODUCT_IMAGE_UNREADABLE', row, part: resolved, role })
      continue
    }

    let facts = mediaCache.get(resolved)
    if (!facts) {
      facts = readMedia(entries, resolved)
      mediaCache.set(resolved, facts)
    }

    const image: PiProductImage = {
      role,
      row,
      part: resolved,
      bytes: facts.bytes,
      byteLength: facts.bytes.length,
      format: facts.format,
      mimeType: facts.mimeType,
      extension: facts.extension,
      anchorKind: anchor.kind,
      anchorFromCol: anchor.fromCol,
      anchorFromRow: anchor.fromRow,
    }

    const target_ = role === 'representative' ? representativeByRow : customizationByRow
    const list = target_.get(row)
    if (list) list.push(image)
    else target_.set(row, [image])
  }

  return { representativeByRow, customizationByRow, issues }
}

type MediaFacts = {
  bytes: Uint8Array
  format: PiProductImage['format']
  mimeType: string | null
  extension: string
}

function readMedia(entries: ArchiveEntries, part: string): MediaFacts {
  const bytes = entries[part]
  // Format comes from the MAGIC BYTES, never the extension: a "photo.png" that
  // is really a JPEG must be stored and served as a JPEG. Same rule as
  // listOptimizableMedia in the optimiser.
  const format = sniffImageFormat(bytes)
  return {
    bytes,
    format,
    mimeType: FORMAT_MIME[format] ?? null,
    extension: extensionOf(part),
  }
}

function extensionOf(part: string): string {
  const leaf = part.slice(part.lastIndexOf('/') + 1)
  const dot = leaf.lastIndexOf('.')
  return dot === -1 ? '' : leaf.slice(dot + 1).toLowerCase()
}
