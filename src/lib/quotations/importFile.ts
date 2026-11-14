// The browser's half of Import: spreadsheets and pasted text are read here (nothing leaves the browser); a PDF or a
// photo is sent once to /api/quotations/import, read there, and dropped (owner allowed BOQ files to go to the AI
// reader on 2026-11-12). Both end as review rows from importBoq.ts.

import type { createClient } from '@/lib/supabase/client'
import { classifyRouteError } from '@/lib/errors/routeError'
import { shrinkPhoto } from '@/lib/exhibitionLeads/scanClient'
import { gridFromText, readGrid, type Cell, type ImportRow } from './importBoq'

type Supabase = ReturnType<typeof createClient>

export const IMPORT_ACCEPT = '.xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp'
/** Vercel refuses a request body above 4.5 MB; PDFs above this are split or sent as Excel. */
export const MAX_IMPORT_PDF_BYTES = 4 * 1024 * 1024

export type ImportResult = { rows: ImportRow[]; pictures: Blob[]; note: string }

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

const kind = (f: File) => {
  const n = f.name.toLowerCase()
  if (/\.(xlsx|xls|csv)$/.test(n)) return 'sheet'
  if (n.endsWith('.pdf') || f.type === 'application/pdf') return 'pdf'
  if (/\.(jpe?g|png|webp)$/.test(n) || f.type.startsWith('image/')) return 'photo'
  return null
}

export async function readImportFile(supabase: Supabase, file: File): Promise<ImportResult> {
  const k = kind(file)
  if (k === 'sheet') return readSpreadsheet(file)
  if (k === 'pdf' || k === 'photo') return readOnServer(supabase, file, k)
  throw new ImportError('Use an Excel or CSV file, a PDF, or a photo (JPG, PNG, WebP).')
}

export function readPastedText(input: string): ImportResult {
  const { rows } = readGrid(gridFromText(input))
  return { rows, pictures: [], note: rows.length ? '' : 'No products found in the text. Paste the rows with their headings.' }
}

/** Every sheet is tried; the one giving the most products wins. Pictures come from .xlsx files only. */
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
    if (!best || rows.length > best.rows.length) best = { rows, pictures: sheetPics.map(p => p.blob), sheet: name, headerRow }
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

type ServerReply = { ok: true; reading: unknown; note?: string } | { ok: false; error: string }

async function readOnServer(supabase: Supabase, file: File, k: 'pdf' | 'photo'): Promise<ImportResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new ImportError('Your session ended. Sign in again, then import.')
  let upload: Blob = file
  if (k === 'photo') upload = await shrinkPhoto(file)
  else if (file.size > MAX_IMPORT_PDF_BYTES) throw new ImportError('This PDF is over 4 MB. Send the BOQ pages only, or the Excel file.')

  const body = new FormData()
  body.set('file', new File([upload], k === 'pdf' ? 'boq.pdf' : 'boq.jpg', { type: k === 'pdf' ? 'application/pdf' : 'image/jpeg' }))
  let res: Response
  try {
    res = await fetch('/api/quotations/import', { method: 'POST', body, headers: { Authorization: `Bearer ${session.access_token}` } })
  } catch { throw new ImportError('No connection. Check the network and try again.') }
  const json = await res.json().catch(() => null) as ServerReply | null
  if (!json) throw new ImportError(res.status === 504 ? 'Reading took too long. Send fewer pages, or the Excel file.' : 'Could not read the file right now. Try again.')
  if (!json.ok) throw new ImportError(json.error)
  const { parseBoqReading } = await import('./importBoq')
  const rows = parseBoqReading(json.reading)
  return { rows, pictures: [], note: rows.length ? (json.note ?? 'Read by the AI reader: check every row, especially the marked cells.') : 'No products found in this file.' }
}
