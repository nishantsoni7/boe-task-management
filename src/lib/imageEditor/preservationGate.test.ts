/**
 * The gate, and an honest account of what it can decide.
 *
 * It cannot prove preservation — two generative models render the final image
 * and neither has a pass-through mode. What it does is refuse the failures that
 * are measurable, so an obviously wrong image is not served silently.
 *
 * The regression subject is the failure the REJECTED pipeline produced
 * (background removal -> prepared cut-out -> Product Shot): the fan of thin
 * verticals under the Irvine chair's seat came back as one opaque block. The
 * pipeline now under test feeds the original photograph instead, which is what
 * the accepted playground run did — so whether that failure recurs is the open
 * question, and this gate is what would catch it if it does.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/preservationGate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  profile, comparePreservation, checkFraming,
  STRUCTURE_FLOOR, PRESERVATION_REFUSAL, INCONCLUSIVE_MESSAGE,
} from './preservationGate'
import { PRODUCT_HEIGHT_MIN, PRODUCT_HEIGHT_MAX } from './studioMaster'

type Opt = {
  size?: number
  product?: { left: number; top: number; width: number; height: number }
  spindles?: number
  spindleWidth?: number
  factoryBackground?: boolean
  /** Fill the fan region solid, keeping the product's bounds identical. This is
   *  the rejected result: the same chair with the openings gone. */
  mergedFan?: boolean
}

/** A photograph or a generated image; the fan under the seat is the variable. */
async function subject(o: Opt = {}): Promise<Buffer> {
  const {
    size = 1000,
    product = { left: 300, top: 200, width: 400, height: 560 },
    spindles = 16, spindleWidth = 3, factoryBackground = false, mergedFan = false,
  } = o

  const d = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o2 = (y * size + x) * 3
    // A cluttered factory wall, or a clean studio sweep. The gate must not care.
    const tone = factoryBackground
      ? 120 + ((x / 37 | 0) % 2 ? 14 : 0) + ((y / 53 | 0) % 2 ? 9 : 0)
      : 148 + (214 - 148) * (y / size)
    d[o2] = tone + 4; d[o2 + 1] = tone; d[o2 + 2] = tone - 6
  }

  const ink = (l: number, t: number, w: number, h: number, v = 80) => {
    for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue
      const o2 = (y * size + x) * 3
      d[o2] = v; d[o2 + 1] = Math.round(v * 0.85); d[o2 + 2] = Math.round(v * 0.7)
    }
  }
  const p = product
  ink(p.left + 20, p.top, p.width - 40, 22)
  for (let i = 0; i < 9; i++) ink(p.left + 34 + i * Math.round((p.width - 60) / 9), p.top + 22, 6, Math.round(p.height * 0.32))
  ink(p.left, p.top + Math.round(p.height * 0.38), p.width, Math.round(p.height * 0.08))
  const fanTop = p.top + Math.round(p.height * 0.46)
  const fanHeight = Math.round(p.height * 0.16)
  const step = Math.max(spindleWidth + 2, Math.round((p.width - 30) / Math.max(1, spindles)))
  if (mergedFan) {
    // Exactly the span the fan occupied, filled in. Same bounds, no openings.
    ink(p.left + 15, fanTop, (spindles - 1) * step + spindleWidth, fanHeight, 72)
  } else {
    for (let i = 0; i < spindles; i++) ink(p.left + 15 + i * step, fanTop, spindleWidth, fanHeight, 72)
  }
  ink(p.left + 10, p.top + Math.round(p.height * 0.66), 24, Math.round(p.height * 0.34))
  ink(p.left + p.width - 34, p.top + Math.round(p.height * 0.66), 24, Math.round(p.height * 0.34))

  return sharp(d, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

const profileOf = async (o: Opt = {}) => {
  const p = await profile(await subject(o))
  assert.ok(p, 'the fixture must be measurable')
  return p!
}

describe('the regression subject', () => {
  test('a faithful generation passes', async () => {
    const original = await profileOf({ factoryBackground: false })
    const generated = await profileOf({ factoryBackground: false })

    const report = comparePreservation(original, generated, 'after product shot')
    assert.equal(report.ok, true, report.summary)
  })

  test('a merged under-seat fan is REFUSED', async () => {
    // "The fan-like vertical spindles beneath the seat became a dark opaque
    // mass" — the rejected cut-out pipeline's result. This test is what would
    // catch it recurring, whatever the pipeline feeds the model.
    const original = await profileOf({ factoryBackground: false, spindles: 16, spindleWidth: 3 })
    const merged = await profileOf({ factoryBackground: false, spindles: 16, spindleWidth: 3, mergedFan: true })

    const report = comparePreservation(original, merged, 'after product shot')
    assert.equal(report.ok, false, report.summary)

    const underseat = report.checks.find(c => c.name === 'under-seat structure')
    assert.ok(underseat && !underseat.ok, `the under-seat check should have fired: ${report.summary}`)
  })

  test('thinning the fan by half is still caught', async () => {
    const original = await profileOf({ factoryBackground: false, spindles: 16 })
    const thinned = await profileOf({ factoryBackground: false, spindles: 4, spindleWidth: 3 })

    const report = comparePreservation(original, thinned, 'after product shot')
    assert.equal(report.ok, false, report.summary)
  })

  test('the floor is a real threshold, not a formality', () => {
    assert.ok(STRUCTURE_FLOOR > 0.3 && STRUCTURE_FLOOR < 0.9, `${STRUCTURE_FLOOR}`)
  })
})

describe('what else it refuses', () => {
  test('a product that came back a different shape', async () => {
    const original = await profileOf({ product: { left: 300, top: 200, width: 400, height: 560 } })
    const squashed = await profileOf({ product: { left: 200, top: 300, width: 620, height: 340 } })

    const report = comparePreservation(original, squashed, 'after product shot')
    const aspect = report.checks.find(c => c.name === 'aspect ratio')
    assert.ok(aspect && !aspect.ok, report.summary)
    assert.equal(report.ok, false)
  })

  test('a product touching the frame edge, which may be cropped', async () => {
    const original = await profileOf()
    const cropped = await profileOf({ product: { left: -30, top: 200, width: 430, height: 560 } })

    const report = comparePreservation(original, cropped, 'after upscale')
    const extremities = report.checks.find(c => c.name === 'extremities')
    assert.ok(extremities && !extremities.ok, report.summary)
  })

  test('the refusal names no provider and blames no photograph wrongly', () => {
    for (const w of ['fal', 'bria', 'seedvr', 'http']) {
      assert.ok(!PRESERVATION_REFUSAL.toLowerCase().includes(w), PRESERVATION_REFUSAL)
    }
    assert.match(PRESERVATION_REFUSAL, /did not preserve the product/i)
  })

  test('the summary is measurements only — never image data', async () => {
    const original = await profileOf()
    const generated = await profileOf()
    const report = comparePreservation(original, generated, 'after product shot')

    assert.ok(!report.summary.includes('base64'))
    assert.ok(!report.summary.includes('data:'))
    assert.ok(report.summary.startsWith('after product shot'))
  })

  test('the two stages are labelled separately in the report', async () => {
    const o = await profileOf()
    const g = await profileOf()
    assert.match(comparePreservation(o, g, 'after product shot').summary, /^after product shot/)
    assert.match(comparePreservation(o, g, 'after upscale').summary, /^after upscale/)
  })
})

describe('the background cannot influence the verdict', () => {
  test('a cluttered upload is reported as unverifiable, never passed quietly', async () => {
    // The real limitation: edge energy cannot find a product on a textured
    // factory wall, so the upload cannot be ground truth. The gate must say so.
    const cluttered = await profileOf({ factoryBackground: true })
    assert.equal(cluttered.confident, false, 'a textured background must not be trusted as ground truth')

    const generated = await profileOf({ factoryBackground: false })
    const report = comparePreservation(cluttered, generated, 'after product shot')

    const comparison = report.checks.find(c => c.name === 'comparison')
    assert.ok(comparison, 'the report must say the comparison did not happen')
    assert.match(comparison!.detail, /INCONCLUSIVE/)
    // And the checks that need no comparison still run.
    assert.ok(report.checks.some(c => c.name === 'extremities'))
  })

  test('an inconclusive comparison is flagged, and its wording is exact', async () => {
    const report = comparePreservation(
      await profileOf({ factoryBackground: true }),
      await profileOf({ factoryBackground: false }),
      'after product shot',
    )
    assert.equal(report.inconclusive, true)
    assert.equal(INCONCLUSIVE_MESSAGE, 'Structural comparison inconclusive; manual review required.')
    assert.ok(report.summary.includes(INCONCLUSIVE_MESSAGE), report.summary)
  })

  test('inconclusive is NOT folded into ok, so it can never read as verified', async () => {
    // `ok` alone would say "passed" here, and the structure was never compared.
    // The two are kept apart so a caller can deliver the image while still
    // telling the truth about it — which is what both callers do, marking it
    // for manual review rather than claiming it was verified.
    const report = comparePreservation(
      await profileOf({ factoryBackground: true }),
      await profileOf({ factoryBackground: false }),
      'after product shot',
    )
    assert.equal(report.inconclusive, true)
    // The summary opens by saying so, before any check reads as an "ok".
    assert.ok(report.summary.indexOf(INCONCLUSIVE_MESSAGE) < report.summary.indexOf('ok ['),
      report.summary)
    // And nothing in the report claims the structure itself was checked.
    const compared = report.checks.filter(c =>
      c.name === 'structure overall' || c.name === 'under-seat structure' || c.name === 'aspect ratio')
    assert.equal(compared.length, 0, 'a comparison check reported on an unverifiable original')
  })

  test('a real comparison is NOT flagged inconclusive', async () => {
    const report = comparePreservation(await profileOf(), await profileOf(), 'after upscale')
    assert.equal(report.inconclusive, false)
    assert.equal(report.ok, true)
  })

  test('a destroyed fan is still refused, not excused as inconclusive', async () => {
    // The escape hatch must not become the verdict for a genuine failure.
    const report = comparePreservation(
      await profileOf(), await profileOf({ mergedFan: true }), 'after product shot')
    assert.equal(report.inconclusive, false)
    assert.equal(report.ok, false)
  })

  test('a plain upload IS trusted as ground truth', async () => {
    const plain = await profileOf({ factoryBackground: false })
    assert.equal(plain.confident, true)
  })
})

describe('framing', () => {
  test('a product in the band passes', async () => {
    const p = await profileOf({ product: { left: 300, top: 200, width: 400, height: 530 } })
    const check = checkFraming(p, { min: PRODUCT_HEIGHT_MIN, max: PRODUCT_HEIGHT_MAX }, false)
    assert.equal(check.ok, true, check.detail)
  })

  test('a product well outside it fails', async () => {
    const p = await profileOf({ product: { left: 400, top: 400, width: 200, height: 200 } })
    const check = checkFraming(p, { min: PRODUCT_HEIGHT_MIN, max: PRODUCT_HEIGHT_MAX }, false)
    assert.equal(check.ok, false, check.detail)
  })

  test('a width-limited product is allowed to be shorter, on purpose', async () => {
    const p = await profileOf({ product: { left: 100, top: 450, width: 800, height: 260 } })
    assert.equal(checkFraming(p, { min: PRODUCT_HEIGHT_MIN, max: PRODUCT_HEIGHT_MAX }, true).ok, true)
    assert.equal(checkFraming(p, { min: PRODUCT_HEIGHT_MIN, max: PRODUCT_HEIGHT_MAX }, false).ok, false)
  })
})

describe('what it cannot do', () => {
  test('an unmeasurable image profiles as null rather than passing by default', async () => {
    const flat = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 190, g: 186, b: 180 } } }).png().toBuffer()
    assert.equal(await profile(flat), null)
  })

  test('it is a structural check, not a proof of pixel identity', async () => {
    // Stated as a test so nobody reads the gate as a guarantee. A product
    // recoloured entirely but structurally identical still passes: this
    // measures edges, and it says so.
    const original = await profileOf()
    const generated = await profileOf()
    const report = comparePreservation(original, generated, 'after upscale')
    assert.equal(report.ok, true)
    assert.ok(!report.checks.some(c => /pixel|identical|exact/i.test(c.name)),
      'no check here claims pixel identity, because none can')
  })
})
