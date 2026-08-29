/**
 * Downloading the same image in another format.
 *
 * The whole contract is that this is an ENCODING change: same pixels, same
 * dimensions, different wrapper. If a conversion ever resized or recropped, a
 * download would silently become a different product photograph from the one
 * BOE reviewed and paid for.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/imageFormats.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { convertImage, isDownloadFormat, DOWNLOAD_FORMATS } from './imageFormats'

/**
 * A studio-image-shaped PNG with photograph-like texture.
 *
 * Blurred noise rather than raw noise: raw noise has no spatial correlation at
 * all, which is the worst case a lossy codec can be handed and nothing like a
 * photograph of a chair. Testing WebP against white noise measures the codec's
 * pathological case, not BOE's.
 */
async function master(width = 1000, height = 1000): Promise<Buffer> {
  return sharp({
    create: {
      width, height, channels: 3,
      noise: { type: 'gaussian', mean: 150, sigma: 30 },
      background: { r: 0, g: 0, b: 0 },
    },
  }).blur(1.2).png().toBuffer()
}

describe('converting', () => {
  test('every offered format is produced, with the right type and extension', async () => {
    const source = await master()

    for (const format of DOWNLOAD_FORMATS) {
      const result = await convertImage(source, format)
      assert.equal(result.ok, true, `${format} should convert`)
      if (!result.ok) continue

      const meta = await sharp(result.image.bytes).metadata()
      const expectedFormat = format === 'jpg' ? 'jpeg' : format
      assert.equal(meta.format, expectedFormat, `${format} produced ${meta.format}`)
      assert.equal(result.image.extension, format)
      assert.equal(result.image.contentType, format === 'jpg' ? 'image/jpeg' : `image/${format}`)
    }
  })

  test('dimensions are untouched — this is an encoding change, not an edit', async () => {
    // A non-square master, so a conversion that "helpfully" squared it would
    // show up here.
    const source = await master(1200, 800)

    for (const format of DOWNLOAD_FORMATS) {
      const result = await convertImage(source, format)
      assert.equal(result.ok, true)
      if (!result.ok) continue

      assert.equal(result.image.width, 1200, `${format} changed the width`)
      assert.equal(result.image.height, 800, `${format} changed the height`)

      const meta = await sharp(result.image.bytes).metadata()
      assert.equal(meta.width, 1200)
      assert.equal(meta.height, 800)
    }
  })

  test('PNG is lossless: the pixels come back identical', async () => {
    const source = await master(64, 64)
    const before = await sharp(source).raw().toBuffer()

    const result = await convertImage(source, 'png')
    assert.equal(result.ok, true)
    if (!result.ok) return

    const after = await sharp(result.image.bytes).raw().toBuffer()
    assert.ok(after.equals(before), 'a PNG round trip must not change one pixel')
  })

  test('JPG and WebP stay close to the master', async () => {
    // Quality 95 with no chroma subsampling: the point of the conversion is a
    // smaller or more portable file, not a degraded one.
    const source = await master(200, 200)
    const before = await sharp(source).raw().toBuffer()

    for (const format of ['jpg', 'webp'] as const) {
      const result = await convertImage(source, format)
      assert.equal(result.ok, true)
      if (!result.ok) continue

      const after = await sharp(result.image.bytes).removeAlpha().raw().toBuffer()
      let diff = 0
      for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - after[i])
      const meanDiff = diff / before.length
      assert.ok(meanDiff < 12, `${format} moved pixels by ${meanDiff.toFixed(1)} levels on average`)
    }
  })

  test('transparency becomes white in a JPG rather than black', async () => {
    const transparent = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer()

    const result = await convertImage(transparent, 'jpg')
    assert.equal(result.ok, true)
    if (!result.ok) return

    const pixels = await sharp(result.image.bytes).raw().toBuffer()
    assert.ok(pixels[0] > 250 && pixels[1] > 250 && pixels[2] > 250,
      `expected white, got ${pixels[0]},${pixels[1]},${pixels[2]}`)
  })

  test('an unreadable file is refused, not thrown', async () => {
    const result = await convertImage(Buffer.from('not an image'), 'png')
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /could not be/)
  })
})

describe('which formats exist', () => {
  test('exactly the three offered', () => {
    assert.deepEqual([...DOWNLOAD_FORMATS], ['png', 'jpg', 'webp'])
  })

  test('anything else is refused before it reaches sharp', () => {
    for (const bad of ['gif', 'tiff', 'svg', 'avif', '', null, undefined, 42, 'png ']) {
      assert.equal(isDownloadFormat(bad), false, `${JSON.stringify(bad)} must not be accepted`)
    }
    for (const good of DOWNLOAD_FORMATS) assert.equal(isDownloadFormat(good), true)
  })
})
