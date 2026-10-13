/**
 * The BOE PI parser.
 *
 * FIXTURES ARE BUILT IN CODE. No real Proforma Invoice is committed, and no
 * customer name, price, total or photograph from one appears here — every
 * workbook below is assembled byte by byte from synthetic values. The two real
 * PIs were used once, locally, to confirm the product counts; their contents are
 * not in this repository.
 *
 * The rule these exist to protect is the section boundary. A BOE PI keeps its
 * unused template rows, and those rows carry convincing product names,
 * quantities and an unbroken internal sequence. Getting the boundary wrong does
 * not throw — it silently imports products that were never ordered.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/piImport.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import {
  parsePiWorkbook, toPiPreview, PiParseError,
  PI_FIRST_PRODUCT_ROW, PI_HEADER_ROW,
} from './piImport'

// ─── Synthetic workbook builder ───────────────────────────────────────────────

type Row = {
  row: number
  hidden?: boolean
  /** Column A. `null` = absent; `{ formula, cached }` models the PI's code cell. */
  code?: string | null | { formula: true; cached: string | null }
  name?: string | null
  qty?: string | null
  dim?: string | null
  /** E / F / K free text. */
  e?: string | null
  f?: string | null
  k?: string | null
  /** Column H — presence only; the parser never reads the value. */
  priced?: boolean
  /** Column J internal sequence. */
  seq?: string | null
}

type ImageSpec = {
  /** 1-based sheet row the anchor points at. */
  row: number
  /** 0-based column. 4 = E (a product photo). Anything else is a logo. */
  col?: number
  /** Distinct byte content; identical strings produce identical bytes. */
  content: string
  ext?: 'png' | 'jpeg'
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inlineCell(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`
}

function buildSheet(rows: Row[], piNumber: string | null, header: Record<string, string>): string {
  const parts: string[] = []

  // PI number block
  if (piNumber !== null) {
    parts.push(`<row r="20">${inlineCell('A20', 'PI No:')}${inlineCell('B20', piNumber)}</row>`)
  }

  // header row
  const headerCells = Object.entries(header)
    .map(([col, text]) => inlineCell(`${col}${PI_HEADER_ROW}`, text)).join('')
  parts.push(`<row r="${PI_HEADER_ROW}">${headerCells}</row>`)

  for (const r of rows) {
    const cells: string[] = []

    if (r.code && typeof r.code === 'object') {
      // A formula cell: cached result present or absent.
      cells.push(
        r.code.cached == null
          ? `<c r="A${r.row}" t="str"><f>CONCAT(X,Y)</f></c>`
          : `<c r="A${r.row}" t="str"><f>CONCAT(X,Y)</f><v>${esc(r.code.cached)}</v></c>`,
      )
    } else if (typeof r.code === 'string') {
      cells.push(inlineCell(`A${r.row}`, r.code))
    }

    if (r.name) cells.push(inlineCell(`B${r.row}`, r.name))
    if (r.qty)  cells.push(`<c r="C${r.row}"><v>${r.qty}</v></c>`)
    if (r.dim)  cells.push(inlineCell(`D${r.row}`, r.dim))
    if (r.e)    cells.push(inlineCell(`E${r.row}`, r.e))
    if (r.f)    cells.push(inlineCell(`F${r.row}`, r.f))
    // Column H carries a number in a real PI. Its VALUE is irrelevant here and
    // the parser must never read it — only that the cell exists.
    if (r.priced) cells.push(`<c r="H${r.row}"><v>1234</v></c>`)
    // Column I total — present so the tests can assert it never escapes.
    if (r.priced) cells.push(`<c r="I${r.row}"><v>99999</v></c>`)
    if (r.k)    cells.push(inlineCell(`K${r.row}`, r.k))
    if (r.seq)  cells.push(inlineCell(`J${r.row}`, r.seq))

    parts.push(`<row r="${r.row}"${r.hidden ? ' hidden="1"' : ''}>${cells.join('')}</row>`)
  }

  return `<?xml version="1.0"?><worksheet xmlns:r="http://x"><sheetData>${parts.join('')}</sheetData>`
    + `<drawing r:id="rId1"/></worksheet>`
}

function buildWorkbook(opts: {
  rows: Row[]
  images?: ImageSpec[]
  piNumber?: string | null
  sheetName?: string
  header?: Record<string, string>
}): Uint8Array {
  const sheetName = opts.sheetName ?? 'Master'
  const header = opts.header ?? {
    A: 'Code', B: 'Name', C: 'Quantity', D: 'Dimension in inches & Shape',
    E: 'Representative Image', H: 'Cost per piece (INR)', I: 'Total Cost (INR)',
  }
  const images = opts.images ?? []

  // Distinct content → one media part. Two anchors with the same content still
  // produce two media FILES, which is what a real PI does and what forces the
  // parser to hash bytes rather than trust filenames.
  const files: Record<string, Uint8Array> = {}
  const drawingRels: string[] = []
  const anchors: string[] = []

  images.forEach((img, i) => {
    const ext = img.ext ?? 'png'
    const mediaName = `image${i + 1}.${ext}`
    files[`xl/media/${mediaName}`] = strToU8(img.content)
    drawingRels.push(
      `<Relationship Id="rIdImg${i}" Type="http://img" Target="../media/${mediaName}"/>`,
    )
    anchors.push(
      `<xdr:twoCellAnchor><xdr:from><xdr:col>${img.col ?? 4}</xdr:col><xdr:colOff>0</xdr:colOff>`
      + `<xdr:row>${img.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:pic><xdr:blipFill><a:blip r:embed="rIdImg${i}"/></xdr:blipFill></xdr:pic>`
      + `</xdr:twoCellAnchor>`,
    )
  })

  files['[Content_Types].xml'] = strToU8('<?xml version="1.0"?><Types/>')
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0"?><workbook xmlns:r="http://x"><sheets>`
    + `<sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships>`
    + `<Relationship Id="rId1" Type="http://sheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  )
  files['xl/worksheets/sheet1.xml'] = strToU8(
    buildSheet(opts.rows, opts.piNumber === undefined ? 'MS 347' : opts.piNumber, header),
  )
  files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships>`
    + `<Relationship Id="rId1" Type="http://drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  )
  files['xl/drawings/drawing1.xml'] = strToU8(
    `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://xdr" xmlns:a="http://a" xmlns:r="http://r">`
    + anchors.join('') + `</xdr:wsDr>`,
  )
  files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships>${drawingRels.join('')}</Relationships>`,
  )

  return zipSync(files)
}

/** N genuine product rows, priced and visible, each with a sequence. */
function genuineRows(count: number, from = PI_FIRST_PRODUCT_ROW): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    row: from + i,
    code: { formula: true as const, cached: `MS347-B${String(i + 1).padStart(3, '0')}` },
    name: `Product ${i + 1}`,
    qty: String(i + 2),
    dim: '24 x 24 x 30',
    priced: true,
    seq: `B${String(i + 1).padStart(3, '0')}`,
  }))
}

/** Residual template rows: hidden and unpriced, but otherwise convincing. */
function residualRows(count: number, from: number, startSeq: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    row: from + i,
    hidden: true,
    code: { formula: true as const, cached: `MS347-B${String(startSeq + i).padStart(3, '0')}` },
    name: `Old template product ${i + 1}`,
    qty: '7',
    dim: '18 x 18 x 30',
    priced: false,
    seq: `B${String(startSeq + i).padStart(3, '0')}`,
  }))
}

const imagesFor = (rows: number[], contentPrefix = 'photo') =>
  rows.map(r => ({ row: r, col: 4, content: `${contentPrefix}-${r}` }))

// ─── 1. Sheet and header validation ───────────────────────────────────────────

describe('sheet and header recognition', () => {
  test('accepts the Master sheet with the expected header row', () => {
    const wb = buildWorkbook({ rows: genuineRows(3), images: imagesFor([32, 33, 34]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.length, 3)
  })

  test('matches the sheet name case-insensitively', () => {
    const wb = buildWorkbook({ rows: genuineRows(2), images: imagesFor([32, 33]), sheetName: 'master' })
    assert.equal(parsePiWorkbook(wb).products.length, 2)
  })

  test('rejects a workbook with no Master sheet, naming what it found', () => {
    const wb = buildWorkbook({ rows: genuineRows(2), sheetName: 'Sheet1' })
    assert.throws(() => parsePiWorkbook(wb), (e: Error) => {
      assert.ok(e instanceof PiParseError)
      assert.match(e.message, /no "Master" sheet/)
      assert.match(e.message, /Sheet1/)
      return true
    })
  })

  test('rejects a workbook whose product table is not at row 31', () => {
    const wb = buildWorkbook({
      rows: genuineRows(2),
      header: { A: 'Item', B: 'Description', C: 'Qty', D: 'Size' },
    })
    assert.throws(() => parsePiWorkbook(wb), /layout is not supported/)
  })

  test('rejects something that is not a zip at all', () => {
    assert.throws(() => parsePiWorkbook(strToU8('this is a CSV,not,xlsx')), /not a readable \.xlsx/)
  })

  test('rejects a PI with no number in B20', () => {
    const wb = buildWorkbook({ rows: genuineRows(2), piNumber: null })
    assert.throws(() => parsePiWorkbook(wb), /no number in B20/)
  })
})

// ─── 2. The section boundary ──────────────────────────────────────────────────

describe('product-section boundary', () => {
  test('stops at the first hidden, unpriced row — the template trap', () => {
    // The residual rows carry names, quantities, dimensions AND an unbroken
    // sequence. Only hidden+unpriced separates them.
    const wb = buildWorkbook({
      rows: [...genuineRows(20), ...residualRows(19, 52, 21)],
      images: imagesFor(Array.from({ length: 20 }, (_, i) => 32 + i)),
    })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.length, 20)
    assert.equal(result.lastRow, 51)
  })

  test('the internal sequence alone would over-read — proving why J is not the rule', () => {
    const rows = [...genuineRows(12), ...residualRows(12, 44, 13)]
    // Every row 32..55 has a valid, strictly incrementing J token.
    const allHaveSequence = rows.every(r => /^B\d{3}$/.test(r.seq ?? ''))
    assert.ok(allHaveSequence, 'fixture must reproduce the unbroken template sequence')
    const wb = buildWorkbook({ rows, images: imagesFor(Array.from({ length: 12 }, (_, i) => 32 + i)) })
    assert.equal(parsePiWorkbook(wb).products.length, 12)
  })

  test('residual rows are reported, not silently dropped', () => {
    const wb = buildWorkbook({
      rows: [...genuineRows(5), ...residualRows(6, 37, 6)],
      images: imagesFor([32, 33, 34, 35, 36]),
    })
    const w = parsePiWorkbook(wb).warnings.find(x => x.code === 'residual_rows_ignored')
    assert.ok(w, 'the template trap must be visible to the user')
    assert.match(w.message, /6 unused template rows/)
  })

  test('when the two signals disagree, it stops at the EARLIER boundary and says so', () => {
    // Row 37 is visible but unpriced; rows 38+ are hidden. Priced-boundary = 36,
    // hidden-boundary = 37. Conservative stop is 36.
    const rows: Row[] = [
      ...genuineRows(5),
      { row: 37, code: 'X-006', name: 'Ambiguous', qty: '2', dim: '10 x 10', priced: false, seq: 'B006' },
      ...residualRows(4, 38, 7),
    ]
    const wb = buildWorkbook({ rows, images: imagesFor([32, 33, 34, 35, 36]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.lastRow, 36)
    assert.equal(result.products.length, 5)
    const w = result.warnings.find(x => x.code === 'boundary_disagreement')
    assert.ok(w, 'a disagreement must be surfaced, never resolved silently')
    assert.match(w.message, /disagree/)
  })

  test('a fully empty sheet under the header is rejected rather than imported as nothing', () => {
    const wb = buildWorkbook({ rows: [] })
    assert.throws(() => parsePiWorkbook(wb), /No product rows/)
  })
})

// ─── 3. Product code ──────────────────────────────────────────────────────────

describe('product code', () => {
  test('uses the cached formula result and keeps it as text', () => {
    const wb = buildWorkbook({ rows: genuineRows(2), images: imagesFor([32, 33]) })
    const [first] = parsePiWorkbook(wb).products
    assert.equal(first.code, 'MS347-B001')
    assert.equal(typeof first.code, 'string')
  })

  test('derives the code from PI number + sequence when the cache is missing, and warns', () => {
    const rows = genuineRows(2)
    rows[0].code = { formula: true, cached: null }
    const wb = buildWorkbook({ rows, images: imagesFor([32, 33]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products[0].code, 'MS 347 B001')
    const w = result.warnings.find(x => x.code === 'derived_code' && x.row === 32)
    assert.ok(w, 'a guessed identity must always be flagged')
  })

  test('a repeated code is warned about, and both rows are kept', () => {
    const rows = genuineRows(3)
    rows[2].code = { formula: true, cached: 'MS347-B001' }
    const wb = buildWorkbook({ rows, images: imagesFor([32, 33, 34]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.length, 3)
    const w = result.warnings.find(x => x.code === 'duplicate_code')
    assert.ok(w)
    assert.match(w.message, /repeats row 32/)
  })

  test('a broken internal sequence warns but does not end the section', () => {
    const rows = genuineRows(4)
    rows[2].seq = 'B099'
    const wb = buildWorkbook({ rows, images: imagesFor([32, 33, 34, 35]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.length, 4, 'sequence is an integrity signal, not the boundary')
    assert.ok(result.warnings.some(x => x.code === 'sequence_break'))
  })
})

// ─── 4. Images ────────────────────────────────────────────────────────────────

describe('image extraction', () => {
  test('matches a column-E anchor to its product row', () => {
    const wb = buildWorkbook({ rows: genuineRows(3), images: imagesFor([32, 33, 34]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.filter(p => p.imageHash).length, 3)
    // Each distinct content becomes one stored image.
    assert.equal(result.images.size, 3)
  })

  test('ignores logos and footer graphics outside column E', () => {
    const wb = buildWorkbook({
      rows: genuineRows(2),
      images: [
        { row: 1, col: 0, content: 'company-logo' },
        { row: 7, col: 2, content: 'banner' },
        { row: 124, col: 5, content: 'footer-graphic' },
        ...imagesFor([32, 33]),
      ],
    })
    const result = parsePiWorkbook(wb)
    assert.equal(result.images.size, 2, 'only column-E anchors are product photographs')
    assert.equal(result.products.filter(p => p.imageHash).length, 2)
  })

  test('ignores column-E anchors outside the product section', () => {
    const wb = buildWorkbook({
      rows: [...genuineRows(2), ...residualRows(3, 34, 3)],
      images: [...imagesFor([32, 33]), { row: 35, col: 4, content: 'residual-photo' }],
    })
    const result = parsePiWorkbook(wb)
    assert.equal(result.images.size, 2)
  })

  test('stores ONE copy when a photograph is reused under different media names', () => {
    // Two media files, byte-identical. Hashing the bytes is the only thing that
    // collapses them; trusting filenames would store the same photo twice.
    const wb = buildWorkbook({
      rows: genuineRows(3),
      images: [
        { row: 32, col: 4, content: 'same-bytes' },
        { row: 33, col: 4, content: 'same-bytes' },
        { row: 34, col: 4, content: 'different' },
      ],
    })
    const result = parsePiWorkbook(wb)
    assert.equal(result.images.size, 2, 'identical bytes must collapse to one stored object')
    const shared = [...result.images.values()].find(i => i.rows.length === 2)
    assert.ok(shared, 'the reused image must record both rows')
    assert.deepEqual(shared.rows, [32, 33])
    // and both products point at the same hash
    assert.equal(result.products[0].imageHash, result.products[1].imageHash)
  })

  test('a product with no photograph is a warning, not an invalid product', () => {
    const wb = buildWorkbook({ rows: genuineRows(3), images: imagesFor([32, 34]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.length, 3, 'the product is still imported')
    assert.equal(result.products[1].imageHash, null)
    const w = result.warnings.find(x => x.code === 'missing_image' && x.row === 33)
    assert.ok(w)
  })
})

// ─── 5. Notes, and what must never be imported ────────────────────────────────

describe('specification note', () => {
  test('keeps a meaningful multi-word instruction from the image area', () => {
    const rows = genuineRows(1)
    rows[0].e = 'Matt polish finish'
    const wb = buildWorkbook({ rows, images: imagesFor([32]) })
    assert.equal(parsePiWorkbook(wb).products[0].specNote, 'Matt polish finish')
  })

  test('drops a bare numeric image-area value — layout bookkeeping, not a note', () => {
    const rows = genuineRows(1)
    rows[0].e = '3'
    rows[0].f = '12'
    const wb = buildWorkbook({ rows, images: imagesFor([32]) })
    assert.equal(parsePiWorkbook(wb).products[0].specNote, null)
  })

  test('includes column K when it carries an operational instruction', () => {
    // K was classified before being trusted: in the sample carrying it, every
    // value was a finish/fabric instruction with no commercial or personal
    // content.
    const rows = genuineRows(1)
    rows[0].k = 'Fabric as per approved shade card'
    const wb = buildWorkbook({ rows, images: imagesFor([32]) })
    assert.equal(parsePiWorkbook(wb).products[0].specNote, 'Fabric as per approved shade card')
  })

  test('combines E and K without repeating an identical value', () => {
    const rows = genuineRows(1)
    rows[0].e = 'Walnut finish'
    rows[0].k = 'Walnut finish'
    const wb = buildWorkbook({ rows, images: imagesFor([32]) })
    assert.equal(parsePiWorkbook(wb).products[0].specNote, 'Walnut finish')
  })

  test('normalizes whitespace without changing meaning', () => {
    const rows = genuineRows(1)
    rows[0].dim = '24  x   24\n x 30'
    const wb = buildWorkbook({ rows, images: imagesFor([32]) })
    assert.equal(parsePiWorkbook(wb).products[0].dimensions, '24 x 24 x 30')
  })

  test('a missing dimension warns but keeps the product', () => {
    const rows = genuineRows(2)
    rows[1].dim = null
    const wb = buildWorkbook({ rows, images: imagesFor([32, 33]) })
    const result = parsePiWorkbook(wb)
    assert.equal(result.products.length, 2)
    assert.ok(result.warnings.some(x => x.code === 'missing_dimensions' && x.row === 33))
  })
})

describe('commercial content never leaves the parser', () => {
  test('no price, total or cost field appears anywhere in the result', () => {
    const wb = buildWorkbook({ rows: genuineRows(4), images: imagesFor([32, 33, 34, 35]) })
    const result = parsePiWorkbook(wb)
    // The fixture puts 1234 in H and 99999 in I on every row.
    const serialized = JSON.stringify(result.products)
    assert.ok(!serialized.includes('1234'), 'a cost value reached the parser output')
    assert.ok(!serialized.includes('99999'), 'a total reached the parser output')
    for (const product of result.products) {
      assert.deepEqual(
        Object.keys(product).sort(),
        ['code', 'dimensions', 'imageHash', 'name', 'quantity', 'row', 'specNote'],
      )
    }
  })

  test('the client preview drops the image bytes and keeps no commercial key', () => {
    const wb = buildWorkbook({ rows: genuineRows(3), images: imagesFor([32, 33, 34]) })
    const preview = toPiPreview(parsePiWorkbook(wb))
    const serialized = JSON.stringify(preview)
    assert.ok(!serialized.includes('1234') && !serialized.includes('99999'))
    assert.ok(!/bytes/i.test(serialized), 'image bytes must not reach the browser before confirmation')
    assert.equal(preview.productCount, 3)
    assert.equal(preview.distinctImageCount, 3)
  })

  test('quantity is a number and the code stays text', () => {
    const wb = buildWorkbook({ rows: genuineRows(2), images: imagesFor([32, 33]) })
    const [p] = parsePiWorkbook(wb).products
    assert.equal(typeof p.quantity, 'number')
    assert.equal(p.quantity, 2)
    assert.equal(typeof p.code, 'string')
  })
})
