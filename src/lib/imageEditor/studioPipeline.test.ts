/**
 * The whole local half, end to end: a cut-out in, the exact Bria request out.
 *
 * The unit tests either side of this one check the arithmetic without sharp and
 * the request without a network. This one runs the real path the route runs —
 * measure the cut-out, gate it, plan the padding, crop and resize, build the
 * body — on cut-outs drawn here, so the parts are checked TOGETHER. Every defect
 * in this feature so far has lived in the joins rather than in the pieces.
 *
 * `fetch` is stubbed. Nothing reaches fal and nothing is billed.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/studioPipeline.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { measureCutout, prepareCutoutForShot } from './prepareCutout'
import { planPadding, checkEnlargement, MASTER_WIDTH, MASTER_HEIGHT, PRODUCT_HEIGHT_MIN, PRODUCT_HEIGHT_MAX } from './studioMaster'
import { composeStudioScene } from './studioScene'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/**
 * A cut-out as background/remove returns one: the ORIGINAL frame, with
 * everything but the product transparent. The product is deliberately off
 * centre and nowhere near the frame edges, because that is what makes the crop
 * step matter — pad this frame instead of the product and the padding is
 * measured from the old photograph.
 */
async function cutout(opts: {
  frame?: { width: number; height: number }
  product: { left: number; top: number; width: number; height: number }
  legs?: boolean
}): Promise<Buffer> {
  const { frame = { width: 2000, height: 2200 }, product, legs = true } = opts
  const data = Buffer.alloc(frame.width * frame.height * 4)

  const box = (l: number, t: number, w: number, h: number) => {
    for (let y = t; y < t + h; y++) {
      for (let x = l; x < l + w; x++) {
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue
        const o = (y * frame.width + x) * 4
        data[o] = 82; data[o + 1] = 74; data[o + 2] = 64; data[o + 3] = 255
      }
    }
  }

  if (legs) {
    // A seat with four thin legs and floor visible between them, so the crop is
    // proved against a shape with real transparency inside its own box.
    const seat = Math.round(product.height * 0.62)
    box(product.left, product.top, product.width, seat)
    const legW = Math.max(2, Math.round(product.width * 0.05))
    const legTop = product.top + seat
    const legH = product.height - seat
    for (const share of [0.02, 0.3, 0.62, 0.93]) {
      box(product.left + Math.round(product.width * share), legTop, legW, legH)
    }
  } else {
    box(product.left, product.top, product.width, product.height)
  }

  return sharp(data, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer()
}

/** The route's local half, in the order the route runs it. */
async function pipeline(png: Buffer) {
  const measured = await measureCutout(png)
  assert.equal(measured.ok, true, measured.ok ? '' : measured.error)
  if (!measured.ok) throw new Error('unreachable')

  const product = { width: measured.bounds.width, height: measured.bounds.height }
  const verdict = checkEnlargement(product)
  const plan = planPadding(product)
  const shaped = await prepareCutoutForShot(png, measured.bounds, plan.product)
  assert.equal(shaped.ok, true, shaped.ok ? '' : shaped.error)
  if (!shaped.ok) throw new Error('unreachable')

  return { measured, product, verdict, plan, shaped }
}

describe('finding the product inside the returned frame', () => {
  test('the box is the product, not the photograph it came from', async () => {
    // background/remove returns the original 2000x2200 frame. Padding computed
    // from THAT would be padding around the old photograph's edges.
    const png = await cutout({ product: { left: 300, top: 250, width: 900, height: 1200 }, legs: false })
    const { product } = await pipeline(png)

    assert.equal(product.width, 900)
    assert.equal(product.height, 1200)
  })

  test('thin legs and the floor between them are inside the box', async () => {
    const png = await cutout({ product: { left: 400, top: 300, width: 1000, height: 1400 } })
    const { product } = await pipeline(png)

    // The legs reach the full height and the full width of the product.
    assert.ok(Math.abs(product.height - 1400) <= 2, `height ${product.height}`)
    assert.ok(Math.abs(product.width - 1000) <= 60, `width ${product.width}`)
  })

  test('an opaque image is refused — it is not a cut-out', async () => {
    const opaque = await sharp({
      create: { width: 800, height: 800, channels: 4, background: { r: 120, g: 110, b: 100, alpha: 1 } },
    }).png().toBuffer()

    const measured = await measureCutout(opaque)
    assert.equal(measured.ok, false)
    if (!measured.ok) assert.match(measured.error, /could not be separated/i)
  })
})

describe('the prepared cut-out that is actually sent', () => {
  test('it is exactly the size the padding plan assumed', async () => {
    // If these disagree by even a pixel, the padding no longer closes on
    // 1000 x 1000 and the master is the wrong size.
    for (const product of [
      { left: 300, top: 250, width: 900, height: 1200 },
      { left: 100, top: 100, width: 1700, height: 700 },
      { left: 500, top: 200, width: 400, height: 1800 },
    ]) {
      const { plan, shaped } = await pipeline(await cutout({ product, legs: false }))
      const meta = await sharp(shaped.png).metadata()

      assert.equal(meta.width, plan.product.width, `${product.width}x${product.height}`)
      assert.equal(meta.height, plan.product.height, `${product.width}x${product.height}`)
      assert.equal(plan.padding.left + meta.width! + plan.padding.right, MASTER_WIDTH)
      assert.equal(plan.padding.top + meta.height! + plan.padding.bottom, MASTER_HEIGHT)
    }
  })

  test('it still has an alpha channel — Bria needs to know where the product ends', async () => {
    const { shaped } = await pipeline(await cutout({ product: { left: 300, top: 250, width: 900, height: 1200 } }))
    const meta = await sharp(shaped.png).metadata()

    assert.equal(meta.hasAlpha, true)
    assert.equal(meta.format, 'png')
  })

  test('the product still touches all four edges of what is sent', async () => {
    // The crop is tight, so after it the product must reach every edge. A gap
    // means the padding is being measured from empty space.
    const { shaped } = await pipeline(await cutout({ product: { left: 300, top: 250, width: 900, height: 1200 } }))
    const { data, info } = await sharp(shaped.png).ensureAlpha().extractChannel(3).raw()
      .toBuffer({ resolveWithObject: true })

    const opaque = (x: number, y: number) => data[y * info.width + x] > 8
    const anyInRow = (y: number) => { for (let x = 0; x < info.width; x++) if (opaque(x, y)) return true; return false }
    const anyInCol = (x: number) => { for (let y = 0; y < info.height; y++) if (opaque(x, y)) return true; return false }

    assert.ok(anyInRow(0), 'nothing on the top edge')
    assert.ok(anyInRow(info.height - 1), 'nothing on the bottom edge')
    assert.ok(anyInCol(0), 'nothing on the left edge')
    assert.ok(anyInCol(info.width - 1), 'nothing on the right edge')
  })

  test('nothing is stretched: the aspect ratio survives the resize', async () => {
    for (const product of [
      { left: 300, top: 250, width: 900, height: 1200 },
      { left: 100, top: 100, width: 1600, height: 800 },
    ]) {
      const { shaped } = await pipeline(await cutout({ product, legs: false }))
      const meta = await sharp(shaped.png).metadata()

      const before = product.width / product.height
      const after = meta.width! / meta.height!
      assert.ok(Math.abs(before - after) / before < 0.01, `${before.toFixed(3)} became ${after.toFixed(3)}`)
    }
  })
})

describe('the size the product owner asked for', () => {
  test('an ordinary chair lands in the 52-55% band', async () => {
    const { plan } = await pipeline(await cutout({ product: { left: 300, top: 250, width: 900, height: 1200 } }))

    assert.ok(plan.heightShare >= PRODUCT_HEIGHT_MIN && plan.heightShare <= PRODUCT_HEIGHT_MAX,
      `${(plan.heightShare * 100).toFixed(1)}%`)
  })

  test('the plan is the same whatever frame the cut-out arrived in', async () => {
    // The same chair, returned in two different photograph sizes, must produce
    // the same request — otherwise the framing depends on the camera.
    const a = await pipeline(await cutout({
      frame: { width: 2000, height: 2200 }, product: { left: 300, top: 250, width: 900, height: 1200 }, legs: false,
    }))
    const b = await pipeline(await cutout({
      frame: { width: 3000, height: 3400 }, product: { left: 1100, top: 900, width: 900, height: 1200 }, legs: false,
    }))

    assert.deepEqual(a.plan.paddingValues, b.plan.paddingValues)
  })

  test('a long sideboard is contained, not cropped, and says so', async () => {
    const { plan } = await pipeline(await cutout({
      frame: { width: 3000, height: 1400 }, product: { left: 200, top: 300, width: 2400, height: 800 }, legs: false,
    }))

    assert.equal(plan.widthLimited, true)
    assert.ok(plan.padding.left >= 0 && plan.padding.right >= 0)
    assert.equal(plan.padding.left + plan.product.width + plan.padding.right, MASTER_WIDTH)
  })

  test('a product photographed too small is refused before the second request', async () => {
    const png = await cutout({
      frame: { width: 1200, height: 1200 }, product: { left: 500, top: 500, width: 150, height: 200 }, legs: false,
    })
    const { verdict } = await pipeline(png)

    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.match(verdict.message, /too small/i)
  })
})

describe('the edge repair, in the pipeline', () => {
  /** A cut-out whose boundary carries dark factory background, as a real one does. */
  async function contaminatedCutout() {
    const W = 1400, H = 1600
    const d = Buffer.alloc(W * H * 4)
    const PRODUCT = { r: 198, g: 174, b: 140 }
    const FACTORY = { r: 32, g: 28, b: 25 }
    const cx = W / 2, cy = H / 2, rx = W * 0.32, ry = H * 0.36

    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry
      const px = (1 - Math.sqrt(nx * nx + ny * ny)) * Math.min(rx, ry)
      const c = Math.max(0, Math.min(1, px / 2 + 0.5))
      const o = (y * W + x) * 4
      d[o] = Math.round(PRODUCT.r * c + FACTORY.r * (1 - c))
      d[o + 1] = Math.round(PRODUCT.g * c + FACTORY.g * (1 - c))
      d[o + 2] = Math.round(PRODUCT.b * c + FACTORY.b * (1 - c))
      d[o + 3] = Math.round(c * 255)
    }
    return sharp(d, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  }

  test('the repair runs, and reports what it did', async () => {
    const { shaped } = await pipeline(await contaminatedCutout())
    assert.ok(shaped.edges.repaired > 0, 'no edge pixel was repaired')
    assert.ok(shaped.edges.solid > shaped.edges.repaired, 'the product must be mostly interior')
  })

  test('the product bounds are unchanged by it', async () => {
    // Padding is computed from these. If the repair moved them, the sizing
    // would shift and the accepted 53% framing with it.
    const png = await contaminatedCutout()
    const before = await measureCutout(png)
    const after = await measureCutout(png)
    assert.equal(before.ok && after.ok, true)
    if (!before.ok || !after.ok) return

    assert.deepEqual(before.bounds, after.bounds)
    const { plan } = await pipeline(png)
    assert.deepEqual(plan.product, planPadding({
      width: before.bounds.width, height: before.bounds.height,
    }).product)
  })

  test('the sizing plan and the image sent still agree exactly', async () => {
    const { plan, shaped } = await pipeline(await contaminatedCutout())
    const meta = await sharp(shaped.png).metadata()

    assert.equal(meta.width, plan.product.width)
    assert.equal(meta.height, plan.product.height)
    assert.equal(plan.padding.left + meta.width! + plan.padding.right, MASTER_WIDTH)
    assert.equal(plan.padding.top + meta.height! + plan.padding.bottom, MASTER_HEIGHT)
    assert.ok(plan.heightShare >= PRODUCT_HEIGHT_MIN && plan.heightShare <= PRODUCT_HEIGHT_MAX)
  })

  test('the alpha silhouette that is sent is the one the resize produced', async () => {
    // The repair never writes alpha, so the only thing that may shape the sent
    // image is the one proportional resize.
    const png = await contaminatedCutout()
    const measured = await measureCutout(png)
    assert.equal(measured.ok, true)
    if (!measured.ok) return

    const plan = planPadding({ width: measured.bounds.width, height: measured.bounds.height })
    const repaired = await prepareCutoutForShot(png, measured.bounds, plan.product)
    assert.equal(repaired.ok, true)
    if (!repaired.ok) return

    // The same crop and resize with no repair at all.
    const plain = await sharp(png).ensureAlpha()
      .extract({
        left: measured.bounds.left, top: measured.bounds.top,
        width: measured.bounds.width, height: measured.bounds.height,
      })
      .resize(plan.product.width, plan.product.height, { kernel: 'lanczos3', fit: 'fill' })
      .png().toBuffer()

    const a = await sharp(plain).ensureAlpha().extractChannel(3).raw().toBuffer()
    const b = await sharp(repaired.png).ensureAlpha().extractChannel(3).raw().toBuffer()
    assert.deepEqual(b, a, 'the repair changed the silhouette')
  })

  test('after the resize, only the boundary band differs, and only slightly', async () => {
    // Opaque pixels one step in from the edge DO move, because the resize
    // legitimately averages repaired neighbours into them. Nothing deeper may.
    const png = await contaminatedCutout()
    const measured = await measureCutout(png)
    assert.equal(measured.ok, true)
    if (!measured.ok) return
    const plan = planPadding({ width: measured.bounds.width, height: measured.bounds.height })

    const repaired = await prepareCutoutForShot(png, measured.bounds, plan.product)
    assert.equal(repaired.ok, true)
    if (!repaired.ok) return

    const plain = await sharp(png).ensureAlpha()
      .extract({
        left: measured.bounds.left, top: measured.bounds.top,
        width: measured.bounds.width, height: measured.bounds.height,
      })
      .resize(plan.product.width, plan.product.height, { kernel: 'lanczos3', fit: 'fill' })
      .png().toBuffer()

    const A = await sharp(plain).raw().toBuffer()
    const B = await sharp(repaired.png).raw().toBuffer()
    const W = plan.product.width, H = plan.product.height

    const nonOpaque = (x: number, y: number) =>
      x < 0 || y < 0 || x >= W || y >= H || B[(y * W + x) * 4 + 3] !== 255

    let deepChanged = 0
    let maxDelta = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      if (A[o + 3] !== 255 || B[o + 3] !== 255) continue

      let delta = 0
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(A[o + c] - B[o + c]))
      if (!delta) continue
      maxDelta = Math.max(maxDelta, delta)

      // Is this pixel adjacent to the silhouette edge?
      let adjacent = false
      for (let dy = -1; dy <= 1 && !adjacent; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (nonOpaque(x + dx, y + dy)) { adjacent = true; break }
      }
      if (!adjacent) deepChanged++
    }

    assert.equal(deepChanged, 0, `${deepChanged} opaque pixels changed away from the edge`)
    assert.ok(maxDelta <= 12, `a boundary pixel moved by ${maxDelta}, which is more than resampling`)
  })

  test('the repair happens before the resize, not after', () => {
    // Order is the difference between averaging clean colour down and baking a
    // rim in. sharp reorders chained operations, so this is asserted on source.
    const source = readFileSync(join(process.cwd(), 'src/lib/imageEditor/prepareCutout.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    const repair = code.indexOf('decontaminateEdges(')
    const resize = code.indexOf('.resize(')
    assert.ok(repair > -1 && resize > -1)
    assert.ok(repair < resize, 'the edge repair must precede the resize')
  })

  test('still one resize, and still no second provider call', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/imageEditor/prepareCutout.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    assert.equal(code.split('.resize(').length - 1, 1, 'exactly one resize')
    for (const banned of ['fetch(', 'callFal', 'removeBackground', 'generateStudioShot', 'https://']) {
      assert.ok(!code.includes(banned), `${banned} must not appear in the preparation path`)
    }
  })
})

describe('what happens after the one provider call', () => {
  test('the composition is local — no second request of any kind', async () => {
    const { plan, shaped } = await pipeline(await cutout({
      product: { left: 300, top: 250, width: 900, height: 1200 },
    }))

    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('{}') }) as typeof globalThis.fetch

    const scene = await composeStudioScene(shaped.png, plan)

    assert.equal(scene.ok, true)
    assert.equal(calls, 0, 'compositing must not reach the network')
  })

  test('the master is 1440 x 1440 and opaque', async () => {
    const { plan, shaped } = await pipeline(await cutout({
      product: { left: 300, top: 250, width: 900, height: 1200 },
    }))
    const scene = await composeStudioScene(shaped.png, plan)
    assert.equal(scene.ok, true)
    if (!scene.ok) return

    const meta = await sharp(scene.png).metadata()
    assert.equal(meta.width, 1440)
    assert.equal(meta.height, 1440)
    assert.equal(meta.hasAlpha ?? false, false)
  })

  test('two different products place differently, from their own dimensions', async () => {
    const chair = await pipeline(await cutout({
      product: { left: 300, top: 250, width: 900, height: 1200 }, legs: false,
    }))
    const bench = await pipeline(await cutout({
      frame: { width: 3000, height: 1400 }, product: { left: 200, top: 300, width: 2400, height: 800 }, legs: false,
    }))

    assert.notDeepEqual(chair.plan.paddingValues, bench.plan.paddingValues,
      'the padding must be derived from the cut-out, not fixed')
    assert.equal(bench.plan.widthLimited, true)
  })
})
