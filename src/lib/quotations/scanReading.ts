// The reader's answers for a scanned client file, turned into review rows. Pure: no browser, no network, so every rule
// here is pinned by scanReading.test.ts. The model's answer is never trusted: anything off the schema is dropped, every
// string is cut to the database's limits, every box is clamped to its page.

import { placeQty, qtyOf, type ImportField, type ImportRow, type RowPicture } from './importBoq'

// ── the request body the scan route accepts (checked on the server) ─────────────

export const MAX_SURVEY_PAGES = 60
export const MAX_READ_PAGES = 4
const MAX_IMAGE_CHARS = 2_000_000 // base64 of one page, about 1.5 MB
const MAX_TEXT = 3000

export type ScanPagePayload = { n: number; jpeg: string; text?: string }

/** The request body, checked: never trust the browser's shape. A string is the reason it was refused. */
export function readScanBody(raw: unknown): { step: 'survey' | 'read'; pages: ScanPagePayload[]; survey: string } | string {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const step = o.step === 'survey' || o.step === 'read' ? o.step : null
  if (!step) return 'Unknown step.'
  if (!Array.isArray(o.pages) || o.pages.length === 0) return 'No pages were sent.'
  if (o.pages.length > (step === 'survey' ? MAX_SURVEY_PAGES : MAX_READ_PAGES)) return 'Too many pages in one request.'
  const pages: ScanPagePayload[] = []
  for (const p of o.pages as unknown[]) {
    const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const n = Number(x.n)
    if (!Number.isInteger(n) || n < 1 || n > 2000) return 'A page number is wrong.'
    if (typeof x.jpeg !== 'string' || x.jpeg.length < 100 || x.jpeg.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(x.jpeg)) return 'A page picture is wrong.'
    pages.push({ n, jpeg: x.jpeg, text: typeof x.text === 'string' ? x.text.slice(0, MAX_TEXT) : undefined })
  }
  const survey = typeof o.survey === 'string' ? o.survey.slice(0, 20000) : ''
  return { step, pages, survey }
}

// ── the survey ──────────────────────────────────────────────────────────────

export type PageKind = 'cover' | 'index' | 'floor_plan' | 'schedule' | 'product' | 'drawing' | 'photos' | 'swatches' | 'notes' | 'terms' | 'price_quote' | 'other'
const KINDS: readonly PageKind[] = ['cover', 'index', 'floor_plan', 'schedule', 'product', 'drawing', 'photos', 'swatches', 'notes', 'terms', 'price_quote', 'other']
export const VENUES = ['hotel', 'resort', 'restaurant', 'cafe', 'brewery', 'other'] as const

export type Survey = {
  project: { name: string; city: string; state: string; venue: (typeof VENUES)[number] | '' }
  units: string; layout: string; quantityRule: string
  rooms: { name: string; count: number | null }[]
  pages: { page: number; kind: PageKind; heading: string; products: number | null }[]
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const int = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null }

export function parseSurvey(raw: unknown, pageCount: number): Survey {
  const o = obj(raw)
  const p = obj(o.project)
  const venue = VENUES.find(v => v === p.venue) ?? ''
  const rooms = (Array.isArray(o.rooms) ? o.rooms : []).slice(0, 40).flatMap(r => {
    const name = str(obj(r).name, 80)
    return name ? [{ name, count: int(obj(r).count, 1, 5000) }] : []
  })
  const pages = (Array.isArray(o.pages) ? o.pages : []).flatMap(x => {
    const r = obj(x)
    const page = int(r.page, 1, pageCount)
    const kind = KINDS.find(k => k === r.kind)
    return page && kind ? [{ page, kind, heading: str(r.heading, 120), products: int(r.products, 0, 500) }] : []
  })
  return {
    project: { name: str(p.name, 120), city: str(p.city, 60), state: str(p.state, 60), venue },
    units: str(o.units, 20), layout: str(o.layout, 300), quantityRule: str(o.quantity_rule, 300), rooms, pages,
  }
}

/** What each read call is told about the whole document. */
export const surveyText = (s: Survey) => JSON.stringify({
  layout: s.layout, units: s.units, quantity_rule: s.quantityRule, rooms: s.rooms,
  pages: s.pages.map(p => ({ page: p.page, kind: p.kind, heading: p.heading || undefined })),
})

/**
 * The pages worth reading, in batches. A cover, index or terms page has no products to read; a page the survey thinks holds
 * many products is read on its own (its answer is long); the rest go in threes. Pages the survey did not mention are read.
 */
export function readBatches(pageCount: number, s: Survey | null, size = 3): number[][] {
  const info = new Map((s?.pages ?? []).map(p => [p.page, p]))
  const skip = (n: number) => { const k = info.get(n)?.kind; return k === 'cover' || k === 'index' || k === 'terms' }
  const out: number[][] = []
  let cur: number[] = []
  for (let n = 1; n <= pageCount; n++) {
    if (skip(n)) continue
    if ((info.get(n)?.products ?? 0) > 10) { if (cur.length) out.push(cur); out.push([n]); cur = []; continue }
    cur.push(n)
    if (cur.length >= size) { out.push(cur); cur = [] }
  }
  if (cur.length) out.push(cur)
  return out
}

// ── the pages ───────────────────────────────────────────────────────────────

export type Box = { page: number; x: number; y: number; w: number; h: number }
export type ScanPicture = Box & { kind: RowPicture['kind'] | 'main'; note: string }
export type ScanRow = {
  page: number; room: string; code: string; name: string; size: string; material: string; finish: string; spec: string
  qty: number | null; qtyText: string; basis: 'per_room' | 'total' | 'unknown'; alternative: boolean; note: string; priceInFile: string
  picture: Box | null; pictures: (Box & { kind: RowPicture['kind']; note: string })[]
  changes: { aspect: string; now: string; wanted: string; swatch: number | null }[]; summary: string; doubtful: ImportField[]
}

const FIELDS: ImportField[] = ['name', 'size', 'qty', 'room', 'material']

/** A box on one of `pages`, clamped inside the page; null when it is not one or is too small to be a picture. */
export function boxOf(v: unknown, pages: ReadonlySet<number>): Box | null {
  const b = obj(v)
  const page = Number(b.page)
  if (!pages.has(page)) return null
  const n = (k: string) => { const x = Number(b[k]); return Number.isFinite(x) ? x : NaN }
  let [x, y, w, h] = [n('x'), n('y'), n('w'), n('h')]
  if ([x, y, w, h].some(Number.isNaN)) return null
  // Some answers come in 0-1 fractions instead of percent.
  if (x <= 1 && y <= 1 && w <= 1 && h <= 1) [x, y, w, h] = [x * 100, y * 100, w * 100, h * 100]
  x = Math.max(0, Math.min(100, x)); y = Math.max(0, Math.min(100, y))
  w = Math.min(100 - x, Math.max(0, w)); h = Math.min(100 - y, Math.max(0, h))
  return w >= 2 && h >= 2 ? { page, x, y, w, h } : null
}

/**
 * The pixels to cut for a box on a page drawn `width` × `height`: the box with a little room around it (the reader's boxes are
 * tight, sometimes a touch short), the room a share of the BOX, not of the page, so a picture in a crowded schedule does not
 * take its neighbours' (seen on the Z40 schedule, 15 Nov 2026).
 */
export function cutRect(b: Box, width: number, height: number) {
  const PAD = 0.06
  const x = Math.max(0, Math.round((b.x - b.w * PAD) / 100 * width)), y = Math.max(0, Math.round((b.y - b.h * PAD) / 100 * height))
  const w = Math.min(width - x, Math.round(b.w * (1 + 2 * PAD) / 100 * width)), h = Math.min(height - y, Math.round(b.h * (1 + 2 * PAD) / 100 * height))
  return { x, y, w, h }
}

/** One read call's answer → rows, kept to the schema; only boxes on the pages that call was given. */
export function parseRead(raw: unknown, pagesRead: readonly number[]): ScanRow[] {
  const pages = new Set(pagesRead)
  const rows = obj(raw).rows
  if (!Array.isArray(rows)) return []
  return rows.slice(0, 300).flatMap((x): ScanRow[] => {
    const r = obj(x)
    const name = str(r.name, 160)
    const page = Number(r.page)
    if (!name || !pages.has(page)) return []
    const pictures = (Array.isArray(r.pictures) ? r.pictures : []).slice(0, 7).flatMap(p => {
      const box = boxOf(p, pages)
      const kind = (['swatch', 'drawing', 'reference'] as const).find(k => k === obj(p).kind)
      return box && kind ? [{ ...box, kind, note: str(obj(p).note, 200) }] : []
    })
    const changes = (Array.isArray(r.changes) ? r.changes : []).slice(0, 10).flatMap(c => {
      const o = obj(c)
      const aspect = str(o.aspect, 60); const wanted = str(o.wanted, 200)
      return aspect && wanted ? [{ aspect, now: str(o.now, 200), wanted, swatch: int(o.swatch, 0, pictures.length - 1) }] : []
    })
    return [{
      page, room: str(r.room, 80), code: str(r.code, 120), name, size: str(r.size, 120), material: str(r.material, 200), finish: str(r.finish, 120),
      spec: str(r.spec, 800), qty: qtyOf(typeof r.qty === 'number' || typeof r.qty === 'string' ? r.qty : null), qtyText: str(r.qty_text, 120),
      basis: r.qty_basis === 'per_room' || r.qty_basis === 'total' ? r.qty_basis : 'unknown', alternative: r.alternative === true,
      note: str(r.note, 300), priceInFile: str(r.price_in_file, 80),
      picture: boxOf(r.picture, pages), pictures, changes, summary: changes.length ? str(r.summary, 400) : '',
      doubtful: Array.isArray(r.doubtful) ? FIELDS.filter(f => (r.doubtful as unknown[]).includes(f)) : [],
    }]
  })
}

/** The same product read twice (a summary page and its own page, or two overlapping answers): one row, the gaps filled. */
export function mergeDuplicates(rows: readonly ScanRow[]): ScanRow[] {
  const out: ScanRow[] = []
  const key = (r: ScanRow) => (r.code ? `${r.room.toLowerCase()}|${r.code.toLowerCase()}|${r.alternative}` : '')
  for (const r of rows) {
    const k = key(r)
    const twin = k ? out.find(o => key(o) === k && o.name.toLowerCase() === r.name.toLowerCase()) : undefined
    if (!twin) { out.push({ ...r }); continue }
    for (const f of ['size', 'material', 'finish', 'spec', 'note', 'priceInFile', 'summary', 'qtyText'] as const) if (!twin[f]) twin[f] = r[f]
    if (twin.qty === null) { twin.qty = r.qty; twin.basis = r.basis }
    if (!twin.picture) twin.picture = r.picture
    if (!twin.changes.length) twin.changes = r.changes
    twin.pictures = [...twin.pictures, ...r.pictures].slice(0, 7)
  }
  return out
}

/** Every picture to cut from the pages, in order: a row's main picture, then its others. Index = position here. */
export function pictureJobs(rows: readonly ScanRow[]): ScanPicture[] {
  const jobs: ScanPicture[] = []
  for (const r of rows) {
    if (r.picture) jobs.push({ ...r.picture, kind: 'main', note: '' })
    for (const p of r.pictures) jobs.push(p)
  }
  return jobs
}

const rid = (() => { let seq = 0; return () => `s${Date.now().toString(36)}${(seq++).toString(36)}` })()

/**
 * Scan rows → review rows. `pictureAt` gives, per picture job (same order as pictureJobs), the index of its cut-out among
 * the pictures, or null when it could not be cut (the row simply has no picture there). The client's code goes in front of
 * the name, what the client wants into Remarks, a price printed in the file and the quantity as printed into the Internal
 * note (never printed, never shown to the client).
 */
export function toImportRows(rows: readonly ScanRow[], survey: Survey | null, pictureAt: readonly (number | null)[]): ImportRow[] {
  const roomCount = new Map((survey?.rooms ?? []).map(r => [r.name.toLowerCase(), r.count]))
  let job = 0
  let lastRoom = ''
  return rows.map(r => {
    let picture: number | null = null
    if (r.picture) { picture = pictureAt[job] ?? null; job++ }
    const extras: RowPicture[] = []
    const swatchAt = new Set<number>()
    r.pictures.forEach((p, i) => { const at = pictureAt[job++] ?? null; if (at !== null) { swatchAt.add(i); extras.push({ picture: at, kind: p.kind, note: p.note }) } })
    // A room printed once and then left out on the next products (Qavalli: "Indoor dining" on one docket page, not on the
    // eight after it) carries on from the row before, shaded for a person to check: a sum across floors can be wrong.
    const doubtful = [...r.doubtful]
    const room = r.room || lastRoom
    if (!r.room && room && !doubtful.includes('room')) doubtful.push('room')
    lastRoom = room
    const rooms = roomCount.get(room.toLowerCase()) ?? null
    const placed = placeQty(r.qty, rooms, r.basis)
    if (placed.unsure && !doubtful.includes('qty')) doubtful.push('qty')
    const changes = r.changes.map(c => `${c.aspect}: ${c.now ? `${c.now} → ` : ''}${c.wanted}${c.swatch !== null && swatchAt.has(c.swatch) ? ' (see the swatch)' : ''}`)
    const internal = [
      r.priceInFile && `Price in the client's file: ${r.priceInFile}`,
      r.qtyText && placed.qty !== null && qtyOf(r.qtyText) !== r.qty && `Quantity in the file: ${r.qtyText}`,
    ].filter(Boolean).join('\n')
    // One code goes in front of the name (C1A Low height chair); a list of them (a spec card shared by room types: "QA-01,
    // SA-01, EA-02") would bury the name, so it goes to the Remarks. A bare serial ("2", "3") is not a code at all.
    const isCode = /[a-z]/i.test(r.code)
    const oneCode = isCode && r.code.length <= 15 && !/[,;/]/.test(r.code)
    return {
      id: rid(), include: true, room, rooms, name: (oneCode ? `${r.code} ${r.name}` : r.name).slice(0, 160),
      size: r.size, material: r.material, finish: r.finish, spec: r.spec, qty: placed.qty, qtyMode: placed.qtyMode,
      price: null, note: [isCode && !oneCode ? `Item no.: ${r.code}` : '', r.note].filter(Boolean).join('\n'),
      internalNote: internal, picture, doubtful, source: `Page ${r.page}`,
      page: r.page, extras, changes, wanted: r.summary, optional: r.alternative,
    }
  })
}
