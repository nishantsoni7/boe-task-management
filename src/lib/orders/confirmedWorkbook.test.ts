/**
 * THE CONFIRMED WORKBOOK — proved against real .xlsx packages.
 *
 * WHAT THESE TESTS DEFEND
 * -----------------------
 * The whole value of this module is a negative claim: the confirmed workbook is
 * the client's own file, with one cell filled in and NOTHING ELSE TOUCHED. A
 * test that only checked B20 would pass for a file that had silently lost every
 * product photograph.
 *
 * So each fixture below is a genuine ZIP with the parts a BOE PI actually
 * carries — images, formulas, merged cells, hidden rows, print settings, styles,
 * column widths, drawing relationships — and every test reads what came out of
 * the rewrite rather than what went into it.
 *
 * Offline and pure. fflate builds and reads the fixtures; no file is written, no
 * network is touched, and no database client exists in this module's import
 * graph.
 *
 * Run:
 *   npx tsx --test src/lib/orders/confirmedWorkbook.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync, zipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONFIRMED_NUMBER_CELL,
  CONFIRMED_SHEET_NAME,
  CONFIRMED_WORKBOOK_MAX_BYTES,
  buildConfirmedWorkbook,
  CONFIRMED_EDITABLE_CELLS,
  CONFIRMED_WRITABLE_REFS,
  columnIndex,
  escapeXmlText,
  parseCellRef,
  readInlineCell,
  setCellInlineString,
  validateConfirmedRebuild,
} from './confirmedWorkbook'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytesOf = (s: string) => enc.encode(s)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ── A workbook that looks like a BOE PI ───────────────────────────────────────
//
// Everything a rewrite could plausibly damage is in here, and every one of them
// is asserted below: a merged header block, a column-width block, hidden rows, a
// print setup, styles, two formulas with cached values, a drawing that anchors
// two images, and shared strings that other cells' indexes depend on.

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function fakeImage(seed: number): Uint8Array {
  const out = new Uint8Array(512)
  out.set(PNG_SIG, 0)
  for (let i = PNG_SIG.length; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

/** The Master sheet, with everything outside <sheetData> that must survive. */
function masterSheetXml(opts: {
  /** What B20 currently holds. `undefined` means the cell is absent. */
  b20?: { style?: string; type?: string; inner: string }
  /** Omit row 20 entirely. */
  noRow20?: boolean
  /** Make B20 a formula cell. */
  b20Formula?: boolean
  /** Emit rows out of ascending order. */
  shuffleRows?: boolean
  /** A completely empty sheet: <sheetData/>. */
  emptySheetData?: boolean
  /** The party rows the header contract names, as a real BOE PI carries them. */
  partyRows?: boolean
  /** Make one correction target a formula cell. */
  billToNameFormula?: boolean
} = {}): string {
  const chrome =
    `<dimension ref="A1:K130"/>`
    + `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="30" topLeftCell="A31" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + `<cols><col min="1" max="1" width="9.5" customWidth="1"/><col min="2" max="2" width="28.75" customWidth="1"/><col min="5" max="5" width="18" customWidth="1" hidden="1"/></cols>`

  const tail =
    `</sheetData>`
    + `<mergeCells count="3"><mergeCell ref="A1:K3"/><mergeCell ref="B20:D20"/><mergeCell ref="A113:D113"/></mergeCells>`
    + `<conditionalFormatting sqref="I32:I112"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>`
    + `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="C32:C112"><formula1>"1,2,3"</formula1></dataValidation></dataValidations>`
    + `<printOptions horizontalCentered="1"/>`
    + `<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>`
    + `<pageSetup paperSize="9" scale="62" orientation="portrait" r:id="rIdPrint"/>`
    + `<headerFooter><oddFooter>&amp;CPage &amp;P of &amp;N</oddFooter></headerFooter>`
    + `<drawing r:id="rIdDraw"/>`
    + `</worksheet>`

  if (opts.emptySheetData) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
      + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + chrome + `<sheetData/>` + tail.replace('</sheetData>', '')
  }

  const b20Cell = opts.b20Formula
    ? `<c r="B20" s="7"><f>CONCATENATE("BOE-",A1)</f><v>BOE-X</v></c>`
    : opts.b20 === undefined
      ? ''
      : `<c r="B20"${opts.b20.style ?? ''}${opts.b20.type ?? ''}>${opts.b20.inner}</c>`

  const row20 = opts.noRow20 ? '' :
    `<row r="20" ht="21" customHeight="1">`
    + `<c r="A20" s="4" t="s"><v>0</v></c>`
    + b20Cell
    + `<c r="G20" s="5" t="s"><v>1</v></c>`
    + `</row>`

  // Two hidden rows, a formula row with a cached value, and a second formula in
  // a different row — the count is what "formulas survived" is measured by.
  const rows = [
    `<row r="1" ht="40" customHeight="1"><c r="A1" s="1" t="s"><v>2</v></c></row>`,
    row20,
    `<row r="31" s="6" customFormat="1"><c r="A31" s="6" t="s"><v>3</v></c><c r="I31" s="6" t="s"><v>4</v></c></row>`,
    `<row r="32"><c r="C32"><v>3</v></c><c r="H32" s="8"><v>1200</v></c><c r="I32" s="8"><f>C32*H32</f><v>3600</v></c></row>`,
    `<row r="33" hidden="1"><c r="A33" s="2" t="str"><v></v></c></row>`,
    `<row r="34" hidden="1"/>`,
    `<row r="120"><c r="I120" s="9"><f>SUM(I32:I112)</f><v>3600</v></c></row>`,
  ].filter(Boolean)

  // The header block a real PI carries: BOE's own GST beside the contact
  // number, then the two parties. Rows 22 and 25-28 hold shared strings, which
  // is what makes "a correction becomes an inline string" a real transition
  // rather than an inline-to-inline rewrite.
  const party = opts.partyRows ? [
    `<row r="22"><c r="B22" s="3" t="s"><v>0</v></c><c r="G22" s="3" t="s"><v>1</v></c></row>`,
    `<row r="25"><c r="B25" s="3" t="s"><v>2</v></c><c r="G25" s="3" t="s"><v>3</v></c></row>`,
    `<row r="26"><c r="B26" s="3" t="s"><v>4</v></c><c r="G26" s="3" t="s"><v>0</v></c></row>`,
    `<row r="27"><c r="B27" s="3" t="s"><v>1</v></c><c r="G27" s="3" t="s"><v>2</v></c></row>`,
    `<row r="28"><c r="B28" s="3" t="s"><v>3</v></c><c r="G28" s="3" t="s"><v>4</v></c></row>`,
  ] : []
  if (opts.partyRows && opts.billToNameFormula) {
    party[1] = `<row r="25"><c r="B25" s="3"><f>CONCATENATE(A1," Ltd")</f><v>X Ltd</v></c>`
      + `<c r="G25" s="3" t="s"><v>3</v></c></row>`
  }

  const withParty = opts.partyRows
    ? [rows[0], rows[1], ...party, ...rows.slice(2)].filter(Boolean)
    : rows

  const ordered = opts.shuffleRows ? [rows[2], rows[1], rows[0], ...rows.slice(3)] : withParty

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + chrome + `<sheetData>` + ordered.join('') + tail
}

type WorkbookOpts = Parameters<typeof masterSheetXml>[0] & {
  /** Sheet names, in workbook.xml order. Master must be among them. */
  sheetNames?: string[]
  /** Drop the Master sheet entirely. */
  noMaster?: boolean
  extraParts?: Record<string, Uint8Array>
}

function buildWorkbook(opts: WorkbookOpts = {}): Uint8Array {
  const sheetNames = opts.sheetNames ?? ['Cover', CONFIRMED_SHEET_NAME, 'Notes']
  const names = opts.noMaster ? sheetNames.filter(n => n !== CONFIRMED_SHEET_NAME) : sheetNames
  const masterIndex = names.indexOf(CONFIRMED_SHEET_NAME)

  const parts: Record<string, Uint8Array> = {}

  parts['[Content_Types].xml'] = bytesOf(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="png" ContentType="image/png"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `</Types>`)

  parts['_rels/.rels'] = bytesOf(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`)

  parts['xl/workbook.xml'] = bytesOf(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="${Math.max(masterIndex, 0)}">Master!$A$1:$K$130</definedName></definedNames>`
    + `</workbook>`)

  // Relationships in REVERSE declaration order, exactly as the production
  // workbooks store them: anything that resolves a sheet by position rather than
  // by r:id fails here.
  parts['xl/_rels/workbook.xml.rels'] = bytesOf(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + names.map((_n, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .reverse().join('')
    + `</Relationships>`)

  names.forEach((_n, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = i === masterIndex
      ? bytesOf(masterSheetXml(opts))
      : bytesOf(`<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>`)
  })

  parts['xl/styles.xml'] = bytesOf(
    `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00"/></numFmts>`
    + `<cellXfs count="10">${Array.from({ length: 10 }, (_v, i) => `<xf numFmtId="${i === 8 ? 164 : 0}" fontId="0" fillId="0" borderId="0"/>`).join('')}</cellXfs>`
    + `</styleSheet>`)

  parts['xl/sharedStrings.xml'] = bytesOf(
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">`
    + ['Order No.', 'Date', 'PROFORMA INVOICE', 'Code', 'Total Cost (INR)']
        .map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
    + `</sst>`)

  parts['xl/calcChain.xml'] = bytesOf(
    `<?xml version="1.0"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<c r="I32" i="${masterIndex + 1}"/><c r="I120" i="${masterIndex + 1}"/></calcChain>`)

  if (masterIndex >= 0) {
    parts[`xl/worksheets/_rels/sheet${masterIndex + 1}.xml.rels`] = bytesOf(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`
      + `<Relationship Id="rIdPrint" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/>`
      + `</Relationships>`)

    parts['xl/drawings/drawing1.xml'] = bytesOf(
      `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
      + `<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:row>31</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rIdImg1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>`
      + `<xdr:twoCellAnchor><xdr:from><xdr:col>10</xdr:col><xdr:row>31</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rIdImg2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>`
      + `</xdr:wsDr>`)

    parts['xl/drawings/_rels/drawing1.xml.rels'] = bytesOf(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
      + `<Relationship Id="rIdImg2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>`
      + `</Relationships>`)

    parts['xl/printerSettings/printerSettings1.bin'] = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  }

  parts['xl/media/image1.png'] = fakeImage(11)
  parts['xl/media/image2.png'] = fakeImage(97)

  for (const [name, data] of Object.entries(opts.extraParts ?? {})) parts[name] = data

  return zipSync(parts)
}

/** The default fixture: B20 present, styled, holding a shared string. */
const DEFAULT_B20 = { style: ' s="7"', type: ' t="s"', inner: '<v>0</v>' }

const NUMBER = '0001'

async function confirm(bytes: Uint8Array, orderNumber = NUMBER) {
  return buildConfirmedWorkbook({ bytes, orderNumber })
}

function masterOf(bytes: Uint8Array): { entries: Record<string, Uint8Array>; xml: string } {
  const entries = unzipSync(bytes) as Record<string, Uint8Array>
  // The fixture's Master is always sheet2 by relationship; resolve it the same
  // way production does rather than assuming.
  const wb = dec.decode(entries['xl/workbook.xml'])
  const rid = /<sheet name="Master"[^>]*r:id="([^"]+)"/.exec(wb)?.[1] ?? ''
  const rels = dec.decode(entries['xl/_rels/workbook.xml.rels'])
  const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
    ?? new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1] ?? ''
  return { entries, xml: dec.decode(entries[`xl/${target}`]) }
}

// ═══ 1. Pure helpers ═════════════════════════════════════════════════════════

describe('the small pure helpers', () => {
  test('escapeXmlText escapes the three characters that break XML text', () => {
    assert.equal(escapeXmlText('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
    assert.equal(escapeXmlText('0001'), '0001')
  })

  test('parseCellRef accepts a plain A1 reference and nothing else', () => {
    assert.deepEqual(parseCellRef('B20'), { column: 'B', row: 20 })
    assert.deepEqual(parseCellRef('AA1'), { column: 'AA', row: 1 })
    for (const bad of ['$B$20', 'B', '20', 'B0', 'Master!B20', 'B20:C21', 'b20', '']) {
      assert.equal(parseCellRef(bad), null, bad)
    }
  })

  test('columnIndex orders columns the way a row does', () => {
    assert.ok(columnIndex('A') < columnIndex('B'))
    assert.ok(columnIndex('Z') < columnIndex('AA'))
    assert.equal(columnIndex('A'), 1)
    assert.equal(columnIndex('AA'), 27)
  })
})

// ═══ 2. The cell write, at the XML level ═════════════════════════════════════

describe('writing one cell', () => {
  const sheet = masterSheetXml({ b20: DEFAULT_B20 })

  test('replaces an existing cell and it reads back', () => {
    const out = setCellInlineString(sheet, 'B20', '0042')
    assert.ok(out.ok)
    assert.equal(out.replaced, true)
    assert.equal(readInlineCell(out.xml, 'B20'), '0042')
  })

  test('KEEPS THE CELL\'S STYLE — the template designer chose that box', () => {
    const out = setCellInlineString(sheet, 'B20', '0042')
    assert.ok(out.ok)
    assert.match(out.xml, /<c r="B20" s="7" t="inlineStr">/)
  })

  test('writes an INLINE string, so sharedStrings.xml is never touched', () => {
    const out = setCellInlineString(sheet, 'B20', '0042')
    assert.ok(out.ok)
    assert.match(out.xml, /t="inlineStr"><is><t xml:space="preserve">0042<\/t><\/is>/)
    assert.ok(!out.xml.includes('sharedStrings'))
  })

  test('leaves every OTHER cell in the row exactly as it was', () => {
    const out = setCellInlineString(sheet, 'B20', '0042')
    assert.ok(out.ok)
    assert.ok(out.xml.includes('<c r="A20" s="4" t="s"><v>0</v></c>'))
    assert.ok(out.xml.includes('<c r="G20" s="5" t="s"><v>1</v></c>'))
  })

  test('leaves the row\'s own attributes alone — its height and its hidden flag', () => {
    const out = setCellInlineString(sheet, 'B20', '0042')
    assert.ok(out.ok)
    assert.match(out.xml, /<row r="20" ht="21" customHeight="1">/)
    assert.ok(out.xml.includes('<row r="33" hidden="1">'))
    assert.ok(out.xml.includes('<row r="34" hidden="1"/>'))
  })

  test('inserts the cell IN COLUMN ORDER when the row has no B20', () => {
    const without = masterSheetXml({ b20: undefined })
    const out = setCellInlineString(without, 'B20', '0042')
    assert.ok(out.ok)
    assert.equal(out.replaced, false)
    const row = /<row r="20"[^>]*>([\s\S]*?)<\/row>/.exec(out.xml)?.[1] ?? ''
    assert.ok(row.indexOf('r="A20"') < row.indexOf('r="B20"'), 'A20 before B20')
    assert.ok(row.indexOf('r="B20"') < row.indexOf('r="G20"'), 'B20 before G20')
  })

  test('inserts the ROW in order when row 20 is absent', () => {
    const out = setCellInlineString(masterSheetXml({ noRow20: true }), 'B20', '0042')
    assert.ok(out.ok)
    const rows = [...out.xml.matchAll(/<row r="(\d+)"/g)].map(m => Number(m[1]))
    assert.deepEqual(rows, [...rows].sort((a, b) => a - b), 'rows stay ascending')
    assert.ok(rows.includes(20))
    assert.equal(readInlineCell(out.xml, 'B20'), '0042')
  })

  test('handles a completely empty sheet', () => {
    const out = setCellInlineString(masterSheetXml({ emptySheetData: true }), 'B20', '0042')
    assert.ok(out.ok)
    assert.equal(readInlineCell(out.xml, 'B20'), '0042')
  })

  test('REFUSES a formula cell rather than breaking the calculation chain', () => {
    const out = setCellInlineString(masterSheetXml({ b20Formula: true }), 'B20', '0042')
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_UNSUPPORTED')
    assert.match(out.detail, /formula/)
  })

  test('refuses a sheet whose rows are not in ascending order', () => {
    const out = setCellInlineString(masterSheetXml({ b20: DEFAULT_B20, shuffleRows: true }), 'B20', '0042')
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_UNSUPPORTED')
  })

  test('refuses a reference that is not a plain cell', () => {
    for (const bad of ['$B$20', 'B20:C21', 'Master!B20']) {
      const out = setCellInlineString(sheet, bad, 'x')
      assert.ok(!out.ok, bad)
    }
  })

  test('escapes a value that would otherwise break the XML', () => {
    const out = setCellInlineString(sheet, 'B20', 'A&B <x>')
    assert.ok(out.ok)
    assert.ok(!/<x>/.test(out.xml.slice(out.xml.indexOf('B20'))))
    assert.equal(readInlineCell(out.xml, 'B20'), 'A&B <x>')
  })

  test('everything outside <sheetData> is byte-identical', () => {
    const out = setCellInlineString(sheet, 'B20', '0042')
    assert.ok(out.ok)
    const chrome = (xml: string) => xml.replace(/<sheetData[\s\S]*?<\/sheetData>/, '<sheetData/>')
    assert.equal(chrome(out.xml), chrome(sheet))
  })
})

// ═══ 3. The whole rewrite ════════════════════════════════════════════════════

describe('the confirmed workbook', () => {
  test('B20 carries the confirmed Order number', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok, result.ok ? '' : result.detail)
    assert.equal(readInlineCell(masterOf(result.bytes).xml, CONFIRMED_NUMBER_CELL), NUMBER)
  })

  test('THE ORIGINAL BYTES ARE UNCHANGED — this function reads, it does not write', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const copy = original.slice()
    const result = await confirm(original)
    assert.ok(result.ok)
    assert.deepEqual([...original], [...copy], 'the input array must be read-only to this module')
  })

  test('and the confirmed copy is a DIFFERENT file', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    assert.notDeepEqual([...result.bytes], [...original])
  })

  test('EVERY IMAGE SURVIVES, byte for byte', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    const before = unzipSync(original) as Record<string, Uint8Array>
    const after = masterOf(result.bytes).entries
    for (const name of ['xl/media/image1.png', 'xl/media/image2.png']) {
      assert.ok(after[name], `${name} is missing from the confirmed workbook`)
      assert.deepEqual([...after[name]], [...before[name]], `${name} changed`)
    }
  })

  test('EVERY FORMULA SURVIVES, with its cached value', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok)
    const { xml } = masterOf(result.bytes)
    assert.ok(xml.includes('<f>C32*H32</f><v>3600</v>'))
    assert.ok(xml.includes('<f>SUM(I32:I112)</f><v>3600</v>'))
    assert.equal((xml.match(/<f>/g) ?? []).length, 2)
  })

  test('merged cells survive', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok)
    const { xml } = masterOf(result.bytes)
    assert.ok(xml.includes('<mergeCells count="3">'))
    assert.ok(xml.includes('<mergeCell ref="B20:D20"/>'), 'the merge over the cell just written')
    assert.ok(xml.includes('<mergeCell ref="A1:K3"/>'))
  })

  test('hidden rows and hidden columns survive', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok)
    const { xml } = masterOf(result.bytes)
    assert.ok(xml.includes('<row r="33" hidden="1">'))
    assert.ok(xml.includes('<row r="34" hidden="1"/>'))
    assert.ok(xml.includes('<col min="5" max="5" width="18" customWidth="1" hidden="1"/>'))
  })

  test('column widths, the frozen pane and the sheet dimension survive', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok)
    const { xml } = masterOf(result.bytes)
    assert.ok(xml.includes('<col min="2" max="2" width="28.75" customWidth="1"/>'))
    assert.ok(xml.includes('state="frozen"'))
    assert.ok(xml.includes('<dimension ref="A1:K130"/>'), 'the dimension is not rewritten')
  })

  test('print settings, margins, header/footer and the print area survive', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    const { xml, entries } = masterOf(result.bytes)
    assert.ok(xml.includes('<pageSetup paperSize="9" scale="62" orientation="portrait" r:id="rIdPrint"/>'))
    assert.ok(xml.includes('<printOptions horizontalCentered="1"/>'))
    assert.ok(xml.includes('<pageMargins left="0.25"'))
    assert.ok(xml.includes('<oddFooter>'))
    assert.ok(dec.decode(entries['xl/workbook.xml']).includes('_xlnm.Print_Area'))
    // The binary printer-settings part is carried through untouched.
    const before = unzipSync(original) as Record<string, Uint8Array>
    assert.deepEqual(
      [...entries['xl/printerSettings/printerSettings1.bin']],
      [...before['xl/printerSettings/printerSettings1.bin']])
  })

  test('styles, number formats and conditional formatting survive', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    const { xml, entries } = masterOf(result.bytes)
    const before = unzipSync(original) as Record<string, Uint8Array>
    assert.deepEqual([...entries['xl/styles.xml']], [...before['xl/styles.xml']])
    assert.ok(xml.includes('<conditionalFormatting sqref="I32:I112">'))
    assert.ok(xml.includes('<dataValidations count="1">'))
  })

  test('WORKBOOK RELATIONSHIPS REMAIN VALID — every internal target resolves', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok)
    const entries = masterOf(result.bytes).entries
    for (const [relsName, bytes] of Object.entries(entries)) {
      if (!relsName.endsWith('.rels')) continue
      for (const m of dec.decode(bytes).matchAll(/Target="([^"]+)"/g)) {
        const target = m[1]
        if (/^https?:/.test(target)) continue
        const dir = relsName.replace(/_rels\/[^/]+$/, '')
        const resolved = new URL(target, `file:///${dir}`).pathname.slice(1)
        assert.ok(resolved in entries, `${relsName} points at a missing part: ${target}`)
      }
    }
  })

  test('the drawing and its two image relationships are untouched', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    const before = unzipSync(original) as Record<string, Uint8Array>
    const after = masterOf(result.bytes).entries
    for (const name of ['xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels']) {
      assert.deepEqual([...after[name]], [...before[name]], name)
    }
  })

  test('EXACTLY ONE part differs, and it is the Master worksheet', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    const before = unzipSync(original) as Record<string, Uint8Array>
    const after = masterOf(result.bytes).entries

    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(),
      'no entry was added, dropped or renamed')

    const changed = Object.keys(before).filter(name =>
      before[name].length !== after[name].length
      || before[name].some((b, i) => b !== after[name][i]))
    assert.deepEqual(changed, [result.changedPart])
    assert.ok(result.changedPart !== null, 'a real rewrite names the part it changed')
    assert.match(result.changedPart, /^xl\/worksheets\/sheet\d+\.xml$/)
    assert.equal(result.unchangedCount, Object.keys(before).length - 1)
  })

  test('shared strings and the calculation chain are untouched', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const result = await confirm(original)
    assert.ok(result.ok)
    const before = unzipSync(original) as Record<string, Uint8Array>
    const after = masterOf(result.bytes).entries
    for (const name of ['xl/sharedStrings.xml', 'xl/calcChain.xml', '[Content_Types].xml', '_rels/.rels']) {
      assert.deepEqual([...after[name]], [...before[name]], name)
    }
  })

  test('the sheet is resolved BY NAME, not by position', async () => {
    // The fixture lists relationships in reverse and puts Master second; a
    // resolver that assumed sheet1 would write into Cover.
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20, sheetNames: ['Cover', 'Master', 'Notes'] }))
    assert.ok(result.ok)
    assert.equal(result.changedPart, 'xl/worksheets/sheet2.xml')
    const entries = masterOf(result.bytes).entries
    assert.ok(!dec.decode(entries['xl/worksheets/sheet1.xml']).includes('inlineStr'),
      'the Cover sheet must not have been written to')
  })

  test('RETRY IS SAFE: two runs over the same original agree', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const a = await confirm(original)
    const b = await confirm(original)
    assert.ok(a.ok && b.ok)
    assert.equal(masterOf(a.bytes).xml, masterOf(b.bytes).xml)
    assert.equal(a.changedPart, b.changedPart)
  })

  test('a workbook whose B20 ALREADY reads the confirmed number succeeds, changing nothing', async () => {
    // A real case, not a curiosity: B20 is the template's sourceOrderNumber, so
    // it carries whatever the employee's starting file had — and once the number
    // cycle resets to 0001, a workbook already saying `0001` is entirely
    // plausible. Re-running over a copy this module produced does it too.
    const once = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(once.ok)
    assert.equal(once.changedPart, 'xl/worksheets/sheet2.xml')

    const twice = await confirm(once.bytes, NUMBER)
    assert.ok(twice.ok, twice.ok ? '' : twice.detail)
    assert.equal(twice.changedPart, null, 'nothing needed rewriting the second time')

    const xml = masterOf(twice.bytes).xml
    assert.equal(readInlineCell(xml, 'B20'), NUMBER)
    assert.equal((xml.match(/r="B20"/g) ?? []).length, 1, 'one B20 cell, not two')
    // And every part is identical to what went in.
    const before = unzipSync(once.bytes) as Record<string, Uint8Array>
    const after = masterOf(twice.bytes).entries
    for (const name of Object.keys(before)) {
      assert.deepEqual([...after[name]], [...before[name]], name)
    }
  })

  test('but a genuine no-op rewrite is still caught', async () => {
    // The relaxation above is scoped to "the cell already reads correctly". The
    // validator must still refuse a rebuild that was SUPPOSED to change a part
    // and did not.
    const original = unzipSync(buildWorkbook({ b20: DEFAULT_B20 })) as Record<string, Uint8Array>
    const names = Object.keys(original)
    const copy: Record<string, Uint8Array> = {}
    for (const k of names) copy[k] = original[k].slice()
    assert.equal(
      validateConfirmedRebuild(original, [...names], copy, [...names], 'xl/worksheets/sheet2.xml'),
      'expected_part_unchanged')
    assert.equal(
      validateConfirmedRebuild(original, [...names], copy, [...names], null),
      null, 'and passes when no change was expected')
  })

  test('a different Order number produces a different file', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20 })
    const a = await confirm(original, '0001')
    const b = await confirm(original, '0002')
    assert.ok(a.ok && b.ok)
    assert.equal(readInlineCell(masterOf(a.bytes).xml, 'B20'), '0001')
    assert.equal(readInlineCell(masterOf(b.bytes).xml, 'B20'), '0002')
  })

  test('a workbook whose B20 is missing entirely still gets one', async () => {
    const result = await confirm(buildWorkbook({ b20: undefined }))
    assert.ok(result.ok, result.ok ? '' : result.detail)
    assert.equal(readInlineCell(masterOf(result.bytes).xml, 'B20'), NUMBER)
  })

  test('the output is within the bucket\'s size limit', async () => {
    const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }))
    assert.ok(result.ok)
    assert.ok(result.bytes.length <= CONFIRMED_WORKBOOK_MAX_BYTES)
  })
})

// ═══ 4. Refusals ═════════════════════════════════════════════════════════════

describe('what it refuses, and how safely', () => {
  test('no bytes at all', async () => {
    const result = await confirm(new Uint8Array(0))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_MISSING')
  })

  test('a file that is not a ZIP', async () => {
    const result = await confirm(enc.encode('this is a PDF, actually'))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_UNREADABLE')
  })

  test('a ZIP that is not a workbook', async () => {
    const result = await confirm(zipSync({ 'notes.txt': bytesOf('hello') }))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_UNREADABLE')
  })

  test('a workbook with no Master sheet', async () => {
    const result = await confirm(buildWorkbook({ noMaster: true, sheetNames: ['Cover', 'Notes'] }))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_UNSUPPORTED')
    assert.match(result.detail, /Master/)
  })

  test('a workbook whose B20 is a formula', async () => {
    const result = await confirm(buildWorkbook({ b20Formula: true }))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_UNSUPPORTED')
  })

  test('an empty Order number', async () => {
    for (const bad of ['', '   ']) {
      const result = await confirm(buildWorkbook({ b20: DEFAULT_B20 }), bad)
      assert.ok(!result.ok, bad)
      assert.equal(result.reason, 'WORKBOOK_UNSUPPORTED')
    }
  })

  test('an oversized source is refused before it is opened', async () => {
    const result = await confirm(new Uint8Array(CONFIRMED_WORKBOOK_MAX_BYTES + 1))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_TOO_LARGE')
  })

  test('an archive carrying a traversal entry name', async () => {
    // isUnsafeEntryName refuses it during the unzip, before its bytes are
    // allocated — the same ordering the media optimiser uses.
    const result = await confirm(zipSync({
      '[Content_Types].xml': bytesOf('<Types/>'),
      '../escape.xml': bytesOf('<x/>'),
    }))
    assert.ok(!result.ok)
    assert.equal(result.reason, 'WORKBOOK_UNREADABLE')
  })

  test('a refusal NEVER carries an exception\'s own text', async () => {
    // The detail is chosen here, from a fixed vocabulary. Whatever fflate or a
    // parser threw contributes nothing to it.
    const result = await confirm(enc.encode('\x00\x01\x02 not a zip'))
    assert.ok(!result.ok)
    assert.ok(!/\bat \w+|node_modules|Error:|\/var\//.test(result.detail), result.detail)
  })
})

// ═══ 5. The safety gate itself ═══════════════════════════════════════════════

describe('validateConfirmedRebuild', () => {
  const original = unzipSync(buildWorkbook({ b20: DEFAULT_B20 })) as Record<string, Uint8Array>
  const names = Object.keys(original)
  const PART = 'xl/worksheets/sheet2.xml'

  const clone = () => {
    const out: Record<string, Uint8Array> = {}
    for (const k of names) out[k] = original[k].slice()
    return out
  }

  /** A rebuild that changed exactly the sheet, which must pass. */
  const good = () => {
    const out = clone()
    out[PART] = enc.encode(dec.decode(original[PART]).replace('<c r="A20"', '<c r="A20" '))
    return out
  }

  test('passes a rebuild that changed exactly the expected part', () => {
    assert.equal(validateConfirmedRebuild(original, [...names], good(), [...names], PART), null)
  })

  test('catches a part that should not have changed', () => {
    const bad = good()
    bad['xl/styles.xml'] = enc.encode(dec.decode(original['xl/styles.xml']) + ' ')
    assert.equal(validateConfirmedRebuild(original, [...names], bad, [...names], PART),
      'unexpected_part_modified')
  })

  test('catches a MODIFIED IMAGE specifically — a lost photograph is the worst outcome', () => {
    const bad = good()
    bad['xl/media/image1.png'] = fakeImage(3)
    assert.equal(validateConfirmedRebuild(original, [...names], bad, [...names], PART), 'media_modified')
  })

  test('catches a dropped entry', () => {
    const bad = good()
    delete bad['xl/media/image2.png']
    const badNames = names.filter(n => n !== 'xl/media/image2.png')
    assert.equal(validateConfirmedRebuild(original, [...names], bad, badNames, PART), 'entry_count_changed')
  })

  test('catches an added entry', () => {
    const bad = good()
    bad['xl/extra.xml'] = bytesOf('<x/>')
    assert.equal(validateConfirmedRebuild(original, [...names], bad, [...names, 'xl/extra.xml'], PART),
      'entry_count_changed')
  })

  test('catches a renamed entry', () => {
    const bad = good()
    const badNames = [...names]
    badNames[badNames.indexOf('xl/media/image1.png')] = 'xl/media/renamed.png'
    bad['xl/media/renamed.png'] = bad['xl/media/image1.png']
    delete bad['xl/media/image1.png']
    assert.equal(validateConfirmedRebuild(original, [...names], bad, badNames, PART), 'entry_names_changed')
  })

  test('catches a rewrite that did NOTHING — the failure nobody would see', () => {
    assert.equal(validateConfirmedRebuild(original, [...names], clone(), [...names], PART),
      'expected_part_unchanged')
  })

  test('catches a LOST FORMULA', () => {
    const bad = clone()
    bad[PART] = enc.encode(dec.decode(original[PART]).replace('<f>C32*H32</f>', ''))
    assert.equal(validateConfirmedRebuild(original, [...names], bad, [...names], PART),
      'formula_count_changed')
  })

  test('catches a broken relationship', () => {
    const bad = good()
    bad['xl/drawings/_rels/drawing1.xml.rels'] = bytesOf(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/gone.png"/>`
      + `</Relationships>`)
    // The rels part changing is itself caught first, which is correct — but the
    // relationship check is what catches it when the CHANGED part is the sheet.
    const viaRels = validateConfirmedRebuild(original, [...names], bad, [...names], PART)
    assert.ok(viaRels === 'unexpected_part_modified' || viaRels === 'broken_relationship')

    const bad2 = good()
    bad2['xl/media/image1.png'] = original['xl/media/image1.png']
    const dropped = names.filter(n => n !== 'xl/media/image1.png')
    delete bad2['xl/media/image1.png']
    assert.equal(
      validateConfirmedRebuild(original, dropped, bad2, dropped, PART),
      'broken_relationship')
  })

  test('catches an unsafe entry name in the rebuild', () => {
    const bad = good()
    bad['../escape.xml'] = bytesOf('<x/>')
    assert.equal(validateConfirmedRebuild(original, [...names], bad, [...names, '../escape.xml'], PART),
      'unsafe_entry_name')
  })

  test('catches a changed sheet NAME', () => {
    const bad = good()
    bad['xl/workbook.xml'] = enc.encode(dec.decode(original['xl/workbook.xml']).replace('name="Notes"', 'name="Other"'))
    // workbook.xml is not the expected part, so this is caught as a modification
    // — which is the stronger answer.
    assert.equal(validateConfirmedRebuild(original, [...names], bad, [...names], PART),
      'unexpected_part_modified')
  })
})

// ══ 9. A correction made on the record reaches the confirmed Excel ═══════════
//
// `Edit PI Details` can fix a phone number or an address without replacing the
// workbook. Before this, the confirmed Excel was the stored file with ONE cell
// filled in, so it still carried the value that was corrected — a document
// contradicting the record it came from, with nothing on either saying which is
// right.
//
// What must stay true while that changes: the workbook's own formulas are still
// formulas, the photographs are still the same bytes, exactly one part moves,
// and nothing commercial is writable at all.

describe('the record’s corrections reach the confirmed workbook', () => {
  const CORRECTIONS = {
    bill_to_name: 'Acme Interiors Pvt Ltd',
    bill_to_phone: '+91 98765 43210',
    billing_address: '12 Residency Road\nBengaluru 560025',
    ship_to_name: 'Acme Warehouse',
    contact_number: '+91 80 4123 0000',
    bill_to_gst: '29ABCDE1234F1Z5',
  }

  const built = async (over: Parameters<typeof buildWorkbook>[0] = {},
                       corrections: Record<string, string | null> = CORRECTIONS) =>
    buildConfirmedWorkbook({
      bytes: buildWorkbook({ b20: DEFAULT_B20, partyRows: true, ...over }),
      orderNumber: NUMBER,
      corrections: corrections as never,
    })

  test('every corrected value reads back out of the produced file', async () => {
    const result = await built()
    assert.equal(result.ok, true, result.ok ? '' : `${result.reason}: ${result.detail}`)
    if (!result.ok) return
    const { xml } = masterOf(result.bytes)
    for (const [field, value] of Object.entries(CORRECTIONS)) {
      const ref = CONFIRMED_EDITABLE_CELLS[field as keyof typeof CONFIRMED_EDITABLE_CELLS]
      assert.equal(readInlineCell(xml, ref), value, `${field} did not land in ${ref}`)
    }
    // And the Order number is still there — the whole reason this module exists.
    assert.equal(readInlineCell(xml, CONFIRMED_NUMBER_CELL), NUMBER)
  })

  test('the workbook’s formulas are still formulas', async () => {
    // The safety gate counts them, and a correction that clobbered one would
    // also leave calcChain.xml naming a cell that no longer computes.
    const result = await built()
    assert.equal(result.ok, true)
    if (!result.ok) return
    const { xml } = masterOf(result.bytes)
    assert.ok(xml.includes('<f>C32*H32</f>'), 'the line total formula survived')
    assert.ok(xml.includes('<f>SUM(I32:I112)</f>'), 'the subtotal formula survived')
  })

  test('exactly one part changed, and the photographs are byte-identical', async () => {
    const original = buildWorkbook({ b20: DEFAULT_B20, partyRows: true })
    const result = await buildConfirmedWorkbook({
      bytes: original, orderNumber: NUMBER, corrections: CORRECTIONS as never,
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.unchangedCount, Object.keys(unzipSync(original)).length - 1,
      'however many cells moved, one part moved')

    const before = unzipSync(original) as Record<string, Uint8Array>
    const after = unzipSync(result.bytes) as Record<string, Uint8Array>
    for (const name of Object.keys(before)) {
      if (name === result.changedPart) continue
      assert.deepEqual(after[name], before[name], `${name} was rewritten`)
    }
  })

  test('a field outside the template contract is REFUSED, not ignored', async () => {
    // Silently dropping it would publish a document missing a correction that
    // nobody was told had been dropped.
    for (const field of ['grand_total', 'discount_amount', 'client_name',
                         'payment_terms', 'due_date', 'order_confirmation_date']) {
      const result = await built({}, { [field]: 'anything' })
      assert.equal(result.ok, false, `${field} was accepted`)
      if (result.ok) continue
      assert.match(result.detail, new RegExp(field))
      assert.match(result.detail, /not a cell this template establishes/)
    }
  })

  test('null and absent leave the cell exactly as the workbook had it', async () => {
    const untouched = await built({}, {})
    const withNulls = await built({}, { bill_to_name: null, contact_number: null })
    assert.equal(untouched.ok, true)
    assert.equal(withNulls.ok, true)
    if (!untouched.ok || !withNulls.ok) return
    // Both produce a file whose Master differs from the other only by nothing:
    // absent and null are the same instruction.
    assert.equal(masterOf(untouched.bytes).xml, masterOf(withNulls.bytes).xml)
    // And B25 is still the shared string it started as, never rewritten inline.
    assert.equal(readInlineCell(masterOf(untouched.bytes).xml, 'B25'), null)
  })

  test('an empty string CLEARS the cell, which is not the same as null', async () => {
    const result = await built({}, { bill_to_phone: '' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(readInlineCell(masterOf(result.bytes).xml, 'B26'), '')
  })

  test('a formula in a correction target refuses the whole document', async () => {
    // Publishing it with that one correction quietly missing would be worse
    // than not publishing: the reader would have no way to know.
    const result = await built({ billToNameFormula: true })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.detail, /bill_to_name \(B25\)/)
  })

  test('nothing commercial is writable, at all', async () => {
    // The honest guard is not offering these rather than relying on the
    // formula refusal downstream — a commercial cell that happened to hold a
    // literal would otherwise be writable.
    const refs = new Set(CONFIRMED_WRITABLE_REFS)
    for (const commercial of ['I115', 'I116', 'I117', 'I118', 'I119', 'I120', 'I121', 'I122', 'G115']) {
      assert.ok(!refs.has(commercial), `${commercial} must never be writable`)
    }
    assert.equal(refs.size, Object.keys(CONFIRMED_EDITABLE_CELLS).length + 1,
      'the writable set is the editable cells plus the Order number, and nothing else')
  })

  test('every editable cell is one the parser already reads', async () => {
    // THE CONTRACT. A cell this system has never read is a cell it has no
    // business writing — the reference a correction writes to must be the same
    // reference the import read from, or the two disagree about where a value
    // lives and no test would notice.
    const parser = readFileSync(
      join(process.cwd(), 'src/lib/pi/masterSheetParser.ts'), 'utf8')
    const header = parser.slice(parser.indexOf('const HEADER_CELLS'),
                                parser.indexOf('const COMMERCIAL_CELLS'))
    const known = new Set([...header.matchAll(/'([A-Z]+\d+)'/g)].map(m => m[1]))
    for (const ref of Object.values(CONFIRMED_EDITABLE_CELLS)) {
      assert.ok(known.has(ref), `${ref} is not a HEADER_CELLS reference`)
    }
    assert.ok(known.has(CONFIRMED_NUMBER_CELL))
  })

  test('a correction survives when its row does not exist yet', async () => {
    // A workbook that never carried a ship-to GST has no row 27 cell for it.
    // The row is created in ascending order rather than appended, or Excel
    // reports the file as needing repair.
    const result = await built({ partyRows: false })
    assert.equal(result.ok, true, result.ok ? '' : result.detail)
    if (!result.ok) return
    const { xml } = masterOf(result.bytes)
    assert.equal(readInlineCell(xml, 'B25'), CORRECTIONS.bill_to_name)
    const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map(m => Number(m[1]))
    assert.deepEqual(rows, [...rows].sort((a, b) => a - b), 'rows stayed in ascending order')
  })
})
