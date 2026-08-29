/**
 * The studio scene, and the rule it exists to keep.
 *
 * A generative pass was tried and it repainted the product: the fan of thin
 * spindles under a chair seat came back as a dark continuous mass with the
 * openings between them filled. So the final visible furniture is now the
 * cut-out and nothing else, and the first four tests here are that rule stated
 * four different ways — because a rule with no test is a preference.
 *
 * The fixtures are drawn in this file rather than photographed, so the awkward
 * structures (1px spindles, a cane lattice, an open underseat, a 3:1 sideboard)
 * are cheap enough to check exhaustively.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/studioScene.test.ts
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { composeStudioScene, studioSweep, sweepTone } from './studioScene'
import { planPadding, MASTER_WIDTH, MASTER_HEIGHT, PRODUCT_HEIGHT_SHARE } from './studioMaster'
import { measureCutout, prepareCutoutForShot } from './prepareCutout'

const TIMBER = { r: 122, g: 88, b: 58 }
const MARK = { r: 236, g: 60, b: 60 }

type Cut = { png: Buffer; width: number; height: number; raw: Buffer }

/** A decoded image: what `sharp(...).raw().toBuffer({ resolveWithObject: true })` gives back. */
type Raw = { data: Buffer; info: { width: number; height: number; channels: number } }

/**
 * A chair with everything that has ever broken: a top rail, a fan of thin
 * spindles under the seat with open floor between them, four legs at two
 * different heights, and a watermark inside the seat.
 */
async function chair(opts: { width?: number; height?: number; spindle?: number; watermark?: boolean } = {}): Promise<Cut> {
  const { width = 900, height = 1150, spindle = 3, watermark = true } = opts
  const d = Buffer.alloc(width * height * 4)

  const paint = (l: number, t: number, w: number, h: number, c = TIMBER) => {
    for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      const o = (y * width + x) * 4
      d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b; d[o + 3] = 255
    }
  }

  paint(80, 40, width - 160, 46)                                   // top back rail
  for (let i = 0; i < 9; i++) paint(120 + i * 74, 86, 12, 330)      // back spindles
  paint(40, 430, width - 80, 70)                                    // seat
  // THE STRUCTURE THAT WAS DESTROYED: a fan of thin spindles under the seat.
  for (let i = 0; i < 15; i++) paint(90 + i * 48, 500, spindle, 150)
  paint(60, 660, 40, height - 700)                                  // front legs
  paint(width - 100, 660, 40, height - 700)
  paint(220, 660, 26, height - 730)                                 // back legs, higher
  paint(width - 250, 660, 26, height - 730)

  if (watermark) paint(Math.round(width * 0.34), 448, Math.round(width * 0.32), 34, MARK)

  const png = await sharp(d, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { png, width, height, raw: d }
}

/** A cane lattice: 1px bars with 1px holes. */
async function cane(width = 700, height = 900): Promise<Cut> {
  const d = Buffer.alloc(width * height * 4)
  const set = (x: number, y: number) => {
    const o = (y * width + x) * 4
    d[o] = TIMBER.r; d[o + 1] = TIMBER.g; d[o + 2] = TIMBER.b; d[o + 3] = 255
  }
  for (let y = 40; y < 620; y++) for (let x = 40; x < width - 40; x++) {
    if (x % 3 === 0 || y % 3 === 0) set(x, y)
  }
  for (let y = 620; y < height - 20; y++) {
    for (let x = 60; x < 100; x++) set(x, y)
    for (let x = width - 100; x < width - 60; x++) set(x, y)
  }
  const png = await sharp(d, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { png, width, height, raw: d }
}

/** A 3:1 sideboard — wide enough that the width, not the height, binds. */
async function sideboard(width = 2400, height = 800): Promise<Cut> {
  const d = Buffer.alloc(width * height * 4)
  const paint = (l: number, t: number, w: number, h: number) => {
    for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) {
      const o = (y * width + x) * 4
      d[o] = TIMBER.r; d[o + 1] = TIMBER.g; d[o + 2] = TIMBER.b; d[o + 3] = 255
    }
  }
  paint(40, 40, width - 80, 520)
  paint(90, 560, 40, 200)
  paint(width - 130, 560, 40, 200)
  const png = await sharp(d, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { png, width, height, raw: d }
}

/**
 * Exactly the route's path: measure the alpha, plan from the PRODUCT's bounding
 * box, prepare (decontaminate, resize, edge-safe sharpen), compose.
 *
 * Going through the real preparation matters — it is what makes the
 * byte-identity check below a check on the thing that actually ships.
 */
async function compose(cut: Cut) {
  const measured = await measureCutout(cut.png)
  assert.equal(measured.ok, true, measured.ok ? '' : measured.error)
  if (!measured.ok) throw new Error('unreachable')

  const plan = planPadding({ width: measured.bounds.width, height: measured.bounds.height })
  const shaped = await prepareCutoutForShot(cut.png, measured.bounds, plan.product)
  assert.equal(shaped.ok, true, shaped.ok ? '' : shaped.error)
  if (!shaped.ok) throw new Error('unreachable')
  const prepared = shaped.png

  const scene = await composeStudioScene(prepared, plan)
  assert.equal(scene.ok, true, scene.ok ? '' : scene.error)
  if (!scene.ok) throw new Error('unreachable')

  const master = await sharp(scene.png).raw().toBuffer({ resolveWithObject: true })
  const product = await sharp(prepared).raw().toBuffer({ resolveWithObject: true })
  return { plan, prepared, scene, master, product }
}

let ref: Awaited<ReturnType<typeof compose>>
before(async () => { ref = await compose(await chair()) })

// ─── The rule ─────────────────────────────────────────────────────────────────

describe('the furniture is the cut-out, and only the cut-out', () => {
  test('every opaque product pixel in the master is byte-identical', async () => {
    const { plan, master, product } = ref
    let checked = 0
    for (let y = 0; y < plan.product.height; y++) {
      for (let x = 0; x < plan.product.width; x++) {
        const p = (y * product.info.width + x) * 4
        if (product.data[p + 3] !== 255) continue
        const m = ((y + plan.padding.top) * master.info.width + x + plan.padding.left) * master.info.channels
        for (let c = 0; c < 3; c++) {
          assert.equal(master.data[m + c], product.data[p + c],
            `product pixel ${x},${y} channel ${c} was changed by compositing`)
        }
        checked++
      }
    }
    assert.ok(checked > 50_000, `only ${checked} opaque pixels checked`)
  })

  test('transparent openings show background, not furniture', async () => {
    const { plan, master, product } = ref
    // A row through the fan of spindles under the seat.
    const y = Math.round(plan.product.height * 0.50)
    let open = 0
    for (let x = 0; x < plan.product.width; x++) {
      const p = (y * product.info.width + x) * 4
      if (product.data[p + 3] !== 0) continue
      const m = ((y + plan.padding.top) * master.info.width + x + plan.padding.left) * master.info.channels
      // Background is light; the timber is dark. An opening that came back dark
      // would be furniture painted into a gap.
      const mean = (master.data[m] + master.data[m + 1] + master.data[m + 2]) / 3
      assert.ok(mean > 130, `opening at ${x},${y} reads ${mean.toFixed(0)} — something filled it`)
      open++
    }
    assert.ok(open > 20, `expected open floor between the spindles, found ${open}px`)
  })

  test('the number of separate transparent regions is unchanged', async () => {
    // The defect, as a count. Filling the gaps between spindles merges many
    // regions into one, and nothing else in the pipeline would notice.
    const { plan, product, master } = ref

    const label = (isOpen: (x: number, y: number) => boolean, w: number, h: number) => {
      const seen = new Uint8Array(w * h)
      let regions = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (seen[y * w + x] || !isOpen(x, y)) continue
        regions++
        const stack = [[x, y]]
        seen[y * w + x] = 1
        while (stack.length) {
          const [cx, cy] = stack.pop()!
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            if (seen[ny * w + nx] || !isOpen(nx, ny)) continue
            seen[ny * w + nx] = 1
            stack.push([nx, ny])
          }
        }
      }
      return regions
    }

    const w = plan.product.width, h = plan.product.height
    const before = label((x, y) => product.data[(y * product.info.width + x) * 4 + 3] === 0, w, h)
    const after = label((x, y) => {
      const p = (y * product.info.width + x) * 4
      if (product.data[p + 3] !== 0) return false
      const m = ((y + plan.padding.top) * master.info.width + x + plan.padding.left) * master.info.channels
      return (master.data[m] + master.data[m + 1] + master.data[m + 2]) / 3 > 130
    }, w, h)

    assert.equal(after, before, `${before} open regions became ${after}`)
    assert.ok(before > 5, `fixture must have several openings, has ${before}`)
  })

  test('1px, 2px and 3px spindles all survive to the master', async () => {
    for (const spindle of [1, 2, 3]) {
      const { plan, master, product } = await compose(await chair({ spindle }))
      const y = Math.round(plan.product.height * 0.50)

      let dark = 0
      for (let x = 0; x < plan.product.width; x++) {
        const m = ((y + plan.padding.top) * master.info.width + x + plan.padding.left) * master.info.channels
        if ((master.data[m] + master.data[m + 1] + master.data[m + 2]) / 3 < 150) dark++
      }
      assert.ok(dark >= 8, `${spindle}px spindles: only ${dark} dark pixels across the fan`)

      // And they are separate, not a mass: open floor between them.
      let open = 0
      for (let x = 0; x < plan.product.width; x++) {
        const p = (y * product.info.width + x) * 4
        if (product.data[p + 3] === 0) open++
      }
      assert.ok(open > plan.product.width * 0.3, `${spindle}px: the fan is not open`)
    }
  })

  test('the watermark reaches the master unchanged', async () => {
    const { plan, master, product } = ref
    let marked = 0
    for (let y = 0; y < plan.product.height; y++) for (let x = 0; x < plan.product.width; x++) {
      const p = (y * product.info.width + x) * 4
      // The watermark is the red region; nothing else in the fixture is red.
      if (!(product.data[p] > 180 && product.data[p + 1] < 120 && product.data[p + 3] === 255)) continue
      const m = ((y + plan.padding.top) * master.info.width + x + plan.padding.left) * master.info.channels
      for (let c = 0; c < 3; c++) assert.equal(master.data[m + c], product.data[p + c])
      marked++
    }
    assert.ok(marked > 500, `the watermark did not survive: ${marked} pixels`)
  })

  test('a cane lattice keeps its holes', async () => {
    const { plan, product, master } = await compose(await cane())
    let holes = 0
    for (let y = 20; y < plan.product.height * 0.5; y += 3) {
      for (let x = 10; x < plan.product.width - 10; x += 3) {
        const p = (y * product.info.width + x) * 4
        if (product.data[p + 3] !== 0) continue
        const m = ((y + plan.padding.top) * master.info.width + x + plan.padding.left) * master.info.channels
        if ((master.data[m] + master.data[m + 1] + master.data[m + 2]) / 3 > 130) holes++
      }
    }
    assert.ok(holes > 100, `a cane lattice must stay open: ${holes} holes read as background`)
  })
})

// ─── Framing ──────────────────────────────────────────────────────────────────

describe('the framing', () => {
  test('the master is 1440 x 1440', async () => {
    const meta = await sharp(ref.scene.png).metadata()
    assert.equal(meta.width, 1440)
    assert.equal(meta.height, 1440)
    assert.equal(meta.hasAlpha ?? false, false, 'the master must be opaque')
  })

  test('the product is placed at 53%, centred, on the 60:40 split', async () => {
    const { plan } = ref
    assert.equal(plan.product.height, 763)
    assert.ok(Math.abs(plan.heightShare - PRODUCT_HEIGHT_SHARE) < 0.005)
    assert.ok(Math.abs(plan.padding.left + plan.product.width / 2 - 720) <= 0.5)

    const leftover = MASTER_HEIGHT - plan.product.height
    assert.ok(Math.abs(plan.padding.top / leftover - 0.6) < 0.005)
    assert.ok(Math.abs(plan.padding.bottom / leftover - 0.4) < 0.005)
  })

  test('a 3:1 sideboard is contained, never cropped', async () => {
    const { plan, scene } = await compose(await sideboard())
    assert.equal(plan.widthLimited, true)
    assert.ok(plan.product.width <= 1267, `${plan.product.width} exceeds the 88% limit`)
    assert.ok(plan.padding.left >= 0 && plan.padding.right >= 0)
    assert.equal(plan.padding.left + plan.product.width + plan.padding.right, MASTER_WIDTH)
    const meta = await sharp(scene.png).metadata()
    assert.equal(meta.width, 1440)
  })

  test('the same cut-out composes to the same bytes', async () => {
    const cut = await chair()
    const a = await compose(cut)
    const b = await compose(cut)
    assert.deepEqual(a.scene.png, b.scene.png)
  })
})

// ─── The background ───────────────────────────────────────────────────────────

describe('the sweep', () => {
  const mean = (r: Raw, fx: number, fy: number) => {
    const x = Math.round(fx * (r.info.width - 1)), y = Math.round(fy * (r.info.height - 1))
    const o = (y * r.info.width + x) * r.info.channels
    return (r.data[o] + r.data[o + 1] + r.data[o + 2]) / 3
  }

  let sweep: Raw
  before(async () => {
    sweep = await sharp(await studioSweep(MASTER_WIDTH, MASTER_HEIGHT)).raw().toBuffer({ resolveWithObject: true })
  })

  test('the calibration anchors hold', () => {
    // Measured from the accepted real outputs. These are the numbers that make
    // it the approved look rather than the earlier cream-coloured flat one.
    for (const [label, fx, fy, lo, hi] of [
      ['upper-left corner', 0.01, 0.01, 140, 160],
      ['upper-right corner', 0.99, 0.01, 140, 160],
      ['left edge', 0.01, 0.45, 140, 160],
      ['right edge', 0.99, 0.45, 140, 160],
      ['centre, behind the product', 0.50, 0.30, 180, 190],
      ['floor', 0.50, 0.92, 195, 220],
    ] as const) {
      const m = mean(sweep, fx, fy)
      assert.ok(m >= lo && m <= hi, `${label}: ${m.toFixed(0)}, want ${lo}-${hi}`)
    }
  })

  test('it is not the old pale, flat background', () => {
    // The earlier local sweep was 235/232/227 nearly everywhere and was
    // rejected as too cream, too bright and too flat.
    assert.ok(mean(sweep, 0.02, 0.02) < 175, 'the corners are still bright')
    const range = mean(sweep, 0.5, 0.95) - mean(sweep, 0.02, 0.02)
    assert.ok(range > 40, `only ${range.toFixed(0)} levels between corner and floor — still flat`)
  })

  test('it is warm-neutral, with no yellow or blue cast', () => {
    for (const [fx, fy] of [[0.02, 0.02], [0.5, 0.35], [0.5, 0.9]] as const) {
      const x = Math.round(fx * (sweep.info.width - 1)), y = Math.round(fy * (sweep.info.height - 1))
      const o = (y * sweep.info.width + x) * sweep.info.channels
      const [r, g, b] = [sweep.data[o], sweep.data[o + 1], sweep.data[o + 2]]
      assert.ok(r > g && g > b, `${r},${g},${b} is not warm-neutral`)
      assert.ok(r - b <= 14, `${r - b} levels of separation reads as a yellow cast`)
    }
  })

  test('there is no wall/floor line anywhere', () => {
    // A horizon is the single most obvious tell that a background was made.
    let worst = 0
    for (let y = 1; y < sweep.info.height; y++) {
      const a = mean(sweep, 0.06, (y - 1) / sweep.info.height)
      const b = mean(sweep, 0.06, y / sweep.info.height)
      worst = Math.max(worst, Math.abs(a - b))
    }
    assert.ok(worst <= 2, `a ${worst.toFixed(1)}-level step appears down the left edge`)
  })

  test('the floor is lighter than the wall, and the corners darkest', () => {
    assert.ok(mean(sweep, 0.5, 0.95) > mean(sweep, 0.5, 0.10), 'the floor must be the lighter end')
    assert.ok(mean(sweep, 0.02, 0.02) < mean(sweep, 0.5, 0.30), 'the corners must be darker than behind the product')
  })

  test('the tone function is smooth — no step anywhere in it', () => {
    for (let i = 1; i <= 400; i++) {
      const a = sweepTone(0.3, (i - 1) / 400)
      const b = sweepTone(0.3, i / 400)
      assert.ok(Math.abs(a - b) < 1.5, `a ${(b - a).toFixed(2)} jump at y=${i / 400}`)
    }
  })
})

// ─── Shadows ──────────────────────────────────────────────────────────────────

describe('the shadows', () => {
  const brightness = (r: Raw, x: number, y: number) => {
    const o = (y * r.info.width + x) * r.info.channels
    return (r.data[o] + r.data[o + 1] + r.data[o + 2]) / 3
  }

  test('there is a contact shadow under each foot, and it touches the foot', async () => {
    const { plan, master, product } = ref
    const feetY = plan.product.height - 1

    // Columns that actually reach the floor.
    const feet: number[] = []
    for (let x = 0; x < plan.product.width; x++) {
      if (product.data[(feetY * product.info.width + x) * 4 + 3] === 255) feet.push(x)
    }
    assert.ok(feet.length > 10, `fixture has no feet: ${feet.length}`)

    const openFloor = brightness(master, 120, plan.padding.top + plan.product.height + 40)
    for (const x of [feet[2], feet[Math.floor(feet.length / 2)], feet[feet.length - 3]]) {
      // Immediately below the foot — touching it, not a gap then a blob.
      const just = brightness(master, plan.padding.left + x, plan.padding.top + plan.product.height + 1)
      assert.ok(just < openFloor - 12,
        `no shadow touching the foot at x=${x}: ${just.toFixed(0)} vs open floor ${openFloor.toFixed(0)}`)
    }
  })

  test('open floor remains between the feet', async () => {
    // A shadow drawn under the whole silhouette reads as a plinth.
    const { plan, scene } = ref
    assert.ok(scene.metrics.contactColumns > 0)
    assert.ok(scene.metrics.contactColumns < plan.product.width * 0.75,
      `${scene.metrics.contactColumns} of ${plan.product.width} columns in contact — that is a silhouette`)
  })

  test('the cast shadow leans right and back', async () => {
    const { plan, master } = ref
    const below = plan.padding.top + plan.product.height + 24
    const left = brightness(master, Math.max(2, plan.padding.left - 60), below)
    const right = brightness(master, Math.min(1437, plan.padding.left + plan.product.width + 60), below)
    assert.ok(right < left, `the shadow must fall right: left ${left.toFixed(0)}, right ${right.toFixed(0)}`)
    assert.equal(ref.scene.metrics.castDrawn, true)
  })

  test('no isolated shadow blob — every dark floor pixel is near the product', async () => {
    const { plan, master } = ref
    const floorTop = plan.padding.top + plan.product.height + 2
    const nearLeft = plan.padding.left - 120
    const nearRight = plan.padding.left + plan.product.width + 200

    for (let y = floorTop; y < MASTER_HEIGHT; y += 3) {
      for (let x = 0; x < MASTER_WIDTH; x += 3) {
        const b = brightness(master, x, y)
        const expected = (sweepTone((x + 0.5) / MASTER_WIDTH, (y + 0.5) / MASTER_HEIGHT))
        if (b > expected - 10) continue
        assert.ok(x > nearLeft && x < nearRight,
          `a detached dark patch at ${x},${y} — ${b.toFixed(0)} against a sweep of ${expected.toFixed(0)}`)
      }
    }
  })

  test('the shadow is secondary — the floor never goes truly dark', async () => {
    const { plan, master } = ref
    let darkest = 255
    for (let y = plan.padding.top + plan.product.height + 2; y < MASTER_HEIGHT; y++) {
      for (let x = 0; x < MASTER_WIDTH; x += 2) darkest = Math.min(darkest, brightness(master, x, y))
    }
    assert.ok(darkest > 110, `the floor reaches ${darkest.toFixed(0)} — the shadow is taking over`)
  })

  test('no shadow is clipped at the canvas edge', async () => {
    const { master } = ref
    for (const [x, y] of [[0, 1439], [1439, 1439], [0, 1200], [1439, 1200]] as const) {
      const b = brightness(master, x, y)
      const expected = sweepTone((x + 0.5) / MASTER_WIDTH, (y + 0.5) / MASTER_HEIGHT)
      assert.ok(Math.abs(b - expected) < 12, `the canvas edge at ${x},${y} is not clean sweep`)
    }
  })

  test('shadows are behind the product, never over it', async () => {
    // Composited before it, so they cannot darken it — checked because the
    // order of a sharp composite list is easy to change by accident.
    const { plan, master, product } = ref
    const midX = Math.round(plan.product.width / 2)
    for (let y = plan.product.height - 40; y < plan.product.height; y++) {
      const p = (y * product.info.width + midX) * 4
      if (product.data[p + 3] !== 255) continue
      const m = ((y + plan.padding.top) * master.info.width + midX + plan.padding.left) * master.info.channels
      assert.equal(master.data[m], product.data[p], `a shadow darkened the product at y=${y}`)
    }
  })
})
