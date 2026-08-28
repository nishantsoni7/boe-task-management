/**
 * The studio request: exactly what goes out, and what must never be in it.
 *
 * `fetch` is stubbed, so nothing reaches fal and no key is needed. What this
 * checks is what no finished image can show:
 *
 *   * the request carries the approved REFERENCE IMAGE and no scene
 *     description — the schema documents the two as mutually exclusive, so
 *     sending both leaves it undefined which one fal honoured;
 *   * `sync_mode` is not sent, so the run stays visible in fal's history;
 *   * the size is padding, not words — the prompt no longer asks for a
 *     percentage, because asking was tried twice and did not work;
 *   * one request, never retried, including after a timeout;
 *   * the key travels in a header and appears nowhere else;
 *   * a missing reference costs nothing, because it is checked BEFORE the
 *     request rather than after it.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/briaProductShot.test.ts
 */

import { test, describe, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateStudioShot, buildRequestBody, isNoRetry, MODEL_ID, FIXED_SETTINGS,
} from './briaProductShot'
import { REFERENCE_PATH, resetReferenceCache } from './studioReference'
import { planPadding } from './studioMaster'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; resetReferenceCache() })

const KEY = 'test-key-not-a-real-one'
const CUTOUT = Buffer.from('PNG-CUTOUT-BYTES')
const PLAN = planPadding({ width: 900, height: 1200 })
const RESULT_DATA_URL = 'data:image/png;base64,U1RVRElP'

/** A repository root carrying an approved reference, so the adapter can run. */
let root: string
before(() => {
  root = mkdtempSync(join(tmpdir(), 'boe-studio-ref-'))
  mkdirSync(join(root, 'assets', 'image-editor'), { recursive: true })
  writeFileSync(join(root, REFERENCE_PATH), Buffer.from('REFERENCE-PNG-BYTES'))
})

type Captured = { url: string; init: RequestInit }

function stubFetch(respond: (call: number) => Response): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(calls.length)
  }) as typeof globalThis.fetch
  return { calls }
}

const okResponse = (images: unknown = [{ url: RESULT_DATA_URL, content_type: 'image/png' }]) =>
  new Response(JSON.stringify({ images }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-studio-1' },
  })

const run = () => generateStudioShot({ cutoutPng: CUTOUT, plan: PLAN, apiKey: KEY, referenceRoot: root })
const body = (calls: Captured[], i = 0) => JSON.parse(String(calls[i].init.body))

describe('the endpoint', () => {
  test('is Bria Product Shot, and the request goes there', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await run()

    assert.equal(result.ok, true)
    assert.equal(MODEL_ID, 'fal-ai/bria/product-shot')
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/bria/product-shot')
  })

  test('the finished image comes back as bytes, never as a URL', async () => {
    stubFetch(() => okResponse())
    const result = await run()
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(Buffer.isBuffer(result.image))
    assert.equal(result.image.toString(), 'STUDIO')
  })

  test('the output is read as an ARRAY, which is what this endpoint returns', async () => {
    // background/remove answers `{ image }` and product-shot answers
    // `{ images: [...] }`. Reading the wrong one is an empty result on a
    // request that was already paid for.
    stubFetch(() => new Response(JSON.stringify({ image: { url: RESULT_DATA_URL } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const single = await run()
    // The shared transport accepts either shape, so this still succeeds — the
    // point is that the array form is the documented one and it works.
    assert.equal(single.ok, true)

    stubFetch(() => okResponse())
    assert.equal((await run()).ok, true)
  })
})

describe('how the result comes back', () => {
  test('a hosted fal URL is downloaded server-side, not handed to the browser', async () => {
    // This is the NORMAL path now: without sync_mode fal answers with a URL.
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          images: [{ url: 'https://v3b.fal.media/files/b/abc/master.png', content_type: 'image/png' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-2' } })
      }
      return new Response(Buffer.from('MASTERBYTES'), {
        status: 200, headers: { 'Content-Type': 'image/png' },
      })
    }) as typeof globalThis.fetch

    const result = await run()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.image.toString(), 'MASTERBYTES')
    assert.equal(calls[1], 'https://v3b.fal.media/files/b/abc/master.png')
    // The download is not a second BILLABLE request — it is fetching a result
    // that has already been paid for.
    assert.equal(calls.filter(u => u.startsWith('https://fal.run/')).length, 1)
  })

  test('a result hosted anywhere but fal is refused, not downloaded', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        images: [{ url: 'https://evil.example.com/master.png', content_type: 'image/png' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch

    const result = await run()
    assert.equal(result.ok, false)
    assert.equal(calls.length, 1, 'nothing off a fal host may be fetched')
  })
})

describe('no scene description, anywhere', () => {
  test('the request carries the reference image and no description', async () => {
    // The schema: "Either ref_image_url or scene_description has to be provided
    // but not both." Sending both leaves it undefined which one fal honoured,
    // which means the approved look could change without anything here changing.
    const { calls } = stubFetch(() => okResponse())
    await run()
    const sent = body(calls)

    assert.equal('scene_description' in sent, false)
    assert.ok(typeof sent.ref_image_url === 'string' && sent.ref_image_url.length > 0)
  })

  test('the module exports no prompt constant at all', async () => {
    // Not merely unsent — gone. A constant left behind is one somebody re-adds
    // to the body later, and the two rejected results came from asking in words.
    const adapter = await import('./briaProductShot') as Record<string, unknown>
    for (const name of Object.keys(adapter)) {
      assert.ok(!/SCENE|DESCRIPTION|PROMPT/i.test(name), `${name} must not exist`)
    }
  })

  test('no scene wording survives in the source of the runtime path', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/imageEditor/briaProductShot.ts'), 'utf8')
    // Comments explain the decision and quote the schema, so the check is on
    // CODE: no string literal describing a scene, and none of the accidental
    // "on a rock, next to the ocean, dark theme" prefix that was in the
    // accepted request.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const phrase of [
      'rock', 'ocean', 'dark theme', 'catalogue studio photograph',
      'warm neutral', 'contact shadows', 'diffused studio light',
    ]) {
      assert.ok(!code.toLowerCase().includes(phrase.toLowerCase()),
        `"${phrase}" must not survive in code`)
    }
  })
})

describe('the fixed settings', () => {
  test('every one is exactly what was accepted', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    const sent = body(calls)

    assert.equal(sent.optimize_description, false)
    assert.equal(sent.num_results, 1)
    assert.equal(sent.fast, true)
    assert.equal(FIXED_SETTINGS.num_results, 1)
    assert.equal(FIXED_SETTINGS.optimize_description, false)
    assert.equal(FIXED_SETTINGS.fast, true)
  })

  test('sync_mode is not sent, so the run stays in fal’s history', async () => {
    // With sync_mode true fal returns the image inline and "the output data
    // won't be available in the request history" — which is the record needed
    // to audit what a run cost and to look at what came back.
    const { calls } = stubFetch(() => okResponse())
    await run()

    assert.equal('sync_mode' in body(calls), false)
    assert.equal('sync_mode' in FIXED_SETTINGS, false)
  })

  test('num_results is one, because Bria bills per result', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    assert.equal(body(calls).num_results, 1)
    assert.notEqual(body(calls).placement_type, 'automatic')
  })

  test('the placement mode is manual_padding', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    assert.equal(body(calls).placement_type, 'manual_padding')
  })

  test('shot_size is NOT sent, because this mode ignores it', async () => {
    // From the schema: shot_size is "only relevant when placement_type=automatic
    // or placement_type=manual_placement". Under manual_padding the canvas is
    // the cut-out plus its padding, so sending a size would be misleading noise.
    const { calls } = stubFetch(() => okResponse())
    await run()
    assert.equal('shot_size' in body(calls), false)
  })

  test('fields belonging to other placement modes are not sent', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    const sent = body(calls)
    for (const field of ['manual_placement_selection', 'original_quality']) {
      assert.equal(field in sent, false, `${field} belongs to a different mode`)
    }
  })

  test('the body carries these fields and no others', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    assert.deepEqual(Object.keys(body(calls)).sort(), [
      'fast', 'image_url', 'num_results', 'optimize_description',
      'padding_values', 'placement_type', 'ref_image_url',
    ])
  })
})

describe('the approved reference', () => {
  test('it is sent, and as inline data rather than a fal.media URL', async () => {
    // The accepted request pointed at a temporary fal.media file. When that
    // expires, results silently stop matching the approved look.
    const { calls } = stubFetch(() => okResponse())
    await run()
    const sent = body(calls)

    assert.ok(typeof sent.ref_image_url === 'string' && sent.ref_image_url.length > 0)
    assert.match(sent.ref_image_url, /^data:image\/png;base64,/)
    assert.ok(!sent.ref_image_url.includes('fal.media'))
  })

  test('a missing reference is refused BEFORE anything is billed', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await generateStudioShot({
      cutoutPng: CUTOUT, plan: PLAN, apiKey: KEY,
      referenceRoot: mkdtempSync(join(tmpdir(), 'boe-no-ref-')),
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'reference_missing')
    assert.equal(calls.length, 0, 'a missing reference must not cost a request')
  })

  test('a missing reference is not retried, and does not substitute anything', async () => {
    assert.equal(isNoRetry('reference_missing'), true)

    const result = await generateStudioShot({
      cutoutPng: CUTOUT, plan: PLAN, apiKey: KEY,
      referenceRoot: mkdtempSync(join(tmpdir(), 'boe-no-ref-2-')),
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    // The employee is told to ask an administrator, not handed a lookalike.
    assert.match(result.message, /reference image is not installed/i)
    assert.ok(result.detail?.includes('assets'), 'the log detail names the path to install')
  })
})

describe('the padding', () => {
  test('it is sent as four numbers in Bria’s order', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    assert.deepEqual(body(calls).padding_values, [
      PLAN.padding.left, PLAN.padding.right, PLAN.padding.top, PLAN.padding.bottom,
    ])
  })

  test('it is the plan’s, not a constant tuned against one chair', async () => {
    const wide = planPadding({ width: 2400, height: 800 })
    const { calls } = stubFetch(() => okResponse())
    await generateStudioShot({ cutoutPng: CUTOUT, plan: wide, apiKey: KEY, referenceRoot: root })

    assert.deepEqual(body(calls).padding_values, wide.paddingValues)
    assert.notDeepEqual(wide.paddingValues, PLAN.paddingValues)
  })

  test('the four values close on a 1000 x 1000 master', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()
    const [left, right, top, bottom] = body(calls).padding_values
    assert.equal(left + PLAN.product.width + right, 1000)
    assert.equal(top + PLAN.product.height + bottom, 1000)
  })
})

describe('cost', () => {
  test('one request per call, whatever comes back', async () => {
    for (const respond of [
      () => okResponse(),
      () => new Response('nope', { status: 500 }),
      () => new Response('busy', { status: 429 }),
      () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ]) {
      const { calls } = stubFetch(respond)
      await run()
      assert.equal(calls.length, 1, 'exactly one request')
    }
  })

  test('a timeout is not retried — that is when a charge is most likely', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      const e = new Error('timed out')
      e.name = 'TimeoutError'
      throw e
    }) as typeof globalThis.fetch

    const result = await run()
    assert.equal(calls, 1)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'timeout')
  })

  test('an oversized cut-out is refused locally rather than paid for', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await generateStudioShot({
      cutoutPng: Buffer.alloc(13 * 1024 * 1024),
      plan: PLAN, apiKey: KEY, referenceRoot: root,
    })
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0)
  })
})

describe('the key and what leaks', () => {
  test('it travels in a header, and appears nowhere else', async () => {
    const { calls } = stubFetch(() => okResponse())
    await run()

    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Key ${KEY}`)
    assert.ok(!calls[0].url.includes(KEY))
    assert.ok(!String(calls[0].init.body).includes(KEY))
  })

  test('no failure message names the provider, the model or the endpoint', async () => {
    for (const status of [401, 402, 403, 429, 422, 500]) {
      stubFetch(() => new Response('provider said something internal', { status }))
      const result = await run()
      assert.equal(result.ok, false)
      if (result.ok) continue
      for (const word of ['fal', 'bria', 'http', 'product-shot', 'endpoint']) {
        assert.ok(!result.message.toLowerCase().includes(word), `"${word}" in: ${result.message}`)
      }
    }
  })

  test('the provider’s own response text is never passed on', async () => {
    stubFetch(() => new Response('SECRET INTERNAL DETAIL', { status: 500 }))
    const result = await run()
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(!result.message.includes('SECRET'))
  })
})

describe('the request body builder', () => {
  test('builds the same body the adapter sends', () => {
    const built = buildRequestBody('data:image/png;base64,AAA', 'data:image/png;base64,BBB', [1, 2, 3, 4])
    assert.equal(built.image_url, 'data:image/png;base64,AAA')
    assert.equal(built.ref_image_url, 'data:image/png;base64,BBB')
    assert.deepEqual(built.padding_values, [1, 2, 3, 4])
    assert.equal('scene_description' in built, false)
    assert.equal('sync_mode' in built, false)
  })

  test('the padding array is copied, so a caller cannot mutate the plan later', () => {
    const source: number[] = [1, 2, 3, 4]
    const built = buildRequestBody('a', 'b', source)
    source[0] = 999
    assert.equal(built.padding_values[0], 1)
  })
})
