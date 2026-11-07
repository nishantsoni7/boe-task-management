/**
 * Excel preview reader: a real .xlsx is built with ExcelJS, written to bytes
 * and read back, so merges, widths, styles and pictures are checked end to end.
 *
 * Run: npm run test:file -- src/lib/attachments/excelPreview.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { readWorkbookPreview, formatNumber, cssColor, colWidthPx, rowHeightPx, PREVIEW_MAX_ROWS } from './excelPreview'

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function sampleWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Master')
  ws.getColumn(1).width = 20
  ws.getColumn(2).width = 10
  ws.getColumn(3).hidden = true
  ws.getColumn(4).width = 12
  ws.getRow(1).height = 30

  ws.mergeCells('A1:B1')
  const title = ws.getCell('A1')
  title.value = 'Best of Exports'
  title.font = { bold: true, size: 16, name: 'Calibri', color: { argb: 'FF276247' } }
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  title.border = { bottom: { style: 'medium', color: { argb: 'FF000000' } } }

  ws.getCell('A2').value = 'Wooden Chair'
  ws.getCell('B2').value = 12345.5
  ws.getCell('B2').numFmt = '#,##0.00'
  ws.getCell('D2').value = 0.18
  ws.getCell('D2').numFmt = '0%'
  ws.getCell('A3').value = { formula: 'B2*2', result: 24691 }
  ws.getCell('B3').value = new Date(Date.UTC(2026, 10, 7))
  ws.getCell('D3').value = { richText: [{ text: 'Rich ' }, { text: 'text', font: { bold: true } }] }

  const imageId = wb.addImage({ buffer: PNG_1PX as unknown as ExcelJS.Buffer, extension: 'png' })
  ws.addImage(imageId, { tl: { col: 1, row: 1 }, ext: { width: 40, height: 20 } })

  const hidden = wb.addWorksheet('Secret')
  hidden.state = 'hidden'
  hidden.getCell('A1').value = 'not shown'

  const bytes = await wb.xlsx.writeBuffer()
  return new Uint8Array(bytes as ArrayBuffer).buffer
}

describe('readWorkbookPreview', async () => {
  const sheets = await readWorkbookPreview(await sampleWorkbook())
  const s = sheets[0]

  test('visible sheets only', () => {
    assert.deepEqual(sheets.map(x => x.name), ['Master'])
  })

  test('column widths and row heights in pixels; hidden column takes no space', () => {
    assert.deepEqual(s.colWidths, [colWidthPx(20), colWidthPx(10), 0, colWidthPx(12)])
    assert.equal(s.rowHeights[0], rowHeightPx(30))
    assert.equal(s.rowHeights[1], rowHeightPx(15))
  })

  test('a merged title spans its cells and keeps its look', () => {
    const t = s.rows[0][0]!
    assert.equal(t.text, 'Best of Exports')
    assert.equal(t.colSpan, 2)
    assert.equal(s.rows[0][1], null)
    assert.equal(t.style.bold, true)
    assert.equal(t.style.fontSizePx, 21)
    assert.equal(t.style.color, '#276247')
    assert.equal(t.style.bg, '#F2F2F2')
    assert.equal(t.style.hAlign, 'center')
    assert.equal(t.style.vAlign, 'middle')
    assert.equal(t.style.borderBottom, '2px solid #000000')
  })

  test('numbers, percent, formula result, date and rich text read as Excel shows them', () => {
    assert.equal(s.rows[1][1]!.text, '12,345.50')
    assert.equal(s.rows[1][1]!.style.hAlign, 'right')
    assert.equal(s.rows[1][3]!.text, '18%')
    assert.equal(s.rows[2][0]!.text, '24691')
    assert.equal(s.rows[2][1]!.text, '07/11/2026')
    assert.equal(s.rows[2][3]!.text, 'Rich text')
  })

  test('unwrapped text runs over an empty neighbour', () => {
    assert.equal(s.rows[1][0]!.spill, false) // B2 has a number
    assert.equal(s.rows[2][3]!.spill, false) // last column, nothing to the right
  })

  test('the picture is placed at its anchor with its size', () => {
    assert.equal(s.images.length, 1)
    const img = s.images[0]
    assert.equal(img.mime, 'image/png')
    assert.equal(img.left, colWidthPx(20))
    assert.equal(img.top, rowHeightPx(30))
    assert.equal(img.width, 40)
    assert.equal(img.height, 20)
    assert.ok(img.data.length > 0)
  })

  test('not truncated', () => assert.equal(s.truncated, false))
})

test('a long sheet is cut at the row limit and says so', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Long')
  for (let r = 1; r <= PREVIEW_MAX_ROWS + 5; r++) ws.getCell(r, 1).value = r
  const bytes = await wb.xlsx.writeBuffer()
  const [s] = await readWorkbookPreview(new Uint8Array(bytes as ArrayBuffer).buffer)
  assert.equal(s.rows.length, PREVIEW_MAX_ROWS)
  assert.equal(s.truncated, true)
})

test('a file that is not a workbook throws, so the modal can fall back', async () => {
  await assert.rejects(readWorkbookPreview(new TextEncoder().encode('not a zip').buffer))
})

describe('formatNumber', () => {
  test('General keeps the number', () => assert.equal(formatNumber(30, 'General'), '30'))
  test('Indian grouping', () => assert.equal(formatNumber(1234567, '#,##,##0'), '12,34,567'))
  test('currency prefix', () => assert.equal(formatNumber(1500, '[$₹-4009] #,##0.00'), '₹1,500.00'))
  test('negative', () => assert.equal(formatNumber(-2.5, '0.0'), '-2.5'))
})

describe('cssColor never passes anything but a hex colour', () => {
  test('argb', () => assert.equal(cssColor({ argb: 'FF112233' }), '#112233'))
  test('theme with tint', () => assert.equal(cssColor({ theme: 1, tint: 0.5 }), '#808080'))
  test('junk', () => assert.equal(cssColor({ argb: 'red;background:url(x)' }), undefined))
})
