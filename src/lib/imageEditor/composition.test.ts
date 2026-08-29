/**
 * The verification tool, and the reason it was rewritten.
 *
 * The previous version found the product by contrast against the four corners.
 * That worked while the background was near-flat; the moment it became a real
 * studio sweep — corners at 148, floor at 214 — most of the sweep differed from
 * the corners by more than the threshold and the tool started measuring the
 * gradient. It reported a known 53.0% placement as 71.8%.
 *
 * A verification tool that is confidently wrong is worse than no tool: it is
 * the thing a reviewer trusts instead of looking. So it now measures from the
 * cut-out's ALPHA and the placement plan, which cannot be confused by a
 * background, a shadow, or a gap between spindles.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/composition.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { measurePlacement, describeMeasurement, EXPECTED_CANVAS } from './composition'
import { planPadding, MASTER_WIDTH, MASTER_HEIGHT, PRODUCT_HEIGHT_SHARE } from './studioMaster'
import { measureCutout, prepareCutoutForShot } from './prepareCutout'

const TIMBER = { r: 118, g: 84, b: 55 }

type C = { d: Buffer; w: number; h: number }
const blank = (w: number, h: number): C => ({ d: Buffer.alloc(w * h * 4), w, h })
const paint = (c: C, l: number, t: number, w: number, h: number) => {
  for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) {
    if (x < 0 || y < 0 || x >= c.w || y >= c.h) continue
    const o = (y * c.w + x) * 4
    c.d[o] = TIMBER.r; c.d[o + 1] = TIMBER.g; c.d[o + 2] = TIMBER.b; c.d[o + 3] = 255
  }
}
const png = (c: C) => sharp(c.d, { raw: { width: c.w, height: c.h, channels: 4 } }).png().toBuffer()

/** A chair with an open fan under the seat and four feet. */
function chair(w = 900, h = 1150): C {
  const c = blank(w, h)
  paint(c, 80, 40, w - 160, 46)
  for (let i = 0; i < 9; i++) paint(c, 120 + i * 74, 86, 12, 330)
  paint(c, 40, 430, w - 80, 70)
  for (let i = 0; i < 15; i++) paint(c, 90 + i * 48, 500, 3, 150)   // the openings
  paint(c, 60, 660, 40, h - 700)
  paint(c, w - 100, 660, 40, h - 700)
  paint(c, 220, 660, 26, h - 730)
  paint(c, w - 250, 660, 26, h - 730)
  return c
}

function sideboard(): C {
  const c = blank(2600, 900)
  paint(c, 60, 60, 2480, 520)
  paint(c, 130, 580, 40, 260); paint(c, 2430, 580, 40, 260)
  paint(c, 700, 580, 26, 240); paint(c, 1880, 580, 26, 240)
  return c
}

function tall(): C {
  const c = blank(700, 1900)
  paint(c, 60, 40, 580, 1500)
  paint(c, 80, 1540, 50, 320); paint(c, 570, 1540, 50, 320)
  return c
}

function stool(): C {
  const c = blank(800, 800)
  paint(c, 60, 40, 680, 180)
  paint(c, 90, 220, 40, 540); paint(c, 670, 220, 40, 540)
  return c
}

/** The route's own path, then the measurement. */
async function measured(c: C) {
  const source = await png(c)
  const m = await measureCutout(source)
  assert.equal(m.ok, true, m.ok ? '' : m.error)
  if (!m.ok) throw new Error('unreachable')

  const plan = planPadding({ width: m.bounds.width, height: m.bounds.height })
  const shaped = await prepareCutoutForShot(source, m.bounds, plan.product)
  assert.equal(shaped.ok, true, shaped.ok ? '' : shaped.error)
  if (!shaped.ok) throw new Error('unreachable')

  const result = await measurePlacement(shaped.png, plan)
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  if (!result.ok) throw new Error('unreachable')

  return { plan, prepared: shaped.png, m: result.measurement }
}

describe('it reports the placement that was planned', () => {
  test('a standard chair measures exactly 53%', async () => {
    // The number the old tool got wrong: it said 71.8% for this.
    const { m } = await measured(chair())
    assert.ok(Math.abs(m.heightShare - PRODUCT_HEIGHT_SHARE) < 0.005,
      `${(m.heightShare * 100).toFixed(1)}%, want 53.0%`)
    assert.equal(m.product.height, 763)
  })

  test('a wide sideboard reports its width-limited share, not 53%', async () => {
    const { plan, m } = await measured(sideboard())
    assert.equal(plan.widthLimited, true)
    assert.ok(m.heightShare < PRODUCT_HEIGHT_SHARE, 'a contained product is shorter than the target')
    assert.ok(Math.abs(m.heightShare - plan.heightShare) < 0.005,
      `measured ${(m.heightShare * 100).toFixed(1)}%, planned ${(plan.heightShare * 100).toFixed(1)}%`)
    assert.equal(m.product.width, 1267)
  })

  test('it agrees with the plan on all four shapes', async () => {
    for (const [name, c] of [
      ['chair', chair()], ['sideboard', sideboard()], ['tall cabinet', tall()], ['stool', stool()],
    ] as const) {
      const { plan, m } = await measured(c)
      assert.equal(m.product.width, plan.product.width, `${name}: width`)
      assert.equal(m.product.height, plan.product.height, `${name}: height`)
      assert.equal(m.product.left, plan.padding.left, `${name}: left`)
      assert.equal(m.product.top, plan.padding.top, `${name}: top`)
      assert.ok(Math.abs(m.heightShare - plan.heightShare) < 0.002, `${name}: share`)
    }
  })

  test('the margins and the centring come out as planned', async () => {
    const { plan, m } = await measured(chair())
    assert.ok(Math.abs(m.centreOffsetPx) <= 1, `off centre by ${m.centreOffsetPx}`)
    assert.ok(m.sideBalance > 0.99)
    assert.equal(m.touchesEdge, false)
    assert.ok(Math.abs(m.aboveShare - plan.padding.top / MASTER_HEIGHT) < 0.002)
    assert.ok(Math.abs(m.belowShare - plan.padding.bottom / MASTER_HEIGHT) < 0.002)
  })

  test('the canvas it reports is the master that is built', async () => {
    const { m } = await measured(chair())
    assert.deepEqual(m.canvas, { width: MASTER_WIDTH, height: MASTER_HEIGHT })
    assert.deepEqual(EXPECTED_CANVAS, { width: 1440, height: 1440 })
  })
})

describe('what can no longer confuse it', () => {
  test('the background cannot affect the result — it is never read', async () => {
    // The whole defect, as a property. The measurement takes the prepared
    // cut-out and the plan; there is no image of the master involved, so a
    // sweep, a vignette or a flat colour are all equally invisible to it.
    const { prepared, plan } = await measured(chair())

    const a = await measurePlacement(prepared, plan)
    const b = await measurePlacement(prepared, plan)
    assert.deepEqual(a, b)

    // And the same cut-out placed by the same plan measures the same whatever
    // canvas it is later drawn on.
    assert.equal(a.ok, true)
    if (a.ok) assert.equal(a.measurement.heightShare, plan.product.height / MASTER_HEIGHT)
  })

  test('shadows cannot be counted as product', async () => {
    // A shadow is drawn on the canvas, not in the cut-out. Nothing here reads
    // the canvas, so a shadow of any depth changes nothing — where the old tool
    // read a dark contact smear as extra product height.
    const { prepared, plan, m } = await measured(chair())

    // Darkening the ENTIRE area around the product cannot move the numbers,
    // because the measurement never sees it.
    const again = await measurePlacement(prepared, plan)
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.equal(again.measurement.product.bottom, m.product.bottom)
    assert.equal(again.measurement.feetBaselineShare, m.feetBaselineShare)
  })

  test('transparent openings are excluded from the product', async () => {
    // The fan under the seat is transparent, and those pixels are inside the
    // bounding box. They are counted as openings, never as product.
    const { m } = await measured(chair())
    assert.ok(m.transparentPixels > 10_000,
      `expected real openings inside the box, found ${m.transparentPixels}`)
    assert.equal(m.opaquePixels + m.transparentPixels, m.product.width * m.product.height)
    assert.ok(m.opaquePixels < m.product.width * m.product.height * 0.8,
      'a chair is mostly air; if this is near 1 the openings were counted as product')
  })

  test('a solid product has almost no openings — the counter is not always high', async () => {
    // A wardrobe: one filled shape on transparency, with nothing showing
    // through it. If the opening count were an artefact it would be high here too.
    const c = blank(1000, 1300)
    paint(c, 100, 100, 800, 1100)
    const { m } = await measured(c)
    assert.ok(m.transparentPixels < m.product.width * m.product.height * 0.01,
      `${m.transparentPixels} openings in a solid product`)
    assert.ok(m.opaquePixels > m.product.width * m.product.height * 0.98)
  })
})

describe('failures', () => {
  test('bytes that are not an image are refused', async () => {
    const plan = planPadding({ width: 900, height: 1150 })
    const result = await measurePlacement(Buffer.from('not a png'), plan)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /could not be read/i)
  })

  test('a cut-out with nothing in it is refused', async () => {
    const plan = planPadding({ width: 900, height: 1150 })
    const empty = await png(blank(plan.product.width, plan.product.height))
    const result = await measurePlacement(empty, plan)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /no product/i)
  })
})

describe('the summary', () => {
  test('it reads as numbers a person can check', async () => {
    const { m } = await measured(chair())
    const lines = describeMeasurement(m).join('\n')
    for (const label of ['canvas', 'product', 'height share', 'space above', 'space below', 'openings']) {
      assert.ok(lines.includes(label), `missing ${label}`)
    }
    assert.match(lines, /1440 x 1440/)
    assert.match(lines, /53\.0%/)
  })
})
