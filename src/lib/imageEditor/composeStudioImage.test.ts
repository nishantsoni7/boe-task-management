/**
 * The finished image, built from a cut-out with no provider involved.
 *
 * Everything here runs for real: sharp composes actual pixels and the
 * assertions read them back. The cases are the promises the page makes about
 * the result — a fixed square canvas, a warm-white background, a product that
 * was scaled but never stretched, kept whole and centred, and a shadow whose
 * shape came from the product's own alpha rather than from a drawn ellipse.
 *
 * The four-legged fixture is the one that matters. A shadow drawn as one blob
 * under the whole product would pass every other test in this file and still be
 * wrong: a chair's shadow has floor between its legs.
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
  alphaBounds,
  CANVAS_PX,
  MARGIN_RATIO,
  BACKGROUND,
} from './composeStudioImage'

/** A transparent PNG with an opaque shape somewhere inside it. */
async function cutout(
  width: number,
  height: number,
  shape: { left: number; top: number; width: number; height: number },
  colour = '#a9682f',
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{
      input: {
        create: {
          width: shape.width, height: shape.height, channels: 4,
          background: { ...hexToRgb(colour), alpha: 1 },
        },
      },
      left: shape.left, top: shape.top,
    }])
    .png()
    .toBuffer()
}

/** A seat on four legs, transparent between them — the shape a real chair cuts. */
async function fourLeggedCutout(): Promise<Buffer> {
  const legs: OverlayOptions[] = [40, 150, 250, 360].map(left => ({
    input: { create: { width: 30, height: 180, channels: 4 as const, background: { r: 90, g: 60, b: 30, alpha: 1 } } },
    left, top: 220,
  }))
  return sharp({
    create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: { create: { width: 380, height: 120, channels: 4, background: { r: 169, g: 104, b: 47, alpha: 1 } } }, left: 30, top: 100 },
      ...legs,
    ])
    .png()
    .toBuffer()
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** One pixel of a rendered image, as RGB. */
async function pixel(png: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const meta = await sharp(png).metadata()
  const i = (y * (meta.width ?? 0) + x) * 4
  return { r: data[i], g: data[i + 1], b: data[i + 2] }
}

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance

describe('the canvas', () => {
  test('is exactly 2048 x 2048, opaque PNG', async () => {
    const result = await composeStudioImage(await cutout(800, 600, { left: 200, top: 150, width: 400, height: 300 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const meta = await sharp(result.png).metadata()
    assert.equal(meta.width, CANVAS_PX)
    assert.equal(meta.height, CANVAS_PX)
    assert.equal(meta.format, 'png')
    // Flattened: a catalogue image with a transparent background would print
    // as a black square.
    assert.equal(meta.channels, 3)
  })

  test('the background is the soft warm white, in every corner', async () => {
    const result = await composeStudioImage(await cutout(800, 600, { left: 200, top: 150, width: 400, height: 300 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    for (const [x, y] of [[4, 4], [CANVAS_PX - 5, 4], [4, CANVAS_PX - 5], [CANVAS_PX - 5, CANVAS_PX - 5]]) {
      const p = await pixel(result.png, x, y)
      assert.ok(near(p.r, BACKGROUND.r) && near(p.g, BACKGROUND.g) && near(p.b, BACKGROUND.b),
        `corner ${x},${y} should be warm white, got ${JSON.stringify(p)}`)
    }
    // Warm, not neutral: red above green above blue.
    assert.ok(BACKGROUND.r > BACKGROUND.g && BACKGROUND.g > BACKGROUND.b)
  })
})

describe('the product', () => {
  test('keeps its aspect ratio — scaled, never stretched', async () => {
    // 2:1, deliberately far from square.
    const result = await composeStudioImage(await cutout(1000, 1000, { left: 100, top: 400, width: 800, height: 400 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { width, height } = result.placement
    assert.ok(Math.abs(width / height - 2) < 0.01, `expected 2:1, got ${width}x${height}`)
  })

  test('is contained inside the canvas with a balanced margin on all four sides', async () => {
    const result = await composeStudioImage(await cutout(900, 700, { left: 50, top: 60, width: 500, height: 500 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { left, top, width, height } = result.placement
    const margin = Math.round(CANVAS_PX * MARGIN_RATIO)

    assert.ok(left >= margin - 1, 'left margin')
    assert.ok(top >= margin - 1, 'top margin')
    assert.ok(left + width <= CANVAS_PX - margin + 1, 'right margin')
    assert.ok(top + height <= CANVAS_PX - margin + 1, 'bottom margin')

    // Centred: the two horizontal margins match, and so do the vertical ones.
    assert.ok(Math.abs(left - (CANVAS_PX - left - width)) <= 1, 'horizontally centred')
    assert.ok(Math.abs(top - (CANVAS_PX - top - height)) <= 1, 'vertically centred')
  })

  test('is found by its alpha, so surrounding transparency is cropped away', async () => {
    // The product occupies a small corner of a large transparent canvas. If the
    // crop were skipped it would come out tiny in the middle of the frame.
    const result = await composeStudioImage(await cutout(2000, 2000, { left: 20, top: 20, width: 200, height: 200 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const box = CANVAS_PX - Math.round(CANVAS_PX * MARGIN_RATIO) * 2
    assert.equal(result.placement.width, box)
    assert.equal(result.placement.height, box)
  })

  test('its own pixels survive the composition', async () => {
    const result = await composeStudioImage(await cutout(600, 600, { left: 100, top: 100, width: 400, height: 400 }, '#a9682f'))
    assert.equal(result.ok, true)
    if (!result.ok) return

    // Dead centre is the middle of the product. No colour correction is applied
    // anywhere, so the finish that went in is the finish that comes out.
    const p = await pixel(result.png, CANVAS_PX / 2, CANVAS_PX / 2)
    const expected = hexToRgb('#a9682f')
    assert.ok(near(p.r, expected.r) && near(p.g, expected.g) && near(p.b, expected.b),
      `expected the source colour unchanged, got ${JSON.stringify(p)}`)
  })

  test('an empty cut-out is refused rather than composed into a blank card', async () => {
    const empty = await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer()

    const result = await composeStudioImage(empty)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /No product/i)
  })

  test('a file that is not an image fails cleanly', async () => {
    const result = await composeStudioImage(Buffer.from('not a png'))
    assert.equal(result.ok, false)
  })
})

describe('the contact shadow', () => {
  test('is present beneath the product, and darker than the background', async () => {
    const result = await composeStudioImage(await cutout(600, 600, { left: 100, top: 100, width: 400, height: 400 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { top, height, left, width } = result.placement
    const below = await pixel(result.png, left + Math.round(width / 2), top + height + 12)

    assert.ok(below.r < BACKGROUND.r - 6, `expected a shadow below the product, got ${JSON.stringify(below)}`)
    // Subtle, not a black bar.
    assert.ok(below.r > 150, `the shadow must stay soft, got ${JSON.stringify(below)}`)
  })

  test('takes its shape from the alpha mask: floor stays visible between the legs', async () => {
    const result = await composeStudioImage(await fourLeggedCutout())
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { top, height, left, width } = result.placement
    const y = top + height + 6

    // The fixture's legs sit at x ≈ 40–70, 150–180, 250–280, 360–390 of 500,
    // scaled to the placement. Under a leg it must be darker than in the gap
    // between two legs.
    const at = (fraction: number) => left + Math.round(width * fraction)
    const underLeg = await pixel(result.png, at((150 + 15) / 420), y)
    const betweenLegs = await pixel(result.png, at((180 + 250) / 2 / 420), y)

    assert.ok(underLeg.r < betweenLegs.r - 4,
      `a leg must cast more shadow than the gap beside it: leg ${underLeg.r}, gap ${betweenLegs.r}`)
    // And the gap must still read as floor, not as one continuous smear.
    assert.ok(betweenLegs.r > BACKGROUND.r - 20,
      `the floor between legs must stay visible, got ${betweenLegs.r}`)
  })

  test('does not darken the top of the frame', async () => {
    const result = await composeStudioImage(await cutout(600, 600, { left: 100, top: 100, width: 400, height: 400 }))
    assert.equal(result.ok, true)
    if (!result.ok) return

    const above = await pixel(result.png, CANVAS_PX / 2, result.placement.top - 20)
    assert.ok(near(above.r, BACKGROUND.r, 3), `above the product must stay clean, got ${JSON.stringify(above)}`)
  })
})

describe('alphaBounds', () => {
  test('finds the tight box around anything opaque', () => {
    const w = 10, h = 10
    const alpha = new Uint8Array(w * h)
    alpha[2 * w + 3] = 255
    alpha[6 * w + 8] = 255

    assert.deepEqual(alphaBounds(alpha, w, h), { left: 3, top: 2, width: 6, height: 5 })
  })

  test('ignores all-but-invisible pixels, and answers null for an empty mask', () => {
    const w = 4, h = 4
    const faint = new Uint8Array(w * h).fill(3)
    assert.equal(alphaBounds(faint, w, h), null)
    assert.equal(alphaBounds(new Uint8Array(w * h), w, h), null)
  })
})
