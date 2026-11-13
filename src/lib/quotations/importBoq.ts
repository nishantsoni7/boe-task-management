// Phase 3, Import: a client's BOQ (Excel, CSV, pasted text, or a PDF / photo read on the server) becomes review rows,
// and the rows the salesperson keeps become room types and products on the quotation. Prices are never imported:
// they stay blank for the salesperson (owner, 2026-11-12). Nothing here is trusted blindly: every row is shown for
// review first, and anything the reader was unsure of is marked.

import type { QuoteArea, QuoteLine } from './math'

export type ImportField = 'name' | 'size' | 'qty' | 'room' | 'material'

export type ImportRow = {
  id: string
  include: boolean
  /** Room type or area the product belongs to; '' when the file names none. */
  room: string
  /** Rooms of that type, when the file says (e.g. "BOHO ROOM (56 ROOMS)"). */
  rooms: number | null
  name: string
  size: string
  material: string
  finish: string
  spec: string
  qty: number | null
  qtyMode: 'per_unit' | 'fixed'
  note: string
  /** Index into the pictures read from the same file (Excel only). */
  picture: number | null
  doubtful: ImportField[]
  /** Where it came from, for the review table: "Row 12", "Page 2". */
  source: string
}

export type Cell = string | number | null | undefined
type Col = 'sno' | 'name' | 'size' | 'qty' | 'room' | 'material' | 'finish' | 'spec' | 'note' | 'picture'

// Header words, compared after lower-casing and dropping everything but letters and digits ("Qty (Nos.)" → "qtynos").
// A heading matches a key when it STARTS with one of its words. Order matters: the first key that matches wins.
const HEADERS: [Col, string[]][] = [
  ['sno', ['srno', 'sno', 'slno', 'serial', 'itemno']], // never bare 'no': it would take "Notes"
  ['note', ['remark', 'notes', 'note', 'comment']],
  ['picture', ['image', 'photo', 'picture', 'pic', 'referenceimage', 'refimage', 'reference']],
  ['qty', ['qty', 'quantity', 'nos', 'noofunits', 'units', 'totalqty', 'count']],
  ['size', ['size', 'dimension', 'dim', 'lxwxh', 'wxdxh', 'lxbxh']],
  ['room', ['roomtype', 'room', 'area', 'location', 'space', 'zone', 'floor']],
  ['finish', ['finish', 'colour', 'color', 'polish']],
  ['material', ['material']],
  ['spec', ['specification', 'spec', 'details']],
  ['name', ['description', 'item', 'particular', 'product', 'furniture', 'name', 'article']],
]

const norm = (v: Cell) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const text = (v: Cell) => String(v ?? '').replace(/\s+/g, ' ').trim()
let seq = 0
const rid = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`

function headerCols(row: Cell[]): Partial<Record<Col, number>> {
  const found: Partial<Record<Col, number>> = {}
  row.forEach((cell, i) => {
    const n = norm(cell)
    if (!n || n.length > 40) return
    for (const [col, words] of HEADERS) {
      if (found[col] !== undefined) continue
      if (words.some(w => n.startsWith(w))) { found[col] = i; return }
    }
  })
  return found
}

/** A number from "2", "2 nos", "2.5", 2; null when there is none. */
export function qtyOf(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  const m = /(\d+(?:\.\d+)?)/.exec(String(v ?? '').replace(/,/g, ''))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** "BOHO ROOM (56 ROOMS)", "Corporate room x 18", "Suite – 4 keys" → 56, 18, 4. */
export function roomsOf(title: string): number | null {
  const m = /(\d+)\s*(?:rooms?|keys?|units?|nos?\.?)\b/i.exec(title) ?? /[x×]\s*(\d+)\b/i.exec(title) ?? /\((\d+)\)/.exec(title)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n >= 1 && n <= 5000 ? n : null
}

const roomTitle = (title: string) => text(title.replace(/[-–(]?\s*(\d+)\s*(rooms?|keys?|units?|nos?\.?)\s*\)?/i, '').replace(/[x×]\s*\d+\s*$/i, '').replace(/\(\s*\d+\s*\)/, '')).replace(/[:\-–]+$/, '').trim()

const SKIP = /^(sub\s*-?\s*total|grand\s*total|total|amount|gst|igst|cgst|sgst|note|notes|terms)\b/i

/** Quantity as the file gave it, turned into per room × rooms when it divides evenly; marked when unsure. */
function placeQty(qty: number | null, rooms: number | null, basis: 'per_room' | 'total' | 'unknown'): Pick<ImportRow, 'qty' | 'qtyMode'> & { unsure: boolean } {
  if (qty === null) return { qty: null, qtyMode: 'per_unit', unsure: true }
  if (!rooms || rooms <= 1) return { qty, qtyMode: rooms ? 'per_unit' : 'fixed', unsure: false }
  if (basis === 'per_room') return { qty, qtyMode: 'per_unit', unsure: false }
  if (qty >= rooms && qty % rooms === 0) return { qty: qty / rooms, qtyMode: 'per_unit', unsure: basis === 'unknown' }
  if (basis === 'total') return { qty, qtyMode: 'fixed', unsure: false }
  return { qty, qtyMode: 'per_unit', unsure: true }
}

export type GridResult = { rows: ImportRow[]; headerRow: number | null }

/**
 * Rows of a sheet (or pasted text) → review rows. `pictureRows` maps a 1-based sheet row to the index of a picture
 * anchored on it. Without a header row, the first text cell is the product and the first number its quantity.
 */
export function readGrid(grid: Cell[][], pictureRows: ReadonlyMap<number, number> = new Map()): GridResult {
  let headerRow: number | null = null
  let cols: Partial<Record<Col, number>> = {}
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    const c = headerCols(grid[r] ?? [])
    if (c.name !== undefined && (c.qty !== undefined || c.size !== undefined)) { headerRow = r; cols = c; break }
  }

  const rows: ImportRow[] = []
  let room = ''
  let rooms: number | null = null
  const start = headerRow === null ? 0 : headerRow + 1
  for (let r = start; r < grid.length; r++) {
    const row = grid[r] ?? []
    const at = (c: Col) => (cols[c] === undefined ? null : row[cols[c]!])
    let name: string, qtyCell: Cell, size: string
    if (headerRow !== null) {
      name = text(at('name')); qtyCell = at('qty'); size = text(at('size'))
    } else {
      const cells = row.map(text)
      name = cells.find(c => c && !/^\d+(\.\d+)?$/.test(c)) ?? ''
      const nameAt = cells.indexOf(name)
      qtyCell = row.slice(nameAt + 1).find(c => qtyOf(c) !== null && /^\s*\d+(\.\d+)?\s*(nos?\.?|pcs|units?|sets?)?\s*$/i.test(String(c))) ?? null
      size = cells.find((c, i) => i !== nameAt && /\d\s*(x|×|\*)\s*\d|\d\s*(mm|cm|in|ft|'|")/i.test(c)) ?? ''
    }
    if (!name || SKIP.test(name) || /^\d+(\.\d+)?$/.test(name)) continue
    const qty = qtyOf(qtyCell)
    const roomCell = text(at('room'))

    // A title row ("BOHO ROOM (56 ROOMS)"): a name with no quantity, no size and no serial number starts a room type.
    if (qty === null && !size && !roomCell && qtyOf(at('sno')) === null) {
      room = roomTitle(name) || name
      rooms = roomsOf(name)
      continue
    }
    const thisRoom = roomCell || room
    const thisRooms = roomCell ? roomsOf(roomCell) : rooms
    const placed = placeQty(qty, thisRooms, 'unknown')
    const doubtful: ImportField[] = []
    if (placed.unsure) doubtful.push('qty')
    if (!size) doubtful.push('size')
    rows.push({
      id: rid(), include: true, room: roomCell ? roomTitle(roomCell) || roomCell : thisRoom, rooms: thisRooms,
      name, size, material: text(at('material')), finish: text(at('finish')), spec: text(at('spec')),
      qty: placed.qty, qtyMode: placed.qtyMode, note: text(at('note')),
      picture: pictureRows.get(r + 1) ?? null, doubtful, source: `Row ${r + 1}`,
    })
  }
  return { rows, headerRow: headerRow === null ? null : headerRow + 1 }
}

/** Text copied from Excel (tabs), a table (" | "), or typed lines → a grid for readGrid. */
export function gridFromText(input: string): Cell[][] {
  return input.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .map(line => (line.includes('\t') ? line.split('\t') : line.includes('|') ? line.split('|') : line.split(/\s{2,}/)).map(c => c.trim()))
}

// ── The server's reading of a PDF or photo ─────────────────────────────────────

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const FIELDS: ImportField[] = ['name', 'size', 'qty', 'room', 'material']

/** The model's answer (tool input) → review rows. Anything outside the schema is dropped. */
export function parseBoqReading(raw: unknown): ImportRow[] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { rooms?: unknown; rows?: unknown }
  const roomCount = new Map<string, number>()
  if (Array.isArray(o.rooms)) for (const r of o.rooms.slice(0, 100)) {
    const name = str((r as { name?: unknown })?.name, 80)
    const n = Number((r as { count?: unknown })?.count)
    if (name && Number.isInteger(n) && n >= 1 && n <= 5000) roomCount.set(name.toLowerCase(), n)
  }
  if (!Array.isArray(o.rows)) return []
  return o.rows.slice(0, 600).flatMap((x): ImportRow[] => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const name = str(r.name, 160)
    if (!name) return []
    const room = str(r.room, 80)
    const rooms = roomCount.get(room.toLowerCase()) ?? null
    const basis = r.qty_basis === 'per_room' || r.qty_basis === 'total' ? r.qty_basis : 'unknown'
    const placed = placeQty(qtyOf(typeof r.qty === 'number' || typeof r.qty === 'string' ? r.qty : null), rooms, basis)
    const doubtful = Array.isArray(r.doubtful) ? FIELDS.filter(f => (r.doubtful as unknown[]).includes(f)) : []
    if (placed.unsure && !doubtful.includes('qty')) doubtful.push('qty')
    const page = Number(r.page)
    return [{
      id: rid(), include: true, room, rooms, name, size: str(r.size, 120), material: str(r.material, 200), finish: str(r.finish, 120),
      spec: str(r.spec, 500), qty: placed.qty, qtyMode: placed.qtyMode, note: str(r.note, 300), picture: null, doubtful,
      source: Number.isInteger(page) && page > 0 ? `Page ${page}` : '',
    }]
  })
}

// ── Into the quotation ─────────────────────────────────────────────────────────

const newKey = () => `n${Math.random().toString(36).slice(2, 10)}`

/**
 * The kept rows appended to the quotation: a room type per distinct room (an existing one with the same name is
 * reused), and a product per row with no price. `picturePaths[i]` is the stored path of row i's picture, if any.
 */
export function addToQuote(rows: readonly ImportRow[], areas: readonly QuoteArea[], picturePaths: ReadonlyMap<string, string> = new Map()):
  { areas: QuoteArea[]; lines: QuoteLine[] } {
  const outAreas = [...areas]
  const keyFor = (room: string, rooms: number | null): string | null => {
    if (!room) return null
    const found = outAreas.find(a => a.name.trim().toLowerCase() === room.toLowerCase())
    if (found) return found.key
    const a: QuoteArea = { key: newKey(), name: room.slice(0, 80), style: '', multiplier: rooms && rooms >= 1 ? rooms : 1, unit_label: 'rooms' }
    outAreas.push(a)
    return a.key
  }
  const lines = rows.filter(r => r.include && r.name.trim()).map((r): QuoteLine => {
    const area_key = keyFor(r.room.trim(), r.rooms)
    return {
      // Cut to the database's limits (20270614000000), so an imported line can always be saved.
      key: newKey(), area_key, name: r.name.trim().slice(0, 160), size_text: r.size.slice(0, 80), spec: [r.spec.trim(), r.note.trim()].filter(Boolean).join('\n').slice(0, 1600),
      material: r.material.slice(0, 120), finish: r.finish.slice(0, 120), category: '',
      qty_mode: area_key ? r.qtyMode : 'fixed', qty: Math.min(100000, Math.round((r.qty ?? 1) * 100) / 100) || 1, unit_price: null, tax_rate: 18,
      image_path: picturePaths.get(r.id) ?? null, is_optional: false, client_note: '', internal_note: '', // the file's own note joins the Remarks text: the builder has no separate note for the client (20270714000000)
    }
  })
  return { areas: outAreas, lines }
}
