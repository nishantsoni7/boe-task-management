// The mark on quotation pictures (owner, 18 Nov 2026): layout numbers, and a real picture marked.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { MARK, logoPositions, markLayout, markPicture } from './pictureMark'

describe('markLayout', () => {
  test("the owner's numbers: a 6% strip centred at 58%, logo 45% of the strip", () => {
    const l = markLayout(1000, 1000)
    assert.equal(l.stripHeight, 60)
    assert.equal(l.stripTop, 550)           // centre at 580 = 58%
    assert.equal(l.logoHeight, 27)
    assert.equal(l.gap, Math.round(27 * MARK.gapLogos))
  })
  test('a small picture gets a strip tall enough to read, and never one taller than the picture', () => {
    assert.equal(markLayout(300, 200).stripHeight, 24)
    const tiny = markLayout(40, 10)
    assert.equal(tiny.stripHeight, 10)
    assert.equal(tiny.stripTop, 0)
  })
  test('the strip always lies inside the picture', () => {
    for (const h of [60, 200, 540, 1100, 4000]) {
      const l = markLayout(800, h)
      assert.ok(l.stripTop >= 0 && l.stripTop + l.stripHeight <= h, `h=${h}`)
    }
  })
})

describe('logoPositions', () => {
  test('one logo plus one gap apart, from half a gap in, until the strip is full', () => {
    const p = logoPositions(1000, { logoWidth: 100, gap: 50 })
    assert.equal(p[0], 25)
    assert.deepEqual(p.slice(0, 3), [25, 175, 325])
    assert.ok(p.every(x => x < 1000))
    assert.equal(p.length, 7)
  })
})

describe('markPicture', () => {
  const plain = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 240 } } }).jpeg().toBuffer()
  test('keeps the picture size, darkens the strip only, and leaves the rest untouched', async () => {
    const src = await plain(800, 600)
    const out = await markPicture(src)
    const meta = await sharp(out).metadata()
    assert.equal(meta.format, 'jpeg')
    assert.equal(meta.width, 800)
    assert.equal(meta.height, 600)
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const lum = (y: number) => data[(y * info.width + 5) * info.channels]  // a column at the left edge, between logos
    const l = markLayout(800, 600)
    const inStrip = lum(l.stripTop + 2)
    assert.ok(inStrip < 170, `strip is darker (${inStrip})`)
    assert.ok(lum(10) > 225, 'above the strip is untouched')
    assert.ok(lum(590) > 225, 'below the strip is untouched')
  })
  test('white logo pixels are present on the strip', async () => {
    const out = await markPicture(await plain(800, 600))
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const l = markLayout(800, 600)
    let bright = 0
    for (let x = 0; x < info.width; x++) {
      const y = l.stripTop + Math.round(l.stripHeight / 2)
      if (data[(y * info.width + x) * info.channels] > 225) bright++
    }
    assert.ok(bright > 20, `logo pixels on the strip (${bright})`)
  })
  test('a picture that is not an image is refused', async () => {
    await assert.rejects(() => markPicture(Buffer.from('not a picture')))
  })
})
