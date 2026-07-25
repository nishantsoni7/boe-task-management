/**
 * Order Request attachment type validation — Main PI is Excel-only.
 *
 * Covers the shared client gate `resolveUploadType` and `prepareAttachment`'s
 * type check + exact Main PI error message, plus the `accept` strings. Every
 * fixture is a tiny in-limit file, so `prepareAttachment` returns before any
 * image/canvas work — no DOM is needed.
 *
 * Run:
 *   npx tsx --test src/lib/orderRequestAttachments.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { File as NodeFile } from 'node:buffer'
import {
  resolveUploadType,
  prepareAttachment,
  MAIN_PI_ACCEPT,
  REFERENCE_ACCEPT,
} from './orderRequestAttachments'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS_MIME  = 'application/vnd.ms-excel'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// node:buffer File is a spec File; the lib's signature uses the DOM File type.
function f(name: string, type = ''): File {
  return new NodeFile(['x'], name, { type }) as unknown as File
}

describe('Main PI accepts Excel only', () => {
  test('.xlsx accepted', () => {
    assert.equal(resolveUploadType(f('pi.xlsx', XLSX_MIME), 'main_pi'), XLSX_MIME)
  })
  test('.xls accepted', () => {
    assert.equal(resolveUploadType(f('pi.xls', XLS_MIME), 'main_pi'), XLS_MIME)
  })
  test('uppercase .XLSX accepted', () => {
    assert.equal(resolveUploadType(f('PI.XLSX', XLSX_MIME), 'main_pi'), XLSX_MIME)
  })
  test('uppercase .XLS accepted', () => {
    assert.equal(resolveUploadType(f('PI.XLS', XLS_MIME), 'main_pi'), XLS_MIME)
  })
  test('valid Excel with EMPTY mime accepted by extension', () => {
    assert.equal(resolveUploadType(f('pi.xlsx', ''), 'main_pi'), XLSX_MIME)
    assert.equal(resolveUploadType(f('pi.xls', ''), 'main_pi'), XLS_MIME)
  })
  test('the two Excel mimes are interchangeable across extensions', () => {
    // Browsers/OSes sometimes report the "other" Excel mime for a workbook.
    assert.equal(resolveUploadType(f('pi.xlsx', XLS_MIME), 'main_pi'), XLSX_MIME)
    assert.equal(resolveUploadType(f('pi.xls', XLSX_MIME), 'main_pi'), XLS_MIME)
  })
})

describe('Main PI rejects everything non-Excel', () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['doc.pdf', 'application/pdf'],
    ['scan.jpg', 'image/jpeg'],
    ['scan.png', 'image/png'],
    ['sheet.csv', 'text/csv'],
    ['letter.docx', DOCX_MIME],
    ['bundle.zip', 'application/zip'],
  ]
  for (const [name, type] of rejected) {
    test(`${name} rejected as Main PI`, () => {
      assert.equal(resolveUploadType(f(name, type), 'main_pi'), null)
    })
  }
  test('misleading extension with clearly conflicting mime rejected (.xlsx that is really a PDF)', () => {
    assert.equal(resolveUploadType(f('pi.xlsx', 'application/pdf'), 'main_pi'), null)
  })
})

describe('prepareAttachment — Main PI gate + exact message', () => {
  test('valid .xlsx prepares ok as the canonical Excel mime', async () => {
    const r = await prepareAttachment(f('pi.xlsx', XLSX_MIME), 'main_pi')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.contentType, XLSX_MIME)
  })
  test('PDF rejected with the exact Main PI message', async () => {
    const r = await prepareAttachment(f('doc.pdf', 'application/pdf'), 'main_pi')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error, 'Main PI must be an Excel file in .xlsx or .xls format.')
  })
})

describe('Reference attachments unaffected by the Excel-only Main PI rule', () => {
  test('reference PDF still accepted (a PI PDF belongs here)', () => {
    assert.equal(resolveUploadType(f('pi-copy.pdf', 'application/pdf'), 'reference'), 'application/pdf')
  })
  test('reference image still accepted', () => {
    assert.equal(resolveUploadType(f('drawing.png', 'image/png'), 'reference'), 'image/png')
  })
  test('reference Excel still accepted', () => {
    assert.equal(resolveUploadType(f('data.xlsx', XLSX_MIME), 'reference'), XLSX_MIME)
  })
  test('reference accept string still advertises PDF + images', () => {
    assert.ok(REFERENCE_ACCEPT.includes('application/pdf'))
    assert.ok(REFERENCE_ACCEPT.includes('image/jpeg'))
    assert.ok(REFERENCE_ACCEPT.includes('.pdf'))
  })
})

describe('accept attribute strings', () => {
  test('Main PI accept is Excel-only (no pdf/image)', () => {
    assert.equal(MAIN_PI_ACCEPT, `${XLSX_MIME},${XLS_MIME},.xlsx,.xls`)
    assert.ok(!MAIN_PI_ACCEPT.includes('application/pdf'))
    assert.ok(!MAIN_PI_ACCEPT.includes('image/'))
  })
})
