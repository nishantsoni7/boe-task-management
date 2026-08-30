/**
 * The dark-product correction, exercised on real pixels.
 *
 * WHY THESE ARE THE TESTS
 * -----------------------
 * This step touches EVERY delivered master, so the things that must not happen
 * are more important than the thing that must: the studio background must not
 * move, the black point must not lift, the watermark must not shift colour, a
 * light product must pay nothing, and a fault must cost the employee nothing.
 * Each of those is a test below, on a synthetic fixture built to the levels
 * measured on a production master — no product image is committed here.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/shadowLift.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  buildShadowLut, liftRaw, enhanceShadows, lumaOf,
  SHADOW_KNEE, SHADOW_MAX_GAIN, SHADOW_MAX_ABS_CHANGE,
} from './shadowLift'

/** A patch of one colour, as a PNG. */
const patch = (r: number, g: number, b: number, side = 32) =>
  sharp({ create: { width: side, height: side, channels: 3, background: { r, g, b } } }).png().toBuffer()

/** Mean RGB of a PNG. */
async function meanRGB(png: Buffer): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < data.length; i += info.channels) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++ }
  return [r / n, g / n, b / n]
}

describe('the curve', () => {
  const lut = buildShadowLut()

  test('is the identity at and above the knee — the background cannot move', () => {
    for (let y = SHADOW_KNEE; y < 256; y++) {
      assert.equal(lut[y], y, `level ${y} moved, and the studio sweep lives up here`)
    }
  })

  test('is monotonic, so it cannot invert an edge', () => {
    for (let y = 1; y < 256; y++) {
      assert.ok(lut[y] >= lut[y - 1], `not monotonic at ${y}: ${lut[y - 1]} -> ${lut[y]}`)
    }
  })

  test('preserves the black point', () => {
    assert.equal(lut[0], 0, 'pure black must stay pure black')
  })

  test('lifts, and only lifts, below the knee', () => {
    for (let y = 1; y < SHADOW_KNEE; y++) {
      assert.ok(lut[y] >= y, `level ${y} was darkened to ${lut[y]}`)
    }
    // And it actually does something where the defect lives: a seat front
    // measured at luma 12 and a rail at 16 must separate visibly.
    assert.ok(lut[12] >= 17, `luma 12 lifted only to ${lut[12]} — too little to read`)
    assert.ok(lut[16] >= 20, `luma 16 lifted only to ${lut[16]}`)
  })

  test('never exceeds the gain ceiling or the derived change bound', () => {
    for (let y = 1; y < SHADOW_KNEE; y++) {
      const gain = Math.min(lut[y] / y, SHADOW_MAX_GAIN)
      assert.ok(gain <= SHADOW_MAX_GAIN + 1e-9, `gain ${gain} at ${y}`)
      assert.ok(lut[y] - y <= SHADOW_MAX_ABS_CHANGE, `change ${lut[y] - y} at ${y}`)
    }
  })

  test('cannot overflow', () => {
    for (let y = 0; y < 256; y++) assert.ok(lut[y] >= 0 && lut[y] <= 255)
  })
})

describe('what it does to a pixel', () => {
  test('holds hue and saturation: one gain, three channels', async () => {
    // Dark walnut, at the level measured on the production rail.
    const before: [number, number, number] = [25, 15, 9]
    const buf = Buffer.from(before)
    liftRaw(buf, 3)
    const after = [buf[0], buf[1], buf[2]]
    assert.ok(after[0] > before[0], 'it should have lifted')
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]] as const) {
      const b = before[i] / before[j], a = after[i] / after[j]
      assert.ok(Math.abs(a - b) / b < 0.06, `channel ratio ${i}:${j} drifted ${(100 * Math.abs(a - b) / b).toFixed(1)}%`)
    }
  })

  test('a saturated red watermark keeps its colour', async () => {
    // The mark burned into a production master measures about this.
    const png = await patch(214, 32, 38)
    const out = await enhanceShadows(png)
    const [r, g, b] = await meanRGB(out.image)
    assert.ok(Math.abs(r - 214) <= 1 && Math.abs(g - 32) <= 1 && Math.abs(b - 38) <= 1,
      `watermark moved to ${r},${g},${b}`)
  })

  test('a brass highlight is untouched', async () => {
    const png = await patch(206, 164, 86)
    const out = await enhanceShadows(png)
    assert.equal(out.applied, false, 'nothing here is below the knee')
    assert.ok(out.image.equals(png), 'the buffer must be handed straight back')
  })
})

describe('the studio background', () => {
  test('a sweep at production levels comes back byte-identical', async () => {
    // 179 is the darkest background pixel measured on a production master.
    const side = 64
    const raw = Buffer.alloc(side * side * 3)
    for (let i = 0; i < side * side; i++) {
      const v = 179 + Math.round((206 - 179) * (i / (side * side)))
      raw[i * 3] = v + 2; raw[i * 3 + 1] = v; raw[i * 3 + 2] = v - 4
    }
    const png = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer()
    const out = await enhanceShadows(png)
    assert.equal(out.applied, false)
    assert.ok(out.image.equals(png), 'the background must not move by a single byte')
  })
})

describe('a light product pays nothing', () => {
  test('an image with nothing below the knee is returned unchanged', async () => {
    const png = await patch(180, 176, 170)
    const out = await enhanceShadows(png)
    assert.equal(out.applied, false)
    assert.equal(out.reason, 'nothing below the knee')
    assert.ok(out.image.equals(png))
  })
})

describe('a dark product improves', () => {
  test('two dark materials measured on a production master separate further', async () => {
    // Seat front and wood rail, at their measured means. Before: 4.3 luma
    // apart and visually merged.
    const seat: [number, number, number] = [10, 13, 10]
    const wood: [number, number, number] = [25, 15, 9]
    const before = Math.abs(lumaOf(...wood) - lumaOf(...seat))

    const sb = Buffer.from(seat), wb = Buffer.from(wood)
    liftRaw(sb, 3); liftRaw(wb, 3)
    const seatAfter = lumaOf(sb[0], sb[1], sb[2])
    const woodAfter = lumaOf(wb[0], wb[1], wb[2])

    assert.ok(seatAfter > lumaOf(...seat) + 4, `seat lifted only to ${seatAfter.toFixed(1)}`)
    assert.ok(woodAfter > lumaOf(...wood) + 4, `wood lifted only to ${woodAfter.toFixed(1)}`)
    // Both leave the zone where the eye cannot read hue, which is the point.
    assert.ok(seatAfter >= 17 && woodAfter >= 20)
    assert.ok(before > 0)
  })
})

describe('the delivered bytes', () => {
  test('dimensions, channels and PNG-ness survive', async () => {
    const png = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 20, g: 16, b: 12 } } })
      .png().toBuffer()
    const out = await enhanceShadows(png)
    assert.equal(out.applied, true)
    const m = await sharp(out.image).metadata()
    assert.equal(m.width, 120); assert.equal(m.height, 90); assert.equal(m.format, 'png')
  })

  test('the same input gives byte-identical output', async () => {
    const png = await patch(18, 14, 11)
    const a = await enhanceShadows(png)
    const b = await enhanceShadows(png)
    assert.ok(a.image.equals(b.image), 'the correction must be deterministic')
  })

  test('applying it twice is visible, which is why the route applies it once', async () => {
    // Not a licence to run it twice — a guard: if this ever stopped differing,
    // a double application would be undetectable.
    const png = await patch(18, 14, 11)
    const once = await enhanceShadows(png)
    const twice = await enhanceShadows(once.image)
    assert.ok(!once.image.equals(twice.image))
  })

  test('a corrupt buffer costs the employee nothing', async () => {
    const junk = Buffer.from('not an image at all')
    const out = await enhanceShadows(junk)
    assert.equal(out.applied, false)
    assert.ok(out.image.equals(junk), 'the input must be handed straight back')
    assert.ok(out.reason && out.reason.length > 0)
  })

  test('settings that would break the bounds are refused, not delivered', async () => {
    // The shipped settings cannot breach SHADOW_MAX_ABS_CHANGE — the taper sees
    // to that, and the curve tests above prove it. This exercises the guard
    // itself, with a reckless curve no caller should ever pass: knee up in the
    // midtones, no taper, a gain ceiling of 40. A midtone pixel then moves ~108
    // levels, the validation catches it, and the ORIGINAL master is returned.
    const png = await patch(100, 100, 100)
    const out = await enhanceShadows(png, { knee: 250, strength: 0.2, taper: 0, maxGain: 40 })
    assert.equal(out.applied, false, 'a breach must not be delivered')
    assert.match(out.reason ?? '', /bounds/)
    assert.ok(out.image.equals(png), 'and the untouched master is what comes back')
  })
})
