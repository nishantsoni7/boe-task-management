// Reads an .xlsx into a drawable model: column widths, row heights, merged
// cells, fonts, fills, borders and pictures, so the attachment preview can
// show a quotation or PI the way Excel does. Runs in the browser; the
// ExcelJS library (~1 MB) is loaded only when a preview is opened.
//
// Not covered (shown plainly instead): charts, shapes, conditional
// formatting, custom number formats beyond decimals / thousands / % / a
// currency prefix. .xls (old binary format) is not readable by ExcelJS; the
// modal falls back to the plain table for it and for any file this throws on.

import type { Workbook, Worksheet, Cell, Color, Borders, Border } from 'exceljs'

export const PREVIEW_MAX_ROWS = 300
export const PREVIEW_MAX_COLS = 50

export type CellStyle = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  fontSizePx?: number
  fontFamily?: string
  color?: string
  bg?: string
  hAlign?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  borderTop?: string
  borderRight?: string
  borderBottom?: string
  borderLeft?: string
}

export type PreviewCell = {
  text: string
  colSpan: number
  rowSpan: number
  style: CellStyle
  /** Unwrapped text whose right neighbour is empty may run over it, as in Excel. */
  spill: boolean
}

export type PreviewImage = {
  left: number
  top: number
  width: number
  height: number
  mime: string
  data: Uint8Array
}

export type PreviewSheet = {
  name: string
  colWidths: number[]
  rowHeights: number[]
  /** null = covered by a merged cell drawn elsewhere. */
  rows: (PreviewCell | null)[][]
  images: PreviewImage[]
  gridLines: boolean
  truncated: boolean
}

const EMU_PER_PX = 9525
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif' }

// Default Office theme, in ExcelJS's theme-index order.
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
const INDEXED: Record<number, string> = {
  8: '000000', 9: 'FFFFFF', 10: 'FF0000', 11: '00FF00', 12: '0000FF', 13: 'FFFF00', 14: 'FF00FF', 15: '00FFFF',
  64: '000000', 65: 'FFFFFF',
}

export const colWidthPx = (chars: number | undefined) => Math.round((chars ?? 8.43) * 7 + 5)
export const rowHeightPx = (points: number | undefined) => Math.round(((points ?? 15) * 96) / 72)

function applyTint(hex: string, tint: number): string {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16)
    const v = tint < 0 ? c * (1 + tint) : c + (255 - c) * tint
    return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  }
  return ch(0) + ch(2) + ch(4)
}

/** Only ever returns '#rrggbb' or undefined, so nothing from the file reaches CSS unchecked. */
export function cssColor(color: Partial<Color> & { indexed?: number; tint?: number } | undefined): string | undefined {
  if (!color) return undefined
  let hex: string | undefined
  if (typeof color.argb === 'string' && /^[0-9a-f]{8}$/i.test(color.argb)) hex = color.argb.slice(2)
  else if (typeof color.argb === 'string' && /^[0-9a-f]{6}$/i.test(color.argb)) hex = color.argb
  else if (typeof color.theme === 'number') hex = THEME[color.theme]
  else if (typeof color.indexed === 'number') hex = INDEXED[color.indexed]
  if (!hex) return undefined
  if (typeof color.tint === 'number' && color.tint !== 0) hex = applyTint(hex, color.tint)
  return '#' + hex.toUpperCase()
}

const BORDER_CSS: Record<string, string> = {
  thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid',
  dashed: '1px dashed', mediumDashed: '2px dashed', dotted: '1px dotted', double: '3px double',
  dashDot: '1px dashed', mediumDashDot: '2px dashed', dashDotDot: '1px dashed', slantDashDot: '2px dashed',
}

function borderCss(b: Partial<Border> | undefined): string | undefined {
  if (!b?.style) return undefined
  const kind = BORDER_CSS[b.style]
  if (!kind) return undefined
  return `${kind} ${cssColor(b.color) ?? '#000000'}`
}

function safeFontFamily(name: string | undefined): string | undefined {
  if (!name || !/^[\w .-]{1,40}$/.test(name)) return undefined
  return `"${name}", Calibri, Carlito, Arial, sans-serif`
}

function decimalsOf(fmt: string): number {
  const m = fmt.split(';')[0].match(/\.(0+)/)
  return m ? m[1].length : 0
}

export function formatNumber(n: number, fmt: string | undefined): string {
  if (!fmt || fmt === 'General' || fmt === '@') {
    return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(10)))
  }
  const section = fmt.split(';')[0]
  const decimals = decimalsOf(section)
  if (section.includes('%')) return (n * 100).toFixed(decimals) + '%'
  const grouped = /[#0],[#0]/.test(section)
  const locale = /#,##,##/.test(section) ? 'en-IN' : 'en-US'
  const body = grouped
    ? Math.abs(n).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : Math.abs(n).toFixed(decimals)
  const symbol = section.match(/\[\$([^\]-]+)/)?.[1] ?? section.match(/"([^"]{1,4})"\s*[#0]/)?.[1] ?? (section.match(/^([₹$€£¥])/)?.[1] ?? '')
  return (n < 0 ? '-' : '') + symbol + body
}

function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  // ExcelJS reads Excel dates as UTC midnight.
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC' })
}

export function cellText(cell: Pick<Cell, 'value' | 'numFmt'>): { text: string; isNumber: boolean } {
  let v: unknown = cell.value
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Record<string, unknown>
    if ('result' in o || 'formula' in o || 'sharedFormula' in o) v = o.result
    else if (Array.isArray(o.richText)) return { text: (o.richText as { text: string }[]).map(r => r.text).join(''), isNumber: false }
    else if ('text' in o) v = o.text
    else if ('error' in o) return { text: String(o.error), isNumber: false }
  }
  if (v === null || v === undefined) return { text: '', isNumber: false }
  if (v instanceof Date) return { text: formatDate(v), isNumber: true }
  if (typeof v === 'number') return { text: formatNumber(v, cell.numFmt), isNumber: true }
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', isNumber: false }
  if (typeof v === 'object' && v && Array.isArray((v as { richText?: unknown }).richText)) {
    return { text: ((v as { richText: { text: string }[] }).richText).map(r => r.text).join(''), isNumber: false }
  }
  return { text: String(v), isNumber: false }
}

function styleOf(cell: Cell, isNumber: boolean): CellStyle {
  const s: CellStyle = {}
  const f = cell.font
  if (f) {
    if (f.bold) s.bold = true
    if (f.italic) s.italic = true
    if (f.underline) s.underline = true
    if (f.strike) s.strike = true
    if (typeof f.size === 'number' && f.size > 0 && f.size < 100) s.fontSizePx = Math.round((f.size * 96) / 72)
    s.fontFamily = safeFontFamily(f.name)
    s.color = cssColor(f.color)
  }
  const fill = cell.fill
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') s.bg = cssColor(fill.fgColor)
  const a = cell.alignment
  const h = a?.horizontal
  s.hAlign = h === 'center' || h === 'centerContinuous' ? 'center' : h === 'right' ? 'right' : h === 'left' ? 'left' : isNumber ? 'right' : 'left'
  s.vAlign = a?.vertical === 'top' ? 'top' : a?.vertical === 'middle' ? 'middle' : 'bottom'
  if (a?.wrapText) s.wrap = true
  const b: Partial<Borders> | undefined = cell.border
  if (b) {
    s.borderTop = borderCss(b.top)
    s.borderRight = borderCss(b.right)
    s.borderBottom = borderCss(b.bottom)
    s.borderLeft = borderCss(b.left)
  }
  return s
}

function decodeAddress(a: string): { row: number; col: number } {
  const m = a.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/i)
  if (!m) throw new Error(`Bad cell address ${a}`)
  let col = 0
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]), col }
}

type Anchor = { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number }

export function sheetPreview(wb: Workbook, ws: Worksheet): PreviewSheet {
  const images = ws.getImages() as unknown as { imageId: string | number; range: { tl: Anchor; br?: Anchor; ext?: { width: number; height: number } } }[]

  let lastRow = ws.rowCount
  let lastCol = ws.columnCount
  for (const img of images) {
    const end = img.range.br ?? img.range.tl
    lastRow = Math.max(lastRow, end.nativeRow + 1)
    lastCol = Math.max(lastCol, end.nativeCol + 1)
  }
  const truncated = lastRow > PREVIEW_MAX_ROWS || lastCol > PREVIEW_MAX_COLS
  lastRow = Math.min(lastRow, PREVIEW_MAX_ROWS)
  lastCol = Math.min(lastCol, PREVIEW_MAX_COLS)

  const defaultWidth = ws.properties?.defaultColWidth
  const defaultHeight = ws.properties?.defaultRowHeight
  // Hidden rows and columns take no space (0 px), exactly as in Excel.
  const colWidths: number[] = []
  for (let c = 1; c <= lastCol; c++) {
    const col = ws.getColumn(c)
    colWidths.push(col.hidden ? 0 : colWidthPx(col.width ?? defaultWidth))
  }
  const rowHeights: number[] = []
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r)
    rowHeights.push(row.hidden ? 0 : rowHeightPx(row.height ?? defaultHeight))
  }

  // Merges: master address -> span, and every other covered cell.
  const span = new Map<string, { rowSpan: number; colSpan: number }>()
  const covered = new Set<string>()
  const merges: string[] = (ws.model as { merges?: string[] }).merges ?? []
  for (const range of merges) {
    const [a, b] = range.split(':')
    if (!b) continue
    const tl = decodeAddress(a)
    const br = decodeAddress(b)
    if (tl.row > lastRow || tl.col > lastCol) continue
    const bottom = Math.min(br.row, lastRow)
    const right = Math.min(br.col, lastCol)
    span.set(`${tl.row}:${tl.col}`, { rowSpan: bottom - tl.row + 1, colSpan: right - tl.col + 1 })
    for (let r = tl.row; r <= bottom; r++) {
      for (let c = tl.col; c <= right; c++) if (r !== tl.row || c !== tl.col) covered.add(`${r}:${c}`)
    }
  }

  const rows: (PreviewCell | null)[][] = []
  for (let r = 1; r <= lastRow; r++) {
    const out: (PreviewCell | null)[] = []
    const row = ws.getRow(r)
    for (let c = 1; c <= lastCol; c++) {
      if (covered.has(`${r}:${c}`)) { out.push(null); continue }
      const cell = row.getCell(c)
      const { text, isNumber } = cellText(cell)
      const sp = span.get(`${r}:${c}`)
      out.push({ text, colSpan: sp?.colSpan ?? 1, rowSpan: sp?.rowSpan ?? 1, style: styleOf(cell, isNumber), spill: false })
    }
    // Excel lets unwrapped text run over empty cells to its right.
    for (let c = 0; c < out.length; c++) {
      const cell = out[c]
      if (!cell || !cell.text || cell.style.wrap || cell.style.hAlign === 'right') continue
      const next = out[c + cell.colSpan]
      if (next && !next.text) cell.spill = true
    }
    rows.push(out)
  }

  const left = (col: number, offEmu: number) =>
    colWidths.slice(0, Math.min(col, lastCol)).reduce((s, w) => s + w, 0) + (colWidths[col] ? offEmu / EMU_PER_PX : 0)
  const top = (row: number, offEmu: number) =>
    rowHeights.slice(0, Math.min(row, lastRow)).reduce((s, h) => s + h, 0) + (rowHeights[row] ? offEmu / EMU_PER_PX : 0)

  const placed: PreviewImage[] = []
  for (const img of images) {
    const media = wb.getImage(Number(img.imageId)) as { extension?: string; buffer?: Uint8Array }
    const mime = IMAGE_MIME[(media?.extension ?? '').toLowerCase()]
    if (!mime || !media.buffer) continue
    const { tl, br, ext } = img.range
    const x = left(tl.nativeCol, tl.nativeColOff)
    const y = top(tl.nativeRow, tl.nativeRowOff)
    const width = ext?.width ?? (br ? left(br.nativeCol, br.nativeColOff) - x : 0)
    const height = ext?.height ?? (br ? top(br.nativeRow, br.nativeRowOff) - y : 0)
    if (width <= 0 || height <= 0) continue
    placed.push({ left: Math.round(x), top: Math.round(y), width: Math.round(width), height: Math.round(height), mime, data: new Uint8Array(media.buffer) })
  }

  const view = ws.views?.[0] as { showGridLines?: boolean } | undefined
  return { name: ws.name, colWidths, rowHeights, rows, images: placed, gridLines: view?.showGridLines !== false, truncated }
}

export async function readWorkbookPreview(buffer: ArrayBuffer): Promise<PreviewSheet[]> {
  const mod = await import('exceljs')
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const sheets = wb.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden').map(ws => sheetPreview(wb, ws))
  if (sheets.length === 0) throw new Error('No sheets found')
  return sheets
}
