/**
 * Task Detail attachment gallery — ordering, naming and the ZIP itself.
 *
 * Pure: no Supabase client, no network, no .env.local. Safe to run anywhere.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskGallery.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import {
  buildGalleryEntries, buildZip, galleryCountLabel, safeFileName,
  stepIndex, uniqueZipNames, zipFileNameForTask, signatureIsStale,
} from './taskGallery'
import { canonicalAttachmentRef } from './attachmentStorage'

const row = (id: string, file_name: string | null, storage_path: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, file_name, storage_path, url: storage_path ? canonicalAttachmentRef(storage_path) : '', ...extra })

describe('buildGalleryEntries', () => {
  test('no attachments → empty', () => {
    assert.deepEqual(buildGalleryEntries({ attachment_url: null }, []), [])
    assert.deepEqual(buildGalleryEntries(null, []), [])
  })

  test('keeps query order and splits images from documents', () => {
    const e = buildGalleryEntries(null, [
      row('a', 'site-1.jpg', 'tasks/t/1.jpg'),
      row('b', 'quote.pdf', 'tasks/t/2.pdf'),
      row('c', 'site-2.PNG', 'tasks/t/3.png'),
      row('d', 'sheet.xlsx', 'tasks/t/4.xlsx'),
    ])
    assert.deepEqual(e.map(x => x.key), ['a', 'b', 'c', 'd'])
    assert.deepEqual(e.map(x => x.isImage), [true, false, true, false])
    assert.equal(galleryCountLabel(e), '2 images · 2 files')
  })

  test('legacy single attachment goes first, and only when no row repeats it', () => {
    const legacy = { attachment_url: canonicalAttachmentRef('tasks/t/old.jpg') }
    const first = buildGalleryEntries(legacy, [row('a', 'x.jpg', 'tasks/t/1.jpg')])
    assert.deepEqual(first.map(x => x.key), ['legacy', 'a'])
    assert.equal(first[0].fileName, 'old.jpg')
    assert.equal(first[0].isImage, true)

    const dup = buildGalleryEntries(legacy, [row('a', 'renamed.jpg', 'tasks/t/old.jpg')])
    assert.deepEqual(dup.map(x => x.key), ['a'])
  })

  test('the display name decides the type, as in the preview modal', () => {
    const [e] = buildGalleryEntries(null, [row('a', 'report.pdf', 'tasks/t/1.jpg')])
    assert.equal(e.isImage, false)
    const [f] = buildGalleryEntries(null, [row('b', 'no-extension', 'tasks/t/2.webp')])
    assert.equal(f.isImage, true)
  })

  test('rows with no locatable object are skipped', () => {
    assert.deepEqual(buildGalleryEntries(null, [row('a', 'x.jpg', null)]), [])
  })

  test('count label', () => {
    const one = buildGalleryEntries(null, [row('a', 'x.jpg', 'p/x.jpg')])
    assert.equal(galleryCountLabel(one), '1 image')
    const doc = buildGalleryEntries(null, [row('a', 'x.pdf', 'p/x.pdf')])
    assert.equal(galleryCountLabel(doc), '1 file')
  })
})

describe('ZIP names', () => {
  test('separators and reserved characters cannot escape or nest', () => {
    assert.equal(safeFileName('../../etc/passwd.jpg'), '.._.._etc_passwd.jpg')
    assert.equal(safeFileName('a\\b:c*?.png'), 'a_b_c__.png')
    assert.equal(safeFileName('   '), 'image')
    assert.equal(safeFileName('...'), 'image')
    assert.equal(safeFileName('photo.jpg.  '), 'photo.jpg')
  })

  test('long names are bounded and keep their extension', () => {
    const s = safeFileName('x'.repeat(400) + '.jpeg')
    assert.equal(s.length, 150)
    assert.ok(s.endsWith('.jpeg'))
  })

  test('collisions get (2), (3) — case-insensitively — in input order', () => {
    assert.deepEqual(
      uniqueZipNames(['IMG.jpg', 'img.JPG', 'img.jpg', 'other.png', 'IMG (2).jpg']),
      ['IMG.jpg', 'img (2).JPG', 'img (3).jpg', 'other.png', 'IMG (2) (2).jpg'],
    )
  })

  test('archive filename from the task title', () => {
    assert.equal(zipFileNameForTask('Gate photos / site 4'), 'Gate photos _ site 4 - images.zip')
    assert.equal(zipFileNameForTask(''), 'Task - images.zip')
  })
})

describe('buildZip', () => {
  test('contains every image exactly once, byte-for-byte', async () => {
    const names = uniqueZipNames(['a.jpg', 'a.jpg', 'b.png'])
    const files = names.map((name, i) => ({ name, bytes: new Uint8Array([i, i + 1, i + 2, 255]) }))
    const out = unzipSync(await buildZip(files))
    assert.deepEqual(Object.keys(out).sort(), ['a (2).jpg', 'a.jpg', 'b.png'])
    for (const f of files) assert.deepEqual(out[f.name], f.bytes)
  })
})

describe('viewer navigation', () => {
  test('wraps at both ends', () => {
    assert.equal(stepIndex(0, -1, 8), 7)
    assert.equal(stepIndex(7, 1, 8), 0)
    assert.equal(stepIndex(2, 1, 8), 3)
    assert.equal(stepIndex(0, 1, 1), 0)
    assert.equal(stepIndex(0, 1, 0), 0)
  })

  test('signature staleness', () => {
    assert.equal(signatureIsStale(1000, 500, 1400), false)
    assert.equal(signatureIsStale(1000, 500, 1600), true)
  })
})
