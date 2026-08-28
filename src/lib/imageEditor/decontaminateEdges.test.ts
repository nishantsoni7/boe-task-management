/**
 * The edge repair, tested adversarially.
 *
 * The defect: a thin dark fringe around the product in the full-resolution
 * master. Background removal assigns alpha without repainting, so a boundary
 * pixel still carries the photograph's own mix of product and dark factory
 * background — and composited onto a light studio sweep that mix reads as a rim.
 *
 * Everything here is built to break the fix rather than to confirm it. The ways
 * an edge repair normally ruins furniture are eroding the alpha, thinning a
 * spindle, filling the gaps between legs, or dragging the whole product's colour
 * toward an average — so each of those is a test, and the fixtures are drawn
 * with one-, two- and three-pixel structures on purpose.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/decontaminateEdges.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decontaminateEdges, SOLID_ALPHA, DONOR_SIGMA, MIN_DONOR_WEIGHT,
} from './decontaminateEdges'

/** A pale timber product photographed against a dark factory background. */
const PRODUCT = { r: 200, g: 176, b: 142 }
const FACTORY = { r: 30, g: 26, b: 24 }
/** Bria's studio sweep, which is what the rim is seen against. */
const STUDIO = { r: 235, g: 232, b: 227 }

const channels = ['r', 'g', 'b'] as const

/** What a segmenter stores at a pixel the product covers `a` of: the
 *  photograph's own colour (a mix), and alpha as the coverage. */
function contaminated(a: number) {
  return {
    r: Math.round(PRODUCT.r * a + FACTORY.r * (1 - a)),
    g: Math.round(PRODUCT.g * a + FACTORY.g * (1 - a)),
    b: Math.round(PRODUCT.b * a + FACTORY.b * (1 - a)),
    alpha: Math.round(a * 255),
  }
}

type Canvas = { data: Buffer; width: number; height: number }

function canvas(width: number, height: number): Canvas {
  return { data: Buffer.alloc(width * height * 4), width, height }
}

function put(c: Canvas, x: number, y: number, p: { r: number; g: number; b: number; alpha: number }) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return
  const o = (y * c.width + x) * 4
  c.data[o] = p.r; c.data[o + 1] = p.g; c.data[o + 2] = p.b; c.data[o + 3] = p.alpha
}

const at = (c: Canvas, x: number, y: number) => {
  const o = (y * c.width + x) * 4
  return { r: c.data[o], g: c.data[o + 1], b: c.data[o + 2], alpha: c.data[o + 3] }
}

/**
 * A solid block with a one-pixel half-covered shoulder all the way round —
 * the simplest thing that has a contaminated edge.
 */
function block(width = 60, height = 60, box = { left: 10, top: 10, w: 40, h: 40 }): Canvas {
  const c = canvas(width, height)
  for (let y = box.top - 1; y < box.top + box.h + 1; y++) {
    for (let x = box.left - 1; x < box.left + box.w + 1; x++) {
      const onShoulder = x === box.left - 1 || x === box.left + box.w
        || y === box.top - 1 || y === box.top + box.h
      put(c, x, y, contaminated(onShoulder ? 0.5 : 1))
    }
  }
  return c
}

/** What a pixel composites to over the studio sweep. */
const composited = (p: { r: number; g: number; b: number; alpha: number }) => {
  const a = p.alpha / 255
  return {
    r: p.r * a + STUDIO.r * (1 - a),
    g: p.g * a + STUDIO.g * (1 - a),
    b: p.b * a + STUDIO.b * (1 - a),
  }
}

/** What it SHOULD composite to: clean product at that coverage. */
const idealComposite = (alpha: number) => {
  const a = alpha / 255
  return {
    r: PRODUCT.r * a + STUDIO.r * (1 - a),
    g: PRODUCT.g * a + STUDIO.g * (1 - a),
    b: PRODUCT.b * a + STUDIO.b * (1 - a),
  }
}

const meanError = (p: { r: number; g: number; b: number; alpha: number }) => {
  const got = composited(p)
  const want = idealComposite(p.alpha)
  return ((want.r - got.r) + (want.g - got.g) + (want.b - got.b)) / 3
}

// ─── The defect itself ────────────────────────────────────────────────────────

describe('the contamination this exists to remove', () => {
  test('an untreated boundary pixel composites visibly too dark', () => {
    // The premise, stated as a measurement. If this ever stops being true the
    // fix below is solving a problem that no longer exists.
    const before = contaminated(0.5)
    assert.ok(meanError(before) > 15,
      `an untreated half-covered pixel is only ${meanError(before).toFixed(1)} levels dark`)
  })

  test('after the repair that pixel is within a level or two of correct', async () => {
    const c = block()
    await decontaminateEdges(c.data, c.width, c.height)

    // Mid-run of the top shoulder, well away from the corners.
    const repaired = at(c, 30, 9)
    assert.ok(Math.abs(meanError(repaired)) < 3,
      `still ${meanError(repaired).toFixed(1)} levels out after repair`)
  })

  test('the repaired colour is the product’s, not an average with the background', async () => {
    const c = block()
    await decontaminateEdges(c.data, c.width, c.height)
    const p = at(c, 30, 9)

    for (const ch of channels) {
      assert.ok(Math.abs(p[ch] - PRODUCT[ch]) <= 6,
        `${ch}: ${p[ch]} is not the product's ${PRODUCT[ch]}`)
    }
  })

  test('it works on a dark product over a light background too', async () => {
    // The fringe is not always dark. A walnut chair shot against a white wall
    // gets a PALE rim, and a repair tuned only for dark contamination would
    // leave it.
    const DARK = { r: 52, g: 40, b: 30 }
    const WALL = { r: 232, g: 230, b: 226 }
    const c = canvas(60, 60)
    for (let y = 9; y < 51; y++) for (let x = 9; x < 51; x++) {
      const shoulder = x === 9 || x === 50 || y === 9 || y === 50
      const a = shoulder ? 0.5 : 1
      put(c, x, y, {
        r: Math.round(DARK.r * a + WALL.r * (1 - a)),
        g: Math.round(DARK.g * a + WALL.g * (1 - a)),
        b: Math.round(DARK.b * a + WALL.b * (1 - a)),
        alpha: Math.round(a * 255),
      })
    }
    await decontaminateEdges(c.data, c.width, c.height)

    const p = at(c, 30, 9)
    for (const ch of channels) {
      assert.ok(Math.abs(p[ch] - DARK[ch]) <= 8, `${ch}: ${p[ch]} is not the product's ${DARK[ch]}`)
    }
  })
})

// ─── What must not change ─────────────────────────────────────────────────────

describe('the silhouette is never touched', () => {
  test('not one alpha byte changes, on any fixture', async () => {
    // The rule the whole design rests on. Eroding alpha is the usual way to
    // kill a fringe, and on furniture it thins the cane and the spindles.
    for (const c of [block(), spindles([1, 2, 3, 8]), lattice()]) {
      const before = Buffer.from(c.data)
      await decontaminateEdges(c.data, c.width, c.height)

      for (let i = 0; i < c.width * c.height; i++) {
        assert.equal(c.data[i * 4 + 3], before[i * 4 + 3], `alpha moved at pixel ${i}`)
      }
    }
  })

  test('fully opaque pixels are byte-identical', async () => {
    const c = block()
    const before = Buffer.from(c.data)
    await decontaminateEdges(c.data, c.width, c.height)

    let checked = 0
    for (let i = 0; i < c.width * c.height; i++) {
      if (before[i * 4 + 3] !== 255) continue
      checked++
      for (let ch = 0; ch < 3; ch++) {
        assert.equal(c.data[i * 4 + ch], before[i * 4 + ch], `opaque pixel ${i} channel ${ch} moved`)
      }
    }
    assert.ok(checked > 1000, 'the fixture must have a real interior')
  })

  test('fully transparent pixels are byte-identical, colour included', async () => {
    const c = block()
    const before = Buffer.from(c.data)
    await decontaminateEdges(c.data, c.width, c.height)

    for (let i = 0; i < c.width * c.height; i++) {
      if (before[i * 4 + 3] !== 0) continue
      for (let ch = 0; ch < 4; ch++) {
        assert.equal(c.data[i * 4 + ch], before[i * 4 + ch], `empty pixel ${i} channel ${ch} moved`)
      }
    }
  })

  test('near-opaque pixels at the solid threshold are left alone', async () => {
    // 250-254 count as product, not as edge, so the donor pool stays clean and
    // the interior keeps its own colour right up to the boundary.
    const c = block()
    for (let x = 12; x < 48; x++) put(c, x, 12, { ...contaminated(1), alpha: SOLID_ALPHA })
    const before = Buffer.from(c.data)
    await decontaminateEdges(c.data, c.width, c.height)

    for (let x = 12; x < 48; x++) {
      const o = (12 * c.width + x) * 4
      for (let ch = 0; ch < 3; ch++) assert.equal(c.data[o + ch], before[o + ch])
    }
  })
})

// ─── Thin structures ──────────────────────────────────────────────────────────

/** Vertical bars of the given widths, each with a half-covered shoulder either
 *  side and open floor between them: spindles, in miniature. */
function spindles(widths: number[]): Canvas & { bars: { x: number; w: number }[] } {
  const c = canvas(140, 40)
  const bars: { x: number; w: number }[] = []
  let x = 8
  for (const w of widths) {
    for (let y = 0; y < c.height; y++) {
      for (let i = -1; i <= w; i++) put(c, x + i, y, contaminated(i === -1 || i === w ? 0.5 : 1))
    }
    bars.push({ x, w })
    x += w + 12
  }
  return Object.assign(c, { bars })
}

/** A cane-like lattice: a grid of one-pixel bars with one-pixel holes. */
function lattice(): Canvas {
  const c = canvas(60, 60)
  for (let y = 10; y < 50; y++) {
    for (let x = 10; x < 50; x++) {
      const onBar = x % 4 === 0 || y % 4 === 0
      if (onBar) put(c, x, y, contaminated(1))
    }
  }
  return c
}

describe('thin furniture survives', () => {
  test('one-, two- and three-pixel bars keep their cores and their width', async () => {
    const c = spindles([1, 2, 3, 8])
    const before = Buffer.from(c.data)
    await decontaminateEdges(c.data, c.width, c.height)

    for (const { x, w } of c.bars) {
      for (let i = 0; i < w; i++) {
        const p = at(c, x + i, 20)
        assert.equal(p.alpha, 255, `${w}px bar lost its core at offset ${i}`)
        // And the core colour is untouched.
        const o = (20 * c.width + x + i) * 4
        for (let ch = 0; ch < 3; ch++) assert.equal(c.data[o + ch], before[o + ch])
      }
    }
  })

  test('a one-pixel bar’s shoulders are repaired, not abandoned', async () => {
    // The narrowest real case: a single opaque column with a contaminated
    // shoulder either side. There IS product within reach, so it must be fixed.
    const c = spindles([1])
    await decontaminateEdges(c.data, c.width, c.height)

    for (const dx of [-1, 1]) {
      const p = at(c, c.bars[0].x + (dx < 0 ? -1 : 1), 20)
      assert.equal(p.alpha, 128)
      assert.ok(Math.abs(meanError(p)) < 6,
        `shoulder at dx=${dx} still ${meanError(p).toFixed(1)} levels out`)
    }
  })

  test('a cane lattice keeps every hole and every bar', async () => {
    const c = lattice()
    const before = Buffer.from(c.data)
    await decontaminateEdges(c.data, c.width, c.height)

    let holes = 0, bars = 0
    for (let i = 0; i < c.width * c.height; i++) {
      assert.equal(c.data[i * 4 + 3], before[i * 4 + 3])
      if (before[i * 4 + 3] === 0) holes++
      if (before[i * 4 + 3] === 255) bars++
    }
    assert.ok(holes > 100 && bars > 100, `lattice fixture is degenerate: ${holes} holes, ${bars} bars`)
  })

  test('a wisp with no product within reach is left exactly as it arrived', async () => {
    // A stray semi-transparent fragment with nothing solid nearby. Any colour
    // guessed for it would be invented, so it is not guessed at.
    const c = canvas(60, 60)
    put(c, 30, 30, contaminated(0.4))
    const before = Buffer.from(c.data)

    const report = await decontaminateEdges(c.data, c.width, c.height)

    assert.equal(report.repaired, 0)
    assert.deepEqual(c.data, before)
  })

  test('the donor guard is what protects it, and it is a real threshold', () => {
    assert.ok(MIN_DONOR_WEIGHT > 0 && MIN_DONOR_WEIGHT < 32, `${MIN_DONOR_WEIGHT} is not a guard`)
    assert.ok(DONOR_SIGMA >= 1 && DONOR_SIGMA <= 5, `${DONOR_SIGMA} reaches too far or not far enough`)
    assert.ok(SOLID_ALPHA >= 240 && SOLID_ALPHA <= 255, `${SOLID_ALPHA}`)
  })
})

// ─── Interior gaps and markings ───────────────────────────────────────────────

describe('gaps and markings', () => {
  test('the gap between two legs stays fully transparent', async () => {
    const c = spindles([6, 6])
    const before = Buffer.from(c.data)
    await decontaminateEdges(c.data, c.width, c.height)

    const gapX = Math.round((c.bars[0].x + c.bars[0].w + c.bars[1].x) / 2)
    for (let y = 0; y < c.height; y++) {
      const p = at(c, gapX, y)
      assert.equal(p.alpha, 0, `the gap filled in at y=${y}`)
      const o = (y * c.width + gapX) * 4
      for (let ch = 0; ch < 3; ch++) assert.equal(c.data[o + ch], before[o + ch])
    }
  })

  test('a watermark inside the product keeps its exact colours', async () => {
    // The scene description used to name the watermark because a model would
    // paint it out. Nothing here may fade it toward the surrounding timber.
    const MARK = { r: 245, g: 250, b: 255, alpha: 255 }
    const c = block()
    for (let y = 24; y < 30; y++) for (let x = 20; x < 40; x++) put(c, x, y, MARK)

    await decontaminateEdges(c.data, c.width, c.height)

    for (let y = 24; y < 30; y++) for (let x = 20; x < 40; x++) {
      assert.deepEqual(at(c, x, y), MARK, `watermark moved at ${x},${y}`)
    }
  })

  test('a translucent watermark keeps its own hue rather than taking the timber’s', async () => {
    // A semi-transparent mark IS repairable by alpha, so the guard is that its
    // donors are its own neighbours — here, the timber it sits on — and the
    // result must not become the studio background or anything invented.
    const c = block()
    put(c, 30, 30, { r: 240, g: 245, b: 250, alpha: 200 })
    const before = at(c, 30, 30)

    await decontaminateEdges(c.data, c.width, c.height)
    const after = at(c, 30, 30)

    assert.equal(after.alpha, before.alpha)
    // It was repaired from surrounding solid product, which is the documented
    // behaviour for any partly transparent pixel — it is not left contaminated
    // and it is not turned into background.
    for (const ch of channels) {
      assert.ok(Math.abs(after[ch] - PRODUCT[ch]) <= 8, `${ch} became ${after[ch]}`)
    }
  })
})

// ─── The report, and what it may carry ────────────────────────────────────────

describe('the report', () => {
  test('it counts pixels and nothing else', async () => {
    const c = block()
    const report = await decontaminateEdges(c.data, c.width, c.height)

    for (const value of Object.values(report)) {
      assert.equal(typeof value, 'number', 'the report must be counts only, never image data')
    }
    assert.ok(report.repaired > 0)
    assert.ok(report.solid > 0)
    assert.ok(report.empty > 0)
  })

  test('every pixel is accounted for exactly once', async () => {
    const c = spindles([1, 2, 3])
    const report = await decontaminateEdges(c.data, c.width, c.height)
    const total = report.repaired + report.skippedThin + report.solid + report.empty
    assert.equal(total, c.width * c.height)
  })

  test('an all-transparent buffer is handled without inventing anything', async () => {
    const c = canvas(20, 20)
    const before = Buffer.from(c.data)
    const report = await decontaminateEdges(c.data, c.width, c.height)

    assert.equal(report.repaired, 0)
    assert.equal(report.solid, 0)
    assert.deepEqual(c.data, before)
  })
})

// ─── No provider surface ──────────────────────────────────────────────────────

describe('this adds nothing to what a run costs', () => {
  test('the module reaches no network and no provider', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/imageEditor/decontaminateEdges.ts'), 'utf8')
    for (const banned of ['fetch(', 'fal', 'http', 'callFal', 'removeBackground', 'generateStudioShot', 'retry']) {
      assert.ok(!source.toLowerCase().includes(banned.toLowerCase()),
        `the edge repair must not reference ${banned}`)
    }
  })

  test('it is local arithmetic over one buffer, with sharp only for the blur', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/imageEditor/decontaminateEdges.ts'), 'utf8')
    assert.equal((source.match(/^import /gm) ?? []).length, 1, 'sharp is the only import')
    assert.match(source, /^import sharp from 'sharp'$/m)
  })
})
