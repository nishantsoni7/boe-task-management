// Price learning, piece 1: the browser's half. A PI workbook is read here (nothing leaves the browser), its sheets handed
// to the pure reader in readPi.ts, and a fingerprint of the file and of its lines made for duplicate detection. Pictures
// are not read at all: the model learns from words and prices.

import { contentPrint, hashBytes, judge, readPiGrids, type Cell, type PiReading, type PiVerdict } from './readPi'

export const PI_ACCEPT = '.xlsx,.xls'
/** A batch stays small enough for a person to check every file. */
export const BATCH_MAX = 25
/** Rows read from each sheet: a PI has well under 200, and large files full of pictures stay quick this way. */
const SHEET_ROWS = 700

export type PiFile = {
  /** The file name: shown to the pricing desk only (it can carry a client's name). */
  label: string
  fileHash: string
  contentPrint: string
  reading: PiReading
  /** The date the file was last saved: offered when the PI carries no date of its own. */
  savedDate: string
  verdict: PiVerdict
  /** Set when the file could not be opened at all. */
  failure: string | null
}

const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const EMPTY: PiReading = { sheet: null, headerRow: null, currency: 'unknown', lines: [], footer: { subtotal: null, discount: null, grandTotal: null }, piDate: null, sumOfLines: 0, unpricedRows: 0, problem: 'NO_TABLE' }

export async function readPiFile(file: File): Promise<PiFile> {
  const base = { label: file.name, savedDate: isoOf(file.lastModified) }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const [fileHash, XLSX] = await Promise.all([hashBytes(bytes), import('xlsx')])
    const wb = XLSX.read(bytes, { type: 'array', cellDates: false, sheetRows: SHEET_ROWS })
    const reading = readPiGrids(wb.SheetNames.map(name => ({ name, grid: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) })))
    return { ...base, fileHash, contentPrint: await contentPrint(reading.lines), reading, verdict: judge(reading, reading.piDate !== null), failure: null }
  } catch (e) {
    return {
      ...base, fileHash: '', contentPrint: '', reading: EMPTY, failure: e instanceof Error ? e.message : 'The file could not be opened.',
      verdict: { status: 'left_out', reasons: ['The file could not be opened as a spreadsheet.'], toCheck: 0 },
    }
  }
}
