/**
 * The BOE Proforma Invoice parser, end to end.
 *
 * WHAT THESE TESTS DEFEND
 * -----------------------
 *   * The Master sheet is found through workbook RELATIONSHIPS, not by assuming
 *     a filename, and a workbook without one is refused rather than guessed at.
 *   * A workbook whose row 31 is not the BOE template is BLOCKED, never silently
 *     mapped onto whatever columns happen to be present.
 *   * Genuine products are separated from the eighty empty slots the template
 *     ships with, for any number of products.
 *   * Material and Customization stay in separate fields.
 *   * I115 is the discount whatever the label above it says, and the discount is
 *     subtracted exactly once.
 *   * Product photographs are matched to rows through DrawingML anchors in
 *     column E — both anchor kinds — while logos and footer artwork are ignored.
 *   * Every disagreement between the workbook's own numbers and ours is reported
 *     as a warning, and the workbook's figure is what comes back.
 *   * The caller's bytes are never modified.
 *
 * FIXTURES ARE SYNTHETIC AND INVENTED. Every workbook in this file is built in
 * process with fflate from made-up product names, quantities and prices. No real
 * BOE workbook, client name, address, contact detail, price or photograph is
 * committed to this repository or read by these tests. The layout they imitate —
 * header block at rows 20–28, headers at row 31, eighty product slots from row
 * 32, commercial footer at rows 115–122 — is the template's structure, which is
 * not confidential.
 *
 * Offline and pure: no network, no filesystem, no database.
 *
 * Run:
 *   npx tsx --test src/lib/pi/masterSheetParser.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import {
  parseBoePiWorkbook,
  isNotApplicableMarker,
  isIncludedMarker,
  TEMPLATE_HEADERS,
  FIRST_PRODUCT_ROW,
  LAST_PRODUCT_ROW,
  MONEY_EPSILON,
} from './masterSheetParser'
import { parseDrawingAnchors, harvestProductImages, resolveDrawingPart } from './drawingAnchors'
import { openPiArchive, PI_MAX_WORKBOOK_BYTES } from './workbookReader'
import type { PiBlockingIssueCode, PiParseResult, PiWarningCode } from './types'

const enc = new TextEncoder()
const bytesOf = (s: string) => enc.encode(s)

// ── Fixture builder ───────────────────────────────────────────────────────────
// Produces a real .xlsx ZIP with the parts the parser walks: content types,
// package rels, workbook + rels, one worksheet per sheet name, shared strings,
// a drawing part with its rels, and media. Everything is invented.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIG = [0xff, 0xd8, 0xff]

/** Deterministic bytes carrying a real image signature, so format sniffing has
 *  something honest to sniff. */
function fakeImage(signature: readonly number[], size = 64, seed = 1): Uint8Array {
  const b = new Uint8Array(size)
  b.set(signature, 0)
  let x = seed >>> 0
  for (let i = signature.length; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    b[i] = x & 0xff
  }
  return b
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

type CellSpec =
  | { kind: 'num'; value: number; formula?: string }
  | { kind: 'text'; value: string }
  /** A formula whose cached result is a STRING (t="str"), which is how Excel
   *  stores IF(...,"-",...) — the shape one production workbook uses for a
   *  fabric cost of nothing. */
  | { kind: 'formulaStr'; value: string; formula: string }
  /** A formula the workbook never evaluated: <f> present, no <v>. */
  | { kind: 'formulaNoCache'; formula: string }

const num = (value: number, formula?: string): CellSpec => ({ kind: 'num', value, formula })
const text = (value: string): CellSpec => ({ kind: 'text', value })
const noCache = (formula: string): CellSpec => ({ kind: 'formulaNoCache', formula })

type ProductFixture = {
  code?: string
  name?: string
  quantity?: number
  dimensions?: string
  material?: string
  cost?: number
  /** Defaults to quantity × cost. Pass a number to force a mismatch, or
   *  'noCache' for a formula the workbook never stored a result for. */
  total?: number | 'noCache'
  sequence?: string
  customization?: string
  /** Text typed into column E. Must never be mistaken for the picture. */
  imageText?: string
}

type AnchorFixture = {
  kind: 'one' | 'two'
  /** 0-based column. 4 is E. */
  col: number
  /** 1-based worksheet row. */
  row: number
  /** Media leaf name, e.g. 'image1.png'. */
  media?: string
  /** false builds a shape anchor instead of a picture. */
  picture?: boolean
  /** Raw relationship target override, for unsafe-path cases. */
  rawTarget?: string
}

type FixtureOptions = {
  sheetNames?: string[]
  masterIndex?: number
  /** Replace or remove row-31 labels to break the fingerprint. */
  headerOverrides?: Record<string, string | null>
  products?: ProductFixture[]
  /** Extra cells anywhere on the Master sheet, by address. null removes one. */
  extraCells?: Record<string, CellSpec | null>
  /** Commercial footer overrides by address (I115…I122, G115). */
  commercial?: Record<string, CellSpec | null>
  anchors?: AnchorFixture[]
  media?: Record<string, Uint8Array>
  includeDrawing?: boolean
  /** Extra archive entries, for package-level tests. */
  extraParts?: Record<string, Uint8Array>
}

const DEFAULT_HEADER_BLOCK: Record<string, CellSpec> = {
  A20: text('Order no:-'),
  B20: num(407),
  F20: text('Date of Creation:'),
  G20: num(45000),
  F21: text('Created By:'),
  G21: text('Sample Employee'),
  A22: text('GST:'),
  B22: text('00AAAAA0000A0Z0'),
  F22: text('Contact no:'),
  G22: num(9000000001),
  A24: text('BILL TO:'),
  F24: text('SHIP TO:'),
  A25: text('Name:'),
  B25: text('Example Buyer Ltd'),
  F25: text('Name:'),
  G25: text('Example Site Office'),
  A26: text('Phone:'),
  B26: num(9000000002),
  F26: text('Phone:'),
  G26: num(9000000003),
  A27: text('GST:'),
  B27: text('11BBBBB1111B1Z1'),
  G27: text('22CCCCC2222C2Z2'),
  A28: text('Billing Address:'),
  B28: text('1 Invented Road\nSample City'),
  F28: text('Shipping Address:'),
  G28: text('2 Fictional Lane\nSample City'),
  A113: num(45010),
  E112: text('Dispatch Date Finalized:'),
  E113: text('6 weeks from date of confirmation'),
}

const DEFAULT_COMMERCIAL: Record<string, CellSpec> = {
  G115: text('Design Fees'),
  G116: text('Sub Total'),
  I116: num(0, 'SUM(I32:I111)-I115'),
  G117: text('(A) Total Fabric Cost (As per Actual)'),
  I117: num(5000),
  G118: text('(B) Total Packing Cost (As per Actual)'),
  I118: num(2500),
  G119: text('(C) Transportation(As per Actual)'),
  I119: text('as applicable'),
  G120: text('Total'),
  I120: num(0, 'I116+I117+I118'),
  G121: text('GST @ 18%'),
  I121: num(0, 'I120*0.18'),
  G122: text('Grand Total'),
  I122: num(0, 'I120+I121'),
}

function buildPiWorkbook(opts: FixtureOptions = {}): Uint8Array {
  const sheetNames = opts.sheetNames ?? ['Cover', 'Fabric and Finish', 'Master']
  const masterIndex = opts.masterIndex ?? sheetNames.indexOf('Master')
  const includeDrawing = opts.includeDrawing ?? true
  const products = opts.products ?? []

  // ── shared strings ──
  const sharedStrings: string[] = []
  const sharedIndex = new Map<string, number>()
  const share = (value: string): number => {
    const existing = sharedIndex.get(value)
    if (existing !== undefined) return existing
    const idx = sharedStrings.length
    sharedStrings.push(value)
    sharedIndex.set(value, idx)
    return idx
  }

  // ── cells ──
  const cells = new Map<string, CellSpec>()
  const put = (address: string, spec: CellSpec | null) => {
    if (spec === null) cells.delete(address)
    else cells.set(address, spec)
  }

  for (const [address, spec] of Object.entries(DEFAULT_HEADER_BLOCK)) put(address, spec)

  // Row 31 — the fingerprint row.
  for (const { cell, expected } of TEMPLATE_HEADERS) put(cell, text(expected))
  for (const [address, value] of Object.entries(opts.headerOverrides ?? {})) {
    put(address, value === null ? null : text(value))
  }

  // Product band: a fixture per genuine row, an unused template row otherwise.
  const hiddenRows = new Set<number>()
  for (let i = 0; i < LAST_PRODUCT_ROW - FIRST_PRODUCT_ROW + 1; i++) {
    const row = FIRST_PRODUCT_ROW + i
    const sequence = `B${String(i + 1).padStart(3, '0')}`
    const product = products[i]

    if (!product) {
      // An unused slot: exactly what the real template leaves behind — a
      // formula-derived code, a formula line total, a pre-filled sequence, and
      // the row hidden.
      hiddenRows.add(row)
      put(`A${row}`, { kind: 'num', value: 0, formula: `$B$20&"-"&J${row}` })
      put(`I${row}`, num(0, `C${row}*H${row}`))
      put(`J${row}`, text(sequence))
      continue
    }

    put(`A${row}`, text(product.code ?? `407-${sequence}`))
    if (product.name !== undefined) put(`B${row}`, text(product.name))
    if (product.quantity !== undefined) put(`C${row}`, num(product.quantity))
    if (product.dimensions !== undefined) put(`D${row}`, text(product.dimensions))
    if (product.imageText !== undefined) put(`E${row}`, text(product.imageText))
    if (product.material !== undefined) put(`G${row}`, text(product.material))
    if (product.cost !== undefined) put(`H${row}`, num(product.cost))

    const formula = `C${row}*H${row}`
    if (product.total === 'noCache') {
      put(`I${row}`, noCache(formula))
    } else {
      const total = product.total ?? (product.quantity ?? 0) * (product.cost ?? 0)
      put(`I${row}`, num(total, formula))
    }
    put(`J${row}`, text(product.sequence ?? sequence))
    if (product.customization !== undefined) put(`K${row}`, text(product.customization))
  }

  // Commercial footer, with the sub total defaulted to the honest figure.
  for (const [address, spec] of Object.entries(DEFAULT_COMMERCIAL)) put(address, spec)
  // Mirrors how the parser derives grossProductAmount — the stored line total
  // when there is one, otherwise quantity × cost — so a fixture is internally
  // consistent by default and a SUBTOTAL_MISMATCH only ever appears in a test
  // that deliberately asks for one.
  const grossDefault = products.reduce((sum, p) => {
    if (typeof p.total === 'number') return sum + p.total
    return sum + (p.quantity ?? 0) * (p.cost ?? 0)
  }, 0)
  put('I116', num(grossDefault, 'SUM(I32:I111)-I115'))
  for (const [address, spec] of Object.entries(opts.commercial ?? {})) put(address, spec)
  for (const [address, spec] of Object.entries(opts.extraCells ?? {})) put(address, spec)

  // ── worksheet XML ──
  const byRow = new Map<number, string[]>()
  for (const [address, spec] of cells) {
    const row = Number(/\d+$/.exec(address)?.[0])
    let xml: string
    if (spec.kind === 'text') {
      xml = `<c r="${address}" t="s"><v>${share(spec.value)}</v></c>`
    } else if (spec.kind === 'formulaStr') {
      xml = `<c r="${address}" t="str"><f>${esc(spec.formula)}</f><v>${esc(spec.value)}</v></c>`
    } else if (spec.kind === 'formulaNoCache') {
      xml = `<c r="${address}"><f>${esc(spec.formula)}</f></c>`
    } else {
      const f = spec.formula ? `<f>${esc(spec.formula)}</f>` : ''
      xml = `<c r="${address}">${f}<v>${spec.value}</v></c>`
    }
    const list = byRow.get(row)
    if (list) list.push(xml)
    else byRow.set(row, [xml])
  }

  const rowNumbers = [...new Set([...byRow.keys(), ...hiddenRows])].sort((a, b) => a - b)
  const rowsXml = rowNumbers.map(row => {
    const hidden = hiddenRows.has(row) ? ' hidden="1"' : ''
    const inner = (byRow.get(row) ?? []).join('')
    return `<row r="${row}"${hidden}>${inner}</row>`
  }).join('')

  const masterSheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<cols>`
    + `<col min="1" max="9" width="12" customWidth="1"/>`
    + `<col min="10" max="10" width="10" hidden="1" customWidth="1"/>`
    + `<col min="11" max="11" width="17" customWidth="1"/>`
    + `</cols>`
    + `<sheetData>${rowsXml}</sheetData>`
    + (includeDrawing ? `<drawing r:id="rIdDraw"/>` : '')
    + `</worksheet>`

  // ── drawing ──
  const anchors = opts.anchors ?? []
  const mediaTargets = new Map<string, string>()
  const anchorXml = anchors.map((anchor, i) => {
    const relId = `rIdImg${i}`
    if (anchor.picture !== false) {
      mediaTargets.set(relId, anchor.rawTarget ?? `../media/${anchor.media ?? 'image1.png'}`)
    }
    const from =
      `<xdr:from><xdr:col>${anchor.col}</xdr:col><xdr:colOff>0</xdr:colOff>`
      + `<xdr:row>${anchor.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    const body = anchor.picture === false
      ? `<xdr:sp><xdr:txBody><a:p><a:r><a:t>a shape, not a picture</a:t></a:r></a:p></xdr:txBody></xdr:sp>`
      : `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Picture ${i + 1}"/></xdr:nvPicPr>`
        + `<xdr:blipFill><a:blip r:embed="${relId}"/></xdr:blipFill></xdr:pic>`

    if (anchor.kind === 'one') {
      return `<xdr:oneCellAnchor>${from}<xdr:ext cx="900000" cy="900000"/>${body}<xdr:clientData/></xdr:oneCellAnchor>`
    }
    const to =
      `<xdr:to><xdr:col>${anchor.col + 1}</xdr:col><xdr:colOff>0</xdr:colOff>`
      + `<xdr:row>${anchor.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    return `<xdr:twoCellAnchor>${from}${to}${body}<xdr:clientData/></xdr:twoCellAnchor>`
  }).join('')

  const drawingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"`
    + ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + anchorXml
    + `</xdr:wsDr>`

  const drawingRels =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + [...mediaTargets].map(([id, target]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${esc(target)}"/>`,
      ).join('')
    + `</Relationships>`

  // ── package ──
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': bytesOf(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Default Extension="png" ContentType="image/png"/>`
      + `<Default Extension="jpeg" ContentType="image/jpeg"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `</Types>`,
    ),
    '_rels/.rels': bytesOf(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`,
    ),
  }

  const sheetTags = sheetNames.map((name, i) =>
    `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  ).join('')

  parts['xl/workbook.xml'] = bytesOf(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheetTags}</sheets></workbook>`,
  )

  // Relationships are emitted in REVERSE declaration order on purpose: both
  // production workbooks list them shuffled, and a parser that relies on order
  // rather than on the r:id must fail here.
  const sheetRelTags = sheetNames.map((_name, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).reverse().join('')

  parts['xl/_rels/workbook.xml.rels'] = bytesOf(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRelTags}</Relationships>`,
  )

  sheetNames.forEach((_name, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = i === masterIndex
      ? bytesOf(masterSheetXml)
      : bytesOf(`<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>`)
  })

  parts['xl/sharedStrings.xml'] = bytesOf(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`
    + sharedStrings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
    + `</sst>`,
  )

  if (includeDrawing && masterIndex >= 0) {
    parts[`xl/worksheets/_rels/sheet${masterIndex + 1}.xml.rels`] = bytesOf(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`
      + `</Relationships>`,
    )
    parts['xl/drawings/drawing1.xml'] = bytesOf(drawingXml)
    parts['xl/drawings/_rels/drawing1.xml.rels'] = bytesOf(drawingRels)
  }

  const media = opts.media ?? { 'image1.png': fakeImage(PNG_SIG) }
  for (const [name, data] of Object.entries(media)) parts[`xl/media/${name}`] = data

  for (const [name, data] of Object.entries(opts.extraParts ?? {})) parts[name] = data

  return zipSync(parts)
}

// ── Fixture shorthands ────────────────────────────────────────────────────────

/** N invented products, each priced so quantity × cost is exact. */
function inventProducts(count: number): ProductFixture[] {
  return Array.from({ length: count }, (_v, i) => ({
    name: `Sample Item ${i + 1}`,
    quantity: i + 1,
    dimensions: `Standard Dimensions\nWidth - ${40 + i}"`,
    material: `Invented Material ${i + 1}`,
    cost: 1000 + i * 100,
  }))
}

/** One column-E picture anchor per product row. */
function anchorsFor(count: number, kind: 'one' | 'two' = 'two', media = 'image1.png'): AnchorFixture[] {
  return Array.from({ length: count }, (_v, i) => ({
    kind, col: 4, row: FIRST_PRODUCT_ROW + i, media,
  }))
}

function expectOk(result: PiParseResult) {
  assert.equal(result.ok, true, result.ok ? '' : `unexpected errors: ${result.errors.map(e => e.code).join(', ')}`)
  if (!result.ok) throw new Error('unreachable')
  return result
}

const codesOf = (warnings: readonly { code: PiWarningCode }[]) => warnings.map(w => w.code)
const countOf = (warnings: readonly { code: PiWarningCode }[], code: PiWarningCode) =>
  warnings.filter(w => w.code === code).length

const blockingCodes = (issues: readonly { code: PiBlockingIssueCode }[]) => issues.map(i => i.code)
const countBlocking = (
  issues: readonly { code: PiBlockingIssueCode }[],
  code: PiBlockingIssueCode,
) => issues.filter(i => i.code === code).length

// ══ 1. Workbook and template validation ══════════════════════════════════════

describe('workbook validation', () => {
  test('resolves Master when it is NOT sheet1.xml', async () => {
    const wb = buildPiWorkbook({
      sheetNames: ['Cover', 'Fabric and Finish', 'Master', 'BDPI'],
      products: inventProducts(3),
      anchors: anchorsFor(3),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.template.sheetPart, 'xl/worksheets/sheet3.xml')
    assert.deepEqual(
      [...result.data.template.workbookSheetNames],
      ['Cover', 'Fabric and Finish', 'Master', 'BDPI'],
    )
  })

  test('resolves Master when it IS the first sheet', async () => {
    const wb = buildPiWorkbook({
      sheetNames: ['Master', 'Notes'],
      products: inventProducts(2),
      anchors: anchorsFor(2),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.template.sheetPart, 'xl/worksheets/sheet1.xml')
  })

  test('a workbook with no Master sheet is blocked', async () => {
    const wb = buildPiWorkbook({ sheetNames: ['Cover', 'Summary'], masterIndex: -1 })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.deepEqual(result.errors.map(e => e.code), ['MASTER_SHEET_MISSING'])
    assert.match(result.errors[0].message, /Cover, Summary/)
  })

  test('the failure branch carries no data field at all', async () => {
    const result = await parseBoePiWorkbook(bytesOf('not a workbook'))
    assert.equal(result.ok, false)
    assert.equal('data' in result, false)
  })

  test('refuses a workbook over the 10 MiB limit', async () => {
    const result = await parseBoePiWorkbook(new Uint8Array(PI_MAX_WORKBOOK_BYTES + 1))
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.deepEqual(result.errors.map(e => e.code), ['INPUT_TOO_LARGE'])
  })

  test('accepts a workbook exactly at the limit boundary', async () => {
    // A real fixture padded with an incompressible comment part to land under
    // the ceiling: what matters is that <= limit is not refused.
    const wb = buildPiWorkbook({ products: inventProducts(1), anchors: anchorsFor(1) })
    assert.ok(wb.length < PI_MAX_WORKBOOK_BYTES)
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, true)
  })

  test('refuses an archive containing a path-escaping entry', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: anchorsFor(1),
      extraParts: { '../escape.xml': bytesOf('<x/>') },
    })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.deepEqual(result.errors.map(e => e.code), ['UNSAFE_ENTRY_NAME'])
  })
})

describe('template fingerprint', () => {
  test('a matching row 31 passes every checked cell', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(1), anchors: anchorsFor(1) })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.template.fingerprint.length, TEMPLATE_HEADERS.length)
    assert.equal(result.data.template.fingerprint.every(f => f.ok), true)
  })

  test('tolerates whitespace and newline differences in a header label', async () => {
    const wb = buildPiWorkbook({
      headerOverrides: { D31: 'Dimension  in\ninches\t& Shape' },
      products: inventProducts(1),
      anchors: anchorsFor(1),
    })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, true)
  })

  test('a renamed column header BLOCKS the parse rather than remapping', async () => {
    const wb = buildPiWorkbook({
      headerOverrides: { G31: 'Fabric' },
      products: inventProducts(3),
      anchors: anchorsFor(3),
    })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.deepEqual(result.errors.map(e => e.code), ['TEMPLATE_FINGERPRINT_MISMATCH'])
    assert.match(result.errors[0].message, /G31 expected "Material", found "Fabric"/)
  })

  test('a missing header cell blocks and says which one', async () => {
    const wb = buildPiWorkbook({
      headerOverrides: { K31: null },
      products: inventProducts(2),
      anchors: anchorsFor(2),
    })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.match(result.errors[0].message, /K31 expected "Customization", found nothing/)
  })

  test('a workbook with a Master sheet but a foreign layout is blocked', async () => {
    const wb = buildPiWorkbook({
      headerOverrides: {
        A31: 'SKU', B31: 'Description', C31: 'Qty', D31: 'Size', E31: 'Photo',
        G31: 'Fabric', H31: 'Rate', I31: 'Amount', K31: 'Notes',
      },
      products: inventProducts(4),
    })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.equal(result.errors[0].code, 'TEMPLATE_FINGERPRINT_MISMATCH')
  })
})

// ══ 2. Header block ══════════════════════════════════════════════════════════

describe('header block', () => {
  test('reads every header field into typed values', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(2), anchors: anchorsFor(2) })
    const { header } = expectOk(await parseBoePiWorkbook(wb)).data

    assert.equal(header.sourceOrderNumber, '407')
    assert.equal(header.creationDate?.iso, '2023-03-15')
    assert.equal(header.creationDate?.source, 'serial')
    assert.equal(header.createdBy, 'Sample Employee')
    assert.equal(header.boeGst, '00AAAAA0000A0Z0')
    assert.equal(header.contactNumber, '9000000001')
    assert.equal(header.billToName, 'Example Buyer Ltd')
    assert.equal(header.billToPhone, '9000000002')
    assert.equal(header.billToGst, '11BBBBB1111B1Z1')
    assert.equal(header.billingAddress, '1 Invented Road\nSample City')
    assert.equal(header.shipToName, 'Example Site Office')
    assert.equal(header.shipToPhone, '9000000003')
    assert.equal(header.shipToGst, '22CCCCC2222C2Z2')
    assert.equal(header.shippingAddress, '2 Fictional Lane\nSample City')
    assert.equal(header.orderConfirmationDate?.iso, '2023-03-25')
    assert.equal(header.dispatchCommitment?.text, '6 weeks from date of confirmation')
    assert.equal(header.dispatchCommitment?.source, 'text')
    assert.equal(header.dispatchCommitment?.iso, null)
  })

  test('B20 is reported as SOURCE data and no official number is allocated', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(1), anchors: anchorsFor(1) })
    const { data } = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(data.header.sourceOrderNumber, '407')
    // Nothing anywhere in the result claims an official order number, and the
    // product code stays the one the source workbook carried.
    assert.equal('officialOrderNumber' in data, false)
    assert.equal('orderNumber' in data, false)
    assert.equal(data.products[0].sourceProductCode, '407-B001')
  })

  test('a whitespace-only header cell is null, never an empty placeholder string', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: anchorsFor(1),
      extraCells: { B25: text('   '), G21: text('\n \t ') },
    })
    const { header } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(header.billToName, null)
    assert.equal(header.createdBy, null)
  })

  test('an absent header cell yields null rather than throwing', async () => {
    // A113 and G27 are genuinely absent in one of the two production layouts,
    // so "the cell is not there at all" has to be an ordinary outcome.
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: anchorsFor(1),
      extraCells: { A113: null, G27: null, B26: null },
    })
    const { header } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(header.orderConfirmationDate, null)
    assert.equal(header.shipToGst, null)
    assert.equal(header.billToPhone, null)
    // The rest of the block is unaffected.
    assert.equal(header.billToName, 'Example Buyer Ltd')
  })

  test('a date cell holding text rather than a serial keeps the text', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: anchorsFor(1),
      extraCells: { A113: text('on receipt of advance') },
    })
    const { header } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(header.orderConfirmationDate?.source, 'text')
    assert.equal(header.orderConfirmationDate?.iso, null)
    assert.equal(header.orderConfirmationDate?.text, 'on receipt of advance')
  })
})

// ══ 3. Product rows ══════════════════════════════════════════════════════════

describe('genuine product rows', () => {
  test('finds exactly seven products in a seven-product workbook', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(7), anchors: anchorsFor(7) })
    const { data } = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(data.products.length, 7)
    assert.deepEqual([...data.template.genuineProductRows], [32, 33, 34, 35, 36, 37, 38])
  })

  test('finds exactly twelve products in a twelve-product workbook', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(12), anchors: anchorsFor(12) })
    const { data } = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(data.products.length, 12)
    assert.equal(data.template.genuineProductRows[0], 32)
    assert.equal(data.template.genuineProductRows[11], 43)
  })

  test('excludes the hidden unused template rows', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(7), anchors: anchorsFor(7) })
    const { data } = expectOk(await parseBoePiWorkbook(wb))
    // Rows 39–111 are the untouched slots: hidden, and carrying only a formula
    // code, a formula total and a sequence.
    assert.equal(data.template.hiddenProductRows.length, LAST_PRODUCT_ROW - 38)
    assert.equal(data.template.hiddenProductRows.includes(39), true)
    assert.equal(data.products.some(p => p.row > 38), false)
  })

  test('a hidden row carrying real content is excluded AND reported', async () => {
    // Build 3 products, then plant content on hidden row 60.
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3),
      extraCells: {
        B60: text('Item hidden by mistake'),
        C60: num(2),
        H60: num(500),
      },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.products.length, 3)
    const warning = result.warnings.find(w => w.code === 'HIDDEN_ROW_WITH_CONTENT')
    assert.ok(warning, 'expected a HIDDEN_ROW_WITH_CONTENT warning')
    assert.equal(warning?.row, 60)
  })

  test('a formula-derived code in column A does not make an empty row genuine', async () => {
    // Every unused slot in the fixture carries a formula code, a formula total
    // and a sequence — none of which is product information.
    const wb = buildPiWorkbook({ products: inventProducts(1), anchors: anchorsFor(1) })
    const { data } = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(data.products.length, 1)
  })

  test('a template with no genuine products at all is a blocking error', async () => {
    const wb = buildPiWorkbook({ products: [], anchors: [] })
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.deepEqual(result.errors.map(e => e.code), ['NO_PRODUCT_ROWS'])
  })

  test('extracts every product field from its own column', async () => {
    const wb = buildPiWorkbook({
      products: [{
        code: 'SRC-0001',
        name: 'Sample Lounge Chair',
        quantity: 4,
        dimensions: 'Standard Dimensions\nSeating Height - 18"',
        material: 'Invented Teak Frame',
        cost: 12500,
        sequence: 'B001',
        customization: 'Arm height raised by 2 inches',
      }],
      anchors: anchorsFor(1),
    })
    const [product] = expectOk(await parseBoePiWorkbook(wb)).data.products

    assert.equal(product.row, 32)
    assert.equal(product.sourceProductCode, 'SRC-0001')
    assert.equal(product.productName, 'Sample Lounge Chair')
    assert.equal(product.quantity, 4)
    assert.equal(product.dimensions, 'Standard Dimensions\nSeating Height - 18"')
    assert.equal(product.material, 'Invented Teak Frame')
    assert.equal(product.costPerPiece, 12500)
    assert.equal(product.lineTotal, 50000)
    assert.equal(product.itemSequence, 'B001')
    assert.equal(product.customization, 'Arm height raised by 2 inches')
  })

  test('preserves internal line breaks in dimensions while trimming the edges', async () => {
    const wb = buildPiWorkbook({
      products: [{ name: 'x', quantity: 1, cost: 1, dimensions: '  Line one  \n  Line two  ' }],
      anchors: anchorsFor(1),
    })
    const [product] = expectOk(await parseBoePiWorkbook(wb)).data.products
    assert.equal(product.dimensions, 'Line one\nLine two')
  })
})

describe('material and customization', () => {
  test('are separate fields, never merged', async () => {
    const wb = buildPiWorkbook({
      products: [{
        name: 'Sample Sofa', quantity: 1, cost: 1000,
        material: 'Invented Fabric A / Invented Wood B',
        customization: 'Back cushion firmer than the reference image',
      }],
      anchors: anchorsFor(1),
    })
    const [product] = expectOk(await parseBoePiWorkbook(wb)).data.products
    assert.equal(product.material, 'Invented Fabric A / Invented Wood B')
    assert.equal(product.customization, 'Back cushion firmer than the reference image')
    assert.notEqual(product.material, product.customization)
  })

  test('customization is optional — a blank one is null, not an empty string', async () => {
    const wb = buildPiWorkbook({
      products: [
        { name: 'With note', quantity: 1, cost: 100, material: 'M1', customization: 'Fluted base' },
        { name: 'Without note', quantity: 1, cost: 100, material: 'M2' },
        { name: 'Whitespace note', quantity: 1, cost: 100, material: 'M3', customization: '   ' },
      ],
      anchors: anchorsFor(3),
    })
    const { products } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(products[0].customization, 'Fluted base')
    assert.equal(products[1].customization, null)
    assert.equal(products[2].customization, null)
    // Material is unaffected by whether a customization exists.
    assert.deepEqual(products.map(p => p.material), ['M1', 'M2', 'M3'])
  })
})

// ══ 4. Arithmetic warnings ═══════════════════════════════════════════════════

describe('line total checks', () => {
  test('quantity × rate matching the stored total produces no warning', async () => {
    const wb = buildPiWorkbook({
      products: [{ name: 'a', quantity: 3, cost: 250, total: 750, material: 'M' }],
      anchors: anchorsFor(1),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countOf(result.warnings, 'LINE_TOTAL_MISMATCH'), 0)
    assert.equal(countOf(result.warnings, 'LINE_TOTAL_UNVERIFIABLE'), 0)
  })

  test('a mismatch is WARNED and the workbook figure is kept', async () => {
    const wb = buildPiWorkbook({
      products: [{ name: 'a', quantity: 3, cost: 250, total: 900, material: 'M' }],
      anchors: anchorsFor(1),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    const warning = result.warnings.find(w => w.code === 'LINE_TOTAL_MISMATCH')
    assert.ok(warning, 'expected LINE_TOTAL_MISMATCH')
    assert.equal(warning?.row, 32)
    assert.equal(warning?.stored, 900)
    assert.equal(warning?.computed, 750)
    // The parser never substitutes its own arithmetic.
    assert.equal(result.data.products[0].lineTotal, 900)
  })

  test('a sub-paisa difference is not treated as a mismatch', async () => {
    const wb = buildPiWorkbook({
      products: [{ name: 'a', quantity: 3, cost: 250, total: 750 + MONEY_EPSILON / 2, material: 'M' }],
      anchors: anchorsFor(1),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countOf(result.warnings, 'LINE_TOTAL_MISMATCH'), 0)
  })

  test('a formula with no cached result is reported, not computed', async () => {
    const wb = buildPiWorkbook({
      products: [{ name: 'a', quantity: 3, cost: 250, total: 'noCache', material: 'M' }],
      anchors: anchorsFor(1),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    const missing = result.warnings.find(w => w.code === 'FORMULA_WITHOUT_CACHED_VALUE')
    assert.ok(missing, 'expected FORMULA_WITHOUT_CACHED_VALUE')
    assert.equal(missing?.cell, 'I32')
    assert.equal(countOf(result.warnings, 'LINE_TOTAL_UNVERIFIABLE'), 1)
    // Reported as absent rather than silently replaced by 3 × 250.
    assert.equal(result.data.products[0].lineTotal, null)
  })

  test('a missing quantity blocks instead of producing a duplicate warning', async () => {
    const wb = buildPiWorkbook({
      products: [{ name: 'a', cost: 250, total: 750, material: 'M', dimensions: 'D' }],
      anchors: anchorsFor(1),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_QUANTITY_INVALID'), 1)
    // The arithmetic check is skipped rather than reported twice: the reviewer is
    // told once that the quantity is what needs fixing.
    assert.equal(countOf(result.warnings, 'LINE_TOTAL_UNVERIFIABLE'), 0)
    assert.equal(countOf(result.warnings, 'LINE_TOTAL_MISMATCH'), 0)
  })
})

// ══ 4b. Blocking versus non-blocking classification ══════════════════════════

describe('submission-blocking product issues', () => {
  /** One complete, valid product plus its picture — the baseline every case
   *  below breaks in exactly one way. */
  const complete = (over: Partial<ProductFixture> = {}): ProductFixture => ({
    name: 'Sample Item', quantity: 2, cost: 1500,
    dimensions: 'Standard Dimensions', material: 'Invented Material',
    ...over,
  })

  const parseOne = async (product: ProductFixture, anchors = anchorsFor(1), extra = {}) =>
    expectOk(await parseBoePiWorkbook(buildPiWorkbook({ products: [product], anchors, ...extra })))

  test('a complete row blocks on nothing', async () => {
    const result = await parseOne(complete())
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(codesOf(result.warnings), [])
  })

  test('a missing product name blocks', async () => {
    const result = await parseOne(complete({ name: undefined }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_NAME_MISSING'])
    assert.equal(result.blockingIssues[0].row, 32)
    assert.equal(result.blockingIssues[0].cell, 'B32')
  })

  test('a whitespace-only product name blocks', async () => {
    const result = await parseOne(complete({ name: '   ' }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_NAME_MISSING'])
  })

  test('a missing quantity blocks', async () => {
    const result = await parseOne(complete({ quantity: undefined }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_QUANTITY_INVALID'])
    assert.equal(result.blockingIssues[0].cell, 'C32')
    assert.match(result.blockingIssues[0].message, /cell is empty/)
  })

  test('a zero quantity blocks', async () => {
    const result = await parseOne(complete({ quantity: 0 }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_QUANTITY_INVALID'])
    assert.match(result.blockingIssues[0].message, /it is 0/)
  })

  test('a negative quantity blocks', async () => {
    const result = await parseOne(complete({ quantity: -3 }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_QUANTITY_INVALID'])
  })

  test('a non-numeric quantity blocks', async () => {
    const result = await parseOne(
      complete({ quantity: undefined }), anchorsFor(1), { extraCells: { C32: text('two') } },
    )
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_QUANTITY_INVALID'])
    assert.match(result.blockingIssues[0].message, /not a number/)
  })

  test('a missing cost per piece blocks', async () => {
    const result = await parseOne(complete({ cost: undefined }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_COST_INVALID'])
    assert.equal(result.blockingIssues[0].cell, 'H32')
  })

  test('a zero cost per piece blocks', async () => {
    const result = await parseOne(complete({ cost: 0 }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_COST_INVALID'])
  })

  test('a negative cost per piece blocks', async () => {
    const result = await parseOne(complete({ cost: -100 }))
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_COST_INVALID'])
  })

  test('a non-numeric cost per piece blocks', async () => {
    const result = await parseOne(
      complete({ cost: undefined }), anchorsFor(1), { extraCells: { H32: text('on request') } },
    )
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_COST_INVALID'])
  })

  test('a missing item sequence blocks', async () => {
    const result = await parseOne(complete(), anchorsFor(1), { extraCells: { J32: text('   ') } })
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_ITEM_SEQUENCE_MISSING'])
    assert.equal(result.blockingIssues[0].cell, 'J32')
    assert.equal(result.data.products[0].itemSequence, null)
  })

  test('a missing image blocks', async () => {
    const result = await parseOne(complete(), [])
    assert.deepEqual(blockingCodes(result.blockingIssues), ['PRODUCT_IMAGE_REQUIRED'])
    assert.equal(result.blockingIssues[0].cell, 'E32')
  })

  // ── The other side of the line ──

  test('missing dimensions WARN and do not block', async () => {
    const result = await parseOne(complete({ dimensions: undefined }))
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(codesOf(result.warnings), ['PRODUCT_DIMENSIONS_MISSING'])
    assert.equal(result.warnings[0].row, 32)
  })

  test('missing material WARNS and does not block', async () => {
    const result = await parseOne(complete({ material: undefined }))
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(codesOf(result.warnings), ['PRODUCT_MATERIAL_MISSING'])
  })

  test('a line-total mismatch WARNS and does not block', async () => {
    const result = await parseOne(complete({ total: 9999 }))
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(codesOf(result.warnings), ['LINE_TOTAL_MISMATCH'])
  })

  test('a formula without a cached value WARNS and does not block', async () => {
    const result = await parseOne(complete({ total: 'noCache' }))
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(
      codesOf(result.warnings).sort(),
      ['FORMULA_WITHOUT_CACHED_VALUE', 'LINE_TOTAL_UNVERIFIABLE'],
    )
  })

  test('a subtotal mismatch WARNS and does not block', async () => {
    const wb = buildPiWorkbook({
      products: [complete()],
      anchors: anchorsFor(1),
      commercial: { I116: num(1) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(codesOf(result.warnings), ['SUBTOTAL_MISMATCH'])
  })

  test('a hidden row with content WARNS and does not block', async () => {
    const wb = buildPiWorkbook({
      products: [complete()],
      anchors: anchorsFor(1),
      extraCells: { B60: text('Item hidden by mistake'), C60: num(1), H60: num(10) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.deepEqual(codesOf(result.warnings), ['HIDDEN_ROW_WITH_CONTENT'])
  })

  test('a blank customization NEVER blocks and never warns', async () => {
    const withNone = await parseOne(complete({ customization: undefined }))
    const withBlank = await parseOne(complete({ customization: '   ' }))
    const withText = await parseOne(complete({ customization: 'Fluted base' }))
    for (const result of [withNone, withBlank, withText]) {
      assert.deepEqual(blockingCodes(result.blockingIssues), [])
      assert.deepEqual(codesOf(result.warnings), [])
    }
    assert.equal(withNone.data.products[0].customization, null)
    assert.equal(withText.data.products[0].customization, 'Fluted base')
  })

  // ── The preview survives ──

  test('the parsed preview is returned IN FULL alongside blocking issues', async () => {
    const wb = buildPiWorkbook({
      products: [
        complete({ name: 'Good Item' }),
        complete({ name: undefined, quantity: 0, cost: -5 }),
      ],
      anchors: anchorsFor(1), // only the first row gets a picture
      commercial: { I115: num(0) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    // Blocking, but everything a reviewer needs in order to FIX it is present.
    assert.equal(result.blockingIssues.length > 0, true)
    assert.equal(result.data.products.length, 2)
    assert.equal(result.data.products[0].productName, 'Good Item')
    assert.equal(result.data.products[0].representativeImage?.row, 32)
    assert.equal(result.data.header.sourceOrderNumber, '407')
    assert.equal(result.data.commercial.grossProductAmount > 0, true)
    assert.equal(result.data.template.genuineProductRows.length, 2)
  })

  test('blocking issues carry the row so they can be listed per product', async () => {
    const wb = buildPiWorkbook({
      products: [complete(), complete({ name: undefined }), complete({ quantity: 0 })],
      anchors: anchorsFor(3),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.deepEqual(
      result.blockingIssues.map(i => [i.row, i.code]),
      [[33, 'PRODUCT_NAME_MISSING'], [34, 'PRODUCT_QUANTITY_INVALID']],
    )
  })

  test('one row can carry several blocking issues at once', async () => {
    const result = await parseOne(complete({ name: undefined, quantity: 0, cost: 0 }), [])
    assert.deepEqual(blockingCodes(result.blockingIssues).sort(), [
      'PRODUCT_COST_INVALID',
      'PRODUCT_IMAGE_REQUIRED',
      'PRODUCT_NAME_MISSING',
      'PRODUCT_QUANTITY_INVALID',
    ])
    assert.equal(result.blockingIssues.every(i => i.row === 32), true)
  })

  test('a failed parse has no blockingIssues field — there are no rows to judge', async () => {
    const result = await parseBoePiWorkbook(bytesOf('not a workbook'))
    assert.equal(result.ok, false)
    assert.equal('blockingIssues' in result, false)
  })
})

// ══ 5. Commercial summary ════════════════════════════════════════════════════

describe('commercial summary', () => {
  test('I115 is the discount even when the label above it says "Design Fees"', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3),
      commercial: { G115: text('Design Fees'), I115: num(4500) },
    })
    const { commercial } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(commercial.discount, 4500)
    assert.equal(commercial.discountLabel, 'Design Fees')
  })

  test('I115 is the discount when the label says "Discount"', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3),
      commercial: { G115: text('Discount'), I115: num(4500) },
    })
    const { commercial } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(commercial.discount, 4500)
    assert.equal(commercial.discountLabel, 'Discount')
  })

  test('a blank I115 is a discount of zero, with no warning — the normal case', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(3), anchors: anchorsFor(3) })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.discount, 0)
    assert.equal(countOf(result.warnings, 'DISCOUNT_NOT_NUMERIC'), 0)
  })

  test('a non-numeric I115 is a discount of zero AND a warning', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3),
      commercial: { I115: text('to be confirmed') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.discount, 0)
    assert.equal(countOf(result.warnings, 'DISCOUNT_NOT_NUMERIC'), 1)
  })

  test('the discount is subtracted EXACTLY ONCE', async () => {
    const products = inventProducts(4)
    const gross = products.reduce((s, p) => s + (p.quantity ?? 0) * (p.cost ?? 0), 0)
    const discount = 2500
    const wb = buildPiWorkbook({
      products,
      anchors: anchorsFor(4),
      commercial: { I115: num(discount), I116: num(gross - discount, 'SUM(I32:I111)-I115') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    const { commercial } = result.data

    // The gross is the raw sum of the lines — the discount has NOT been taken
    // off it.
    assert.equal(commercial.grossProductAmount, gross)
    // expectedSubtotal takes it off once.
    assert.equal(commercial.expectedSubtotal, gross - discount)
    // The workbook's own post-discount figure comes back untouched — it is
    // never reduced by the discount a second time.
    assert.equal(commercial.subtotalAfterDiscount.amount, gross - discount)
    assert.notEqual(commercial.expectedSubtotal, gross - discount * 2)
    // And because the two agree, nothing is flagged.
    assert.equal(countOf(result.warnings, 'SUBTOTAL_MISMATCH'), 0)
  })

  test('a subtotal that disagrees with gross − discount is warned, not corrected', async () => {
    const products = inventProducts(4)
    const gross = products.reduce((s, p) => s + (p.quantity ?? 0) * (p.cost ?? 0), 0)
    const wb = buildPiWorkbook({
      products,
      anchors: anchorsFor(4),
      commercial: { I115: num(1000), I116: num(gross) }, // discount never applied
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    const warning = result.warnings.find(w => w.code === 'SUBTOTAL_MISMATCH')
    assert.ok(warning, 'expected SUBTOTAL_MISMATCH')
    assert.equal(warning?.stored, gross)
    assert.equal(warning?.computed, gross - 1000)
    assert.equal(result.data.commercial.subtotalAfterDiscount.amount, gross)
  })

  test('reads the whole footer by position', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: anchorsFor(2),
      commercial: {
        I115: num(500), I117: num(7000), I118: num(1200),
        I119: num(3400), I120: num(20000), I121: num(3600), I122: num(23600),
      },
    })
    const { commercial } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(commercial.discount, 500)
    assert.equal(commercial.fabricCost.amount, 7000)
    assert.equal(commercial.packingCost.amount, 1200)
    assert.equal(commercial.transportation.amount, 3400)
    assert.equal(commercial.totalBeforeGst.amount, 20000)
    assert.equal(commercial.gst.amount, 3600)
    assert.equal(commercial.grandTotal.amount, 23600)
    // The cell each figure came from travels with it.
    assert.equal(commercial.grandTotal.cell, 'I122')
  })

  test('GST is never recalculated — a wrong-looking GST is returned as stored', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: anchorsFor(2),
      commercial: { I120: num(10000), I121: num(1) },
    })
    const { commercial } = expectOk(await parseBoePiWorkbook(wb)).data
    assert.equal(commercial.gst.amount, 1)
  })
})

describe('transportation', () => {
  test('a numeric transportation is an amount', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I119: num(4500) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.transportation.amount, 4500)
    assert.equal(result.data.commercial.transportation.text, null)
    assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
  })

  test('a textual transportation is preserved verbatim and is not a warning', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I119: text('as applicable') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.transportation.amount, null)
    assert.equal(result.data.commercial.transportation.text, 'as applicable')
    assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
  })

  test('a dash in transportation is NOT resolved to zero — it stays text', async () => {
    // Transportation keeps a dash verbatim: unlike fabric and packing it carries
    // no "as per actual" zero convention, and rewriting it would invent a fact.
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I119: text('-') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.transportation.text, '-')
    assert.equal(result.data.commercial.transportation.amount, null)
    assert.equal(result.data.commercial.transportation.zeroMeaning, null)
  })
})

describe('fabric and packing cost — the "nothing to charge" cells', () => {
  const costCells = [
    { label: 'fabric', cell: 'I117', read: 'fabricCost' as const },
    { label: 'packing', cell: 'I118', read: 'packingCost' as const },
  ]

  for (const { label, cell, read } of costCells) {
    test(`a numeric ${label} cost stays numeric`, async () => {
      const wb = buildPiWorkbook({
        products: inventProducts(2), anchors: anchorsFor(2),
        commercial: { [cell]: num(7250.5) },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))
      const value = result.data.commercial[read]
      assert.equal(value.amount, 7250.5)
      assert.equal(value.text, null)
      assert.equal(value.zeroMeaning, null)
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
    })

    test(`a BLANK ${label} cost means zero, with no warning`, async () => {
      const wb = buildPiWorkbook({
        products: inventProducts(2), anchors: anchorsFor(2),
        commercial: { [cell]: null },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))
      const value = result.data.commercial[read]
      assert.equal(value.amount, 0)
      assert.equal(value.zeroMeaning, 'notApplicable')
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
    })

    test(`a WHITESPACE-only ${label} cost means zero, with no warning`, async () => {
      const wb = buildPiWorkbook({
        products: inventProducts(2), anchors: anchorsFor(2),
        commercial: { [cell]: text('   ') },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))
      const value = result.data.commercial[read]
      assert.equal(value.amount, 0)
      assert.equal(value.zeroMeaning, 'notApplicable')
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
    })

    test(`a DASH ${label} cost means zero, with no warning`, async () => {
      const wb = buildPiWorkbook({
        products: inventProducts(2), anchors: anchorsFor(2),
        commercial: { [cell]: text('-') },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))
      const value = result.data.commercial[read]
      assert.equal(value.amount, 0)
      assert.equal(value.text, null)
      assert.equal(value.zeroMeaning, 'notApplicable')
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
    })

    test(`UNEXPECTED text in the ${label} cost is preserved AND warned`, async () => {
      const wb = buildPiWorkbook({
        products: inventProducts(2), anchors: anchorsFor(2),
        commercial: { [cell]: text('to be confirmed') },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))
      const value = result.data.commercial[read]
      assert.equal(value.amount, null)
      assert.equal(value.text, 'to be confirmed')
      assert.equal(value.zeroMeaning, null)
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 1)
      const warning = result.warnings.find(w => w.code === 'COMMERCIAL_VALUE_NON_NUMERIC')
      assert.equal(warning?.cell, cell)
    })
  }

  test('a formula that EVALUATES to a dash is zero — the real production case', async () => {
    // One reference workbook stores the fabric cost as a formula whose cached
    // result is a single ASCII hyphen. That must read as zero, not as unexpected
    // text, which is the whole point of this correction.
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I117: { kind: 'formulaStr', value: '-', formula: 'IF(X1=0,"-",X1)' } },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.fabricCost.amount, 0)
    assert.equal(result.data.commercial.fabricCost.zeroMeaning, 'notApplicable')
    assert.deepEqual(codesOf(result.warnings), [])
  })

  test('an en dash and an em dash count too, and a repeated dash', async () => {
    for (const marker of ['–', '—', '--', ' - ']) {
      const wb = buildPiWorkbook({
        products: inventProducts(1), anchors: anchorsFor(1),
        commercial: { I117: text(marker) },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))
      assert.equal(result.data.commercial.fabricCost.amount, 0, `marker ${JSON.stringify(marker)}`)
      assert.equal(result.data.commercial.fabricCost.zeroMeaning, 'notApplicable')
    }
  })

  test('the zero-means-nothing rule does NOT leak to the other footer cells', async () => {
    // A dash in a grand total is not "nothing to charge" — it is a workbook that
    // needs looking at.
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I122: text('-') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.commercial.grandTotal.amount, null)
    assert.equal(result.data.commercial.grandTotal.text, '-')
    assert.equal(result.data.commercial.grandTotal.zeroMeaning, null)
    assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 1)
  })

  test('isNotApplicableMarker accepts blanks and dashes and nothing else', () => {
    for (const yes of [null, '', '   ', '-', '--', '–', '—', ' – ']) {
      assert.equal(isNotApplicableMarker(yes), true, JSON.stringify(yes))
    }
    for (const no of ['0', 'n/a', 'N/A', 'nil', 'TBC', 'to be confirmed', '-1', 'as applicable']) {
      assert.equal(isNotApplicableMarker(no), false, JSON.stringify(no))
    }
  })
})

describe('fabric and packing cost — "Inclusive" is charged, not absent', () => {
  const costCells = [
    { label: 'fabric', cell: 'I117', read: 'fabricCost' as const },
    { label: 'packing', cell: 'I118', read: 'packingCost' as const },
  ]

  const wordings = ['Inclusive', 'Included', 'INCLUSIVE', 'included', 'InClUdEd', '  Inclusive  ', 'Included\n']

  for (const { label, cell, read } of costCells) {
    for (const wording of wordings) {
      test(`${JSON.stringify(wording)} in the ${label} cost is zero, included, and silent`, async () => {
        const wb = buildPiWorkbook({
          products: inventProducts(2), anchors: anchorsFor(2),
          commercial: { [cell]: text(wording) },
        })
        const result = expectOk(await parseBoePiWorkbook(wb))
        const value = result.data.commercial[read]

        assert.equal(value.amount, 0, 'normalized to zero for the arithmetic')
        assert.equal(value.zeroMeaning, 'included', 'and classified as included')
        assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0, 'no warning')
      })
    }

    test(`the source wording of an included ${label} cost is kept for audit`, async () => {
      const wb = buildPiWorkbook({
        products: inventProducts(2), anchors: anchorsFor(2),
        commercial: { [cell]: text('  Inclusive  ') },
      })
      const { data } = expectOk(await parseBoePiWorkbook(wb))
      // Trimmed by the cell reader, but the WORD the workbook used survives —
      // unlike a dash, which carries no information worth keeping.
      assert.equal(data.commercial[read].text, 'Inclusive')
    })

    test(`an included ${label} cost is NOT the same fact as a dash`, async () => {
      const included = buildPiWorkbook({
        products: inventProducts(1), anchors: anchorsFor(1),
        commercial: { [cell]: text('Inclusive') },
      })
      const dashed = buildPiWorkbook({
        products: inventProducts(1), anchors: anchorsFor(1),
        commercial: { [cell]: text('-') },
      })
      const a = expectOk(await parseBoePiWorkbook(included)).data.commercial[read]
      const b = expectOk(await parseBoePiWorkbook(dashed)).data.commercial[read]

      assert.equal(a.amount, b.amount, 'both add nothing to the total')
      assert.notEqual(a.zeroMeaning, b.zeroMeaning, 'but they mean opposite things')
      assert.equal(a.zeroMeaning, 'included')
      assert.equal(b.zeroMeaning, 'notApplicable')
    })
  }

  test('a formula CACHED as "Inclusive" is read the same way', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I118: { kind: 'formulaStr', value: 'Inclusive', formula: 'IF(X1=0,"Inclusive",X1)' } },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.commercial.packingCost.amount, 0)
    assert.equal(result.data.commercial.packingCost.zeroMeaning, 'included')
    assert.deepEqual(codesOf(result.warnings), [])
  })

  test('a formula CACHED as "Included" is read the same way', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I117: { kind: 'formulaStr', value: 'Included', formula: 'IF(X1=0,"Included",X1)' } },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.commercial.fabricCost.zeroMeaning, 'included')
    assert.deepEqual(codesOf(result.warnings), [])
  })

  test('both cost cells can be included at once, still silently', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2), anchors: anchorsFor(2),
      commercial: { I117: text('Inclusive'), I118: text('Included') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.commercial.fabricCost.zeroMeaning, 'included')
    assert.equal(result.data.commercial.packingCost.zeroMeaning, 'included')
    assert.deepEqual(codesOf(result.warnings), [])
  })

  test('genuinely unexpected wording in those cells still warns', async () => {
    // The rule must not become "any word means zero". A qualification is
    // something a person has to read.
    for (const wording of ['inclusive of GST', 'included?', 'partly included', 'incl', 'to be confirmed']) {
      const wb = buildPiWorkbook({
        products: inventProducts(1), anchors: anchorsFor(1),
        commercial: { I117: text(wording) },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))

      assert.equal(result.data.commercial.fabricCost.amount, null, JSON.stringify(wording))
      assert.equal(result.data.commercial.fabricCost.text, wording)
      assert.equal(result.data.commercial.fabricCost.zeroMeaning, null)
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 1, JSON.stringify(wording))
    }
  })

  test('the rule does NOT reach any other commercial cell', async () => {
    // A grand total, a GST line or a subtotal that says "Inclusive" is a
    // workbook somebody must look at — not a zero.
    const others: { cell: string; read: 'subtotalAfterDiscount' | 'totalBeforeGst' | 'gst' | 'grandTotal' }[] = [
      { cell: 'I116', read: 'subtotalAfterDiscount' },
      { cell: 'I120', read: 'totalBeforeGst' },
      { cell: 'I121', read: 'gst' },
      { cell: 'I122', read: 'grandTotal' },
    ]
    for (const { cell, read } of others) {
      const wb = buildPiWorkbook({
        products: inventProducts(1), anchors: anchorsFor(1),
        commercial: { [cell]: text('Inclusive') },
      })
      const result = expectOk(await parseBoePiWorkbook(wb))

      assert.equal(result.data.commercial[read].amount, null, cell)
      assert.equal(result.data.commercial[read].text, 'Inclusive', cell)
      assert.equal(result.data.commercial[read].zeroMeaning, null, cell)
      assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 1, cell)
    }
  })

  test('the discount cell is unaffected — it has its own rule', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1), anchors: anchorsFor(1),
      commercial: { I115: text('Inclusive') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.commercial.discount, 0, 'a non-numeric discount is still 0')
    assert.equal(countOf(result.warnings, 'DISCOUNT_NOT_NUMERIC'), 1, 'and still says so')
  })

  test('transportation keeps its numeric-or-text behaviour', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1), anchors: anchorsFor(1),
      commercial: { I119: text('Inclusive') },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.commercial.transportation.text, 'Inclusive', 'preserved verbatim')
    assert.equal(result.data.commercial.transportation.amount, null, 'not turned into a zero')
    assert.equal(result.data.commercial.transportation.zeroMeaning, null)
    // Transportation never warns on text: words are expected there.
    assert.equal(countOf(result.warnings, 'COMMERCIAL_VALUE_NON_NUMERIC'), 0)
  })

  test('isIncludedMarker accepts exactly the two bare words', () => {
    for (const yes of ['Inclusive', 'included', 'INCLUSIVE', '  Included  ', 'In cluded'.replace(' ', '')]) {
      assert.equal(isIncludedMarker(yes), true, JSON.stringify(yes))
    }
    for (const no of [null, '', '   ', '-', '0', 'incl', 'inclusive of GST', 'included?', 'not included', 'excluded']) {
      assert.equal(isIncludedMarker(no), false, JSON.stringify(no))
    }
  })
})

// ══ 6. Embedded images ═══════════════════════════════════════════════════════

describe('drawing anchors', () => {
  test('parses both anchor kinds and reports their geometry', () => {
    const xml =
      `<xdr:wsDr xmlns:xdr="x" xmlns:r="y">`
      + `<xdr:twoCellAnchor>`
      + `<xdr:from><xdr:col>4</xdr:col><xdr:colOff>111</xdr:colOff><xdr:row>31</xdr:row><xdr:rowOff>222</xdr:rowOff></xdr:from>`
      + `<xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>32</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:pic><xdr:blipFill><a:blip r:embed="rId7"/></xdr:blipFill></xdr:pic>`
      + `</xdr:twoCellAnchor>`
      + `<xdr:oneCellAnchor>`
      + `<xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>35</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="1" cy="1"/>`
      + `<xdr:pic><xdr:blipFill><a:blip r:embed="rId8"/></xdr:blipFill></xdr:pic>`
      + `</xdr:oneCellAnchor>`
      + `</xdr:wsDr>`

    const anchors = parseDrawingAnchors(xml)
    assert.equal(anchors.length, 2)
    assert.deepEqual(anchors[0], {
      kind: 'twoCellAnchor', fromCol: 4, fromRow: 31, toCol: 5, toRow: 32,
      embedId: 'rId7', isPicture: true,
    })
    assert.deepEqual(anchors[1], {
      kind: 'oneCellAnchor', fromCol: 4, fromRow: 35, toCol: null, toRow: null,
      embedId: 'rId8', isPicture: true,
    })
  })

  test('<colOff> is never mistaken for <col>', () => {
    const xml =
      `<xdr:wsDr><xdr:oneCellAnchor>`
      + `<xdr:from><xdr:colOff>999</xdr:colOff><xdr:col>4</xdr:col><xdr:rowOff>888</xdr:rowOff><xdr:row>31</xdr:row></xdr:from>`
      + `<xdr:pic><a:blip r:embed="rId1"/></xdr:pic>`
      + `</xdr:oneCellAnchor></xdr:wsDr>`
    const [anchor] = parseDrawingAnchors(xml)
    assert.equal(anchor.fromCol, 4)
    assert.equal(anchor.fromRow, 31)
  })

  test('a shape anchor is recorded as not a picture', () => {
    const xml =
      `<xdr:wsDr><xdr:twoCellAnchor>`
      + `<xdr:from><xdr:col>12</xdr:col><xdr:row>34</xdr:row></xdr:from>`
      + `<xdr:to><xdr:col>13</xdr:col><xdr:row>35</xdr:row></xdr:to>`
      + `<xdr:sp><xdr:txBody/></xdr:sp>`
      + `</xdr:twoCellAnchor></xdr:wsDr>`
    const [anchor] = parseDrawingAnchors(xml)
    assert.equal(anchor.isPicture, false)
    assert.equal(anchor.embedId, null)
  })

  test('absoluteAnchor carries no cell reference and is ignored', () => {
    const xml =
      `<xdr:wsDr><xdr:absoluteAnchor><xdr:pos x="0" y="0"/>`
      + `<xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:absoluteAnchor></xdr:wsDr>`
    assert.deepEqual(parseDrawingAnchors(xml), [])
  })

  test('tolerates a different namespace prefix', () => {
    const xml =
      `<wsDr><twoCellAnchor>`
      + `<from><col>4</col><row>31</row></from><to><col>5</col><row>32</row></to>`
      + `<pic><blipFill><blip r:embed="rId3"/></blipFill></pic>`
      + `</twoCellAnchor></wsDr>`
    const [anchor] = parseDrawingAnchors(xml)
    assert.equal(anchor.fromCol, 4)
    assert.equal(anchor.embedId, 'rId3')
  })

  test('an empty or absent drawing part yields no anchors', () => {
    assert.deepEqual(parseDrawingAnchors(''), [])
  })
})

describe('product images', () => {
  test('maps a twoCellAnchor picture in column E to its product row', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3, 'two'),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.representativeImages.length, 3)
    assert.deepEqual(result.data.products.map(p => p.representativeImage?.row), [32, 33, 34])
    assert.equal(result.data.products[0].representativeImage?.anchorKind, 'twoCellAnchor')
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
  })

  test('maps a oneCellAnchor picture just as well', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: anchorsFor(2, 'one'),
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.products[0].representativeImage?.anchorKind, 'oneCellAnchor')
    assert.equal(result.data.products[1].representativeImage?.anchorKind, 'oneCellAnchor')
  })

  test('handles a workbook mixing both anchor kinds, as production files do', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(4),
      anchors: [
        { kind: 'two', col: 4, row: 32, media: 'image1.png' },
        { kind: 'one', col: 4, row: 33, media: 'image2.jpeg' },
        { kind: 'two', col: 4, row: 34, media: 'image1.png' },
        { kind: 'one', col: 4, row: 35, media: 'image2.jpeg' },
      ],
      media: { 'image1.png': fakeImage(PNG_SIG), 'image2.jpeg': fakeImage(JPEG_SIG, 80, 7) },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))
    assert.deepEqual(data.products.map(p => p.representativeImage?.anchorKind), [
      'twoCellAnchor', 'oneCellAnchor', 'twoCellAnchor', 'oneCellAnchor',
    ])
    assert.deepEqual(data.products.map(p => p.representativeImage?.format), ['png', 'jpeg', 'png', 'jpeg'])
    assert.deepEqual(data.products.map(p => p.representativeImage?.mimeType), [
      'image/png', 'image/jpeg', 'image/png', 'image/jpeg',
    ])
  })

  test('extracts bytes, format, MIME and the source media path', async () => {
    const png = fakeImage(PNG_SIG, 128, 3)
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [{ kind: 'two', col: 4, row: 32, media: 'image9.png' }],
      media: { 'image9.png': png },
    })
    const image = expectOk(await parseBoePiWorkbook(wb)).data.products[0].representativeImage
    assert.ok(image)
    assert.equal(image?.part, 'xl/media/image9.png')
    assert.equal(image?.format, 'png')
    assert.equal(image?.mimeType, 'image/png')
    assert.equal(image?.extension, 'png')
    assert.equal(image?.byteLength, png.length)
    assert.deepEqual(Array.from(image?.bytes ?? []), Array.from(png))
    assert.equal(image?.anchorFromCol, 4)
    assert.equal(image?.anchorFromRow, 31)
  })

  test('sniffs the real format when the extension lies', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [{ kind: 'two', col: 4, row: 32, media: 'image1.png' }],
      media: { 'image1.png': fakeImage(JPEG_SIG, 64, 5) },
    })
    const image = expectOk(await parseBoePiWorkbook(wb)).data.products[0].representativeImage
    assert.equal(image?.extension, 'png')
    assert.equal(image?.format, 'jpeg')
    assert.equal(image?.mimeType, 'image/jpeg')
  })

  test('one media part anchored to several rows SHARES one byte buffer', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3, 'two', 'image1.png'),
    })
    const { products } = expectOk(await parseBoePiWorkbook(wb)).data
    const first = products[0].representativeImage?.bytes
    assert.ok(first)
    // Same part, so the identical buffer is handed out — read once, never copied.
    assert.equal(products[1].representativeImage?.bytes, first)
    assert.equal(products[2].representativeImage?.bytes, first)
    // Each row still gets its own record with its own row number.
    assert.deepEqual(products.map(p => p.representativeImage?.row), [32, 33, 34])
  })

  test('a picture outside column E is not a product image', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [
        { kind: 'two', col: 3, row: 32, media: 'image1.png' }, // column D
        { kind: 'two', col: 5, row: 33, media: 'image1.png' }, // column F
      ],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.representativeImages.length, 0)
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 2)
  })

  test('logos and footer artwork outside the product band are ignored', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [
        { kind: 'two', col: 4, row: 1, media: 'image1.png' },   // header logo
        { kind: 'two', col: 4, row: 7, media: 'image1.png' },   // signature block
        { kind: 'two', col: 4, row: 32, media: 'image1.png' },  // product
        { kind: 'two', col: 4, row: 33, media: 'image1.png' },  // product
        { kind: 'two', col: 4, row: 124, media: 'image1.png' }, // footer artwork
      ],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.representativeImages.length, 2)
    assert.deepEqual(result.data.representativeImages.map(i => i.row), [32, 33])
  })

  test('a shape anchored in column E is not treated as a picture', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [{ kind: 'two', col: 4, row: 32, picture: false }],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.representativeImages.length, 0)
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 1)
  })

  test('TEXT typed into column E is never mistaken for the image', async () => {
    const wb = buildPiWorkbook({
      products: [{
        name: 'Sample Chair', quantity: 1, cost: 100, material: 'M',
        imageText: 'refer attached drawing',
      }],
      anchors: [],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.products[0].representativeImage, null)
    assert.equal(result.data.representativeImages.length, 0)
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 1)
    // And that text does not leak into any product field.
    const values = Object.values(result.data.products[0])
    assert.equal(values.includes('refer attached drawing'), false)
  })

  test('a genuine row with no image blocks, once per row', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(1), // only row 32 gets a picture
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 2)
    const rows = result.blockingIssues
      .filter(i => i.code === 'PRODUCT_IMAGE_REQUIRED')
      .map(i => i.row)
    assert.deepEqual(rows, [33, 34])
  })

  test('two pictures on one row BLOCK — neither is chosen', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        { kind: 'two', col: 4, row: 32, media: 'imageA.png' },
        { kind: 'one', col: 4, row: 32, media: 'imageB.png' },
      ],
      media: { 'imageA.png': fakeImage(PNG_SIG, 64, 11), 'imageB.png': fakeImage(PNG_SIG, 96, 12) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_AMBIGUOUS'), 1)
    // Guessing would attach the wrong photograph to a commercial document, so
    // nothing is attached and nothing is added to the extracted image list.
    assert.equal(result.data.products[0].representativeImage, null)
    assert.equal(result.data.representativeImages.length, 0)
    assert.match(result.blockingIssues[0].message, /2 images/)
  })

  test('a relationship escaping the package is rejected, not read', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [{ kind: 'two', col: 4, row: 32, rawTarget: '../../../../etc/passwd' }],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countOf(result.warnings, 'PRODUCT_IMAGE_UNSAFE_PATH'), 1)
    assert.equal(result.data.products[0].representativeImage, null)
    // The warning explains WHY; the blocking issue is what stops a submission.
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 1)
  })

  test('a relationship pointing outside xl/media is rejected', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [{ kind: 'two', col: 4, row: 32, rawTarget: '../worksheets/sheet3.xml' }],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    const warning = result.warnings.find(w => w.code === 'PRODUCT_IMAGE_UNSAFE_PATH')
    assert.ok(warning, 'expected PRODUCT_IMAGE_UNSAFE_PATH')
    assert.equal(warning?.part, 'xl/worksheets/sheet3.xml')
    assert.equal(result.data.products[0].representativeImage, null)
  })

  test('a relationship to a part that is not in the archive is unreadable', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [{ kind: 'two', col: 4, row: 32, rawTarget: '../media/absent.png' }],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(countOf(result.warnings, 'PRODUCT_IMAGE_UNREADABLE'), 1)
    assert.equal(result.data.products[0].representativeImage, null)
    // "Unreadable" is blocking too — the row still has no usable image.
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 1)
  })

  test('a Master sheet with no drawing part is reported, not fatal', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      includeDrawing: false,
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.equal(result.data.template.drawingPart, null)
    assert.equal(countOf(result.warnings, 'DRAWING_PART_MISSING'), 1)
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 2)
  })

  test('the harvest helpers can be driven directly, for later phases', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [
        { kind: 'two', col: 4, row: 32, media: 'image1.png' },
        { kind: 'one', col: 4, row: 33, media: 'image1.png' },
        { kind: 'two', col: 4, row: 1, media: 'image1.png' }, // outside the band
      ],
    })
    const opened = await openPiArchive(wb)
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('unreachable')

    const drawingPart = resolveDrawingPart(opened.archive.entries, 'xl/worksheets/sheet3.xml')
    assert.equal(drawingPart, 'xl/drawings/drawing1.xml')

    const harvest = harvestProductImages({
      entries: opened.archive.entries,
      drawingPart: drawingPart!,
      representativeColumn: 4,
      customizationColumn: 10,
      firstRow: FIRST_PRODUCT_ROW,
      lastRow: LAST_PRODUCT_ROW,
    })
    assert.deepEqual([...harvest.representativeByRow.keys()].sort((a, b) => a - b), [32, 33])
    assert.equal(harvest.issues.length, 0)
  })
})

// ══ 7. Purity ════════════════════════════════════════════════════════════════

describe('the parser is read-only', () => {
  test('the input bytes are byte-for-byte unchanged after a successful parse', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(5), anchors: anchorsFor(5) })
    const before = Uint8Array.from(wb)
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, true)
    assert.equal(wb.length, before.length)
    assert.deepEqual(Array.from(wb), Array.from(before))
  })

  test('the input bytes are unchanged after a FAILED parse too', async () => {
    const wb = buildPiWorkbook({ headerOverrides: { A31: 'SKU' }, products: inventProducts(2) })
    const before = Uint8Array.from(wb)
    const result = await parseBoePiWorkbook(wb)
    assert.equal(result.ok, false)
    assert.deepEqual(Array.from(wb), Array.from(before))
  })

  test('parsing the same workbook twice gives the same answer', async () => {
    const wb = buildPiWorkbook({ products: inventProducts(6), anchors: anchorsFor(6) })
    const first = expectOk(await parseBoePiWorkbook(wb))
    const second = expectOk(await parseBoePiWorkbook(Uint8Array.from(wb)))
    assert.deepEqual(
      first.data.products.map(p => [p.row, p.productName, p.lineTotal, p.itemSequence]),
      second.data.products.map(p => [p.row, p.productName, p.lineTotal, p.itemSequence]),
    )
    assert.deepEqual(codesOf(first.warnings), codesOf(second.warnings))
  })

  test('a clean workbook produces no warnings at all', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(7),
      anchors: anchorsFor(7),
      commercial: { I115: num(0) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    assert.deepEqual(codesOf(result.warnings), [])
  })
})

// ══ 9. Customization images (column K) ═══════════════════════════════════════
//
// Column E is the product. Column K is what should DIFFER from it. The two are
// read from the same drawing part by the same walk, and everything below exists
// to prove they never trade places: a customization image must never satisfy
// the representative requirement, and a representative image must never appear
// as a customization.
//
// Column K also holds the customization TEXT. A cell value is not a picture and
// a picture is not a cell value, so a row can carry both, either, or neither.

/** A column-K picture anchor. col 10 is K. */
const customizationAnchor = (
  row: number,
  media: string,
  kind: 'one' | 'two' = 'two',
): AnchorFixture => ({ kind, col: 10, row, media })

describe('customization images', () => {
  test('column E and column K are classified separately', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [
        ...anchorsFor(2, 'two', 'rep.png'),
        customizationAnchor(FIRST_PRODUCT_ROW, 'cust.png'),
      ],
      media: { 'rep.png': fakeImage(PNG_SIG), 'cust.png': fakeImage(JPEG_SIG, 64, 9) },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(data.representativeImages.length, 2)
    assert.equal(data.customizationImages.length, 1)
    assert.equal(data.products[0].representativeImage?.part, 'xl/media/rep.png')
    assert.equal(data.products[0].representativeImage?.role, 'representative')
    assert.equal(data.products[0].customizationImages[0].part, 'xl/media/cust.png')
    assert.equal(data.products[0].customizationImages[0].role, 'customization')
  })

  test('a customization image never satisfies the representative requirement', async () => {
    // Column K only: the row still has no product photograph.
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [customizationAnchor(FIRST_PRODUCT_ROW, 'cust.png')],
      media: { 'cust.png': fakeImage(PNG_SIG) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.products[0].representativeImage, null)
    assert.equal(result.data.products[0].customizationImages.length, 1)
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_REQUIRED'), 1)
  })

  test('customization text and a customization image coexist on one row', async () => {
    const wb = buildPiWorkbook({
      products: [{ ...inventProducts(1)[0], customization: 'Brass handles\nMatte finish' }],
      anchors: [...anchorsFor(1), customizationAnchor(FIRST_PRODUCT_ROW, 'cust.png')],
      media: { 'image1.png': fakeImage(PNG_SIG), 'cust.png': fakeImage(PNG_SIG, 64, 3) },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(data.products[0].customization, 'Brass handles\nMatte finish')
    assert.equal(data.products[0].customizationImages.length, 1)
  })

  test('text in column K is never read as an image', async () => {
    const wb = buildPiWorkbook({
      products: [{ ...inventProducts(1)[0], customization: 'Taller by 6 inches' }],
      anchors: anchorsFor(1),
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(data.products[0].customization, 'Taller by 6 inches')
    assert.deepEqual(data.products[0].customizationImages, [])
    assert.equal(data.customizationImages.length, 0)
  })

  test('zero customization images is silent — no warning, no blocking issue', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: anchorsFor(3),
      commercial: { I115: num(0) },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.deepEqual(result.data.products.map(p => p.customizationImages.length), [0, 0, 0])
    assert.deepEqual(codesOf(result.warnings), [])
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
  })

  test('one customization image on a row', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [...anchorsFor(2), customizationAnchor(FIRST_PRODUCT_ROW + 1, 'cust.png')],
      media: { 'image1.png': fakeImage(PNG_SIG), 'cust.png': fakeImage(PNG_SIG, 64, 4) },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.deepEqual(data.products.map(p => p.customizationImages.length), [0, 1])
    assert.equal(data.customizationImages.length, 1)
    assert.equal(data.customizationImages[0].row, FIRST_PRODUCT_ROW + 1)
  })

  test('several customization images on ONE row are all kept, and none blocks', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        ...anchorsFor(1),
        customizationAnchor(FIRST_PRODUCT_ROW, 'c1.png'),
        customizationAnchor(FIRST_PRODUCT_ROW, 'c2.png'),
        customizationAnchor(FIRST_PRODUCT_ROW, 'c3.png'),
      ],
      media: {
        'image1.png': fakeImage(PNG_SIG),
        'c1.png': fakeImage(PNG_SIG, 64, 11),
        'c2.png': fakeImage(PNG_SIG, 64, 12),
        'c3.png': fakeImage(PNG_SIG, 64, 13),
      },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(result.data.products[0].customizationImages.length, 3)
    // The representative-image ambiguity rule applies to column E ONLY.
    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_AMBIGUOUS'), 0)
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
  })

  test('several representative images on one row still block', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        { kind: 'two', col: 4, row: FIRST_PRODUCT_ROW, media: 'image1.png' },
        { kind: 'one', col: 4, row: FIRST_PRODUCT_ROW, media: 'c1.png' },
        customizationAnchor(FIRST_PRODUCT_ROW, 'c2.png'),
      ],
      media: {
        'image1.png': fakeImage(PNG_SIG),
        'c1.png': fakeImage(PNG_SIG, 64, 21),
        'c2.png': fakeImage(PNG_SIG, 64, 22),
      },
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(countBlocking(result.blockingIssues, 'PRODUCT_IMAGE_AMBIGUOUS'), 1)
    // …and the customization image on the same row is unaffected by it.
    assert.equal(result.data.products[0].customizationImages.length, 1)
  })

  test('both anchor kinds work in column K', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        ...anchorsFor(1),
        customizationAnchor(FIRST_PRODUCT_ROW, 'c1.png', 'one'),
        customizationAnchor(FIRST_PRODUCT_ROW, 'c2.png', 'two'),
      ],
      media: {
        'image1.png': fakeImage(PNG_SIG),
        'c1.png': fakeImage(PNG_SIG, 64, 31),
        'c2.png': fakeImage(JPEG_SIG, 64, 32),
      },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.deepEqual(
      data.products[0].customizationImages.map(i => i.anchorKind),
      ['oneCellAnchor', 'twoCellAnchor'],
    )
    assert.deepEqual(data.products[0].customizationImages.map(i => i.format), ['png', 'jpeg'])
  })

  test('a media part used as BOTH roles is read once and shared by reference', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        ...anchorsFor(1, 'two', 'shared.png'),
        customizationAnchor(FIRST_PRODUCT_ROW, 'shared.png'),
      ],
      media: { 'shared.png': fakeImage(PNG_SIG) },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    const representative = data.products[0].representativeImage
    const customization = data.products[0].customizationImages[0]
    assert.equal(representative?.bytes, customization.bytes, 'one buffer, two records')
    assert.notEqual(representative?.role, customization.role, 'and two distinct roles')
  })

  test('one customization photograph reused across rows is shared, and counted per row', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: [
        ...anchorsFor(3),
        customizationAnchor(FIRST_PRODUCT_ROW, 'shared.png'),
        customizationAnchor(FIRST_PRODUCT_ROW + 1, 'shared.png'),
        customizationAnchor(FIRST_PRODUCT_ROW + 2, 'shared.png'),
      ],
      media: { 'image1.png': fakeImage(PNG_SIG), 'shared.png': fakeImage(PNG_SIG, 64, 41) },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(data.customizationImages.length, 3)
    assert.equal(data.customizationImages[0].bytes, data.customizationImages[2].bytes)
    assert.deepEqual(data.customizationImages.map(i => i.row), [32, 33, 34])
  })

  test('an unreadable customization image warns, and does NOT block', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        ...anchorsFor(1),
        { kind: 'two', col: 10, row: FIRST_PRODUCT_ROW, rawTarget: '../media/absent.png' },
      ],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(countOf(result.warnings, 'CUSTOMIZATION_IMAGE_UNREADABLE'), 1)
    assert.equal(countOf(result.warnings, 'PRODUCT_IMAGE_UNREADABLE'), 0,
      'a customization failure must not borrow the representative code')
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.equal(result.data.products[0].representativeImage?.row, FIRST_PRODUCT_ROW)
  })

  test('an unsafe customization relationship warns, and does NOT block', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(1),
      anchors: [
        ...anchorsFor(1),
        { kind: 'one', col: 10, row: FIRST_PRODUCT_ROW, rawTarget: '../../../../etc/passwd' },
      ],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(countOf(result.warnings, 'CUSTOMIZATION_IMAGE_UNSAFE_PATH'), 1)
    assert.equal(countOf(result.warnings, 'PRODUCT_IMAGE_UNSAFE_PATH'), 0)
    assert.deepEqual(blockingCodes(result.blockingIssues), [])
    assert.equal(result.data.customizationImages.length, 0, 'the unsafe target is not read')
  })

  test('the warning names the row the customization image belongs to', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(3),
      anchors: [
        ...anchorsFor(3),
        { kind: 'two', col: 10, row: FIRST_PRODUCT_ROW + 2, rawTarget: '../media/absent.png' },
      ],
    })
    const result = expectOk(await parseBoePiWorkbook(wb))
    const warning = result.warnings.find(w => w.code === 'CUSTOMIZATION_IMAGE_UNREADABLE')

    assert.equal(warning?.row, FIRST_PRODUCT_ROW + 2, 'never attributed to another product')
  })

  test('decorative and wrong-column pictures are still excluded', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [
        ...anchorsFor(2),
        { kind: 'two', col: 1, row: 1, media: 'logo.png' },
        { kind: 'one', col: 10, row: 7, media: 'signature.png' },
        { kind: 'two', col: 10, row: LAST_PRODUCT_ROW + 13, media: 'footer.png' },
        { kind: 'two', col: 7, row: FIRST_PRODUCT_ROW, media: 'stray.png' },
      ],
      media: {
        'image1.png': fakeImage(PNG_SIG),
        'logo.png': fakeImage(PNG_SIG, 64, 51),
        'signature.png': fakeImage(PNG_SIG, 64, 52),
        'footer.png': fakeImage(PNG_SIG, 64, 53),
        'stray.png': fakeImage(PNG_SIG, 64, 54),
      },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.equal(data.customizationImages.length, 0,
      'a column-K picture outside the product band is decoration')
    assert.equal(data.representativeImages.length, 2)
  })

  test('a customization image is never attributed to a neighbouring row', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(4),
      anchors: [
        ...anchorsFor(4),
        customizationAnchor(FIRST_PRODUCT_ROW + 1, 'c1.png'),
        customizationAnchor(FIRST_PRODUCT_ROW + 3, 'c2.png'),
      ],
      media: {
        'image1.png': fakeImage(PNG_SIG),
        'c1.png': fakeImage(PNG_SIG, 64, 61),
        'c2.png': fakeImage(PNG_SIG, 64, 62),
      },
    })
    const { data } = expectOk(await parseBoePiWorkbook(wb))

    assert.deepEqual(data.products.map(p => p.customizationImages.length), [0, 1, 0, 1])
    assert.equal(data.products[1].customizationImages[0].part, 'xl/media/c1.png')
    assert.equal(data.products[3].customizationImages[0].part, 'xl/media/c2.png')
  })

  test('the input workbook bytes are not modified', async () => {
    const wb = buildPiWorkbook({
      products: inventProducts(2),
      anchors: [...anchorsFor(2), customizationAnchor(FIRST_PRODUCT_ROW, 'c1.png')],
      media: { 'image1.png': fakeImage(PNG_SIG), 'c1.png': fakeImage(PNG_SIG, 64, 71) },
    })
    const copy = Uint8Array.from(wb)
    await parseBoePiWorkbook(wb)
    assert.deepEqual(wb, copy)
  })
})
