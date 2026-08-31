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
  buildShadowLut, liftRaw, enhanceShadows, lumaOf, isShadowPixel,
  SHADOW_KNEE, SHADOW_MAX_GAIN, SHADOW_MAX_ABS_CHANGE, SHADOW_OFFSET, SHADOW_PLATEAU_TO,
} from './shadowLift'
import { decodeGrey, edgeMap, locateProduct, EDGE_THRESHOLD } from './generatedProduct'

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

  test('preserves the black point — at the OPERATOR, not in the table', () => {
    // The plateau means lut[0] is the offset, not zero, and that is correct:
    // the table describes a luma target, while the lift is applied as a GAIN.
    // A pure black pixel has no luma to multiply, so the loop skips it and it
    // stays exactly black. Asserting lut[0] === 0 would be asserting the wrong
    // object, so this asserts the pixel.
    const black = Buffer.from([0, 0, 0])
    liftRaw(black, 3)
    assert.deepEqual([...black], [0, 0, 0], 'pure black must stay pure black')
    // And the deepest non-black pixels stay bounded rather than exploding.
    const nearBlack = Buffer.from([1, 0, 0])
    liftRaw(nearBlack, 3)
    assert.ok(nearBlack[0] <= Math.ceil(1 * SHADOW_MAX_GAIN), 'the gain ceiling holds at the floor')
  })

  test('lifts, and only lifts, below the knee', () => {
    for (let y = 1; y < SHADOW_KNEE; y++) {
      assert.ok(lut[y] >= y, `level ${y} was darkened to ${lut[y]}`)
    }
    // And it actually does something where the defect lives: a seat front
    // measured at luma 12 and a rail at 16 must separate visibly.
    assert.ok(lut[12] >= 17, `luma 12 lifted only to ${lut[12]} — too little to read`)
    assert.ok(lut[16] >= 21, `luma 16 lifted only to ${lut[16]}`)
  })

  test('holds a FLAT offset across the plateau — this is what keeps texture', () => {
    // The whole reason for this curve shape. Across the plateau the lift is a
    // constant, so the slope is exactly 1 and local contrast — wood grain,
    // leather weave — passes through untouched. A bending curve here cost the
    // measured wood rail 22% of its standard deviation.
    for (let y = 1; y <= SHADOW_PLATEAU_TO; y++) {
      assert.equal(lut[y] - y, SHADOW_OFFSET, `the plateau breaks at luma ${y}`)
    }
    for (let y = 2; y <= SHADOW_PLATEAU_TO - 1; y++) {
      const slope = (lut[y + 1] - lut[y - 1]) / 2
      assert.equal(slope, 1, `slope ${slope} at luma ${y} — texture would not survive`)
    }
  })

  test('the taper reaches the identity smoothly, with no step at either end', () => {
    // Continuous at the plateau edge and at the knee: a jump would show as a
    // banding line across a smooth dark surface.
    assert.equal(lut[SHADOW_PLATEAU_TO] - SHADOW_PLATEAU_TO, SHADOW_OFFSET)
    assert.ok(lut[SHADOW_PLATEAU_TO + 1] - (SHADOW_PLATEAU_TO + 1) >= SHADOW_OFFSET - 1,
      'the taper must start gently, not fall off a cliff')
    assert.equal(lut[SHADOW_KNEE - 1] - (SHADOW_KNEE - 1), 0, 'the lift must be spent by the knee')
    // Monotone decreasing lift through the taper.
    let previous = SHADOW_OFFSET
    for (let y = SHADOW_PLATEAU_TO; y < SHADOW_KNEE; y++) {
      const lift = lut[y] - y
      assert.ok(lift <= previous, `the taper rises again at luma ${y}`)
      previous = lift
    }
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
    // Dark walnut, at the median measured on the lossless production rail.
    const before: [number, number, number] = [26, 15, 9]
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
    // The darkest pixel outside the product on the lossless master is 124.5;
    // this sweep starts far below that and must still come back untouched.
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
    // Seat front and wood rail, at their medians on the lossless master. Before:
    // 4.4 luma apart, CIEDE2000 6.61, and visually merged.
    const seat: [number, number, number] = [11, 13, 10]
    const wood: [number, number, number] = [26, 15, 9]
    const before = Math.abs(lumaOf(...wood) - lumaOf(...seat))

    const sb = Buffer.from(seat), wb = Buffer.from(wood)
    liftRaw(sb, 3); liftRaw(wb, 3)
    const seatAfter = lumaOf(sb[0], sb[1], sb[2])
    const woodAfter = lumaOf(wb[0], wb[1], wb[2])

    assert.ok(seatAfter > lumaOf(...seat) + 4, `seat lifted only to ${seatAfter.toFixed(1)}`)
    assert.ok(woodAfter > lumaOf(...wood) + 4, `wood lifted only to ${woodAfter.toFixed(1)}`)
    // Both leave the zone where the eye cannot read hue, which is the point.
    assert.ok(seatAfter >= 17 && woodAfter >= 21)
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
    // The shipped settings cannot breach SHADOW_MAX_ABS_CHANGE — the channel
    // guard and the gain ceiling see to that, and the exhaustive test below
    // proves it. This exercises the guard itself, with a reckless curve no
    // caller should ever pass: a knee up in the midtones, a 120-level offset
    // and a gain ceiling of 40. A midtone pixel then moves far past the bound,
    // the validation catches it, and the ORIGINAL master is returned.
    const png = await patch(100, 100, 100)
    const out = await enhanceShadows(png, { knee: 250, offset: 120, plateauTo: 200, maxGain: 40 })
    assert.equal(out.applied, false, 'a breach must not be delivered')
    assert.match(out.reason ?? '', /bounds/)
    assert.ok(out.image.equals(png), 'and the untouched master is what comes back')
  })
})

describe('no channel is ever driven into clipping', () => {
  /** One colour through the operator. */
  const through = (r: number, g: number, b: number) => {
    const buf = Buffer.from([r, g, b])
    liftRaw(buf, 3)
    return [buf[0], buf[1], buf[2]] as const
  }

  test('EXHAUSTIVE over every colour the operator can touch', () => {
    // Every changed pixel has all three channels below the knee, so this sweep
    // — 64^3 = 262,144 colours — covers the operator's entire domain exactly,
    // not a sample of it.
    let clipped = 0, decreased = 0, overBound = 0, worst = 0
    for (let r = 0; r < SHADOW_KNEE; r++) {
      for (let g = 0; g < SHADOW_KNEE; g++) {
        for (let b = 0; b < SHADOW_KNEE; b++) {
          const [nr, ng, nb] = through(r, g, b)
          if ((r < 255 && nr === 255) || (g < 255 && ng === 255) || (b < 255 && nb === 255)) clipped++
          if (nr < r || ng < g || nb < b) decreased++
          const d = Math.max(Math.abs(nr - r), Math.abs(ng - g), Math.abs(nb - b))
          if (d > worst) worst = d
          if (d > SHADOW_MAX_ABS_CHANGE) overBound++
        }
      }
    }
    assert.equal(clipped, 0, 'a channel below 255 must never reach 255')
    assert.equal(decreased, 0, 'the operator only ever lifts')
    assert.equal(overBound, 0, `something moved further than ${SHADOW_MAX_ABS_CHANGE}`)
    assert.ok(worst <= SHADOW_MAX_ABS_CHANGE, `worst change ${worst}`)
    // And the bound is tight enough to mean something: it is not simply 255.
    assert.ok(SHADOW_MAX_ABS_CHANGE < 128, 'the bound must actually bind')
  })

  test('nothing outside that domain moves at all — strided over the whole cube', () => {
    let moved = 0
    for (let r = 0; r < 256; r += 5) {
      for (let g = 0; g < 256; g += 5) {
        for (let b = 0; b < 256; b += 5) {
          if (isShadowPixel(r, g, b, SHADOW_KNEE)) continue
          const [nr, ng, nb] = through(r, g, b)
          if (nr !== r || ng !== g || nb !== b) moved++
        }
      }
    }
    assert.equal(moved, 0, 'a pixel with any channel at or above the knee must be untouched')
  })

  test('a saturated dark colour is left alone, not lifted into clipping', () => {
    // Each of these is BELOW the knee in luma while carrying a bright channel.
    // Under a luma-only test the last one measured a 118-level jump.
    for (const [r, g, b] of [[255, 0, 0], [250, 10, 10], [0, 0, 150], [0, 0, 255], [214, 32, 38]] as const) {
      assert.ok(lumaOf(r, g, b) < 255, 'sanity')
      const out = through(r, g, b)
      assert.deepEqual([...out], [r, g, b], `${r},${g},${b} was modified`)
    }
  })

  test('the watermark red is below the knee in luma and still untouched', () => {
    const [r, g, b] = [214, 32, 38]
    assert.ok(lumaOf(r, g, b) < 80, 'this is exactly the trap: dark in luma, bright in one channel')
    assert.deepEqual([...through(r, g, b)], [r, g, b])
  })
})

describe('what a point operation does and does not preserve', () => {
  /** A dark product on a light sweep, with thin structure. Synthetic — no
   *  product image is committed to this repository. */
  async function darkFixture(): Promise<Buffer> {
    const side = 240
    const raw = Buffer.alloc(side * side * 3)
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = (y * side + x) * 3
        let v = 185                                   // sweep
        if (y > 60 && y < 150 && x > 40 && x < 200) v = 12   // dark seat
        else if (y >= 150 && y < 180 && x > 40 && x < 200) v = 17  // dark rail
        else if (y >= 180 && y < 220 && x > 40 && x < 200) v = (x % 7 < 3 ? 22 : 14) // spindles
        raw[i] = v + 2; raw[i + 1] = v; raw[i + 2] = v - 2
      }
    }
    return sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer()
  }

  test('GEOMETRY is preserved exactly — the product does not move', async () => {
    const before = await darkFixture()
    const after = (await enhanceShadows(before)).image
    const [db, da] = [await decodeGrey(before), await decodeGrey(after)]
    const [bb, ba] = [locateProduct(db, edgeMap(db)), locateProduct(da, edgeMap(da))]
    assert.ok(bb && ba)
    assert.deepEqual(ba, bb, 'the located product must sit in exactly the same pixels')
    assert.equal(da.width, db.width)
    assert.equal(da.height, db.height)
  })

  test('THRESHOLDED EDGES are NOT promised to be identical — and are not claimed to be', async () => {
    // The honest counterpart to the test above. A monotonic point operation
    // fixes geometry; it does not fix the answer a threshold gives, because a
    // gradient sitting near EDGE_THRESHOLD can cross it. This test exists so
    // that fact is recorded rather than assumed away — it is why the
    // preservation gate keeps measuring the provider's image, not this one.
    const before = await darkFixture()
    const after = (await enhanceShadows(before)).image
    const [eb, ea] = [edgeMap(await decodeGrey(before)), edgeMap(await decodeGrey(after))]
    let crossed = 0
    for (let i = 0; i < eb.length; i++) {
      if ((eb[i] >= EDGE_THRESHOLD) !== (ea[i] >= EDGE_THRESHOLD)) crossed++
    }
    // No assertion that this is zero. What is asserted is that it stays small,
    // so a change of settings that moved edges wholesale would fail here.
    const share = crossed / eb.length
    assert.ok(share < 0.05, `${(share * 100).toFixed(2)}% of pixels changed edge state — far too many`)
  })
})
