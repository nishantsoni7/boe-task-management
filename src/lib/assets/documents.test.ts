/**
 * Asset documents — the upload gate and the storage-path shape.
 *
 * Run:
 *   npx tsx --test src/lib/assets/documents.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_DOCUMENT_MAX_BYTES,
  activeDocuments,
  buildDocumentPath,
  extOf,
  formatFileSize,
  resolveDocumentType,
  sanitizeDocumentName,
  validateDocument,
} from './documents'

describe('resolveDocumentType — extension first', () => {
  test('an allowed extension resolves to its canonical MIME', () => {
    assert.equal(resolveDocumentType({ name: 'invoice.pdf' }), 'application/pdf')
    assert.equal(resolveDocumentType({ name: 'card.JPG' }), 'image/jpeg')
    assert.equal(resolveDocumentType({ name: 'sheet.xlsx' }),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  test('a double extension is judged by the LAST one', () => {
    // "invoice.pdf.exe" is an executable, whatever it wants to look like.
    assert.equal(resolveDocumentType({ name: 'invoice.pdf.exe' }), null)
  })

  test('macro-enabled Office formats are refused', () => {
    assert.equal(resolveDocumentType({ name: 'book.xlsm' }), null)
    assert.equal(resolveDocumentType({ name: 'doc.docm' }), null)
  })

  test('archives are refused — a container can hold anything', () => {
    assert.equal(resolveDocumentType({ name: 'stuff.zip' }), null)
  })

  test('a file with no extension is refused', () => {
    assert.equal(resolveDocumentType({ name: 'invoice' }), null)
  })

  test('a reported type that contradicts the extension is refused', () => {
    assert.equal(resolveDocumentType({ name: 'invoice.pdf', type: 'application/x-msdownload' }), null)
  })

  test('a blank reported type is tolerated — some browsers send nothing', () => {
    assert.equal(resolveDocumentType({ name: 'notes.txt', type: '' }), 'text/plain')
  })

  test('text/plain on a CSV is tolerated, and we still upload as text/csv', () => {
    assert.equal(resolveDocumentType({ name: 'rows.csv', type: 'text/plain' }), 'text/csv')
  })

  test('we upload as the canonical MIME, never the browser’s claim', () => {
    // A spoofed-but-allowed type cannot smuggle itself past the bucket check.
    assert.equal(resolveDocumentType({ name: 'photo.png', type: 'image/jpeg' }), 'image/png')
  })
})

describe('validateDocument', () => {
  const file = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
    name: 'invoice.pdf', type: 'application/pdf', size: 1024, ...over,
  })

  test('accepts an ordinary file', () => {
    const result = validateDocument(file())
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.contentType, 'application/pdf')
  })

  test('refuses an empty file', () => {
    const result = validateDocument(file({ size: 0 }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.error.includes('empty'))
  })

  test('refuses a type outside the allow-list, and says which are allowed', () => {
    const result = validateDocument(file({ name: 'thing.exe', type: '' }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.error.includes('PDF'))
  })

  test('refuses an oversized file rather than silently re-encoding it', () => {
    // No compression path here on purpose: silently re-encoding a commercial
    // document to squeeze it under a limit is how records get corrupted.
    const result = validateDocument(file({ size: ASSET_DOCUMENT_MAX_BYTES + 1 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('10 MB'))
      assert.ok(result.error.includes('smaller'))
    }
  })

  test('exactly at the limit is accepted', () => {
    assert.equal(validateDocument(file({ size: ASSET_DOCUMENT_MAX_BYTES })).ok, true)
  })

  test('the limit matches the bucket’s file_size_limit', () => {
    assert.equal(ASSET_DOCUMENT_MAX_BYTES, 10485760)
  })
})

describe('buildDocumentPath', () => {
  test('the asset id is ALWAYS the first segment — storage RLS reads it', () => {
    const path = buildDocumentPath('11111111-1111-1111-1111-111111111111', 'invoice', 'My Invoice.pdf')
    assert.equal(path.split('/')[0], '11111111-1111-1111-1111-111111111111')
  })

  test('each document type gets its own folder', () => {
    const id = 'a1'
    assert.equal(buildDocumentPath(id, 'invoice', 'x.pdf').split('/')[1], 'invoice')
    assert.equal(buildDocumentPath(id, 'warranty_card', 'x.pdf').split('/')[1], 'warranty')
    assert.equal(buildDocumentPath(id, 'other', 'x.pdf').split('/')[1], 'other')
  })

  test('the raw filename is never the key, and same-named files never collide', () => {
    const a = buildDocumentPath('a1', 'invoice', 'invoice.pdf')
    const b = buildDocumentPath('a1', 'invoice', 'invoice.pdf')
    assert.notEqual(a, b)
    assert.ok(a.endsWith('-invoice.pdf'))
  })
})

describe('sanitizeDocumentName', () => {
  test('keeps only characters safe in a storage key', () => {
    assert.equal(sanitizeDocumentName('My Invoice (final).pdf'), 'My-Invoice-final-.pdf')
  })

  test('never returns an empty name', () => {
    assert.equal(sanitizeDocumentName('...'), 'file')
    assert.equal(sanitizeDocumentName('   '), 'file')
  })

  test('caps the length', () => {
    assert.ok(sanitizeDocumentName('a'.repeat(200)).length <= 80)
  })

  test('path separators cannot survive — a name must not become a directory', () => {
    const cleaned = sanitizeDocumentName('../../etc/passwd')
    assert.ok(!cleaned.includes('/'))
    assert.ok(!cleaned.includes('..'))
  })
})

describe('formatFileSize', () => {
  test('reads as a size, not as a number of bytes', () => {
    assert.equal(formatFileSize(0), '0 B')
    assert.equal(formatFileSize(null), '0 B')
    assert.equal(formatFileSize(512), '512 B')
    assert.equal(formatFileSize(1024), '1 KB')
    assert.equal(formatFileSize(10 * 1024 * 1024), '10 MB')
  })

  test('a whole number keeps no pointless decimal', () => {
    assert.equal(formatFileSize(2 * 1024 * 1024), '2 MB')
  })
})

describe('activeDocuments', () => {
  test('a soft-removed document is history, not a file on the record', () => {
    const rows = [
      { id: '1', removed_at: null },
      { id: '2', removed_at: '2026-05-01T00:00:00Z' },
      { id: '3', removed_at: null },
    ]
    assert.deepEqual(activeDocuments(rows).map(r => r.id), ['1', '3'])
  })
})

describe('extOf', () => {
  test('lower-cases and takes the last segment', () => {
    assert.equal(extOf('Invoice.PDF'), 'pdf')
    assert.equal(extOf('archive.tar.gz'), 'gz')
    assert.equal(extOf('noext'), 'noext')
  })
})
