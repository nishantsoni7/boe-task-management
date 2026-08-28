/**
 * Measuring a result against the approved composition.
 *
 * The fixtures are built to known numbers, so the measurement can be checked
 * against arithmetic rather than against a judgement. The two cases that decide
 * whether this is trustworthy:
 *
 *   * a product drawn at exactly the reference proportions measures at the
 *     reference proportions;
 *   * a soft cast shadow beneath the feet does NOT count as product, or every
 *     measurement would put the feet below the feet and report a taller
 *     product than the photograph contains.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/composition.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import { measureComposition, describeMeasurement } from './composition'
import { planPadding, MASTER_WIDTH, MASTER_HEIGHT } from './studioMaster'

/** A studio-like canvas with a dark block standing on it. */
async function scene(opts: {
  width: number
  height: number
  product: { left: number; top: number; width: number; height: number }
  shadow?: boolean
}): Promise<Buffer> {
  const { width, height, product } = opts
  const layers: OverlayOptions[] = []

  if (opts.shadow) {
    // A wide, faint smear under the feet: what a cast shadow looks like, and
    // what must not be mistaken for the product.
    layers.push({
      input: await sharp({
        create: {
          width: Math.round(product.width * 1.4), height: 26, channels: 4,
          // A real feathered cast shadow: it darkens the sweep by about a
          // tenth. A shadow dark enough to read as product would not be the
          // "restrained, secondary" one the scene asks for.
          background: { r: 120, g: 116, b: 110, alpha: 0.18 },
        },
      }).blur(9).png().toBuffer(),
      left: Math.max(0, Math.round(product.left - product.width * 0.2)),
      top: Math.min(height - 26, product.top + product.height - 6),
    })
  }

  layers.push({
    input: await sharp({
      create: { width: product.width, height: product.height, channels: 3, background: { r: 96, g: 62, b: 30 } },
    }).png().toBuffer(),
    left: product.left, top: product.top,
  })

  return sharp({
    create: { width, height, channels: 3, background: { r: 238, g: 236, b: 232 } },
  }).composite(layers).png().toBuffer()
}

describe('measuring the reference composition', () => {
  test('a product drawn at the targets measures at the targets', async () => {
    const plan = planPadding({ width: 900, height: 1200 })

    const png = await scene({
      width: MASTER_WIDTH, height: MASTER_HEIGHT,
      product: {
        left: plan.padding.left, top: plan.padding.top,
        width: plan.product.width, height: plan.product.height,
      },
    })

    const result = await measureComposition(png)
    assert.equal(result.ok, true, result.ok ? '' : result.error)
    if (!result.ok) return
    const m = result.measurement

    assert.equal(m.canvas.width, 1000)
    assert.equal(m.canvas.height, 1000)
    assert.ok(Math.abs(m.heightShare - 0.53) < 0.005, `height share ${m.heightShare}`)
    assert.ok(Math.abs(m.aboveShare - plan.padding.top / MASTER_HEIGHT) < 0.005, `above ${m.aboveShare}`)
    assert.ok(Math.abs(m.belowShare - plan.padding.bottom / MASTER_HEIGHT) < 0.006, `below ${m.belowShare}`)
    assert.ok(Math.abs(m.centreOffsetPx) <= 1, `centre offset ${m.centreOffsetPx}`)
    assert.ok(m.sideBalance > 0.98, `side balance ${m.sideBalance}`)
    assert.equal(m.touchesEdge, false)
  })

  test('a soft cast shadow is not counted as product', async () => {
    // Without this, the measured product runs down into its own shadow: the
    // height comes out too large and the feet baseline too low, and every
    // review of a real result would be wrong in the same direction.
    const plan = planPadding({ width: 900, height: 1200 })
    const width = MASTER_WIDTH
    const height = MASTER_HEIGHT
    const t = { centreX: MASTER_WIDTH / 2, productTop: plan.padding.top, productHeight: plan.product.height }

    const withShadow = await measureComposition(await scene({
      width, height, shadow: true,
      product: { left: t.centreX - 210, top: t.productTop, width: 420, height: t.productHeight },
    }))

    assert.equal(withShadow.ok, true)
    if (!withShadow.ok) return
    assert.ok(Math.abs(withShadow.measurement.heightShare - plan.heightShare) < 0.02,
      `the shadow inflated the product to ${(withShadow.measurement.heightShare * 100).toFixed(1)}%`)
  })

  test('a small product in a big canvas is reported as small, not as centred', async () => {
    // The rejected result was exactly this shape: a little chair adrift in a
    // decorated frame. The measurement has to say so.
    const png = await scene({
      width: 1200, height: 800,
      product: { left: 520, top: 330, width: 160, height: 180 },
    })

    const result = await measureComposition(png)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.measurement.heightShare < 0.3,
      `expected a small product, measured ${result.measurement.heightShare}`)
  })

  test('an off-centre product is reported by how far off it is', async () => {
    const png = await scene({
      width: 1200, height: 800,
      product: { left: 200, top: 168, width: 300, height: 520 },
    })

    const result = await measureComposition(png)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.measurement.centreOffsetPx < -200,
      `offset ${result.measurement.centreOffsetPx}`)
    assert.ok(result.measurement.sideBalance < 0.4, `balance ${result.measurement.sideBalance}`)
  })

  test('a cropped product is flagged as touching an edge', async () => {
    const png = await scene({
      width: 1200, height: 800,
      product: { left: 0, top: 0, width: 500, height: 700 },
    })

    const result = await measureComposition(png)
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.measurement.touchesEdge, true)
  })

  test('the square master measures the share the padding plan intended', async () => {
    // The plan and the measurement are independent: one computes padding from
    // a cut-out's size, the other reads a finished picture back. If they agree
    // on a product drawn exactly where the plan puts it, the arithmetic and the
    // check are not both wrong in the same direction.
    for (const cutout of [
      { width: 900, height: 1200 },   // a chair
      { width: 1400, height: 900 },   // a low sideboard
      { width: 700, height: 1900 },   // a tall cabinet
    ]) {
      const plan = planPadding(cutout)

      const png = await scene({
        width: MASTER_WIDTH, height: MASTER_HEIGHT,
        product: {
          left: plan.padding.left, top: plan.padding.top,
          width: plan.product.width, height: plan.product.height,
        },
      })

      const result = await measureComposition(png)
      assert.equal(result.ok, true)
      if (!result.ok) continue
      assert.ok(Math.abs(result.measurement.heightShare - plan.heightShare) < 0.006,
        `${cutout.width}x${cutout.height}: measured ${result.measurement.heightShare}, planned ${plan.heightShare}`)
    }
  })
})

describe('what this cannot tell you', () => {
  test('a decorative backdrop is measured AS the product', async () => {
    // Pinned deliberately. The rejected result put a small chair inside a
    // circular backdrop; measured, the circle is what differs from the corners,
    // so the numbers describe the circle and look reassuringly large and
    // centred. Anyone reading a measurement has to have looked at the image
    // first — this checks framing, never cleanliness.
    const width = MASTER_WIDTH
    const height = MASTER_HEIGHT
    const decorated = await sharp({
      create: { width, height, channels: 3, background: { r: 232, g: 228, b: 222 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
            `<circle cx="${width / 2}" cy="${height * 0.46}" r="${height * 0.34}" fill="#cfc7ba"/></svg>`),
          top: 0, left: 0,
        },
        {
          input: await sharp({
            create: { width: 180, height: 210, channels: 3, background: { r: 96, g: 62, b: 30 } },
          }).png().toBuffer(),
          left: Math.round(width / 2 - 90), top: Math.round(height * 0.36),
        },
      ])
      .png().toBuffer()

    const result = await measureComposition(decorated)
    assert.equal(result.ok, true)
    if (!result.ok) return

    // The chair is 210px tall — 26% of the canvas. The measurement reports the
    // circle instead, at about two thirds. That gap is the limitation.
    assert.ok(result.measurement.heightShare > 0.6,
      `measured ${result.measurement.heightShare}, which is the backdrop, not the chair`)
  })
})

describe('reporting', () => {
  test('an empty canvas is refused rather than measured', async () => {
    const blank = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 238, g: 236, b: 232 } },
    }).png().toBuffer()

    const result = await measureComposition(blank)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /No product/)
  })

  test('a file that is not an image is refused', async () => {
    const result = await measureComposition(Buffer.from('not a png'))
    assert.equal(result.ok, false)
  })

  test('the description carries every number a review needs', async () => {
    const png = await scene({
      width: 1200, height: 800,
      product: { left: 390, top: 168, width: 420, height: 520 },
    })
    const result = await measureComposition(png)
    assert.equal(result.ok, true)
    if (!result.ok) return

    const lines = describeMeasurement(result.measurement).join('\n')
    for (const needed of ['product height', 'space above', 'space below feet', 'feet baseline', 'centre offset', 'side balance']) {
      assert.ok(lines.includes(needed), `the report should mention ${needed}`)
    }
    assert.ok(lines.includes('[target 65%]'))
  })
})
