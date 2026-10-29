/**
 * The workbook's fabric, packing and finish sheets, read as they are.
 *
 * Offline: every workbook is built here, in the shape the BOE template has —
 * a Master sheet with the product band at rows 32–111, and the two sheets
 * whose rows 2–81 mirror it. One optional case reads the real template when it
 * is present on this machine, and is skipped when it is not.
 *
 * Run:
 *   npx tsx --test src/lib/pi/fabricFinishSheets.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import {
  FABRIC_COST_SHEET_NAME,
  FABRIC_FINISH_SHEET_NAME,
  RECONCILE_TOLERANCE_RUPEES,
  SHEET_ROW_OFFSET,
  lineDrift,
  readFabricFinishSheets,
  reconcileWithPi,
  type FabricFinishLine,
} from './fabricFinishSheets'

// ── A workbook builder ────────────────────────────────────────────────────────

type Cell = string | number | null
type Rows = Record<number, Record<string, Cell>>

const enc = new TextEncoder()
const bytesOf = (s: string) => enc.encode(s)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One worksheet part from an address→value map; strings are inline, numbers plain. */
function sheetXml(rows: Rows): string {
  const rowXml = Object.entries(rows)
    .map(([r, cells]) => {
      const cs = Object.entries(cells).map(([col, v]) => {
        const ref = `${col}${r}`
        if (v === null) return `<c r="${ref}"/>`
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
      }).join('')
      return `<row r="${r}">${cs}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
}

function workbook(sheets: { name: string; rows: Rows }[]): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': bytesOf(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `</Types>`,
    ),
    '_rels/.rels': bytesOf(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`,
    ),
  }
  parts['xl/workbook.xml'] = bytesOf(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  )
  parts['xl/_rels/workbook.xml.rels'] = bytesOf(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `</Relationships>`,
  )
  sheets.forEach((s, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = bytesOf(sheetXml(s.rows)) })
  return zipSync(parts)
}

const COST_HEADER: Record<string, Cell> = {
  A: 'Code', B: 'Name', C: 'Quantity', D: 'Dimension in inches\n& Shape', E: 'Representative Image',
  G: 'Material', H: 'Fabric Per pc', I: 'Total fabric', J: 'Fabric price per meter', K: 'Total Fabric Amount',
  L: 'Packing cost/pc', M: 'Total packing cost', N: 'Packing Type:\n(BCF: Bubble, Foam, Corrugate)\nOR (CB: Carton ',
}
const FINISH_HEADER: Record<string, Cell> = {
  A: 'Code', B: 'Name', C: 'Quantity', D: 'Dimensions / Shape', E: 'Representative Image',
  G: 'Fabric Approval', H: 'Wood Finish Approval', I: 'Metal Finish', J: 'Marble/Rope Approval',
}

/** An unused slot reads exactly as the template's formulas leave it: 0, 0, 0, a space. */
const unused = (code: string): Record<string, Cell> => ({ A: code, B: 0, C: 0, D: 0, G: ' ', I: 0, K: 0, M: 0 })

const master = { name: 'Master', rows: { 31: { A: 'Code', B: 'Name' }, 32: { A: '539-B001', B: 'Bar Stool' } } }

const costSheet = {
  name: FABRIC_COST_SHEET_NAME,
  rows: {
    1: COST_HEADER,
    2: { A: '539-B001', B: 'Bar Stool ', C: 10, D: 'Standard', G: 'MS Structure and Upholstery ', H: 0, I: 0, J: 650, K: 0, L: 380, M: 3800, N: 'Carton and Carret' },
    3: { A: '539-B002', B: 'Chair', C: 8, D: 'Standard', G: 'Oak wood and Upholstery ', H: 0.7, I: 5.6, J: 650, K: 3639.9999999999995, L: 380, M: 3040, N: 'BCF' },
    // The cached products are missing: the workbook saved formulas without values.
    4: { A: '539-B003', B: 'Sofa', C: 2, G: 'Oak', H: 12.5, J: 800, L: 1500, N: 'BCF' },
    5: unused('539-B004'),
    6: unused('539-B005'),
  } as Rows,
}

const finishSheet = {
  name: FABRIC_FINISH_SHEET_NAME,
  rows: {
    1: FINISH_HEADER,
    2: { A: '539-B001', B: 'Bar Stool ', C: 10, G: 'NA', I: 'Complete Brass finish on Base', J: 'NA' },
    3: { A: '539-B002', B: 'Chair', C: 8, G: 'PENDING', H: 'PENDING', I: 'PENDING', J: 'PENDING' },
    4: { A: '539-B003', B: 'Sofa', C: 2, G: 'Approved 12 Oct', H: 'PENDING', I: 'NA', J: 'NA' },
    5: { A: '539-B004', B: 0, C: 0, G: 'PENDING', H: 'PENDING', I: 'PENDING', J: 'PENDING' },
  } as Rows,
}

const ok = async (bytes: Uint8Array) => {
  const r = await readFabricFinishSheets(bytes)
  assert.ok(r.ok, r.ok ? '' : r.message)
  return r.sheets
}

// ── The read ──────────────────────────────────────────────────────────────────

describe('both sheets, as the template lays them out', () => {
  test('one line per used slot, joined to the Master row by arithmetic', async () => {
    const sheets = await ok(workbook([master, costSheet, finishSheet]))
    assert.equal(sheets.costSheet.present, true)
    assert.equal(sheets.finishSheet.present, true)
    assert.deepEqual(sheets.lines.map(l => l.code), ['539-B001', '539-B002', '539-B003'], 'the two unused slots are not lines')
    assert.deepEqual(sheets.lines.map(l => l.masterRow), [32, 33, 34])
    assert.equal(SHEET_ROW_OFFSET, 30)
    assert.deepEqual(sheets.lines.map(l => l.sheetRow), [2, 3, 4])
  })

  test('the fabric and packing figures are the workbook’s own, with its trailing spaces gone', async () => {
    const sheets = await ok(workbook([master, costSheet, finishSheet]))
    const chair = sheets.lines[1]
    assert.equal(chair.name, 'Chair')
    assert.equal(chair.quantity, 8)
    assert.equal(chair.material, 'Oak wood and Upholstery')
    assert.deepEqual(chair.fabric, { perPiece: 0.7, total: 5.6, pricePerMetre: 650, amount: 3639.9999999999995 })
    assert.deepEqual(chair.packing, { perPiece: 380, total: 3040, type: 'BCF' })
    const stool = sheets.lines[0]
    assert.deepEqual(stool.fabric, { perPiece: 0, total: 0, pricePerMetre: 650, amount: 0 })
    assert.equal(stool.packing?.type, 'Carton and Carret')
  })

  test('a formula that kept no value is the product the formula states, and only then', async () => {
    const sheets = await ok(workbook([master, costSheet, finishSheet]))
    const sofa = sheets.lines[2]
    assert.deepEqual(sofa.fabric, { perPiece: 12.5, total: 25, pricePerMetre: 800, amount: 20000 })
    assert.deepEqual(sofa.packing, { perPiece: 1500, total: 3000, type: 'BCF' })
  })

  test('the totals are the sums the Master sheet takes', async () => {
    const { totals } = await ok(workbook([master, costSheet, finishSheet]))
    assert.equal(totals.totalFabricMetres, 30.6)
    assert.equal(totals.fabricAmount, 23640)
    assert.equal(totals.packingTotal, 9840)
    assert.equal(totals.linesWithFabric, 2)
    assert.equal(totals.linesWithPacking, 3)
  })

  test('every approval column from G on, in the sheet’s order, with its words', async () => {
    const sheets = await ok(workbook([master, costSheet, finishSheet]))
    assert.deepEqual(sheets.finishSheet.approvalColumns, ['Fabric Approval', 'Wood Finish Approval', 'Metal Finish', 'Marble/Rope Approval'])
    const stool = sheets.lines[0]
    assert.deepEqual(stool.approvals, [
      { column: 'Fabric Approval', value: 'NA' },
      { column: 'Wood Finish Approval', value: null },
      { column: 'Metal Finish', value: 'Complete Brass finish on Base' },
      { column: 'Marble/Rope Approval', value: 'NA' },
    ])
    assert.equal(sheets.lines[2].approvals[0].value, 'Approved 12 Oct')
  })

  test('a column a salesperson added to the finish sheet is one more approval', async () => {
    const extra = { ...finishSheet, rows: { ...finishSheet.rows, 1: { ...FINISH_HEADER, K: 'Seat Fabric' }, 3: { ...finishSheet.rows[3], K: 'Velvet 402' } } }
    const sheets = await ok(workbook([master, costSheet, extra]))
    assert.deepEqual(sheets.finishSheet.approvalColumns.at(-1), 'Seat Fabric')
    assert.equal(sheets.lines[1].approvals.at(-1)?.value, 'Velvet 402')
    assert.equal(sheets.lines[0].approvals.at(-1)?.value, null)
  })

  test('columns are found by their header words, not their letters', async () => {
    const shifted: Rows = {
      1: { A: 'Code', B: 'Name', C: 'Quantity', G: 'Material', H: 'Notes', I: 'Fabric Per pc', J: 'Total fabric', K: 'Fabric price per meter', L: 'Total Fabric Amount', M: 'Packing cost/pc', N: 'Total packing cost', O: 'Packing Type' },
      2: { A: '539-B001', B: 'Bench', C: 4, G: 'Oak', H: 'see drawing', I: 1.5, J: 6, K: 700, L: 4200, M: 500, N: 2000, O: 'CB' },
    }
    const sheets = await ok(workbook([master, { name: FABRIC_COST_SHEET_NAME, rows: shifted }]))
    assert.deepEqual(sheets.lines[0].fabric, { perPiece: 1.5, total: 6, pricePerMetre: 700, amount: 4200 })
    assert.deepEqual(sheets.lines[0].packing, { perPiece: 500, total: 2000, type: 'CB' })
  })
})

describe('a workbook with one sheet, or neither', () => {
  test('only the cost sheet: lines with figures and no approval columns', async () => {
    const sheets = await ok(workbook([master, costSheet]))
    assert.equal(sheets.finishSheet.present, false)
    assert.deepEqual(sheets.finishSheet.approvalColumns, [])
    assert.equal(sheets.lines.length, 3)
    assert.deepEqual(sheets.lines[0].approvals, [])
  })

  test('only the finish sheet: lines with approvals and no figures', async () => {
    const sheets = await ok(workbook([master, finishSheet]))
    assert.equal(sheets.costSheet.present, false)
    assert.equal(sheets.lines.length, 3)
    assert.equal(sheets.lines[0].fabric, null)
    assert.equal(sheets.lines[0].packing, null)
    assert.equal(sheets.lines[1].approvals[0].value, 'PENDING')
    assert.equal(sheets.totals.fabricAmount, 0)
  })

  test('neither sheet is said, with the sheets the workbook does have', async () => {
    const r = await readFabricFinishSheets(workbook([master, { name: 'BDPI', rows: {} }]))
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'NO_SHEETS')
      assert.deepEqual(r.sheetNames, ['Master', 'BDPI'])
    }
  })

  test('bytes that are not a workbook are refused, not thrown', async () => {
    const r = await readFabricFinishSheets(new Uint8Array([1, 2, 3, 4]))
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'ARCHIVE')
  })
})

// ── Reconciling with the PI ───────────────────────────────────────────────────

describe('the sheet sum against the PI’s own figure', () => {
  test('inside the Master sheet’s rounding is the same figure', () => {
    assert.equal(RECONCILE_TOLERANCE_RUPEES, 10)
    assert.deepEqual(reconcileWithPi(6760, 6760, null), { kind: 'match' })
    assert.deepEqual(reconcileWithPi(3639.99, 3640, null), { kind: 'match' })
    assert.deepEqual(reconcileWithPi(77430, 77400, null), { kind: 'differs', sheet: 77430, pi: 77400 })
  })

  test('a PI that states fabric in words says so; one that states nothing says that', () => {
    assert.deepEqual(reconcileWithPi(0, null, 'Included'), { kind: 'pi_worded', piText: 'Included' })
    assert.deepEqual(reconcileWithPi(0, null, null), { kind: 'unknown' })
  })

  test('a line whose PI quantity moved since upload is flagged; a line the PI no longer has, too', () => {
    const line: FabricFinishLine = { masterRow: 33, sheetRow: 3, code: '539-B002', name: 'Chair', quantity: 8, material: null, fabric: null, packing: null, approvals: [] }
    assert.deepEqual(lineDrift(line, new Map([[33, 8]])), { kind: 'same' })
    assert.deepEqual(lineDrift(line, new Map([[33, 11]])), { kind: 'quantity', piQuantity: 11 })
    assert.deepEqual(lineDrift(line, new Map([[32, 8]])), { kind: 'not_on_pi' })
    assert.deepEqual(lineDrift(line, new Map([[33, null]])), { kind: 'same' }, 'an unknown PI quantity is not a difference')
  })
})

// ── The real template, when it is on this machine ─────────────────────────────

const TEMPLATE = join(homedir(), 'BOE-Development', 'temporary', 'pi-sample', 'Revised PI Format.xlsx')
const opts = { skip: existsSync(TEMPLATE) ? false : `sample workbook not present at ${TEMPLATE}` }

describe('the production template', () => {
  test('carries both sheets with the four approval columns', opts, async () => {
    const r = await readFabricFinishSheets(new Uint8Array(readFileSync(TEMPLATE)))
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.sheets.costSheet.present, true)
    assert.equal(r.sheets.finishSheet.present, true)
    assert.deepEqual(r.sheets.finishSheet.approvalColumns, ['Fabric Approval', 'Wood Finish Approval', 'Metal Finish', 'Marble/Rope Approval'])
    for (const line of r.sheets.lines) assert.equal(line.masterRow, line.sheetRow + SHEET_ROW_OFFSET)
  })
})
