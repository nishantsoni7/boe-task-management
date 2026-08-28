/**
 * The studio image itself, composed end to end from a cut-out.
 *
 * No provider and no network: `composeStudioImage` takes a transparent PNG and
 * returns the finished picture, so everything BOE actually judges the result on
 * — the framing, the background, the shadows, whether the product survived —
 * can be measured here rather than looked at.
 *
 * The cut-outs are drawn in this file. That is deliberate: a photograph fixture
 * would test one chair, while a generated one can be given a two-pixel leg, a
 * soft edge, feet at different heights, or a product too small for the frame,
 * which is where the failures actually are.
 *
 * Slower than the other suites — real sharp pipelines on megapixel canvases.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/composeStudioImage.test.ts
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { composeStudioImage, BACKGROUND_BASE, defringe } from './composeStudioImage'
import { measureComposition } from './composition'
import { OUTPUT_PRESETS, PRODUCT_HEIGHT_SHARE, SPACE_ABOVE_SHARE, SPACE_BELOW_SHARE } from './outputPresets'
import { alphaBounds, MAX_ENLARGEMENT } from './cutoutGeometry'

// ─── Drawing cut-outs ─────────────────────────────────────────────────────────

type Canvas = { width: number; height: number; data: Buffer }

function blank(width: number, height: number): Canvas {
  return { width, height, data: Buffer.alloc(width * height * 4) }
}

function box(
  c: Canvas,
  left: number, top: number, width: number, height: number,
  grey: number, alpha = 255,
) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue
      const o = (y * c.width + x) * 4
      c.data[o] = grey; c.data[o + 1] = Math.round(grey * 0.94); c.data[o + 2] = Math.round(grey * 0.86)
      c.data[o + 3] = alpha
    }
  }
}

const png = (c: Canvas) =>
  sharp(c.data, { raw: { width: c.width, height: c.height, channels: 4 } }).png().toBuffer()

/**
 * A chair, near enough: a back, a seat, and four legs with floor visible
 * between them. `legWidth` goes down to two pixels on purpose, and the back
 * legs end higher than the front ones the way a three-quarter view puts them.
 */
function chair(opts: {
  width?: number; height?: number
  productWidth?: number; productHeight?: number
  legWidth?: number; grey?: number; softEdge?: boolean
} = {}) {
  const {
    width = 1400, height = 1600,
    productWidth = 900, productHeight = 1200,
    legWidth = 40, grey = 70, softEdge = false,
  } = opts

  const c = blank(width, height)
  const left = Math.round((width - productWidth) / 2)
  const top = Math.round((height - productHeight) / 2)

  const backHeight = Math.round(productHeight * 0.45)
  const seatTop = top + backHeight
  const seatHeight = Math.round(productHeight * 0.09)

  box(c, left + Math.round(productWidth * 0.1), top, Math.round(productWidth * 0.8), backHeight, grey)
  box(c, left, seatTop, productWidth, seatHeight, grey + 12)

  const legTop = seatTop + seatHeight
  const legHeight = top + productHeight - legTop
  // Front pair reaches the floor; the back pair stops a little short of it.
  box(c, left + 6, legTop, legWidth, legHeight, grey - 6)
  box(c, left + productWidth - legWidth - 6, legTop, legWidth, legHeight, grey - 6)
  box(c, left + Math.round(productWidth * 0.3), legTop, legWidth, legHeight - 18, grey - 10)
  box(c, left + Math.round(productWidth * 0.62), legTop, legWidth, legHeight - 18, grey - 10)

  if (softEdge) {
    // A one-pixel half-covered rim down the left of the back, of the kind
    // segmentation leaves behind.
    box(c, left + Math.round(productWidth * 0.1) - 1, top, 1, backHeight, grey, 120)
  }

  return { canvas: c, bounds: { left, top, width: productWidth, height: productHeight } }
}

// ─── Reading the result ───────────────────────────────────────────────────────

async function raw(image: Buffer) {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

function at(r: Awaited<ReturnType<typeof raw>>, x: number, y: number) {
  const o = (y * r.width + x) * r.channels
  return { r: r.data[o], g: r.data[o + 1], b: r.data[o + 2] }
}

const brightness = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3

async function compose(c: Canvas, preset?: 'landscape' | 'square' | 'portrait') {
  const result = await composeStudioImage(await png(c), preset)
  assert.equal(result.ok, true, result.ok ? '' : `compose failed: ${result.error}`)
  if (!result.ok) throw new Error('unreachable')
  return result
}

// One composition, reused by the tests that only read it.
let reference: Awaited<ReturnType<typeof compose>>
let referenceRaw: Awaited<ReturnType<typeof raw>>

before(async () => {
  reference = await compose(chair().canvas)
  referenceRaw = await raw(reference.png)
})

// ─── The canvas ───────────────────────────────────────────────────────────────

describe('the canvas', () => {
  test('each preset comes back at exactly its own dimensions', async () => {
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const result = await compose(chair().canvas, preset.key)
      const meta = await sharp(result.png).metadata()
      assert.deepEqual([meta.width, meta.height], [...preset.shotSize], preset.key)
    }
  })

  test('the default shape is Landscape, without being asked for', async () => {
    const meta = await sharp(reference.png).metadata()
    assert.deepEqual([meta.width, meta.height], [1200, 800])
  })

  test('the result is an opaque PNG — nothing that would print black', async () => {
    const meta = await sharp(reference.png).metadata()
    assert.equal(meta.format, 'png')
    // `flatten` chained onto `composite` runs BEFORE it, which left an alpha
    // channel on a finished image here once already.
    assert.equal(meta.hasAlpha ?? false, false)
  })
})

// ─── The framing ──────────────────────────────────────────────────────────────

describe('the approved composition', () => {
  test('every preset lands on the reference measurements', async () => {
    for (const preset of Object.values(OUTPUT_PRESETS)) {
      const result = await compose(chair().canvas, preset.key)
      const measured = await measureComposition(result.png)
      assert.equal(measured.ok, true, preset.key)
      if (!measured.ok) continue
      const m = measured.measurement

      assert.ok(Math.abs(m.heightShare - PRODUCT_HEIGHT_SHARE) <= 0.02,
        `${preset.key}: product is ${(m.heightShare * 100).toFixed(1)}% of the height`)
      assert.ok(Math.abs(m.aboveShare - SPACE_ABOVE_SHARE) <= 0.02,
        `${preset.key}: ${(m.aboveShare * 100).toFixed(1)}% above`)
      assert.ok(Math.abs(m.belowShare - SPACE_BELOW_SHARE) <= 0.02,
        `${preset.key}: ${(m.belowShare * 100).toFixed(1)}% below`)
    }
  })

  test('the product is centred, and nowhere near an edge', async () => {
    const measured = await measureComposition(reference.png)
    assert.equal(measured.ok, true)
    if (!measured.ok) return

    assert.ok(Math.abs(measured.measurement.centreOffsetPx) <= 2,
      `off centre by ${measured.measurement.centreOffsetPx}px`)
    assert.equal(measured.measurement.touchesEdge, false, 'the product is cropped')
    assert.ok(measured.measurement.sideBalance > 0.95, 'the side margins are uneven')
  })

  test('the aspect ratio of the product is the one the photograph had', async () => {
    // Scaled as a whole or not at all: a stretched chair is a different chair.
    for (const source of [
      { productWidth: 900, productHeight: 1200 },
      { productWidth: 1200, productHeight: 900 },
      { productWidth: 600, productHeight: 1400 },
    ]) {
      const drawn = chair({ ...source, width: 1600, height: 1600 })
      const result = await compose(drawn.canvas)
      const sourceRatio = result.metrics.bounds.width / result.metrics.bounds.height
      const placedRatio = result.metrics.placement.width / result.metrics.placement.height

      assert.ok(Math.abs(sourceRatio - placedRatio) / sourceRatio < 0.01,
        `${sourceRatio.toFixed(3)} became ${placedRatio.toFixed(3)}`)
    }
  })

  test('a long sideboard is scaled to fit rather than cropped at both ends', async () => {
    const wide = chair({ width: 2000, height: 1000, productWidth: 1800, productHeight: 600 })
    const result = await compose(wide.canvas)

    assert.ok(result.metrics.placement.left >= 0)
    assert.ok(result.metrics.placement.left + result.metrics.placement.width <= 1200)

    const measured = await measureComposition(result.png)
    assert.equal(measured.ok, true)
    if (measured.ok) assert.equal(measured.measurement.touchesEdge, false)
  })

  test('the same cut-out composes to the same bytes, every time', async () => {
    // Nothing random, nothing timed, nothing carried over between calls.
    const drawn = chair()
    const a = await compose(drawn.canvas)
    const b = await compose(drawn.canvas)
    assert.deepEqual(a.png, b.png)
  })
})

// ─── The quality gate ─────────────────────────────────────────────────────────

describe('refusing what cannot be done well', () => {
  test('a product too small in the frame is refused, with a measured reason', async () => {
    // 2x enlargement measured out at a 71% loss of detail. This is the check
    // that turned that into a refusal instead of a blurry catalogue image.
    const tiny = chair({ width: 1000, height: 1000, productWidth: 180, productHeight: 240 })
    const result = await composeStudioImage(await png(tiny.canvas))

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.quality, 'the refusal must say it was about quality')
    assert.match(result.quality!.message, /too small/i)
    // The detail is for the server log: sizes and ratios, never image data.
    assert.match(result.quality!.detail, /enlargement/)
    assert.match(result.quality!.detail, new RegExp(String(MAX_ENLARGEMENT)))
  })

  test('an opaque image is refused rather than pasted on as a rectangle', async () => {
    // A JPEG that never went through background removal. Composing it would
    // put a slab of factory floor in the middle of the studio sweep.
    const solid = blank(800, 800)
    box(solid, 0, 0, 800, 800, 120)
    const result = await composeStudioImage(await png(solid))

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /could not be separated/i)
    assert.equal(result.quality, undefined)
  })

  test('a fully transparent cut-out is refused, not composed as an empty room', async () => {
    const result = await composeStudioImage(await png(blank(600, 600)))
    assert.equal(result.ok, false)
  })

  test('bytes that are not an image at all are refused without throwing', async () => {
    const result = await composeStudioImage(Buffer.from('not a png, not anything'))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /could not be read/i)
  })

  test('no refusal names a provider, a model or an endpoint', async () => {
    const tiny = chair({ width: 1000, height: 1000, productWidth: 180, productHeight: 240 })
    const refusals = [
      await composeStudioImage(await png(tiny.canvas)),
      await composeStudioImage(await png(blank(600, 600))),
      await composeStudioImage(Buffer.from('nonsense')),
    ]

    for (const result of refusals) {
      assert.equal(result.ok, false)
      if (result.ok) continue
      const text = `${result.error} ${result.quality?.message ?? ''}`.toLowerCase()
      // Not "sharp": the refusal says "a sharp catalogue image", which is the
      // English word and exactly what an employee needs to be told.
      for (const word of ['fal', 'bria', 'http', 'endpoint', 'api key', 'sharp(']) {
        assert.ok(!text.includes(word), `an employee must not be shown "${word}": ${text}`)
      }
    }
  })
})

// ─── The background ───────────────────────────────────────────────────────────

describe('the background', () => {
  test('it is the approved warm-neutral light grey', async () => {
    const corner = at(referenceRaw, 4, 4)
    const base = brightness(BACKGROUND_BASE)
    assert.ok(Math.abs(brightness(corner) - base) < 30, `a corner reads ${brightness(corner).toFixed(0)}`)
    assert.ok(corner.r >= corner.g && corner.g >= corner.b, 'the sweep must stay warm, not go cool')
  })

  test('it stays inside a narrow tonal band — light, never white, never grey-blue', async () => {
    let min = 255
    let max = 0
    for (const [x, y] of [[2, 2], [1197, 2], [2, 797], [1197, 797], [600, 4], [4, 400], [1195, 400]] as const) {
      const b = brightness(at(referenceRaw, x, y))
      min = Math.min(min, b); max = Math.max(max, b)
    }
    assert.ok(min > 200, `the darkest background sample is ${min.toFixed(0)}`)
    assert.ok(max < 250, `the brightest background sample is ${max.toFixed(0)} — near white`)
  })

  test('there is no horizon: no row is a step change from the one above it', async () => {
    // A wall/floor seam is the single most obvious "this was generated" tell,
    // and the brief forbids one. Sampled down a column clear of the product.
    let worst = 0
    for (let y = 1; y < referenceRaw.height; y++) {
      const step = Math.abs(brightness(at(referenceRaw, 30, y)) - brightness(at(referenceRaw, 30, y - 1)))
      worst = Math.max(worst, step)
    }
    assert.ok(worst <= 1, `a ${worst.toFixed(1)}-level step appears down the left edge`)
  })

  test('the sweep is symmetric, so nothing reads as a light in one corner', async () => {
    for (const y of [40, 400, 760]) {
      const left = brightness(at(referenceRaw, 20, y))
      const right = brightness(at(referenceRaw, 1179, y))
      assert.ok(Math.abs(left - right) < 1.5, `row ${y}: ${left.toFixed(1)} vs ${right.toFixed(1)}`)
    }
  })

  test('it is brighter behind the product than at the corners, gently', async () => {
    // Sampled above the product rather than through it — the sweep's bright
    // centre is behind the chair, where nothing can read it directly.
    const nearCentre = brightness(at(referenceRaw, 600, 60))
    const corner = brightness(at(referenceRaw, 6, 794))
    assert.ok(nearCentre > corner, 'the lift is the wrong way round')
    assert.ok(nearCentre - corner < 30,
      `a ${(nearCentre - corner).toFixed(0)}-level falloff reads as a vignette`)
  })
})

// ─── The shadows ──────────────────────────────────────────────────────────────

describe('the shadows', () => {
  test('there is a shadow under the feet, and it is darker than the floor', async () => {
    const measured = await measureComposition(reference.png)
    assert.equal(measured.ok, true)
    if (!measured.ok) return

    const feet = measured.measurement.product.bottom
    const centre = Math.round(1200 / 2)
    const underFoot = brightness(at(referenceRaw, measured.measurement.product.left + 10, feet + 3))
    const openFloor = brightness(at(referenceRaw, centre, 780))

    assert.ok(underFoot < openFloor - 8,
      `under a foot reads ${underFoot.toFixed(0)}, open floor ${openFloor.toFixed(0)}`)
  })

  test('the grounding is strong enough to see, and not so strong it is a hole', async () => {
    // Measured, because "there is a shadow" passed for a long time on a shadow
    // two levels darker than the floor — the chair read as floating and no
    // assertion noticed. These are the numbers that separate the two.
    // Measured from where the product was actually PLACED. The measured
    // bounding box already counts a few rows of contact shadow as product, so
    // sampling from its bottom edge starts below the shadow and reads the floor.
    const p = reference.metrics.placement
    const feet = p.top + p.height
    let darkest = 255
    for (let d = 1; d <= 10; d++) darkest = Math.min(darkest, brightness(at(referenceRaw, p.left + 11, feet + d)))
    const openFloor = brightness(at(referenceRaw, 120, 780))

    assert.ok(openFloor - darkest > 30,
      `only ${(openFloor - darkest).toFixed(0)} levels under the foot — the product is floating`)
    assert.ok(darkest > 120, `${darkest.toFixed(0)} under the foot is a hole, not a shadow`)
  })

  test('the shadow fades out instead of ending on a line', async () => {
    // The layer has to carry padding for its own blur AND its downward bias, or
    // it is cropped mid-shadow and leaves a hard edge straight across the floor.
    const p = reference.metrics.placement
    const x = p.left + 11
    let worst = 0
    for (let y = p.top + p.height + 1; y < 799; y++) {
      worst = Math.max(worst, Math.abs(brightness(at(referenceRaw, x, y)) - brightness(at(referenceRaw, x, y + 1))))
    }
    assert.ok(worst < 14, `a ${worst.toFixed(1)}-level step appears below the feet`)
  })

  test('the shadow is under each foot, with floor still visible between them', async () => {
    // The failure this replaced: one shadow drawn under the whole silhouette
    // reads as a plinth, and a chair on a plinth is not a catalogue image.
    assert.ok(reference.metrics.contactColumns > 0, 'no contact shadow was drawn at all')
    assert.ok(reference.metrics.contactColumns < reference.metrics.placement.width * 0.8,
      `${reference.metrics.contactColumns} of ${reference.metrics.placement.width} columns are in contact ` +
      '— that is a silhouette, not four feet')
  })

  test('the shadow leans one way, consistently, as one light source would', async () => {
    const measured = await measureComposition(reference.png)
    assert.equal(measured.ok, true)
    if (!measured.ok) return

    const p = measured.measurement.product
    const below = Math.min(799, p.bottom + 12)
    const outsideLeft = brightness(at(referenceRaw, Math.max(0, p.left - 40), below))
    const outsideRight = brightness(at(referenceRaw, Math.min(1199, p.right + 40), below))

    assert.ok(outsideRight < outsideLeft,
      `the shadow must fall away from a light at the upper left: ` +
      `left ${outsideLeft.toFixed(0)}, right ${outsideRight.toFixed(0)}`)
  })

  test('the shadow never darkens the product itself', async () => {
    // Composited before the product, so it cannot. Checked because the order of
    // a sharp composite list is easy to change by accident.
    const drawn = chair({ grey: 70 })
    const result = await compose(drawn.canvas)
    const r = await raw(result.png)

    const p = result.metrics.placement
    const midX = p.left + Math.round(p.width / 2)
    const midY = p.top + Math.round(p.height * 0.2)
    assert.ok(brightness(at(r, midX, midY)) < 160, 'the product is not where it was placed')
  })

  test('the shadow is secondary: no part of the floor goes truly dark', async () => {
    let darkest = 255
    for (let x = 0; x < 1200; x += 3) {
      for (let y = 700; y < 800; y++) {
        const b = brightness(at(referenceRaw, x, y))
        if (y > reference.metrics.placement.top + reference.metrics.placement.height + 2) {
          darkest = Math.min(darkest, b)
        }
      }
    }
    assert.ok(darkest > 130, `the floor reaches ${darkest.toFixed(0)} — that is a shadow taking over`)
  })

  test('the shadow stays on the canvas: no hard edge where it was clipped', async () => {
    for (const [x, y] of [[0, 799], [1199, 799], [0, 700], [1199, 700]] as const) {
      const edge = brightness(at(referenceRaw, x, y))
      assert.ok(edge > 180, `the canvas edge at ${x},${y} reads ${edge.toFixed(0)}`)
    }
  })
})

// ─── The product ──────────────────────────────────────────────────────────────

describe('the product survives', () => {
  test('a two-pixel leg is still there afterwards', async () => {
    // The reason nothing here erodes alpha. A choke of one pixel each side
    // removes this leg entirely, and no measurement of the framing would notice.
    const thin = chair({ legWidth: 4, productWidth: 900, productHeight: 1200 })
    const result = await compose(thin.canvas)
    const r = await raw(result.png)

    const p = result.metrics.placement
    // Down the legs, a quarter of the way up from the feet.
    const y = p.top + Math.round(p.height * 0.92)
    let legPixels = 0
    for (let x = p.left; x < p.left + p.width; x++) {
      if (brightness(at(r, x, y)) < 170) legPixels++
    }
    assert.ok(legPixels >= 4, `only ${legPixels} dark pixels remain across the legs`)
  })

  test('the gaps between the legs are still background, not filled in', async () => {
    const r = referenceRaw
    const p = reference.metrics.placement
    const y = p.top + Math.round(p.height * 0.9)

    let background = 0
    for (let x = p.left; x < p.left + p.width; x++) {
      if (brightness(at(r, x, y)) > 200) background++
    }
    assert.ok(background > p.width * 0.4,
      `only ${background} of ${p.width} pixels between the legs are open`)
  })

  test('the tone correction reaches the product and not the background', async () => {
    // "Product-only": a correction applied to the canvas would change the
    // background's colour, and the background is fixed by the reference.
    const dim = chair({ grey: 45 })
    const bright = chair({ grey: 150 })

    const a = await raw((await compose(dim.canvas)).png)
    const b = await raw((await compose(bright.canvas)).png)

    for (const [x, y] of [[6, 6], [1193, 6], [600, 20], [6, 793]] as const) {
      assert.equal(brightness(at(a, x, y)).toFixed(2), brightness(at(b, x, y)).toFixed(2),
        `the background at ${x},${y} moved with the product's exposure`)
    }
  })

  test('a dim photograph comes back brighter than it went in', async () => {
    const result = await compose(chair({ grey: 45 }).canvas)
    assert.equal(result.metrics.tone.reason, 'underexposed')
    assert.ok(result.metrics.tone.gain > 1.1)
  })

  test('a well-exposed photograph is left nearly alone', async () => {
    const result = await compose(chair({ grey: 128 }).canvas)
    assert.ok(result.metrics.tone.gain <= 1.05,
      `an already-lit product was given a gain of ${result.metrics.tone.gain.toFixed(2)}`)
  })

  test('nothing on the product is pushed to pure white', async () => {
    const pale = chair({ grey: 205 })
    const result = await compose(pale.canvas)
    const r = await raw(result.png)

    const p = result.metrics.placement
    let clipped = 0
    for (let y = p.top; y < p.top + p.height; y += 2) {
      for (let x = p.left; x < p.left + p.width; x += 2) {
        const pixel = at(r, x, y)
        if (pixel.r >= 255 && pixel.g >= 255 && pixel.b >= 255) clipped++
      }
    }
    assert.equal(clipped, 0, `${clipped} sampled pixels on a pale product are pure white`)
  })

  test('there is no bright halo around the product where it was sharpened', async () => {
    // Sharpening a cut-out outlines its alpha. The interior mask is what stops
    // that, and a halo is the one artefact that reads as "cut out" instantly.
    const measured = await measureComposition(reference.png)
    assert.equal(measured.ok, true)
    if (!measured.ok) return

    const p = measured.measurement.product
    const y = p.top + Math.round((p.bottom - p.top) * 0.2)
    // Just outside the product's left edge, above the shadow entirely.
    const justOutside = brightness(at(referenceRaw, Math.max(0, p.left - 3), y))
    const wellOutside = brightness(at(referenceRaw, Math.max(0, p.left - 60), y))

    assert.ok(justOutside <= wellOutside + 2,
      `a rim ${(justOutside - wellOutside).toFixed(1)} levels brighter than the background sits at the edge`)
  })
})

// ─── Defringing ───────────────────────────────────────────────────────────────

describe('taking the old background out of the edge', () => {
  test('alpha comes out of the defringe exactly as it went in', async () => {
    // Not "nearly": alpha is the product's shape, and this function is the one
    // that would be tempted to erode it.
    const width = 60
    const height = 60
    const rgba = Buffer.alloc(width * height * 4)
    for (let y = 10; y < 50; y++) {
      for (let x = 10; x < 50; x++) {
        const o = (y * width + x) * 4
        rgba[o] = 80; rgba[o + 1] = 70; rgba[o + 2] = 60
        // A soft rim one pixel wide all the way round.
        rgba[o + 3] = (x === 10 || x === 49 || y === 10 || y === 49) ? 110 : 255
      }
    }
    const before = Uint8Array.from(rgba.filter((_, i) => i % 4 === 3))

    await defringe(rgba, width, height)

    assert.deepEqual(Uint8Array.from(rgba.filter((_, i) => i % 4 === 3)), before)
  })

  test('an edge pixel takes its colour from the product, not the old background', async () => {
    const width = 40
    const height = 40
    const rgba = Buffer.alloc(width * height * 4)
    for (let y = 8; y < 32; y++) {
      for (let x = 8; x < 32; x++) {
        const o = (y * width + x) * 4
        const rim = x === 8 || x === 31 || y === 8 || y === 31
        // A dark product with a rim still carrying a bright factory wall.
        rgba[o] = rim ? 240 : 60
        rgba[o + 1] = rim ? 240 : 55
        rgba[o + 2] = rim ? 240 : 50
        rgba[o + 3] = rim ? 90 : 255
      }
    }

    await defringe(rgba, width, height)

    const rim = (8 * width + 20) * 4
    assert.ok(rgba[rim] < 140, `the rim is still reading ${rgba[rim]} — the old wall survived`)
  })

  test('a fully transparent pixel is not given a colour it did not have', async () => {
    const width = 40
    const height = 40
    const rgba = Buffer.alloc(width * height * 4)
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) {
        const o = (y * width + x) * 4
        rgba[o] = 90; rgba[o + 1] = 80; rgba[o + 2] = 70; rgba[o + 3] = 255
      }
    }

    await defringe(rgba, width, height)

    const empty = (2 * width + 2) * 4
    assert.deepEqual([rgba[empty], rgba[empty + 1], rgba[empty + 2], rgba[empty + 3]], [0, 0, 0, 0])
  })

  test('a soft edge in a real cut-out still composes, and is still soft', async () => {
    const soft = chair({ softEdge: true })
    const sourceAlpha = await sharp(await png(soft.canvas)).extractChannel(3).raw().toBuffer()
    const sourceBounds = alphaBounds(sourceAlpha, soft.canvas.width, soft.canvas.height)!

    const result = await compose(soft.canvas)
    // The half-covered rim is part of the product, so it is inside the box the
    // composition is built from — not trimmed off as noise.
    assert.equal(result.metrics.bounds.left, sourceBounds.left)
    assert.equal(result.metrics.bounds.width, sourceBounds.width)
  })
})
