/**
 * The test screenshot: what may be attached, and where it lands.
 *
 * ONE IMAGE, ONE KIND, ONE CARD. The functions here are the browser-side
 * courtesy check and the readable statement of the object-key shape. Neither is
 * the boundary — /api/customer-reviews/photos reads the bytes, re-encodes them
 * and generates its own key, and no client role can write an object or register
 * one — which is what uploadRoute.test.ts and the migration assert.
 *
 * What this file pins is that the constants here MATCH the bucket, so a file
 * that passes the browser check cannot then be refused by Storage for a reason
 * nobody anticipated.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/photos.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_TEST_SCREENSHOTS,
  TEST_SCREENSHOT_ALLOWED_TYPES,
  TEST_SCREENSHOT_BUCKET,
  TEST_SCREENSHOT_MAX_BYTES,
  buildTestScreenshotPath,
  formatPhotoSize,
  testScreenshotContentType,
  validateTestScreenshot,
} from './photos'

const ROOT = process.cwd()
const sql = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'), 'utf8',
).replace(/\r\n/g, '\n')

const CARD = 'aaaaaaaa-0000-4000-8000-000000000001'

describe('the constants agree with the bucket', () => {
  test('the bucket id is the one the migration creates', () => {
    assert.equal(TEST_SCREENSHOT_BUCKET, 'customer-review-test-screenshots')
    assert.ok(sql.includes(`'${TEST_SCREENSHOT_BUCKET}',`))
  })

  test('the size limit is the same number on both sides', () => {
    assert.equal(TEST_SCREENSHOT_MAX_BYTES, 5 * 1024 * 1024)
    assert.ok(sql.includes(String(TEST_SCREENSHOT_MAX_BYTES)))
  })

  test('the accepted types are the same three on both sides', () => {
    assert.deepEqual([...TEST_SCREENSHOT_ALLOWED_TYPES], ['image/jpeg', 'image/png', 'image/webp'])
    assert.ok(sql.includes("array['image/jpeg', 'image/png', 'image/webp']"))
    assert.ok(sql.includes("mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp'))"))
  })

  test('ONE SCREENSHOT PER CARD', () => {
    // A card records one test. A second image would be either a duplicate or
    // evidence of a different test, and neither belongs on this row. Replacing
    // it means removing the first, which leaves a screenshot_removed entry in
    // the append-only trail — so a swap is visible rather than silent.
    assert.equal(MAX_TEST_SCREENSHOTS, 1)
  })
})

describe('the courtesy check', () => {
  const file = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
    name: 'shot.png', type: 'image/png', size: 1024, ...over,
  })

  test('an ordinary screenshot passes', () => {
    assert.equal(validateTestScreenshot(file()), null)
  })

  test('an empty file is refused', () => {
    assert.equal(validateTestScreenshot(file({ size: 0 })), 'That file is empty.')
  })

  test('an oversized file is refused before the round trip', () => {
    assert.equal(
      validateTestScreenshot(file({ size: TEST_SCREENSHOT_MAX_BYTES + 1 })),
      'The screenshot must be under 5 MB.',
    )
    // Exactly at the limit is allowed — the bucket accepts it too.
    assert.equal(validateTestScreenshot(file({ size: TEST_SCREENSHOT_MAX_BYTES })), null)
  })

  test('a type the bucket would refuse is refused here as well', () => {
    for (const type of ['application/pdf', 'image/gif', 'image/svg+xml', 'video/mp4', 'text/html']) {
      assert.ok(validateTestScreenshot(file({ type })), type)
    }
  })

  test('AN EXTENSION CANNOT LAUNDER A DISALLOWED TYPE', () => {
    // A file that says it is a PDF is refused whatever it is called.
    assert.ok(validateTestScreenshot({ name: 'shot.png', type: 'application/pdf', size: 10 }))
    assert.equal(testScreenshotContentType({ name: 'shot.png', type: 'application/pdf' }), null)
  })

  test('the extension is consulted ONLY when the browser reported nothing', () => {
    assert.equal(testScreenshotContentType({ name: 'shot.jpg', type: '' }), 'image/jpeg')
    assert.equal(testScreenshotContentType({ name: 'shot.JPEG', type: '' }), 'image/jpeg')
    assert.equal(testScreenshotContentType({ name: 'shot.webp', type: '' }), 'image/webp')
    assert.equal(testScreenshotContentType({ name: 'shot.pdf', type: '' }), null)
    assert.equal(testScreenshotContentType({ name: 'shot', type: '' }), null)
  })
})

describe('the object key shape, which the storage policies depend on', () => {
  test('THE FIRST PATH SEGMENT IS ALWAYS THE CARD ID', () => {
    // The storage policy reads ownership out of split_part(name, '/', 1), and
    // the metadata row's CHECK requires the two to agree. If this shape ever
    // changed, a tester holding one card could reach another's objects.
    const path = buildTestScreenshotPath(CARD, 'test_screenshot', 'photo.png')
    assert.equal(path.split('/')[0], CARD)
    assert.equal(path.split('/')[1], 'test_screenshot')
    assert.ok(sql.includes("split_part(storage_path, '/', 1) = card_id::text"))
    assert.ok(sql.includes("split_part(storage.objects.name, '/', 1)"))
  })

  test('NOTHING A USER TYPED REACHES THE PATH, only a sanitised extension', () => {
    for (const name of [
      '../../etc/passwd.png',
      'my photo (1).PNG',
      'shot.png; drop table users',
      'shot.p n g',
    ]) {
      const path = buildTestScreenshotPath(CARD, 'test_screenshot', name)
      const file = path.split('/')[2]
      assert.equal(/^[a-z0-9_]+\.[a-z0-9]+$/.test(file), true, `${name} -> ${file}`)
      assert.equal(path.includes('..'), false, name)
      assert.equal(path.split('/').length, 3, name)
    }
  })

  test('a filename with no extension gets a default rather than its own name', () => {
    // 'photo'.split('.').pop() is 'photo', so without the guard the whole name
    // would have leaked into the key.
    const path = buildTestScreenshotPath(CARD, 'test_screenshot', 'photo')
    assert.ok(path.endsWith('.jpg'))
    assert.equal(path.includes('photo'), false)
  })

  test('two calls never produce the same key', () => {
    const a = buildTestScreenshotPath(CARD, 'test_screenshot', 'x.png')
    const b = buildTestScreenshotPath(CARD, 'test_screenshot', 'x.png')
    assert.notEqual(a, b)
  })

  test('the path always contains a separator, which the CHECK requires', () => {
    assert.ok(sql.includes("position('/' in storage_path) > 1"))
    assert.ok(buildTestScreenshotPath(CARD, 'test_screenshot', 'x.png').includes('/'))
  })
})

describe('display helpers', () => {
  test('sizes read the way a person expects', () => {
    assert.equal(formatPhotoSize(512), '512 B')
    assert.equal(formatPhotoSize(2048), '2 KB')
    assert.equal(formatPhotoSize(1024 * 1024 * 2.5), '2.5 MB')
  })
})
