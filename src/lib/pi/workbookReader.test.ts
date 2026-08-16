/**
 * The archive and cell layer beneath the PI parser.
 *
 * WHAT THESE TESTS DEFEND: that the raw material the parser reasons about is
 * read correctly — shared strings including rich-text runs, XML entities, cell
 * types, formulas with and without a stored result, hidden rows and columns,
 * sheet resolution through relationships rather than by filename, and the
 * resource ceilings that make an untrusted workbook safe to open.
 *
 * Everything here is offline and pure. No file is written, no network is
 * touched, and no database client exists in this module's import graph.
 *
 * Run:
 *   npx tsx --test src/lib/pi/workbookReader.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import {
  openPiArchive,
  readSharedStrings,
  readSheet,
  resolveSheetPart,
  relationshipMap,
  relationshipTarget,
  relsPathFor,
  partText,
  decodeXml,
  normalizeCellText,
  normalizeLabel,
  columnToIndex,
  indexToColumn,
  cellRef,
  excelSerialToIso,
  numberToPlainText,
  PI_MAX_WORKBOOK_BYTES,
} from './workbookReader'

const enc = new TextEncoder()
const bytesOf = (s: string) => enc.encode(s)

// ── Pure string helpers ───────────────────────────────────────────────────────

describe('decodeXml', () => {
  test('decodes the five predefined entities', () => {
    assert.equal(decodeXml('a &lt; b &gt; c &quot;d&quot; &apos;e&apos; &amp; f'), `a < b > c "d" 'e' & f`)
  })

  test('decodes &amp; last, so &amp;lt; stays the literal text &lt;', () => {
    assert.equal(decodeXml('&amp;lt;'), '&lt;')
  })

  test('decodes decimal and hexadecimal character references', () => {
    assert.equal(decodeXml('&#65;&#x42;'), 'AB')
  })

  test('drops Excel _x000D_ escapes but keeps the newline beside them', () => {
    assert.equal(decodeXml('line one_x000D_\nline two'), 'line one\nline two')
  })

  test('an out-of-range character reference is dropped rather than thrown', () => {
    assert.equal(decodeXml('a&#1114112;b'), 'ab')
  })
})

describe('normalizeCellText', () => {
  test('keeps internal line breaks — a dimensions cell is multi-line on purpose', () => {
    assert.equal(
      normalizeCellText('  Standard Dimensions \n   Three Seater - 72"  '),
      'Standard Dimensions\nThree Seater - 72"',
    )
  })

  test('collapses horizontal whitespace runs inside a line', () => {
    assert.equal(normalizeCellText('Teak   Wood\t\tFrame'), 'Teak Wood Frame')
  })

  test('drops blank lines at either end but keeps one in the middle', () => {
    assert.equal(normalizeCellText('\n\nfirst\n\nsecond\n\n'), 'first\n\nsecond')
  })

  test('a whitespace-only cell is null, never an empty string', () => {
    assert.equal(normalizeCellText('   \n\t  '), null)
    assert.equal(normalizeCellText(''), null)
  })
})

describe('normalizeLabel', () => {
  test('folds case and every kind of whitespace into one comparable form', () => {
    assert.equal(
      normalizeLabel('Dimension  in\ninches\t& Shape '),
      'dimension in inches & shape',
    )
  })
})

// ── Addresses ─────────────────────────────────────────────────────────────────

describe('column addressing', () => {
  test('maps single and double letters both ways', () => {
    assert.equal(columnToIndex('A'), 0)
    assert.equal(columnToIndex('E'), 4)
    assert.equal(columnToIndex('K'), 10)
    assert.equal(columnToIndex('AA'), 26)
    assert.equal(indexToColumn(0), 'A')
    assert.equal(indexToColumn(10), 'K')
    assert.equal(indexToColumn(26), 'AA')
  })

  test('rejects anything that is not letters', () => {
    assert.equal(columnToIndex('A1'), -1)
    assert.equal(columnToIndex(''), -1)
  })

  test('cellRef composes the address the template constants use', () => {
    assert.equal(cellRef(4, 32), 'E32')
    assert.equal(cellRef(8, 115), 'I115')
  })
})

// ── Dates and numbers ─────────────────────────────────────────────────────────

describe('excelSerialToIso', () => {
  test('converts a modern date serial', () => {
    // 45000 is 2023-03-15 in the 1900 system.
    assert.equal(excelSerialToIso(45000), '2023-03-15')
  })

  test('keeps only the date part of a serial that carries a time', () => {
    assert.equal(excelSerialToIso(45000.75), '2023-03-15')
  })

  test('refuses the 1900 leap-year-bug range rather than guessing', () => {
    assert.equal(excelSerialToIso(1), null)
    assert.equal(excelSerialToIso(60), null)
  })

  test('refuses non-finite and out-of-range values', () => {
    assert.equal(excelSerialToIso(NaN), null)
    assert.equal(excelSerialToIso(-5), null)
    assert.equal(excelSerialToIso(9e12), null)
  })
})

describe('numberToPlainText', () => {
  test('never renders a phone number in exponent notation', () => {
    assert.equal(numberToPlainText(9876543210), '9876543210')
  })

  test('keeps a decimal as written', () => {
    assert.equal(numberToPlainText(1234.5), '1234.5')
  })
})

// ── Shared strings ────────────────────────────────────────────────────────────

describe('readSharedStrings', () => {
  const table = (inner: string) => ({
    'xl/sharedStrings.xml': bytesOf(`<?xml version="1.0"?><sst>${inner}</sst>`),
  })

  test('reads plain strings in declaration order', () => {
    const out = readSharedStrings(table('<si><t>Code</t></si><si><t>Name</t></si>'))
    assert.deepEqual(out, ['Code', 'Name'])
  })

  test('concatenates rich-text runs into one value', () => {
    const out = readSharedStrings(table('<si><r><t>Cost per </t></r><r><t>piece (INR)</t></r></si>'))
    assert.deepEqual(out, ['Cost per piece (INR)'])
  })

  test('ignores phonetic guide runs, which also contain <t>', () => {
    const out = readSharedStrings(table('<si><t>Material</t><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si>'))
    assert.deepEqual(out, ['Material'])
  })

  test('preserves whitespace declared with xml:space', () => {
    const out = readSharedStrings(table('<si><t xml:space="preserve">Dimension in inches &amp; Shape</t></si>'))
    assert.deepEqual(out, ['Dimension in inches & Shape'])
  })

  test('an absent table is an empty list, not a throw', () => {
    assert.deepEqual(readSharedStrings({}), [])
  })
})

// ── Sheet cells ───────────────────────────────────────────────────────────────

const SHEET = `<?xml version="1.0"?>
<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>
    <col min="1" max="9" width="10" customWidth="1"/>
    <col min="10" max="10" width="10" hidden="1" customWidth="1"/>
    <col min="11" max="16384" width="9"/>
  </cols>
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="str"><f>CONCAT(1)</f><v>literal</v></c></row>
    <row r="2" hidden="1"><c r="A2"><v>42</v></c></row>
    <row r="3"><c r="A3"><f>SUM(A1:A2)</f></c><c r="B3"><f>SUM(A1:A2)</f><v/></c></row>
    <row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" t="e"><v>#DIV/0!</v></c><c r="C4" s="3"/></row>
    <row r="5"><c r="A5" t="inlineStr"><is><t>inline value</t></is></c></row>
    <row r="6"/>
  </sheetData>
</worksheet>`

describe('readSheet', () => {
  const sheet = readSheet(SHEET, ['shared value'])

  test('resolves a shared-string cell through the table', () => {
    assert.equal(sheet.cells.get('A1')?.text, 'shared value')
    assert.equal(sheet.cells.get('A1')?.type, 'string')
  })

  test('reads a formula string result and records that it has one', () => {
    const b1 = sheet.cells.get('B1')
    assert.equal(b1?.text, 'literal')
    assert.equal(b1?.hasFormula, true)
    assert.equal(b1?.hasCachedValue, true)
  })

  test('reads a plain number', () => {
    assert.equal(sheet.cells.get('A2')?.number, 42)
    assert.equal(sheet.cells.get('A2')?.type, 'number')
  })

  test('a formula with no <v> is reported as having no cached value', () => {
    const a3 = sheet.cells.get('A3')
    assert.equal(a3?.hasFormula, true)
    assert.equal(a3?.hasCachedValue, false)
    assert.equal(a3?.number, null)
  })

  test('an EMPTY <v/> is not a cached value — it must not read as 0', () => {
    const b3 = sheet.cells.get('B3')
    assert.equal(b3?.hasFormula, true)
    assert.equal(b3?.hasCachedValue, false)
    assert.equal(b3?.number, null)
    assert.equal(b3?.type, 'empty')
  })

  test('reads booleans, errors, styled-but-empty cells and inline strings', () => {
    assert.equal(sheet.cells.get('A4')?.text, 'TRUE')
    assert.equal(sheet.cells.get('B4')?.text, '#DIV/0!')
    assert.equal(sheet.cells.get('B4')?.type, 'error')
    assert.equal(sheet.cells.get('C4')?.type, 'empty')
    assert.equal(sheet.cells.get('A5')?.text, 'inline value')
  })

  test('collects hidden rows and hidden columns', () => {
    assert.equal(sheet.hiddenRows.has(2), true)
    assert.equal(sheet.hiddenRows.has(1), false)
    // Column J is index 9 — the sequence column the BOE template hides.
    assert.equal(sheet.hiddenCols.has(9), true)
    assert.equal(sheet.hiddenCols.has(8), false)
  })

  test('records cell coordinates as 1-based row and 0-based column', () => {
    const a1 = sheet.cells.get('A1')
    assert.equal(a1?.row, 1)
    assert.equal(a1?.col, 0)
  })

  test('a self-closing row contributes no cells and does not throw', () => {
    assert.equal(sheet.maxRow, 6)
  })
})

// ── Relationships ─────────────────────────────────────────────────────────────

describe('relationships', () => {
  const rels = `<Relationships>
    <Relationship Id="rId3" Target="worksheets/sheet3.xml"/>
    <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rIdX" Target="https://example.invalid/x" TargetMode="External"/>
  </Relationships>`

  test('finds a target by id regardless of declaration order', () => {
    assert.equal(relationshipTarget(rels, 'rId3'), 'worksheets/sheet3.xml')
    assert.equal(relationshipTarget(rels, 'rId1'), 'worksheets/sheet1.xml')
  })

  test('skips external relationships — they have no bytes in the package', () => {
    assert.equal(relationshipTarget(rels, 'rIdX'), null)
    assert.equal(relationshipMap(rels).has('rIdX'), false)
    assert.equal(relationshipMap(rels).size, 2)
  })

  test('an unknown id is null', () => {
    assert.equal(relationshipTarget(rels, 'rId9'), null)
  })

  test('relsPathFor puts the .rels beside its part', () => {
    assert.equal(relsPathFor('xl/worksheets/sheet1.xml'), 'xl/worksheets/_rels/sheet1.xml.rels')
    assert.equal(relsPathFor('xl/drawings/drawing1.xml'), 'xl/drawings/_rels/drawing1.xml.rels')
  })
})

describe('resolveSheetPart', () => {
  const workbook = (sheets: string) => ({
    'xl/workbook.xml': bytesOf(`<workbook><sheets>${sheets}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': bytesOf(`<Relationships>
      <Relationship Id="rId3" Target="worksheets/sheet3.xml"/>
      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    </Relationships>`),
    'xl/worksheets/sheet1.xml': bytesOf('<worksheet/>'),
    'xl/worksheets/sheet3.xml': bytesOf('<worksheet/>'),
  })

  test('follows the relationship rather than assuming sheet1.xml', () => {
    const out = resolveSheetPart(
      workbook('<sheet name="Cover" sheetId="1" r:id="rId1"/><sheet name="Master" sheetId="3" r:id="rId3"/>'),
      'Master',
    )
    assert.equal(out.ok, true)
    assert.equal(out.ok && out.part, 'xl/worksheets/sheet3.xml')
    assert.deepEqual(out.sheetNames, ['Cover', 'Master'])
  })

  test('matches the sheet name EXACTLY — case and padding are different sheets', () => {
    const out = resolveSheetPart(
      workbook('<sheet name="master" sheetId="1" r:id="rId1"/>'),
      'Master',
    )
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'MASTER_SHEET_MISSING')
  })

  test('decodes an entity in a sheet name', () => {
    const out = resolveSheetPart(
      workbook('<sheet name="A&amp;B" sheetId="1" r:id="rId1"/>'),
      'A&B',
    )
    assert.equal(out.ok, true)
  })

  test('a declared sheet whose part is absent is unreadable, not missing', () => {
    const entries = workbook('<sheet name="Master" sheetId="9" r:id="rId9"/>')
    const out = resolveSheetPart(entries, 'Master')
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'MASTER_SHEET_UNREADABLE')
  })
})

// ── Archive ───────────────────────────────────────────────────────────────────

const MINIMAL_PARTS: Record<string, Uint8Array> = {
  '[Content_Types].xml': bytesOf('<Types/>'),
  '_rels/.rels': bytesOf('<Relationships/>'),
  'xl/workbook.xml': bytesOf('<workbook/>'),
  'xl/_rels/workbook.xml.rels': bytesOf('<Relationships/>'),
  'xl/worksheets/sheet1.xml': bytesOf('<worksheet/>'),
}

describe('openPiArchive', () => {
  test('opens a well-formed minimal package', async () => {
    const out = await openPiArchive(zipSync({ ...MINIMAL_PARTS }))
    assert.equal(out.ok, true)
    assert.equal(out.ok && partText(out.archive.entries, 'xl/workbook.xml'), '<workbook/>')
  })

  test('refuses anything over 10 MiB BEFORE unzipping it', async () => {
    const oversized = new Uint8Array(PI_MAX_WORKBOOK_BYTES + 1)
    const out = await openPiArchive(oversized)
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'INPUT_TOO_LARGE')
  })

  test('the limit is exactly the 10 MiB the storage bucket enforces', () => {
    assert.equal(PI_MAX_WORKBOOK_BYTES, 10 * 1024 * 1024)
    assert.equal(PI_MAX_WORKBOOK_BYTES, 10485760)
  })

  test('refuses bytes that are not a ZIP at all', async () => {
    const out = await openPiArchive(bytesOf('this is a PDF, honestly'))
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'INVALID_ZIP')
  })

  test('refuses an empty input', async () => {
    const out = await openPiArchive(new Uint8Array(0))
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'INVALID_ZIP')
  })

  test('refuses a legacy .xls — this parser is .xlsx only', async () => {
    // The OLE2 compound-document signature every BIFF8 .xls begins with. It is
    // not a ZIP, so there is no package to walk: a legacy workbook has to be
    // saved as .xlsx before it can be imported, exactly as the Order Request
    // attachment rules already require.
    const ole2 = new Uint8Array(512)
    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
    const out = await openPiArchive(ole2)
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'INVALID_ZIP')
  })

  test('refuses an entry name that escapes the package', async () => {
    const out = await openPiArchive(zipSync({ ...MINIMAL_PARTS, '../escape.xml': bytesOf('x') }))
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'UNSAFE_ENTRY_NAME')
  })

  test('refuses an absolute entry name', async () => {
    const out = await openPiArchive(zipSync({ ...MINIMAL_PARTS, '/etc/passwd': bytesOf('x') }))
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'UNSAFE_ENTRY_NAME')
  })

  test('refuses a package missing the parts every workbook must have', async () => {
    const { 'xl/workbook.xml': _dropped, ...rest } = MINIMAL_PARTS
    const out = await openPiArchive(zipSync({ ...rest }))
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'MISSING_WORKBOOK_PARTS')
  })

  test('refuses a package with no worksheet part', async () => {
    const { 'xl/worksheets/sheet1.xml': _dropped, ...rest } = MINIMAL_PARTS
    const out = await openPiArchive(zipSync({ ...rest }))
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'MISSING_WORKBOOK_PARTS')
  })

  test('refuses a highly compressible payload — the zip-bomb ratio guard', async () => {
    // 8 MB of zeros deflates to a few kilobytes: a ratio far past the ceiling.
    const bomb = zipSync({ ...MINIMAL_PARTS, 'xl/bomb.bin': new Uint8Array(8 * 1024 * 1024) })
    const out = await openPiArchive(bomb)
    assert.equal(out.ok, false)
    assert.equal(!out.ok && out.reason, 'DECOMPRESSED_TOO_LARGE')
  })

  test('does not modify the caller’s bytes', async () => {
    const zipped = zipSync({ ...MINIMAL_PARTS })
    const before = Uint8Array.from(zipped)
    await openPiArchive(zipped)
    assert.deepEqual(Array.from(zipped), Array.from(before))
  })
})
