import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  canPreview, extOf, fileKind, fileKey, LEAD_FILE_ACCEPT, LEAD_FILE_MAX_BYTES, LEAD_FILE_TYPES, LEAD_FILES_BUCKET, LEAD_FILES_MAX, leadFilePath,
  leadFileType, noteForFiles, refusalLine, sortIncoming, uploadErrorWords,
} from './files'

// Files on a lead's update (owner, 2026-11-15; migration 20270722000000). The bucket refuses what this file would not send; the
// two are one rule written twice, so the first block reads the migration and compares.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const sql = read('supabase/migrations/20270722000000_sales_lead_attachments.sql')
const file = (name: string, size = 1000, type = '', lastModified = 1) => ({ name, size, type, lastModified }) as File

describe('one rule, written in the bucket and in the browser', () => {
  test('the types, the size and the bucket are the migration\'s', () => {
    const list = /allowed_mime_types[\s\S]*?array\[([\s\S]*?)\]\s*\)/.exec(sql)?.[1] ?? ''
    const inBucket = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
    assert.deepEqual([...LEAD_FILE_TYPES].sort(), inBucket)
    assert.equal(inBucket.length, 14, 'the migration\'s self-check counts fourteen')
    assert.ok(sql.includes(`'${LEAD_FILES_BUCKET}', '${LEAD_FILES_BUCKET}', false, ${LEAD_FILE_MAX_BYTES}`), 'a private bucket of the same size')
    assert.ok(sql.includes(`size_bytes between 1 and ${LEAD_FILE_MAX_BYTES}`))
    assert.ok(sql.includes(`jsonb_array_length(v_files) > ${LEAD_FILES_MAX}`))
  })
  test('no zip, no program, no octet-stream', () => {
    for (const t of LEAD_FILE_TYPES) assert.ok(!/zip|octet|executable|x-msdownload/.test(t), t)
    assert.ok(!LEAD_FILE_ACCEPT.includes('.zip') && !LEAD_FILE_ACCEPT.includes('.exe'))
  })
})

describe('what a file is', () => {
  test('the extension decides, and a browser that calls a CSV Excel is not believed', () => {
    assert.equal(leadFileType(file('quote.PDF', 10, 'application/pdf')), 'application/pdf')
    assert.equal(leadFileType(file('list.csv', 10, 'application/vnd.ms-excel')), 'text/csv')
    assert.equal(leadFileType(file('site.JPG', 10, '')), 'image/jpeg')
    assert.equal(leadFileType(file('plan.pptx', 10, '')), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    assert.equal(leadFileType(file('phone.heic', 10, '')), 'image/heic')
  })
  test('a pasted screenshot with no useful name is taken by its own type; anything else with no extension is not', () => {
    assert.equal(leadFileType(file('image', 10, 'image/png')), 'image/png')
    assert.equal(leadFileType(file('notes', 10, '')), null)
    assert.equal(leadFileType(file('setup.exe', 10, 'application/x-msdownload')), null)
    assert.equal(leadFileType(file('archive.zip', 10, 'application/zip')), null)
  })
  test('extOf and the kinds', () => {
    assert.equal(extOf('a.b.PNG'), 'png')
    assert.equal(extOf('noext'), '')
    assert.deepEqual(['image/png', 'application/pdf', 'text/csv', 'application/vnd.ms-excel', 'application/msword', 'application/vnd.ms-powerpoint', 'text/plain'].map(fileKind),
      ['image', 'pdf', 'sheet', 'sheet', 'doc', 'slides', 'text'])
  })
  test('a browser can draw a JPEG, a PNG and a WebP, and not a HEIC', () => {
    assert.ok(canPreview('image/jpeg') && canPreview('image/png') && canPreview('image/webp'))
    assert.ok(!canPreview('image/heic') && !canPreview('application/pdf'))
  })
})

describe('what is picked, dropped or pasted', () => {
  test('the good ones are taken; the others are refused with a reason in words', () => {
    const r = sortIncoming([file('a.pdf'), file('b.zip', 10, 'application/zip'), file('c.png', 0), file('d.pdf', LEAD_FILE_MAX_BYTES + 1)], 0, new Set())
    assert.deepEqual(r.take.map(f => f.name), ['a.pdf'])
    assert.deepEqual(r.refused.map(x => x.name), ['b.zip', 'c.png', 'd.pdf'])
    const line = refusalLine(r.refused)
    assert.ok(line.startsWith('Not added: b.zip is not a kind we keep') && line.includes('c.png is empty') && line.includes('d.pdf is over 10 MB'), line)
    assert.equal(refusalLine([]), '')
  })
  test('a big photo is let in to be made smaller; a big PNG or HEIC is not', () => {
    const big = LEAD_FILE_MAX_BYTES + 5
    assert.equal(sortIncoming([file('p.jpg', big), file('q.webp', big)], 0, new Set()).take.length, 2)
    assert.equal(sortIncoming([file('p.png', big), file('q.heic', big)], 0, new Set()).take.length, 0)
  })
  test('a repeated paste or drop of the same file is taken once, silently', () => {
    const a = file('a.pdf', 10, '', 5)
    const r = sortIncoming([a, file('a.pdf', 10, '', 5)], 0, new Set())
    assert.equal(r.take.length, 1)
    assert.equal(r.refused.length, 0)
    assert.equal(sortIncoming([file('a.pdf', 10, '', 5)], 1, new Set([fileKey(a)])).take.length, 0, 'already queued')
  })
  test('ten files on one update, counting what is already there', () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`f${i}.pdf`, 10, '', i))
    const r = sortIncoming(many, 3, new Set())
    assert.equal(r.take.length, 7)
    assert.equal(r.refused.length, 5)
    assert.ok(r.refused[0].why.includes('more than 10 files'))
  })
})

describe('where a file goes and what is said', () => {
  test('the lead is the first folder of the path, which is what the bucket\'s policies read', () => {
    const p = leadFilePath('3f0c9a1e-0000-4000-8000-000000000001', 'My Quote (final).PDF', 'ab12cd34')
    assert.ok(p.startsWith('3f0c9a1e-0000-4000-8000-000000000001/ab12cd34-'), p)
    assert.ok(/^[0-9a-f-]{36}\/[A-Za-z0-9._-]+$/.test(p), 'nothing but safe characters after the folder: ' + p)
    assert.ok(sql.includes("split_part(storage.objects.name, '/', 1)"), 'the migration reads the same folder')
  })
  test('an update that is only files says so', () => {
    assert.equal(noteForFiles(1), 'Shared 1 file.')
    assert.equal(noteForFiles(3), 'Shared 3 files.')
  })
  test('a failed upload is said in words, never as the storage message', () => {
    assert.equal(uploadErrorWords({ message: 'new row violates row-level security policy' }), 'You cannot add files to this lead.')
    assert.equal(uploadErrorWords({ message: 'The object exceeded the maximum allowed size' }), 'This is over 10 MB.')
    assert.ok(uploadErrorWords({ message: 'mime type text/html is not supported' }).startsWith('This is not a kind we keep'))
    assert.ok(uploadErrorWords({ message: 'Failed to fetch' }).includes('Check the connection'))
    assert.equal(uploadErrorWords(null), 'The upload did not finish. Retry.')
    assert.equal(uploadErrorWords({ message: 'The resource already exists' }), 'This file is already there. Remove it and add it again.')
  })
})
