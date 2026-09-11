/**
 * Evidence images — what may be attached, where it is stored, and what the
 * reader is told when something fails.
 *
 * The database is the boundary (20261203000000); these cover the browser half,
 * which must refuse a wrong file before an upload is attempted and must never
 * describe an image as attached when it was not.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/evidence.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MEETING_EVIDENCE_ACCEPT, MEETING_EVIDENCE_BUCKET, MEETING_EVIDENCE_MAX_BYTES,
  MEETING_EVIDENCE_MIME_TYPES, MEETING_EVIDENCE_PATH_PATTERN, buildEvidencePath,
  evidenceDisplayName, evidenceSaveOutcome, evidenceUploadErrorMessage, isEvidencePathForOrder,
  prepareEvidenceFile, resolveEvidenceType,
} from './evidence'

const ORDER = '0b6f3a8e-2a4b-4c1d-9e8f-1234567890ab'
const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const LEAF  = '11111111-2222-4333-8444-555555555555'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20261203000000_meeting_order_evidence.sql'),
  'utf8',
)

describe('which files may be attached', () => {
  test('ordinary screenshots and photos are accepted, uploaded under their canonical type', () => {
    assert.deepEqual(resolveEvidenceType({ name: 'Screenshot 2026-09-11 104233.png', type: 'image/png' }), { mime: 'image/png', ext: 'png' })
    assert.deepEqual(resolveEvidenceType({ name: 'IMG_2041.JPG', type: 'image/jpeg' }), { mime: 'image/jpeg', ext: 'jpg' })
    assert.deepEqual(resolveEvidenceType({ name: 'photo.jpeg', type: 'image/jpg' }), { mime: 'image/jpeg', ext: 'jpg' })
    assert.deepEqual(resolveEvidenceType({ name: 'ticket.webp', type: 'image/webp' }), { mime: 'image/webp', ext: 'webp' })
    // Some sources report no type at all; the extension decides.
    assert.deepEqual(resolveEvidenceType({ name: 'ticket.png', type: '' }), { mime: 'image/png', ext: 'png' })
  })

  test('a pasted clipboard image with no usable name is judged on its type', () => {
    assert.deepEqual(resolveEvidenceType({ name: '', type: 'image/png' }), { mime: 'image/png', ext: 'png' })
    assert.equal(resolveEvidenceType({ name: '', type: 'application/octet-stream' }), null)
  })

  test('anything that is not a JPG, PNG or WEBP image is refused', () => {
    for (const file of [
      { name: 'quote.pdf', type: 'application/pdf' },
      { name: 'anim.gif', type: 'image/gif' },
      { name: 'iphone.heic', type: 'image/heic' },
      { name: 'drawing.svg', type: 'image/svg+xml' },
      { name: 'notes.txt', type: 'text/plain' },
    ]) {
      assert.equal(resolveEvidenceType(file), null, file.name)
    }
  })

  test('a disguised file is refused: double extension, or a type that disagrees with the name', () => {
    assert.equal(resolveEvidenceType({ name: 'ticket.png.exe', type: 'application/x-msdownload' }), null)
    assert.equal(resolveEvidenceType({ name: 'ticket.png', type: 'application/pdf' }), null)
    assert.equal(resolveEvidenceType({ name: 'ticket.jpg', type: 'image/png' }), null)
  })

  test('the picker offers exactly the accepted types', () => {
    for (const mime of MEETING_EVIDENCE_MIME_TYPES) assert.ok(MEETING_EVIDENCE_ACCEPT.includes(mime), mime)
    assert.ok(!MEETING_EVIDENCE_ACCEPT.includes('pdf'))
  })
})

describe('where an image is stored', () => {
  test('the key is {order}/{generated}.{ext} — never the user’s filename', () => {
    const path = buildEvidencePath(ORDER, 'png', LEAF)
    assert.equal(path, `${ORDER}/${LEAF}.png`)
    assert.match(path, MEETING_EVIDENCE_PATH_PATTERN)
    assert.match(buildEvidencePath(ORDER, 'jpg'), MEETING_EVIDENCE_PATH_PATTERN, 'a generated leaf fits too')
  })

  test('a key only belongs to the Order whose folder it is in', () => {
    assert.equal(isEvidencePathForOrder(`${ORDER}/${LEAF}.png`, ORDER), true)
    assert.equal(isEvidencePathForOrder(`${OTHER}/${LEAF}.png`, ORDER), false)
    assert.equal(isEvidencePathForOrder(`${ORDER}/../${OTHER}/${LEAF}.png`, ORDER), false)
    assert.equal(isEvidencePathForOrder(`${ORDER}/sub/${LEAF}.png`, ORDER), false)
    assert.equal(isEvidencePathForOrder(`${ORDER}/${LEAF}.PNG`, ORDER), false)
    assert.equal(isEvidencePathForOrder(`${ORDER}/Screenshot.png`, ORDER), false)
  })

  test('the browser pattern is the same shape the storage policy and the RPC enforce', () => {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    assert.ok(MIGRATION.includes(`'^${uuid}/${uuid}\\.(jpg|png|webp)$'`), 'storage INSERT policy shape')
    assert.ok(MIGRATION.includes(`'/${uuid}\\.(jpg|png|webp)$'`), 'RPC shape under the order folder')
  })

  test('the display name keeps what a person typed and drops what could mislead', () => {
    assert.equal(evidenceDisplayName('Ops ticket #412 (v2).png'), 'Ops ticket #412 (v2).png')
    assert.equal(evidenceDisplayName('../../etc/passwd'), '....etcpasswd')
    assert.equal(evidenceDisplayName(`a${String.fromCharCode(0)}b${String.fromCharCode(10)}c.png`), 'abc.png')
    assert.equal(evidenceDisplayName('   '), 'image')
    assert.equal(evidenceDisplayName('x'.repeat(300)).length, 120)
  })
})

describe('the limits agree with the database', () => {
  test('10 MB, at the bucket and in the table', () => {
    assert.equal(MEETING_EVIDENCE_MAX_BYTES, 10 * 1024 * 1024)
    assert.match(MIGRATION, /'meeting-evidence',\s*false,\s*10485760,/)
    assert.match(MIGRATION, /size_bytes > 0 AND size_bytes <= 10485760/)
  })

  test('the same three types at the bucket, in the table and in the RPC', () => {
    const list = MEETING_EVIDENCE_MIME_TYPES.map(m => `'${m}'`).join(', ')
    assert.ok(MIGRATION.includes(`ARRAY[${list}]`), 'bucket allowed_mime_types')
    assert.ok(MIGRATION.includes(`mime_type IN (${list})`), 'table CHECK')
    assert.ok(MIGRATION.includes(`v_mime NOT IN (${list})`), 'RPC check')
    assert.equal(MEETING_EVIDENCE_BUCKET, 'meeting-evidence')
  })
})

describe('preparing a file never produces false evidence', () => {
  test('an empty file is refused', async () => {
    const result = await prepareEvidenceFile(new File([], 'blank.png', { type: 'image/png' }))
    assert.equal(result.ok, false)
  })

  test('a wrong type is refused before any upload', async () => {
    const result = await prepareEvidenceFile(new File(['%PDF'], 'quote.pdf', { type: 'application/pdf' }))
    assert.equal(result.ok, false)
    assert.ok(!result.ok && /JPG, PNG or WEBP/.test(result.error))
  })

  test('an image within the limit is passed through byte-for-byte', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'ticket.png', { type: 'image/png' })
    const result = await prepareEvidenceFile(file)
    assert.ok(result.ok)
    assert.equal(result.file, file)
    assert.equal(result.compressed, false)
  })

  test('an oversized image that cannot be reduced is refused, never passed through', async () => {
    // No canvas outside a browser, so compression cannot succeed: the refusal
    // path is exactly what this exercises.
    const big = new File([new Uint8Array(MEETING_EVIDENCE_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' })
    const result = await prepareEvidenceFile(big)
    assert.equal(result.ok, false)
  })
})

describe('what the reader is told', () => {
  test('storage failures become one actionable sentence', () => {
    assert.match(evidenceUploadErrorMessage({ message: 'The object exceeded the maximum allowed size', statusCode: '413' }), /larger than 10 MB/)
    assert.match(evidenceUploadErrorMessage({ message: 'mime type image/gif is not supported' }), /JPG, PNG or WEBP/)
    assert.match(evidenceUploadErrorMessage({ message: 'new row violates row-level security policy', statusCode: '403' }), /permission/)
    assert.match(evidenceUploadErrorMessage({ message: 'Failed to fetch' }), /connection/)
    assert.equal(evidenceUploadErrorMessage({ message: 'something odd' }), 'The image could not be uploaded.')
    assert.equal(evidenceUploadErrorMessage(null), 'The image could not be uploaded.')
  })

  test('success names exactly what was recorded', () => {
    assert.deepEqual(evidenceSaveOutcome({ updateSaved: true, attached: 0, failed: 0 }), { tone: 'success', message: 'Update saved' })
    assert.deepEqual(evidenceSaveOutcome({ updateSaved: true, attached: 2, failed: 0 }), { tone: 'success', message: 'Update saved · 2 images attached' })
    assert.deepEqual(evidenceSaveOutcome({ updateSaved: false, attached: 1, failed: 0 }), { tone: 'success', message: '1 image attached' })
  })

  test('a failed image is never implied to be attached', () => {
    const partial = evidenceSaveOutcome({ updateSaved: true, attached: 1, failed: 1 })
    assert.equal(partial.tone, 'error')
    assert.equal(partial.message, 'Update saved · 1 image attached. 1 image could not be attached, so nothing was recorded for it. Try again.')

    const none = evidenceSaveOutcome({ updateSaved: false, attached: 0, failed: 2 })
    assert.equal(none.message, '2 images could not be attached, so nothing was recorded for them. Try again.')
  })
})
