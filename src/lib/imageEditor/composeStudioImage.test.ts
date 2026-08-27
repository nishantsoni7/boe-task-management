/**
 * The finished image, built from a cut-out with no provider involved.
 *
 * Everything here runs for real: sharp composes actual pixels and the
 * assertions read them back.
 *
 * The cases that matter most are the two this file exists to lock down after
 * the first version shipped soft images:
 *
 *   * a product too small to reach the frame within the enlargement cap is
 *     REFUSED, not enlarged — the refusal is the feature;
 *   * the shadow comes from the columns that actually reach the floor, so a
 *     seat with two legs casts two shadows and nothing under the gap between
 *     them.
 *
 * Fixtures are large (~1400px) because that is what the gate now requires; the
 * suite is correspondingly slower than a unit-test suite has any right to be.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/composeStudioImage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import {
  composeStudioImage,
  defringe,
  CANVAS_PX,
  MARGIN_RATIO,
  MAX_ENLARGEMENT,
  BACKGROUND,
  BACKGROUND_FOOT,
} from './composeStudioImage'

/** Big enough to clear the enlargement gate. */
const BIG = 1500

/** A transparent canvas with one opaque rectangle in it. Noise, so the product
 *  carries detail — a flat patch would trip the sharpness gate. */
async function cutout(
  width: number,
  height: number,
  shape: { left: number; top: number; width: number; height: number },
  tint: { r: number; g: number; b: number } = { r: 169, g: 104, b: 47 },
): Promise<Buffer> {
  const body = await sharp({
    create: {
      width: shape.width, height: shape.height, channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 22 },
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .tint(tint)
    .png()
    .toBuffer()

  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: body, left: shape.left, top: shape.top }])
    .png()
    .toBuffer()
}

/** A seat on two narrow legs with a wide gap between them: the shape that tells
 *  a contact shadow apart from a silhouette shadow. */
async function twoLeggedCutout(): Promise<Buffer> {
  const seat = await sharp({
    create: { width: 1500, height: 300, channels: 3, noise: { type: 'gaussian', mean: 130, sigma: 20 }, background: { r: 0, g: 0, b: 0 } },
  }).tint({ r: 169, g: 104, b: 47 }).png().toBuffer()

  const leg = await sharp({
    create: { width: 110, height: 1150, channels: 3, noise: { type: 'gaussian', mean: 110, sigma: 18 }, background: { r: 0, g: 0, b: 0 } },
  }).tint({ r: 120, g: 78, b: 38 }).png().toBuffer()

  const parts: OverlayOptions[] = [
    { input: seat, left: 150, top: 150 },
    { input: leg, left: 210, top: 430 },
    { input: leg, left: 1430, top: 430 },
  ]

  return sharp({
    create: { width: 1800, height: 1800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(parts).png().toBuffer()
}

async function pixel(png: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return { r: data[i], g: data[i + 1], b: data[i + 2] }
}

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance

describe('the quality gate', () => {
  test('a product too small for a sharp 2048px image is refused, not enlarged', async () => {
    // 300px of product would need ~5.7x. The old pipeline delivered that as a
    // "catalogue image"; measured, it lost 71% of its fine detail.
    const result = await composeStudioImage(await cutout(2000, 2000, { left: 800, top: 800, width: 300, height: 300 }))

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error, 'quality')
    assert.match(result.quality?.message ?? '', /too small/i)
    assert.match(result.quality?.message ?? '', /closer|crop/i)
    // The log line carries measurements and no image data.
    assert.match(result.quality?.detail ?? '', /300x300/)
    assert.match(result.quality?.detail ?? '', /enlargement/)
  })

  test('a product just inside the cap is accepted', async () => {
    const box = CANVAS_PX - Math.round(CANVAS_PX * MARGIN_RATIO) * 2
    const justEnough = Math.ceil(box / MAX_ENLARGEMENT) + 8

    const result = await composeStudioImage(
      await cutout(justEnough + 100, justEnough + 100, { left: 50, top: 50, width: justEnough, height: justEnough }),
    )
    assert.equal(result.ok, true, result.ok ? '' : result.quality?.detail ?? result.error)
    if (!result.ok) return
    assert.ok(result.metrics.enlargement <= MAX_ENLARGEMENT + 0.01)
  })

  test('a product larger than the frame is downscaled, never refused', async () => {
    const result = await composeStudioImage(await cutout(3000, 3000, { left: 100, top: 100, width: 2800, height: 2800 }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.metrics.enlargement < 1)
  })

  test('a completely flat product is refused as too soft', async () => {
    // No texture at all: nothing a resize could sharpen into detail.
    const flat = await sharp({
      create: { width: 1500, height: 1500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{
        input: {
          create: { width: BIG, height: BIG, channels: 4, background: { r: 169, g: 104, b: 47, alpha: 1 } },
        },
        left: 0, top: 0,
      }])
      .png().toBuffer()

    const result = await composeStudioImage(flat)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error, 'quality')
    assert.match(result.quality?.message ?? '', /too soft|focus/i)
  })

  test('an empty cut-out is refused with its own message', async () => {
    const empty = await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer()

    const result = await composeStudioImage(empty)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /No product/i)
  })
})

describe('the canvas', () => {
  test('is exactly 2048 x 2048, opaque PNG', async () => {
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const meta = await sharp(result.png).metadata()
    assert.equal(meta.width, CANVAS_PX)
    assert.equal(meta.height, CANVAS_PX)
    assert.equal(meta.format, 'png')
    assert.equal(meta.channels, 3)
  })

  test('the background is warm white, and carries a gentle vertical gradient', async () => {
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const topLeft = await pixel(result.png, 4, 4)
    const bottomLeft = await pixel(result.png, 4, CANVAS_PX - 5)

    assert.ok(near(topLeft.r, BACKGROUND.r) && near(topLeft.b, BACKGROUND.b), `top ${JSON.stringify(topLeft)}`)
    assert.ok(near(bottomLeft.r, BACKGROUND_FOOT.r) && near(bottomLeft.b, BACKGROUND_FOOT.b), `foot ${JSON.stringify(bottomLeft)}`)

    // Warm at both ends: red above green above blue, never yellow-cast or grey.
    for (const p of [topLeft, bottomLeft]) assert.ok(p.r > p.g && p.g > p.b, JSON.stringify(p))
    // And gentle: the whole ramp is under 12 levels.
    assert.ok(topLeft.r - bottomLeft.r < 12, 'the gradient must stay subtle')
  })
})

describe('the product', () => {
  test('keeps its aspect ratio — scaled, never stretched', async () => {
    const result = await composeStudioImage(await cutout(3000, 2000, { left: 100, top: 300, width: 2800, height: 1400 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { width, height } = result.metrics.placement
    assert.ok(Math.abs(width / height - 2) < 0.01, `expected 2:1, got ${width}x${height}`)
  })

  test('sits inside the margins on all four sides', async () => {
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { left, top, width, height } = result.metrics.placement
    const margin = Math.round(CANVAS_PX * MARGIN_RATIO)

    assert.ok(left >= Math.round(margin * 0.75) - 1, 'left')
    assert.ok(top >= Math.round(margin * 0.75) - 1, 'top')
    assert.ok(left + width <= CANVAS_PX - margin + 1, 'right')
    assert.ok(top + height <= CANVAS_PX - margin + 1, 'bottom')
  })

  test('is centred by its mass, not by its bounding box', async () => {
    // Heavy on the left, light on the right: a box-centred placement would look
    // visibly off. The mass centre pulls it back.
    // Tall enough that the height, not the width, decides the scale — so the
    // placement has lateral room to move and the test can see it move.
    const heavy = await sharp({
      create: { width: 500, height: 1400, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 22 }, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer()
    const light = await sharp({
      create: { width: 120, height: 1400, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 22 }, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer()

    const lopsided = await sharp({
      create: { width: 1200, height: 1600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: heavy, left: 40, top: 100 },
        { input: light, left: 900, top: 100 },
      ])
      .png().toBuffer()

    const result = await composeStudioImage(lopsided)
    assert.equal(result.ok, true, result.ok ? '' : result.quality?.detail ?? result.error)
    if (!result.ok) return

    const { left, width } = result.metrics.placement
    const boxCentred = Math.round((CANVAS_PX - width) / 2)
    // The heavy half is on the left, so mass-centring must push the box right.
    assert.ok(left > boxCentred, `mass centring should shift right of ${boxCentred}, got ${left}`)
  })

  test('no pale outline appears around the cut-out edge', async () => {
    // The halo sharpening produces on a cut-out is the single most obvious
    // "badly cut out" tell. Sampled just outside the product, the background
    // must still be the background.
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { left, top, width } = result.metrics.placement
    for (const dx of [-6, -3, -2]) {
      const p = await pixel(result.png, left + dx, top + Math.round(width / 2))
      assert.ok(near(p.r, BACKGROUND.r, 6) && near(p.g, BACKGROUND.g, 6),
        `halo at dx=${dx}: ${JSON.stringify(p)}`)
    }
  })
})

describe('the contact shadow', () => {
  test('falls under the legs and not under the gap between them', async () => {
    const result = await composeStudioImage(await twoLeggedCutout())
    assert.equal(result.ok, true, result.ok ? '' : result.quality?.detail ?? result.error)
    if (!result.ok) return

    const { left, top, width, height } = result.metrics.placement
    const y = top + height + 6
    const at = (fraction: number) => left + Math.round(width * fraction)

    // Legs at roughly x = 210-320 and 1430-1540, in a bbox starting at x = 150.
    const underLeg = await pixel(result.png, at((210 + 55 - 150) / 1500), y)
    const underGap = await pixel(result.png, at(0.5), y)

    assert.ok(underLeg.r < underGap.r - 6,
      `leg ${underLeg.r} should be darker than the gap ${underGap.r}`)
    // The gap must read as floor. Not the seat's silhouette printed on it.
    assert.ok(underGap.r > BACKGROUND_FOOT.r - 14, `gap ${underGap.r} should still be background`)
  })

  test('grounds the product without a dark oval', async () => {
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { left, top, width, height } = result.metrics.placement
    const below = await pixel(result.png, left + Math.round(width / 2), top + height + 8)

    assert.ok(below.r < BACKGROUND_FOOT.r - 5, `expected a shadow, got ${JSON.stringify(below)}`)
    assert.ok(below.r > 150, `the shadow must stay soft, got ${JSON.stringify(below)}`)
  })

  test('reports how many columns actually touched the floor', async () => {
    const result = await composeStudioImage(await twoLeggedCutout())
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { contactColumns, placement } = result.metrics
    assert.ok(contactColumns > 0, 'the legs must be found')
    // Two legs, not the whole seat: well under half the product's width.
    assert.ok(contactColumns < placement.width * 0.35,
      `${contactColumns} of ${placement.width} columns is a silhouette, not two feet`)
  })

  test('does not darken the top of the frame', async () => {
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const above = await pixel(result.png, CANVAS_PX / 2, result.metrics.placement.top - 20)
    assert.ok(near(above.r, BACKGROUND.r, 4), `above the product must stay clean, got ${JSON.stringify(above)}`)
  })
})

describe('the cut-out edge', () => {
  /** A product with a `depth`-pixel rim of half-transparent background colour,
   *  as raw RGBA — the shape a segmenter leaves along a chair leg. */
  function contaminated(size: number, depth: number) {
    const rgba = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4
        const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
        if (edge < depth) {
          // The old background, half covered: green wall, green rim.
          rgba[o] = 60; rgba[o + 1] = 190; rgba[o + 2] = 70; rgba[o + 3] = 128
        } else {
          rgba[o] = 140; rgba[o + 1] = 90; rgba[o + 2] = 40; rgba[o + 3] = 255
        }
      }
    }
    return rgba
  }

  test('a green rim takes the product\'s colour, and keeps every pixel of alpha', async () => {
    const size = 60, depth = 2
    const rgba = contaminated(size, depth)
    const alphaBefore = Buffer.from(rgba.filter((_, i) => i % 4 === 3))

    await defringe(rgba, size, size)

    // A rim pixel: no longer greener than it is red.
    const rim = (size * 0 + Math.round(size / 2)) * 4
    assert.ok(rgba[rim + 1] < rgba[rim] + 20,
      `rim still green: ${rgba[rim]},${rgba[rim + 1]},${rgba[rim + 2]}`)
    assert.ok(rgba[rim] > 100, 'and it has taken the product colour, not gone grey')

    // Not one pixel of alpha moved: the leg is exactly as wide as it was.
    const alphaAfter = Buffer.from(rgba.filter((_, i) => i % 4 === 3))
    assert.ok(alphaAfter.equals(alphaBefore), 'alpha must be untouched')
  })

  test('solid product pixels are left exactly alone', async () => {
    const size = 60
    const rgba = contaminated(size, 2)
    const middle = ((size / 2) * size + size / 2) * 4
    const before = [rgba[middle], rgba[middle + 1], rgba[middle + 2]]

    await defringe(rgba, size, size)

    assert.deepEqual([rgba[middle], rgba[middle + 1], rgba[middle + 2]], before)
  })

  test('a fully transparent pixel is not given a colour', async () => {
    const size = 40
    const rgba = Buffer.alloc(size * size * 4)
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) {
        const o = (y * size + x) * 4
        rgba[o] = 140; rgba[o + 1] = 90; rgba[o + 2] = 40; rgba[o + 3] = 255
      }
    }
    await defringe(rgba, size, size)
    assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 0])
  })

  test('and end to end, no halo appears where the product meets the background', async () => {
    const result = await composeStudioImage(await cutout(1600, 1600, { left: 50, top: 50, width: BIG, height: BIG }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { left, top, height } = result.metrics.placement
    const outside = await pixel(result.png, left - 4, top + Math.round(height / 2))
    assert.ok(near(outside.r, BACKGROUND.r, 6), `halo outside the edge: ${JSON.stringify(outside)}`)
  })
})

describe('cut-out shapes no photograph of a chair produces', () => {
  test('a wide, shallow sliver is refused or composed, never thrown', async () => {
    const result = await composeStudioImage(await cutout(3000, 400, { left: 0, top: 200, width: 3000, height: 3 }))
    // Either answer is acceptable; an exception is not.
    if (result.ok) {
      const meta = await sharp(result.png).metadata()
      assert.equal(meta.width, CANVAS_PX)
    } else {
      assert.ok(result.error.length > 0)
    }
  })

  test('a tall, narrow sliver behaves the same way', async () => {
    const result = await composeStudioImage(await cutout(400, 3000, { left: 200, top: 0, width: 3, height: 3000 }))
    assert.ok(typeof result.ok === 'boolean')
  })

  test('a file that is not an image fails cleanly', async () => {
    const result = await composeStudioImage(Buffer.from('not a png'))
    assert.equal(result.ok, false)
  })
})
