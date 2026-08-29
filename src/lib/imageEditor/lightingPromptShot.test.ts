/**
 * The lighting experiment: one prompt, one changed field, and everything else
 * held still.
 *
 * The value of a controlled experiment is entirely in what did NOT change. Most
 * of this file is therefore about the settings that must be identical to the
 * accepted run, and about the accepted pipeline being untouched — because a
 * lighting comparison that quietly also changed the placement or the upscale
 * would produce a verdict about nothing.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/lightingPromptShot.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  generateLightingShot, buildRequestBody, LIGHTING_SCENE_DESCRIPTION,
  MODEL_ID, FIXED_SETTINGS,
} from './lightingPromptShot'
import {
  buildRequestBody as buildAcceptedBody,
  FIXED_SETTINGS as ACCEPTED_SETTINGS,
  MODEL_ID as ACCEPTED_MODEL,
} from './briaProductShot'
import { upscaleImage, normaliseSquare, buildRequestBody as buildUpscaleBody } from './seedvrUpscale'
import { findProduct, planReframe, reframe } from './generatedProduct'
import {
  MASTER_SIDE, PRODUCT_HEIGHT_SHARE, SIDE_MARGIN_SHARE, ABOVE_SHARE_OF_LEFTOVER,
} from './studioMaster'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const KEY = 'test-key'
const PHOTO = Buffer.from('ORIGINAL-PHOTOGRAPH-BYTES')

type Captured = { url: string; init: RequestInit }
function stubFetch(respond: (n: number) => Response | Promise<Response>) {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(calls.length)
  }) as typeof globalThis.fetch
  return { calls }
}

const shotOk = () => new Response(JSON.stringify({
  images: [{ url: 'data:image/png;base64,U0hPVA==', content_type: 'image/png' }],
}), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-lit' } })

const run = () => generateLightingShot({ photograph: PHOTO, mimeType: 'image/jpeg', apiKey: KEY })
const body = (c: Captured[], i = 0) => JSON.parse(String(c[i].init.body))

// ═══ The one thing that changed ═══════════════════════════════════════════════

describe('the scene source', () => {
  test('scene_description is present, exactly once', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    const sent = body(calls)

    const keys = Object.keys(sent).filter(k => k === 'scene_description')
    assert.equal(keys.length, 1, 'exactly one scene_description key')
    assert.equal(sent.scene_description, LIGHTING_SCENE_DESCRIPTION)
    // And once in the serialised body too — nothing nested it a second time.
    assert.equal(String(calls[0].init.body).split('"scene_description"').length - 1, 1)
  })

  test('ref_image_url is ABSENT, not empty', async () => {
    // The schema is explicit: "Either ref_image_url or scene_description has to
    // be provided but not both." An empty string is still a second scene source.
    const { calls } = stubFetch(shotOk)
    await run()
    assert.equal('ref_image_url' in body(calls), false)
    assert.equal(String(calls[0].init.body).includes('ref_image_url'), false)
  })

  test('the accepted adapter is the mirror image, and still is', async () => {
    const accepted = buildAcceptedBody('data:image/jpeg;base64,AAA', 'data:image/png;base64,BBB')
    assert.equal('ref_image_url' in accepted, true)
    assert.equal('scene_description' in accepted, false)
  })
})

// ═══ Everything that did NOT change ═══════════════════════════════════════════

describe('every other setting is the accepted one', () => {
  test('the settings object is IMPORTED, not copied', () => {
    // Identity, not equality: a copy could drift and then the experiment would
    // be measuring two changes while reporting one.
    assert.equal(FIXED_SETTINGS, ACCEPTED_SETTINGS)
    assert.equal(MODEL_ID, ACCEPTED_MODEL)
  })

  test('optimize_description stays false, so the prompt is sent as written', async () => {
    // With it true Bria may rewrite the description, and the careful parts —
    // infer the light direction, keep the shadow off the wall, lift the blacks
    // by half a stop and no more — are what a rewrite would smooth away.
    const { calls } = stubFetch(shotOk)
    await run()
    assert.equal(body(calls).optimize_description, false)
  })

  test('the reviewed placement, size, count and speed are untouched', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    const sent = body(calls)
    assert.equal(sent.num_results, 1)
    assert.equal(sent.fast, true)
    assert.equal(sent.placement_type, 'manual_placement')
    assert.equal(sent.manual_placement_selection, 'bottom_center')
    assert.deepEqual(sent.shot_size, [1000, 1000])
  })

  test('the body differs from the accepted one in the scene source and NOTHING else', () => {
    const photo = 'data:image/jpeg;base64,AAA'
    const experimental = buildRequestBody(photo)
    const accepted = buildAcceptedBody(photo, 'data:image/png;base64,BBB')

    const differing = new Set<string>()
    for (const k of new Set([...Object.keys(experimental), ...Object.keys(accepted)])) {
      const a = (experimental as Record<string, unknown>)[k]
      const b = (accepted as Record<string, unknown>)[k]
      if (JSON.stringify(a) !== JSON.stringify(b)) differing.add(k)
    }
    assert.deepEqual([...differing].sort(), ['ref_image_url', 'scene_description'],
      'the ONLY difference may be which scene source is used')
  })

  test('the endpoint and the model are the same', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/bria/product-shot')
  })

  test('sync_mode is still not sent, so the run stays in fal history', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    assert.equal('sync_mode' in body(calls), false)
  })

  test('the whole key set is the accepted one, minus ref plus scene', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    assert.deepEqual(Object.keys(body(calls)).sort(), [
      'fast', 'image_url', 'manual_placement_selection', 'num_results',
      'optimize_description', 'placement_type', 'scene_description', 'shot_size',
    ])
  })
})

// ═══ The original photograph, not a cut-out ═══════════════════════════════════

describe('what is sent as the image', () => {
  test('the ORIGINAL upload goes out, byte for byte', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    const sent = String(body(calls).image_url)
    assert.match(sent, /^data:image\/jpeg;base64,/)
    assert.equal(Buffer.from(sent.split(',')[1], 'base64').toString(), PHOTO.toString())
  })

  test('nothing here can segment, mask or cut out', () => {
    const SOURCE = readFileSync(join(process.cwd(), 'src/lib/imageEditor/lightingPromptShot.ts'), 'utf8')
    for (const banned of ['background/remove', 'removeBackground', 'prepareCutout', 'alpha', 'ensureAlpha']) {
      assert.ok(!SOURCE.includes(banned), `${banned} must not appear`)
    }
  })
})

// ═══ The prompt itself ════════════════════════════════════════════════════════

describe('the prompt', () => {
  test('it is six paragraphs, joined by blank lines', () => {
    const paras = LIGHTING_SCENE_DESCRIPTION.split('\n\n')
    assert.equal(paras.length, 6)
    for (const p of paras) {
      assert.equal(p.trim(), p, 'no leading or trailing whitespace on a paragraph')
      assert.ok(!p.includes('\n'), 'a paragraph must not be hard-wrapped')
    }
  })

  test('preservation comes FIRST, before any lighting instruction', () => {
    // A model asked to relight will otherwise relight by repainting.
    const preserve = LIGHTING_SCENE_DESCRIPTION.indexOf('Preserve the complete furniture product exactly')
    const light = LIGHTING_SCENE_DESCRIPTION.indexOf('key light')
    assert.ok(preserve > -1 && preserve < light, 'the preservation clause must precede the lighting ones')
  })

  test('it forbids redrawing the product', () => {
    assert.match(LIGHTING_SCENE_DESCRIPTION,
      /Do not rotate, reshape, redesign, replace, remove, add or merge any product part\./)
  })

  test('it never permits relighting BY repainting', () => {
    // The failure this experiment must not buy: "make it brighter" answered
    // with a new chair.
    for (const permission of ['redraw', 'reimagine', 'restyle', 'recreate', 'improve the product', 'enhance the product']) {
      assert.ok(!LIGHTING_SCENE_DESCRIPTION.toLowerCase().includes(permission),
        `"${permission}" would give permission to repaint`)
    }
  })

  test('the shadow direction is INFERRED, never dictated', () => {
    // Dictating a direction would fight every photograph lit from the other
    // side, which is how a shadow ends up pointing at the light.
    assert.match(LIGHTING_SCENE_DESCRIPTION, /Infer the dominant illumination direction/)
    assert.match(LIGHTING_SCENE_DESCRIPTION, /Never cast a shadow toward the dominant light source\./)
  })

  test('the fill light is bounded by a quantity, not an adjective', () => {
    assert.match(LIGHTING_SCENE_DESCRIPTION, /half to three-quarters of a photographic stop/)
    assert.match(LIGHTING_SCENE_DESCRIPTION, /Do not make the product flat, washed out, grey, glossy, plastic or artificially bright\./)
  })

  test('it addresses all three observed defects', () => {
    assert.match(LIGHTING_SCENE_DESCRIPTION, /must not appear pressed against a wall/)        // distance
    assert.match(LIGHTING_SCENE_DESCRIPTION, /Keep the cast shadow primarily on the floor, not on the rear background\./)
    assert.match(LIGHTING_SCENE_DESCRIPTION, /remain clearly readable/)                        // fill
  })

  test('it is exactly 2382 characters', () => {
    // Pinned so an invisible edit — a smart quote, a double space, a stray
    // newline — cannot silently change what a live result is attributed to.
    assert.equal(LIGHTING_SCENE_DESCRIPTION.length, 2382)
    assert.equal(
      createHash('sha256').update(LIGHTING_SCENE_DESCRIPTION, 'utf8').digest('hex'),
      createHash('sha256').update(LIGHTING_SCENE_DESCRIPTION, 'utf8').digest('hex'),
    )
  })

  test('it contains no smart quotes or non-breaking spaces', () => {
    assert.ok(!/[‘’“” –—]/.test(LIGHTING_SCENE_DESCRIPTION),
      'the prompt must be plain ASCII punctuation')
  })
})

// ═══ Cost ═════════════════════════════════════════════════════════════════════

describe('cost', () => {
  test('exactly one request, whatever comes back', async () => {
    for (const respond of [shotOk, () => new Response('x', { status: 500 })]) {
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

  test('a rate limit is not retried either', async () => {
    let n = 0
    stubFetch(() => { n++; return new Response('slow down', { status: 429 }) })
    await run()
    assert.equal(n, 1)
  })

  test('an oversized photograph is refused before it is sent', async () => {
    const { calls } = stubFetch(shotOk)
    const result = await generateLightingShot({
      photograph: Buffer.alloc(13 * 1024 * 1024), mimeType: 'image/jpeg', apiKey: KEY,
    })
    assert.equal(calls.length, 0, 'nothing may be billed for an image fal would reject')
    assert.equal(result.ok, false)
  })

  test('the key travels in a header only', async () => {
    const { calls } = stubFetch(shotOk)
    await run()
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Key ${KEY}`)
    assert.ok(!calls[0].url.includes(KEY))
  })

  test('no failure message names the provider or the model', async () => {
    stubFetch(() => new Response('upstream detail', { status: 500 }))
    const result = await run()
    assert.equal(result.ok, false)
    if (result.ok) return
    for (const w of ['fal', 'bria', 'http', 'upstream detail']) {
      assert.ok(!result.message.toLowerCase().includes(w), result.message)
    }
  })
})

// ═══ The whole experimental pipeline ══════════════════════════════════════════
//
// The smoke script's path, run here so the two-request count and the delivered
// size are proved rather than asserted about the source.

describe('the experimental pipeline end to end', () => {
  /**
   * A chair on a plain sweep, so the stages have something real to find.
   *
   * `share` is how much of the frame height the product fills. The default
   * matches the live Irvine run — Product Shot placed the chair at 33.5%, which
   * is what leaves the reframe room to crop up to 53%. A product that already
   * fills the frame cannot be reframed and the crop clamps instead, which would
   * be testing the clamp rather than the reframe.
   */
  async function chair(size: number, share = 0.335): Promise<Buffer> {
    const d = Buffer.alloc(size * size * 3)
    const height0 = Math.round(size * share)
    const s = height0 / 540
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3
      const t = 148 + (214 - 148) * (y / size)
      d[i] = t + 4; d[i + 1] = t; d[i + 2] = t - 6
    }
    const ink = (l: number, tp: number, w: number, h: number, v = 80) => {
      for (let y = tp; y < tp + h; y++) for (let x = l; x < l + w; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const i = (y * size + x) * 3
        d[i] = v + 20; d[i + 1] = v; d[i + 2] = v - 15
      }
    }
    const height = Math.round(540 * s)
    const width = Math.round(380 * s)
    const left = Math.round((size - width) / 2)
    const top = Math.round((size - height) * 0.45)
    ink(left, top, width, Math.round(height * 0.36))
    ink(left, top + Math.round(height * 0.40), width, Math.round(height * 0.06))
    const fanTop = top + Math.round(height * 0.46)
    for (let i = 0; i < 16; i++) {
      ink(left + Math.round((i + 0.5) * width / 16) - 1, fanTop, Math.max(2, 3 * s | 0), Math.round(height * 0.42))
    }
    ink(left, top + height - Math.round(height * 0.04), width, Math.round(height * 0.04))
    return sharp(d, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
  }

  async function pipeline(upscaleSide: number) {
    const shotImage = await chair(1024)
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url))
      const sent = JSON.parse(String(init?.body ?? '{}'))
      if (String(url).includes('product-shot')) {
        return new Response(JSON.stringify({
          images: [{ url: `data:image/png;base64,${shotImage.toString('base64')}`, content_type: 'image/png' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'shot' } })
      }
      const src = Buffer.from(String(sent.image_url).split(',')[1], 'base64')
      const up = await sharp(src).resize(upscaleSide, upscaleSide, { kernel: 'lanczos3' }).png().toBuffer()
      return new Response(JSON.stringify({
        image: { url: `data:image/png;base64,${up.toString('base64')}`, content_type: 'image/png' }, seed: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'up' } })
    }) as typeof globalThis.fetch

    const shot = await generateLightingShot({
      photograph: await chair(900), mimeType: 'image/png', apiKey: KEY,
    })
    assert.equal(shot.ok, true)
    if (!shot.ok) throw new Error('shot failed')

    const found = await findProduct(shot.image)
    assert.ok(found)
    const meta = await sharp(shot.image).metadata()
    const plan = planReframe(found!.bounds, { width: meta.width!, height: meta.height! }, {
      heightShare: PRODUCT_HEIGHT_SHARE,
      aboveSplit: ABOVE_SHARE_OF_LEFTOVER,
      maxWidthShare: 1 - 2 * SIDE_MARGIN_SHARE,
    })
    const reframed = await reframe(shot.image, plan)
    const up = await upscaleImage({
      image: reframed, mimeType: 'image/png',
      sourceSide: plan.crop.size, targetSide: MASTER_SIDE, apiKey: KEY,
    })
    assert.equal(up.ok, true)
    if (!up.ok) throw new Error('upscale failed')

    const normalised = await normaliseSquare(up.image, MASTER_SIDE)
    assert.equal(normalised.ok, true)
    return { calls, normalised, plan }
  }

  test('exactly two provider requests, in order', async () => {
    const { calls } = await pipeline(1456)
    assert.equal(calls.length, 2)
    assert.ok(calls[0].includes('bria/product-shot'))
    assert.ok(calls[1].includes('seedvr/upscale/image'))
  })

  test('the delivered image is exactly 1440 x 1440', async () => {
    // The upscaler is made to return 1456, exactly as the live Irvine run did,
    // so this proves the local normalisation rather than a lucky factor.
    for (const side of [1456, 1440, 1439]) {
      const { normalised } = await pipeline(side)
      if (!normalised.ok) throw new Error('normalise failed')
      const meta = await sharp(normalised.image).metadata()
      assert.equal(meta.width, 1440, `returned ${side}`)
      assert.equal(meta.height, 1440, `returned ${side}`)
      assert.deepEqual(normalised.returned, { width: side, height: side })
    }
  })

  test('the reframe still targets about 53%', async () => {
    const { plan } = await pipeline(1456)
    assert.ok(Math.abs(plan.productHeightShare - 0.53) < 0.02,
      `share was ${plan.productHeightShare}`)
  })

  test('the SeedVR2 body is the reviewed one', async () => {
    const built = buildUpscaleBody('data:image/png;base64,AAA', 1.41)
    assert.equal(built.noise_scale, 0)
    assert.equal(built.output_format, 'png')
    assert.equal(built.upscale_mode, 'factor')
    assert.equal('sync_mode' in built, false)
  })
})

// ═══ The accepted pipeline is untouched ═══════════════════════════════════════

describe('the reference-driven pipeline is byte-for-byte unchanged', () => {
  /**
   * Pinned hashes of the three files this experiment must not disturb, taken at
   * HEAD 8888e59 — the reviewed and accepted state.
   *
   * DELETE THIS TEST when the experiment is either adopted or abandoned. It is
   * a scaffold for one comparison, not a permanent rule: the point is that a
   * verdict on lighting must not be contaminated by an unnoticed edit to the
   * route, the accepted adapter, or the upscaler.
   */
  const PINNED: Record<string, string> = {
    'src/app/api/image-editor/studio/route.ts':
      'd1a657314ed7aaad05cee16e1acf6dcfb06243a4cae491533f23a5a2ff6bb36e',
    'src/lib/imageEditor/briaProductShot.ts':
      'e2872123456d7044423c1d67189ced69c4f55d4612ee48dc0fdba5f278874d7d',
    'src/lib/imageEditor/seedvrUpscale.ts':
      '23535f3a0190dabd2113aa1baaecad79d1505edc0d50be578a5db2b9afcfedc6',
  }

  for (const [path, expected] of Object.entries(PINNED)) {
    test(`${path} is unchanged`, () => {
      const actual = createHash('sha256')
        .update(readFileSync(join(process.cwd(), path))).digest('hex')
      assert.equal(actual, expected,
        `${path} changed. This experiment must not touch the accepted pipeline.`)
    })
  }

  test('the route does not import the experiment', () => {
    const ROUTE = readFileSync(
      join(process.cwd(), 'src/app/api/image-editor/studio/route.ts'), 'utf8')
    assert.ok(!ROUTE.includes('lightingPromptShot'))
    assert.ok(!ROUTE.includes('scene_description'))
    assert.ok(!ROUTE.includes('LIGHTING_SCENE_DESCRIPTION'))
  })
})

// ═══ The prompt stays on the server ═══════════════════════════════════════════

describe('the prompt is server-only', () => {
  test('nothing under src/app/image-editor imports it', () => {
    for (const f of ['page.tsx', 'ResultCard.tsx', 'QueueList.tsx']) {
      const SOURCE = readFileSync(join(process.cwd(), 'src/app/image-editor', f), 'utf8')
      assert.ok(!SOURCE.includes('lightingPromptShot'), `${f} imports the experiment`)
      assert.ok(!SOURCE.includes('scene_description'), `${f} mentions scene_description`)
      // A phrase that could only have come from the prompt. "catalogue
      // photograph" alone appears in the page's own comments, describing what
      // an employee is doing — which is not a leak.
      assert.ok(!SOURCE.includes('seamless studio cyclorama'), `${f} carries prompt text`)
      assert.ok(!SOURCE.includes('photographic stop'), `${f} carries prompt text`)
    }
  })

  test("it is not a 'use client' module, and imports server-only code", () => {
    const SOURCE = readFileSync(join(process.cwd(), 'src/lib/imageEditor/lightingPromptShot.ts'), 'utf8')
    assert.ok(!SOURCE.includes("'use client'"))
    assert.ok(SOURCE.includes("from './falRequest'"), 'it sits behind the server-only transport')
  })

  test('no client-safe module re-exports the prompt', () => {
    for (const f of ['verification.ts', 'queue.ts', 'downloadFormats.ts', 'validation.ts']) {
      const SOURCE = readFileSync(join(process.cwd(), 'src/lib/imageEditor', f), 'utf8')
      assert.ok(!SOURCE.includes('lightingPromptShot'), `${f} pulls the prompt client-side`)
    }
  })
})

// ═══ The smoke script's two modes ═════════════════════════════════════════════

describe('the smoke script', () => {
  const SCRIPT = readFileSync(join(process.cwd(), 'scripts/image-editor-smoke.mjs'), 'utf8')

  test('the experiment is behind a flag, and the default is the accepted path', () => {
    assert.ok(SCRIPT.includes("const LIGHTING_FLAG = '--lighting-prompt-test'"))
    assert.ok(SCRIPT.includes('argv.includes(LIGHTING_FLAG)'))
    // Without the flag, stage one is the accepted adapter.
    assert.match(SCRIPT, /lightingMode\s*\?\s*await generateLightingShot\([^)]*\)\s*:\s*await generateProductShot\(/)
  })

  test('only stage one differs between the modes', () => {
    // The reframe, the upscale, the gate and the normalisation are shared, so a
    // difference in the output is a difference in the request.
    for (const shared of ['upscaleImage(', 'normaliseSquare(', 'planReframe(', 'reframe(shot.image']) {
      assert.equal(SCRIPT.split(shared).length - 1, 1, `${shared} must exist once, shared by both modes`)
    }
    // The gate runs twice, once per stage — but the same twice in both modes.
    assert.equal(SCRIPT.split('comparePreservation(').length - 1, 2)
    // The mode is decided once and never reassigned, so no branch can flip it.
    assert.equal(SCRIPT.split('const lightingMode =').length - 1, 1)
    assert.ok(!/(?<!const )lightingMode\s*=[^=]/.test(SCRIPT), 'lightingMode must never be reassigned')
  })

  test('the reference is required for the accepted mode and not for the experiment', () => {
    // The experiment sends no reference, so demanding one would refuse a run
    // that costs nothing to make correctly.
    const guard = SCRIPT.slice(SCRIPT.indexOf('if (lightingMode) {'), SCRIPT.indexOf('mkdirSync(dirname(out)'))
    assert.ok(guard.includes('loadStudioReference(referenceRoot)'),
      'the accepted branch must still load and check a reference')
    const experimentBranch = guard.slice(0, guard.indexOf('} else {'))
    assert.ok(!experimentBranch.includes('loadStudioReference'))
  })

  test('it never prints the key, a data URI or the prompt', () => {
    assert.ok(!SCRIPT.includes('console.log(apiKey'), 'the key must never be printed')
    assert.ok(!/console\.log\([^)]*LIGHTING_SCENE_DESCRIPTION[^)]*\)/.test(
      SCRIPT.replace(/LIGHTING_SCENE_DESCRIPTION\.length/g, 'LEN')
            .replace(/LIGHTING_SCENE_DESCRIPTION\.split/g, 'SPLIT')),
      'the prompt text itself must never be printed')
    for (const leak of ['dataUrl)', 'image_url)', '.toString(\'base64\')']) {
      assert.ok(!SCRIPT.includes(`console.log(${leak}`), leak)
    }
  })

  test('it writes the four lighting regions, at 100% and 4x', () => {
    for (const region of [
      'region-underseat', 'region-darkest', 'region-floor-shadow', 'region-upper-background',
    ]) {
      assert.ok(SCRIPT.includes(`'${region}'`), `${region} must be written`)
    }
    assert.match(SCRIPT, /width \* 4, height \* 4, \{ kernel: 'nearest' \}/)
  })

  test('it prints request ids, timings, dimensions and the height share', () => {
    assert.ok(SCRIPT.includes('shot.requestId'))
    assert.ok(SCRIPT.includes('upscaled.requestId'))
    assert.ok(SCRIPT.includes('shot.durationMs'))
    assert.ok(SCRIPT.includes('upscaled.durationMs'))
    assert.ok(SCRIPT.includes('normalised.returned.width'))
    assert.ok(SCRIPT.includes('normalised.delivered.width'))
    assert.ok(SCRIPT.includes('product height share'))
  })
})
