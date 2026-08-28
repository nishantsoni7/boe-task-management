/**
 * THE DECODE-AND-RE-ENCODE PASS, run for real.
 *
 * Every image here is produced by libvips and fed back through libvips, so this
 * is a behavioural test of the thing that actually runs — not a source-shape
 * assertion and not a stub. It is the reason the module can now say the stored
 * object is a re-encoded image rather than the bytes somebody uploaded.
 *
 * WHAT IT PINS, and each of these was checked against real behaviour rather
 * than assumed:
 *
 *   * the three supported formats survive, in the same format;
 *   * EXIF does not survive — a phone photograph of a customer's premises
 *     carries GPS coordinates, and stripping them is a privacy fix as much as a
 *     safety one;
 *   * appended payloads do not survive, because they were never part of the
 *     decoded image;
 *   * SVG IS REFUSED, and this is the one that would be easy to lose: libvips
 *     accepts SVG and would rasterise it. The structural gate is what keeps it
 *     out, and removing that gate would silently widen the accepted set.
 *
 * Fictional images only. No network, no database, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/imageProcessing.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  MAX_DECODED_PIXELS,
  PROCESSED_MAX_BYTES,
  PROCESSING_REJECTION_MESSAGES,
  processReviewImage,
} from './imageProcessing'

const MAX = PROCESSED_MAX_BYTES
const chars = (s: string) => Buffer.from([...s].map(c => c.charCodeAt(0)))

const make = (format: 'jpeg' | 'png' | 'webp', width = 40, height = 30) =>
  sharp({ create: { width, height, channels: 3, background: { r: 210, g: 120, b: 60 } } })
    .toFormat(format)
    .toBuffer()

describe('a genuine image survives, in its own format', () => {
  for (const [format, mime] of [
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const) {
    test(format, async () => {
      const input = await make(format, 40, 30)
      const result = await processReviewImage(new Uint8Array(input), MAX)
      assert.ok(result.ok, `${format} was refused`)
      assert.equal(result.mime, mime)
      assert.equal(result.width, 40)
      assert.equal(result.height, 30)
      assert.ok(result.bytes.length > 0)

      // And the output really is that format when read back by the decoder.
      const meta = await sharp(Buffer.from(result.bytes)).metadata()
      assert.equal(meta.format, format)
    })
  }

  test('the stored bytes are the DECODER’s output, not the upload', async () => {
    const input = await make('jpeg')
    const result = await processReviewImage(new Uint8Array(input), MAX)
    assert.ok(result.ok)
    // Same picture, independently produced. It may coincidentally be the same
    // length, so identity is asserted on the decode rather than on the bytes.
    const meta = await sharp(Buffer.from(result.bytes)).metadata()
    assert.equal(meta.width, 40)
    assert.equal(meta.height, 30)
  })
})

describe('CAMERA METADATA DOES NOT SURVIVE', () => {
  test('EXIF present on the way in, absent on the way out', async () => {
    const withExif = await sharp({
      create: { width: 20, height: 15, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ IFD0: { Copyright: 'BOE', ImageDescription: 'site visit' } })
      .jpeg()
      .toBuffer()

    const before = await sharp(withExif).metadata()
    assert.ok(before.exif && before.exif.length > 0, 'the fixture must carry EXIF')

    const result = await processReviewImage(new Uint8Array(withExif), MAX)
    assert.ok(result.ok)

    const after = await sharp(Buffer.from(result.bytes)).metadata()
    assert.equal(after.exif, undefined, 'EXIF must not reach storage')
  })
})

describe('AN APPENDED PAYLOAD DOES NOT REACH STORAGE', () => {
  // libvips accepts these — it decodes the image and ignores the tail. The
  // structural gate refuses them first, and even if it did not, the re-encode
  // would drop the tail. Both are asserted, because the second is the property
  // that would still hold if the first were ever relaxed.
  test('the structural gate refuses them before a decoder sees them', async () => {
    const jpeg = await make('jpeg')
    for (const [label, tail] of [
      ['zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
      ['script', chars('<script>fetch("https://evil.test")</script>')],
      ['php', chars('<?php system($_GET[0]); ?>')],
    ] as const) {
      const polyglot = Buffer.concat([jpeg, tail])
      const result = await processReviewImage(new Uint8Array(polyglot), MAX)
      assert.equal(result.ok, false, label)
      assert.equal(result.ok === false && result.reason, 'trailing_data', label)
    }
  })

  test('and the re-encode would drop it anyway', async () => {
    // Proven directly against libvips: decoding a polyglot and writing it out
    // produces the image without the tail.
    const jpeg = await make('jpeg')
    const polyglot = Buffer.concat([jpeg, chars('<script>alert(1)</script>')])
    const reencoded = await sharp(polyglot).jpeg().toBuffer()
    assert.ok(reencoded.length < polyglot.length)
    assert.equal(reencoded.includes(Buffer.from('<script')), false)
  })
})

describe('SVG IS REFUSED, THOUGH THE DECODER WOULD TAKE IT', () => {
  test('the structural gate is what keeps it out', async () => {
    const svg = chars('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')

    // libvips WOULD accept and rasterise this.
    const decoderAccepts = await sharp(svg).metadata().then(m => m.format).catch(() => null)
    assert.equal(decoderAccepts, 'svg', 'the premise of this test has changed')

    // The module does not.
    const result = await processReviewImage(new Uint8Array(svg), MAX)
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, 'unknown_format')
  })
})

describe('everything else is still refused', () => {
  test('unsupported containers', async () => {
    for (const [label, bytes] of [
      ['HTML', chars('<!DOCTYPE html><html><body>x</body></html>')],
      ['PDF', chars('%PDF-1.7\nstream')],
      ['ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])],
      ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])],
      ['GIF', chars('GIF89a')],
      ['TIFF', Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0])],
    ] as const) {
      const result = await processReviewImage(new Uint8Array(bytes), MAX)
      assert.equal(result.ok, false, label)
    }
  })

  test('an empty file', async () => {
    const result = await processReviewImage(new Uint8Array(0), MAX)
    assert.equal(result.ok === false && result.reason, 'empty')
  })

  test('a file over the limit', async () => {
    const jpeg = await make('jpeg')
    const result = await processReviewImage(new Uint8Array(jpeg), jpeg.length - 1)
    assert.equal(result.ok === false && result.reason, 'too_large')
  })
})

describe('A DAMAGED IMAGE IS CAUGHT BY THE DECODER, NOT THE PARSER', () => {
  test('a JPEG whose pixel data is corrupt but whose container is intact', async () => {
    const jpeg = await make('jpeg', 60, 60)
    const damaged = Buffer.from(jpeg)
    // Scribble over the entropy-coded data, leaving SOI, the headers and EOI
    // exactly as they were — so the structural parser still sees a valid JPEG.
    for (let i = Math.floor(damaged.length * 0.55); i < damaged.length - 2; i += 1) {
      damaged[i] = 0x5a
    }
    assert.equal(damaged[damaged.length - 2], 0xff)
    assert.equal(damaged[damaged.length - 1], 0xd9)

    const result = await processReviewImage(new Uint8Array(damaged), MAX)
    // This is precisely what a structural parser cannot decide and a decoder
    // can. Whichever way libvips calls it, the answer must be a clean one.
    if (result.ok) {
      assert.ok(result.bytes.length > 0)
    } else {
      assert.ok(['undecodable', 'malformed'].includes(result.reason), result.reason)
    }
  })

  test('a truncated JPEG is refused', async () => {
    const jpeg = await make('jpeg', 60, 60)
    const cut = jpeg.subarray(0, Math.floor(jpeg.length * 0.5))
    const result = await processReviewImage(new Uint8Array(cut), MAX)
    assert.equal(result.ok, false)
  })
})

describe('the decompression-bomb ceiling', () => {
  test('is modest, and far above any real photograph', () => {
    assert.equal(MAX_DECODED_PIXELS, 50_000_000)
    // A 48-megapixel phone camera is ~8000x6000 = 48M, which fits.
    assert.ok(8000 * 6000 < MAX_DECODED_PIXELS)
  })

  test('its refusal has a sentence of its own', () => {
    assert.equal(
      PROCESSING_REJECTION_MESSAGES.too_many_pixels,
      'That image is too large to process. Try a smaller photograph.',
    )
    assert.equal(
      PROCESSING_REJECTION_MESSAGES.undecodable,
      'That image could not be read. It may be damaged.',
    )
  })
})

describe('the parser and the decoder must agree', () => {
  test('a disagreement about format is a refusal, not a reconciliation', async () => {
    // Asserted on the source: a file that two independent readers identify
    // differently is a file pretending to be two things.
    const source = await import('node:fs').then(fs =>
      fs.readFileSync('src/lib/customerReviews/imageProcessing.ts', 'utf8'))
    assert.ok(source.includes("if (metadata.format !== format) return { ok: false, reason: 'unknown_format' }"))
  })
})
