/**
 * The three things done to a photograph before it is sent for editing, and the
 * one thing that must NOT be done to it.
 *
 * The orientation case is the operational one. Employees photograph furniture on
 * a phone, and a portrait phone photograph is stored as landscape pixels plus an
 * EXIF "rotate me" flag. A provider reading raw pixels never sees that flag, so
 * without this step BOE's rule — keep the uploaded viewing direction — is broken
 * before the model is even asked to keep it.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/prepareSource.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { prepareSourceImage, MAX_SOURCE_EDGE_PX } from './prepareSource'

/** A plain image of the given size, in the given format. */
async function makeImage(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: '#8a6a44' } })
  return format === 'png' ? base.png().toBuffer() : base.jpeg().toBuffer()
}

async function sizeOf(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

describe('preparing an upload', () => {
  test('a portrait phone photograph is rotated upright before it is sent', async () => {
    // 40×20 pixels tagged "orientation 6" is what a phone stores for a portrait
    // shot. Upright, it is 20×40.
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#8a6a44' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    const prepared = await prepareSourceImage(bytes, 'image/jpeg')
    assert.equal(prepared.ok, true)
    if (!prepared.ok) return

    assert.deepEqual(await sizeOf(prepared.bytes), { width: 20, height: 40 })
    assert.equal(prepared.width, 20)
    assert.equal(prepared.height, 40)
  })

  test('an oversized photograph is scaled to the longest-edge limit, keeping its shape', async () => {
    const bytes = await makeImage(6000, 4000)
    const prepared = await prepareSourceImage(bytes, 'image/jpeg')

    assert.equal(prepared.ok, true)
    if (!prepared.ok) return

    assert.equal(prepared.width, MAX_SOURCE_EDGE_PX)
    // 3:2 in, 3:2 out. A stretched source would be a changed product.
    assert.equal(prepared.height, Math.round(MAX_SOURCE_EDGE_PX * 2 / 3))
    assert.equal(prepared.mimeType, 'image/jpeg')
  })

  test('a photograph that needs nothing is passed through byte for byte', async () => {
    // Not re-encoded "just in case": every re-encode is a small loss of the
    // upholstery texture and wood grain the edit is supposed to preserve.
    const bytes = await makeImage(1200, 900, 'png')
    const prepared = await prepareSourceImage(bytes, 'image/png')

    assert.equal(prepared.ok, true)
    if (!prepared.ok) return

    assert.ok(prepared.bytes.equals(bytes))
    assert.equal(prepared.mimeType, 'image/png')
    assert.equal(prepared.width, 1200)
    assert.equal(prepared.height, 900)
  })

  test('an image at exactly the limit is left alone', async () => {
    const bytes = await makeImage(MAX_SOURCE_EDGE_PX, 1000)
    const prepared = await prepareSourceImage(bytes, 'image/jpeg')

    assert.equal(prepared.ok, true)
    assert.ok(prepared.ok && prepared.bytes.equals(bytes))
  })

  test('a file that is not an image fails cleanly instead of throwing', async () => {
    const prepared = await prepareSourceImage(Buffer.from('not an image at all'), 'image/jpeg')
    assert.equal(prepared.ok, false)
    assert.match(prepared.ok ? '' : prepared.error, /could not be read/)
  })

  test('a truncated JPEG fails cleanly too', async () => {
    const bytes = (await makeImage(800, 600)).subarray(0, 40)
    const prepared = await prepareSourceImage(bytes, 'image/jpeg')
    assert.equal(prepared.ok, false)
  })
})
