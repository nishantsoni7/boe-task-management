/**
 * The upscale request, and the settings that keep it a resampler rather than a
 * restorer.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/seedvrUpscale.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  upscaleImage, buildRequestBody, upscaleFactorFor, normaliseSquare,
  MODEL_ID, NOISE_SCALE, MAX_UPSCALE_FACTOR,
} from './seedvrUpscale'
import { MASTER_WIDTH } from './studioMaster'

/** The delivered master is square, and this is its side. */
const MASTER_SIDE = MASTER_WIDTH

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const KEY = 'test-key'
const IMG = Buffer.from('REFRAMED-PNG')

type Captured = { url: string; init: RequestInit }
function stubFetch(respond: (n: number) => Response) {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(calls.length)
  }) as typeof globalThis.fetch
  return { calls }
}

const ok = () => new Response(JSON.stringify({
  image: { url: 'data:image/png;base64,VVA=', content_type: 'image/png' }, seed: 7,
}), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-up' } })

const run = (sourceSide = 1000, targetSide = 1440) =>
  upscaleImage({ image: IMG, mimeType: 'image/png', sourceSide, targetSide, apiKey: KEY })
const body = (c: Captured[], i = 0) => JSON.parse(String(c[i].init.body))

describe('the endpoint and contract', () => {
  test('it is the official SeedVR image upscaler', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.equal(MODEL_ID, 'fal-ai/seedvr/upscale/image')
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/seedvr/upscale/image')
  })

  test('the output comes back as ONE image, matching the schema', async () => {
    stubFetch(ok)
    const result = await run()
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.image.toString(), 'UP')
  })
})

describe('the settings that protect the product', () => {
  test('noise_scale is the least the contract allows', async () => {
    // The default is 0.1. This is the one knob governing how much the model
    // invents, and the brief asks for resolution, not restoration.
    const { calls } = stubFetch(ok)
    await run()
    assert.equal(body(calls).noise_scale, 0)
    assert.equal(NOISE_SCALE, 0)
  })

  test('png is asked for explicitly — the default is jpg', async () => {
    // A catalogue master is not delivered with jpeg artefacts in the grain.
    const { calls } = stubFetch(ok)
    await run()
    assert.equal(body(calls).output_format, 'png')
  })

  test('a factor is sent, not a target resolution', async () => {
    // "1440p" conventionally means a 1440-pixel HEIGHT on a 16:9 frame and the
    // contract does not say what it does to a square. A factor is arithmetic
    // we control.
    const { calls } = stubFetch(ok)
    await run()
    assert.equal(body(calls).upscale_mode, 'factor')
    assert.equal('target_resolution' in body(calls), false)
  })

  test('the body carries these keys and no others', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.deepEqual(Object.keys(body(calls)).sort(), [
      'image_url', 'noise_scale', 'output_format', 'upscale_factor', 'upscale_mode',
    ])
  })

  test('sync_mode is not sent, so the run stays in fal history', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.equal('sync_mode' in body(calls), false)
  })
})

describe('the factor', () => {
  test('it is the smallest that reaches the target', async () => {
    assert.ok(Math.abs(upscaleFactorFor(1000, 1440) - 1.44) < 0.005)
    assert.ok(Math.abs(upscaleFactorFor(720, 1440) - 2.0) < 0.005)
    assert.ok(Math.abs(upscaleFactorFor(1200, 1440) - 1.2) < 0.005)
  })

  test('it always reaches the target, never falls a pixel short', () => {
    for (const side of [400, 617, 720, 913, 1000, 1103, 1439]) {
      const f = upscaleFactorFor(side, 1440)
      assert.ok(side * f >= 1440, `${side} x ${f} = ${side * f}, short of 1440`)
    }
  })

  test('an image already at the target still asks for 1, never below', () => {
    assert.equal(upscaleFactorFor(1440, 1440), 1)
    assert.equal(upscaleFactorFor(2000, 1440), 1)
  })

  test('a pathological input cannot ask for a runaway factor', () => {
    assert.equal(upscaleFactorFor(10, 1440), MAX_UPSCALE_FACTOR)
    assert.equal(upscaleFactorFor(0, 1440), 1)
  })

  test('the factor used is reported back', async () => {
    stubFetch(ok)
    const result = await run(1000, 1440)
    assert.equal(result.ok, true)
    if (result.ok) assert.ok(Math.abs(result.factor - 1.44) < 0.005)
  })
})

describe('cost', () => {
  test('exactly one request, whatever comes back', async () => {
    for (const respond of [ok, () => new Response('x', { status: 500 })]) {
      const { calls } = stubFetch(respond)
      await run()
      assert.equal(calls.length, 1)
    }
  })

  test('a timeout is not retried', async () => {
    let n = 0
    globalThis.fetch = (async () => {
      n++; const e = new Error('t'); e.name = 'TimeoutError'; throw e
    }) as typeof globalThis.fetch
    const result = await run()
    assert.equal(n, 1)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'timeout')
  })

  test('the key travels in a header only', async () => {
    const { calls } = stubFetch(ok)
    await run()
    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Key ${KEY}`)
    assert.ok(!calls[0].url.includes(KEY))
  })

  test('no failure message names the provider or the model', async () => {
    stubFetch(() => new Response('detail', { status: 500 }))
    const result = await run()
    assert.equal(result.ok, false)
    if (result.ok) return
    for (const w of ['fal', 'seedvr', 'http']) {
      assert.ok(!result.message.toLowerCase().includes(w), result.message)
    }
  })
})

describe('the body builder', () => {
  test('it builds what the adapter sends', () => {
    const built = buildRequestBody('data:image/png;base64,AAA', 1.44)
    assert.equal(built.image_url, 'data:image/png;base64,AAA')
    assert.equal(built.upscale_factor, 1.44)
    assert.equal(built.upscale_mode, 'factor')
    assert.equal(built.output_format, 'png')
    assert.equal(built.noise_scale, 0)
    assert.equal('sync_mode' in built, false)
    assert.equal('target_resolution' in built, false)
  })
})

// ─── Delivering exactly 1440 x 1440 ───────────────────────────────────────────
//
// `upscale_factor: 1.44` on a 1000px square SHOULD give 1440. Nothing in the
// contract promises the model rounds the way we would, and the factor's
// accepted range is undocumented besides, so what comes back is inspected.

const square = (side: number) => sharp({
  create: { width: side, height: side, channels: 3, background: { r: 200, g: 190, b: 180 } },
}).png().toBuffer()

const rect = (w: number, h: number) => sharp({
  create: { width: w, height: h, channels: 3, background: { r: 200, g: 190, b: 180 } },
}).png().toBuffer()

describe('normalising to the master size', () => {
  test('an unexpected square size is still delivered at exactly 1440 x 1440', async () => {
    // The point of the whole function: the model may hand back 1439, 1441 or
    // something else entirely, and the employee still gets the master size.
    for (const side of [1439, 1441, 1408, 2000, 1000]) {
      const result = await normaliseSquare(await square(side), MASTER_SIDE)
      assert.equal(result.ok, true, `${side} was refused`)
      if (!result.ok) continue

      const meta = await sharp(result.image).metadata()
      assert.equal(meta.width, 1440, `${side} delivered ${meta.width}px wide`)
      assert.equal(meta.height, 1440, `${side} delivered ${meta.height}px tall`)
      assert.deepEqual(result.returned, { width: side, height: side })
      assert.deepEqual(result.delivered, { width: 1440, height: 1440 })
      assert.equal(result.resized, true)
    }
  })

  test('an exact result is passed through, not resampled again', async () => {
    const result = await normaliseSquare(await square(1440), MASTER_SIDE)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.resized, false)
    assert.deepEqual(result.returned, { width: 1440, height: 1440 })
    const meta = await sharp(result.image).metadata()
    assert.equal(meta.width, 1440)
    assert.equal(meta.height, 1440)
  })

  test('whatever comes back, the delivered bytes are PNG', async () => {
    const jpg = await sharp({
      create: { width: 1500, height: 1500, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer()
    for (const input of [jpg, await square(1440)]) {
      const result = await normaliseSquare(input, MASTER_SIDE)
      assert.equal(result.ok, true)
      if (!result.ok) continue
      assert.equal((await sharp(result.image).metadata()).format, 'png')
    }
  })

  test('a non-square result is REFUSED, never squeezed into shape', async () => {
    // Squeezing 1440x1200 into a square would change the product's proportions,
    // which is the one thing this pipeline exists to avoid.
    const result = await normaliseSquare(await rect(1440, 1200), MASTER_SIDE)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.returned, { width: 1440, height: 1200 })
    assert.match(result.error, /wrong shape/i)
  })

  test('nothing is cropped on the way to the master size', async () => {
    // A mark in each corner of an off-size square must survive to the master.
    const side = 1500
    const dot = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer()
    const canvas = await sharp({
      create: { width: side, height: side, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        { input: dot, left: 0, top: 0 },
        { input: dot, left: side - 40, top: 0 },
        { input: dot, left: 0, top: side - 40 },
        { input: dot, left: side - 40, top: side - 40 },
      ])
      .png().toBuffer()

    const result = await normaliseSquare(canvas, MASTER_SIDE)
    assert.equal(result.ok, true)
    if (!result.ok) return

    const { data, info } = await sharp(result.image).raw().toBuffer({ resolveWithObject: true })
    const red = (x: number, y: number) => data[(y * info.width + x) * info.channels]
    const green = (x: number, y: number) => data[(y * info.width + x) * info.channels + 1]
    for (const [x, y] of [[2, 2], [1437, 2], [2, 1437], [1437, 1437]]) {
      assert.ok(red(x, y) > 200 && green(x, y) < 80, `corner ${x},${y} lost its mark`)
    }
  })

  test('unreadable bytes fail with a message, never a throw', async () => {
    const result = await normaliseSquare(Buffer.from('NOT-AN-IMAGE'), MASTER_SIDE)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /could not be read/i)
  })

  test('no failure message names the provider or the model', async () => {
    const failures = [
      await normaliseSquare(await rect(1440, 1200), MASTER_SIDE),
      await normaliseSquare(Buffer.from('x'), MASTER_SIDE),
    ]
    for (const f of failures) {
      assert.equal(f.ok, false)
      if (f.ok) continue
      for (const w of ['fal', 'seedvr', 'sharp']) {
        assert.ok(!f.error.toLowerCase().includes(w), f.error)
      }
    }
  })
})
