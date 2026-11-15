// The browser's half of Import: spreadsheets and pasted text are read here (nothing leaves the browser); a PDF, a photo or a
// PowerPoint is scanned (scanRun.ts: its pages become pictures on this device and only those go to the AI reader, owner
// allowed 2026-11-12 and 2026-11-15). Everything ends as review rows from importBoq.ts.

import type { createClient } from '@/lib/supabase/client'
import { classifyRouteError } from '@/lib/errors/routeError'
import { gridFromText, readGrid, type Cell, type ImportRow } from './importBoq'
import { SCAN_ACCEPT, scanKind, type ScanPage } from './scanPages'
import type { ScanProgress } from './scanRun'
import type { Survey } from './scanReading'

type Supabase = ReturnType<typeof createClient>

export const IMPORT_ACCEPT = `.xlsx,.xls,.csv,${SCAN_ACCEPT}`

export type ImportResult = { rows: ImportRow[]; pictures: Blob[]; note: string; pages?: ScanPage[]; survey?: Survey | null }

export class ImportError extends Error {}

const STALE_PAGE_TEXT = 'Part of BOE could not be downloaded, most likely because BOE was updated while this page was open. Reload the page, then choose the file again. If the browser asks whether to leave, stay, close this window and press Save first.'

/**
 * The spreadsheet reader is downloaded the first time a file is chosen. When BOE was updated under an open page, or that
 * download dropped, the page keeps the failed result until it reloads, so choosing the file again cannot work: say so and
 * let the dialog offer Reload, instead of printing the loader's own text. Anything else keeps its own message.
 */
export function readFailure(e: unknown, fallback: string): { text: string; reload: boolean } {
  if (classifyRouteError(e as Error | null) === 'updated') return { text: STALE_PAGE_TEXT, reload: true }
  return { text: e instanceof Error ? e.message : fallback, reload: false }
}

const isSheet = (f: File) => /\.(xlsx|xls|csv)$/i.test(f.name)

/**
 * One or more files, as review rows: every spreadsheet read here, every PDF / photo / PowerPoint scanned together (one survey
 * over all their pages, so photos sent one by one on WhatsApp read as one document). Pictures of both kinds in one list.
 */
export async function readImportFiles(supabase: Supabase, files: readonly File[], onProgress: (p: ScanProgress) => void): Promise<ImportResult> {
  const bad = files.find(f => !isSheet(f) && !scanKind(f))
  if (bad) throw new ImportError(`${bad.name}: use Excel or CSV, a PDF, a photo (JPG, PNG, WebP) or a PowerPoint (.pptx).`)
  const out: ImportResult = { rows: [], pictures: [], note: '' }
  const notes: string[] = []
  const take = (r: ImportResult) => {
    const at = out.pictures.length
    out.rows.push(...r.rows.map(x => ({ ...x, picture: x.picture === null ? null : x.picture + at, extras: x.extras?.map(e => ({ ...e, picture: e.picture + at })) })))
    out.pictures.push(...r.pictures)
    if (r.note) notes.push(r.note)
  }
  for (const f of files.filter(isSheet)) take(await readSpreadsheet(f))
  const scan = files.filter(f => !isSheet(f))
  if (scan.length) {
    const { scanFiles } = await import('./scanRun')
    const r = await scanFiles(supabase, scan, onProgress)
    take(r)
    Object.assign(out, { pages: r.pages, survey: r.survey })
  }
  out.note = notes.join(' ')
  return out
}

export function readPastedText(input: string): ImportResult {
  const { rows } = readGrid(gridFromText(input))
  return { rows, pictures: [], note: rows.length ? '' : 'No products found in the text. Paste the rows with their headings.' }
}

/**
 * Products that carry BOE's own price. A PI's helper tabs (packing, fabric, finish) list the same products with no price,
 * so the tab with the price must win over a tab that merely has more rows. A price read from a bare "Price" / "Rate"
 * heading (marked doubtful) does not count: a client's small rate summary must not beat the full list.
 */
export const pricedRows = (rows: readonly ImportRow[]) => rows.filter(r => r.price !== null && !r.doubtful.includes('price')).length

/** Every sheet is tried; the one with the most priced products wins, then the one with the most products. Pictures come from .xlsx files only. */
export async function readSpreadsheet(file: File): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const XLSX = await import('xlsx')
  let wb
  try { wb = XLSX.read(bytes, { type: 'array', cellDates: false }) } catch { throw new ImportError('This file could not be opened as a spreadsheet.') }

  const pics = file.name.toLowerCase().endsWith('.xlsx') ? await picturesBySheet(bytes) : new Map<string, { row: number; blob: Blob }[]>()
  let best: { rows: ImportRow[]; pictures: Blob[]; sheet: string; headerRow: number | null } | null = null
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true })
    const sheetPics = pics.get(name) ?? []
    const pictureRows = new Map<number, number>()
    sheetPics.forEach((p, i) => { if (!pictureRows.has(p.row)) pictureRows.set(p.row, i) })
    const { rows, headerRow } = readGrid(grid, pictureRows)
    const [priced, bestPriced] = [pricedRows(rows), best ? pricedRows(best.rows) : 0]
    if (!best || priced > bestPriced || (priced === bestPriced && rows.length > best.rows.length)) best = { rows, pictures: sheetPics.map(p => p.blob), sheet: name, headerRow }
  }
  if (!best || best.rows.length === 0) return { rows: [], pictures: [], note: 'No products found. Check that the sheet has a heading row (Description, Qty, Size…).' }
  return {
    rows: best.rows, pictures: best.pictures,
    note: `Read sheet "${best.sheet}"${best.headerRow ? `, headings on row ${best.headerRow}` : ', no heading row found (first text = product, first number = quantity)'}.`,
  }
}

/** Pictures anchored in each sheet of an .xlsx, with the 1-based row their top-left corner sits on. */
async function picturesBySheet(bytes: Uint8Array): Promise<Map<string, { row: number; blob: Blob }[]>> {
  const out = new Map<string, { row: number; blob: Blob }[]>()
  try {
    const mod = await import('exceljs')
    const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    for (const ws of wb.worksheets) {
      const list = ws.getImages().flatMap(img => {
        const media = wb.getImage(Number(img.imageId)) as { buffer?: ArrayBuffer | Uint8Array; extension?: string } | undefined
        if (!media?.buffer || !/^(jpe?g|png|webp)$/i.test(media.extension ?? '')) return []
        const ext = (media.extension ?? 'png').toLowerCase().replace('jpg', 'jpeg')
        return [{ row: Math.floor(img.range.tl.nativeRow) + 1, col: Math.floor(img.range.tl.nativeCol), blob: new Blob([media.buffer as BlobPart], { type: `image/${ext}` }) }]
      })
      // A PI row can hold several pictures (the representative image in column E, customization pictures further right):
      // the one a row keeps is the leftmost, whatever order the file lists them in.
      list.sort((a, b) => a.row - b.row || a.col - b.col)
      out.set(ws.name, list)
    }
  } catch { /* pictures are a bonus: the rows still import */ }
  return out
}
