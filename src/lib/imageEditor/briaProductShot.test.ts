/**
 * The fal.ai call: what goes out, what comes back, and what it is never allowed
 * to cost.
 *
 * `fetch` is stubbed, so nothing here reaches fal and no key is needed to run
 * it. What it checks is everything that cannot be seen by looking at a finished
 * image:
 *
 *   * the model id, and every setting that decides the bill — one request, one
 *     result, manual placement rather than the automatic mode that returns TEN;
 *   * that none of those settings can be reached from the browser, because the
 *     adapter takes an image and nothing else;
 *   * that the scene description is the server's, in full, with nothing from
 *     the upload interpolated into it;
 *   * that the key travels in a header and appears nowhere else;
 *   * that a data URI and a temporary URL both come back safely, and that a
 *     missing or malformed result fails rather than half-succeeding;
 *   * that no request is ever sent twice, including after a timeout — a
 *     silently repeated call is a silently repeated charge.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/briaProductShot.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateProductShot,
  buildRequestBody,
  classifyFailure,
  isAllowedResultUrl,
  MODEL_ID,
  FIXED_SETTINGS,
  STUDIO_SCENE_DESCRIPTION,
  NO_RETRY_FAILURES,
  PROVIDER_MAX_IMAGE_BYTES,
} from './briaProductShot'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const PHOTO = { bytes: Buffer.from('JPEG-BYTES-HERE'), mimeType: 'image/jpeg' }
const KEY = 'test-key-not-a-real-one'
const RESULT_DATA_URL = 'data:image/png;base64,UkVTVUxU'

type Captured = { url: string; init: RequestInit }

function stubFetch(respond: (call: number) => Response): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(calls.length)
  }) as typeof globalThis.fetch
  return { calls }
}

const okResponse = (images: unknown = [{ url: RESULT_DATA_URL, content_type: 'image/png', width: 1000, height: 1000 }]) =>
  new Response(JSON.stringify({ images }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-123' },
  })

const body = (calls: Captured[], i = 0) => JSON.parse(String(calls[i].init.body))

describe('the request', () => {
  test('goes to the one model, by its exact id', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(MODEL_ID, 'fal-ai/bria/product-shot')
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/bria/product-shot')
    assert.equal(String(calls[0].init.method), 'POST')
  })

  test('asks for exactly one result, in the mode that cannot return ten', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    const sent = body(calls)

    assert.equal(sent.num_results, 1)
    // `automatic` returns ten placements and bills for them.
    assert.equal(sent.placement_type, 'manual_placement')
    assert.notEqual(sent.placement_type, 'automatic')
    assert.equal(sent.manual_placement_selection, 'bottom_center')
  })

  test('carries the rest of the fixed settings verbatim', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    const sent = body(calls)

    assert.equal(sent.fast, true)
    assert.equal(sent.optimize_description, false)
    assert.equal(sent.sync_mode, true)
    // Square unless a preset is chosen — the shape the integration has always
    // sent.
    assert.deepEqual(sent.shot_size, [1000, 1000])

    // And the constants themselves, so a change to them is a deliberate one.
    assert.deepEqual({ ...FIXED_SETTINGS }, {
      num_results: 1,
      fast: true,
      optimize_description: false,
      placement_type: 'manual_placement',
      manual_placement_selection: 'bottom_center',
      sync_mode: true,
    })
  })

  test('the scene description is the server’s, whole, and is the only text sent', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    const sent = body(calls)

    assert.equal(sent.scene_description, STUDIO_SCENE_DESCRIPTION)
    // Either a reference image or a description, never both — and BOE sends the
    // description.
    assert.equal('ref_image_url' in sent, false)
  })

  test('no placement field from another placement mode is sent', async () => {
    // Bria's placement fields belong to one placement_type each. With
    // manual_placement the compatible set is manual_placement_selection and
    // shot_size; padding_values belongs to manual_padding and original_quality
    // to original, and sending either is at best ignored, at worst rejected.
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    const sent = body(calls)

    for (const field of ['padding_values', 'original_quality', 'ref_image_url', 'ref_image_file', 'image_file']) {
      assert.equal(field in sent, false, `${field} does not belong with manual_placement`)
    }
  })

  test('the browser cannot reach any of it: the adapter takes an image and a key', async () => {
    const { calls } = stubFetch(() => okResponse())
    // Every cost-sensitive field is a constant in the module, so there is no
    // parameter through which a request body could carry a different model, a
    // higher num_results or the automatic placement mode.
    await generateProductShot({ ...PHOTO, apiKey: KEY })

    const sent = body(calls)
    const fixed = ['num_results', 'fast', 'optimize_description', 'placement_type',
      'manual_placement_selection', 'sync_mode']
    for (const field of fixed) {
      assert.deepEqual(sent[field], (FIXED_SETTINGS as Record<string, unknown>)[field])
    }
    // The image and the output shape are the only things that vary between
    // requests, and the shape only ever takes one of three table values.
    assert.deepEqual(Object.keys(sent).sort(),
      ['image_url', 'scene_description', 'shot_size', ...fixed].sort())
  })

  test('the photograph travels as a data URI, never as a public URL', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })

    const sent = body(calls)
    assert.match(sent.image_url, /^data:image\/jpeg;base64,/)
    assert.equal(sent.image_url.includes(PHOTO.bytes.toString('base64')), true)
  })

  test('the API key is a header and appears nowhere else', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })

    const { url, init } = calls[0]
    assert.equal((init.headers as Record<string, string>).Authorization, `Key ${KEY}`)
    assert.ok(!url.includes(KEY), 'not in the URL')
    assert.ok(!String(init.body).includes(KEY), 'not in the body')
  })

  test('an image beyond the provider ceiling is refused before it is paid for', async () => {
    const { calls } = stubFetch(() => okResponse())
    const huge = Buffer.alloc(PROVIDER_MAX_IMAGE_BYTES + 1)

    const result = await generateProductShot({ ...PHOTO, bytes: huge, apiKey: KEY })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'unsupported_image')
    assert.equal(calls.length, 0, 'nothing may be sent')
  })
})

describe('the scene description holds the reference standard', () => {
  // Each of these is a line of the reference BOE approved. They are asserted
  // one at a time so that a rewrite which quietly drops the margins, or the
  // cyclorama, or the preservation clause, fails on the clause it dropped
  // rather than on one unreadable string comparison.

  const scene = STUDIO_SCENE_DESCRIPTION

  test('framing: one product, centred, filling sixty to sixty five percent of the height', () => {
    assert.match(scene, /packshot of one product/)
    assert.match(scene, /horizontally centred/)
    assert.match(scene, /sixty to sixty five percent of the image height/)
  })

  test('framing: the margins above and below the product are stated', () => {
    assert.match(scene, /twenty percent clear space above/)
    assert.match(scene, /sixteen percent clear space below the feet/)
    assert.match(scene, /balanced side margins/)
    assert.match(scene, /do not crop any part of the product/)
  })

  test('view: front three quarter, with the source angle taking priority', () => {
    assert.match(scene, /front three quarter furniture view/)
    assert.match(scene, /twenty five to thirty five degrees from the front/)
    assert.match(scene, /front dominant, one side visible/)
    assert.match(scene, /seat or top surface/)
    // The angle is a preference, not an instruction to rebuild the furniture.
    assert.match(scene, /Preserve the uploaded viewing angle whenever changing it would require reconstructing or inventing product details/)
  })

  test('background: a seamless warm light grey cyclorama with no wall or floor division', () => {
    assert.match(scene, /seamless warm light grey cyclorama studio/)
    assert.match(scene, /one continuous warm light grey studio background and floor transition/)
    assert.match(scene, /no visible horizon, wall and floor division/)
  })

  test('background: nothing may be added to the scene', () => {
    for (const forbidden of ['skirting', 'corner', 'room', 'architecture', 'props', 'texture', 'decoration', 'text', 'added logo']) {
      assert.ok(scene.includes(forbidden), `the scene must forbid ${forbidden}`)
    }
  })

  test('light: large, soft, upper left front, with opposite fill', () => {
    assert.match(scene, /large soft directional studio light from the upper left front/)
    assert.match(scene, /gentle opposite fill light/)
    assert.match(scene, /controlled highlights/)
    assert.match(scene, /natural contrast/)
    assert.match(scene, /sharp readable material texture/)
  })

  test('shadow: compact contact shadows under every foot, and one soft cast shadow', () => {
    assert.match(scene, /compact contact shadows directly beneath every product foot/)
    assert.match(scene, /one subtle soft cast shadow extending away from the main light/)
  })

  test('preservation: the product is named part by part, and nothing may change it', () => {
    assert.match(scene, /Preserve the uploaded furniture product exactly/)
    for (const part of ['construction', 'geometry', 'proportions', 'viewing direction', 'legs', 'arms',
      'joints', 'cane pattern', 'rope pattern', 'upholstery', 'stitching', 'wood grain', 'metal details',
      'finish', 'colours', 'materials', 'existing product marking']) {
      assert.ok(scene.includes(part), `the scene must preserve ${part}`)
    }
    // Checked inside the prohibition itself, not anywhere in the text: "add"
    // also appears in "added logo", and a loose search would pass even if the
    // verb had been dropped from the sentence that forbids it.
    const prohibition = scene.slice(scene.indexOf('Do not add'))
    for (const verb of ['add', 'remove', 'redesign', 'reshape', 'rotate', 'recolour', 'smooth', 'replace', 'regenerate']) {
      assert.ok(prohibition.includes(verb), `the prohibition must name ${verb}`)
    }
  })

  test('preservation is the last word, after the framing and the light', () => {
    // Ordering matters: a model asked to make furniture look good will redesign
    // it, and the preservation clause has to read as the final constraint
    // rather than as something the framing above may trade away.
    assert.ok(scene.indexOf('Preserve the uploaded furniture product exactly') >
      scene.indexOf('studio light from the upper left front'))
    assert.ok(scene.trimEnd().endsWith('regenerate any product component.'))
  })

  test('it is plain English with no special characters, as Bria requires', () => {
    const unusual = [...scene].filter(c => c.charCodeAt(0) > 126)
    assert.deepEqual(unusual, [], `Bria takes no special characters: ${unusual.join('')}`)
  })
})

describe('the output shape', () => {
  test('each preset sends its own dimensions', async () => {
    for (const [preset, expected] of [
      ['square', [1000, 1000]], ['portrait', [900, 1125]], ['landscape', [1200, 800]],
    ] as const) {
      const { calls } = stubFetch(() => okResponse())
      await generateProductShot({ ...PHOTO, apiKey: KEY, preset })
      assert.deepEqual(body(calls).shot_size, [...expected], `${preset} shot_size`)
    }
  })

  test('no preset means Square', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.deepEqual(body(calls).shot_size, [1000, 1000])
  })

  test('dimensions can never be supplied directly, only chosen from the table', () => {
    // buildRequestBody takes a KEY. Anything unrecognised resolves to Square
    // rather than reaching Bria, so no caller can ask for a 40 megapixel canvas
    // on BOE's account.
    for (const bad of ['huge', '', undefined, '[4000,4000]']) {
      const built = buildRequestBody('data:image/png;base64,AAA', bad as never)
      assert.deepEqual(built.shot_size, [1000, 1000], `${JSON.stringify(bad)} must not be honoured`)
    }
  })

  test('the shape is the only thing about the request a person chooses', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY, preset: 'landscape' })
    const sent = body(calls)

    // Everything that costs money is still fixed.
    assert.equal(sent.num_results, 1)
    assert.equal(sent.placement_type, 'manual_placement')
    assert.equal(sent.scene_description, STUDIO_SCENE_DESCRIPTION)
  })
})

describe('cost', () => {
  test('one call is one request', async () => {
    const { calls } = stubFetch(() => okResponse())
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(calls.length, 1)
  })

  test('a rate limit is not retried', async () => {
    const { calls } = stubFetch(() => new Response('{"detail":"slow down"}', {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }))

    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'rate_limited')
    // The official client retries 429 three times by default. That would be
    // four charges from one button press, which is why this adapter is a plain
    // fetch.
    assert.equal(calls.length, 1)
  })

  test('a timeout is not retried either — the request may already have been billed', async () => {
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      const err = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as typeof globalThis.fetch

    const result = await generateProductShot({ ...PHOTO, apiKey: KEY, timeoutMs: 5 })
    assert.equal(!result.ok && result.reason, 'timeout')
    assert.equal(attempts, 1)
  })

  test('a server error is not retried', async () => {
    const { calls } = stubFetch(() => new Response('boom', { status: 503 }))
    await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(calls.length, 1)
  })

  test('no key means no request at all', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await generateProductShot({ ...PHOTO, apiKey: '' })

    assert.equal(!result.ok && result.reason, 'not_configured')
    assert.equal(calls.length, 0)
  })
})

describe('the result', () => {
  test('a data URI is returned as it arrived, at its native size and format', async () => {
    stubFetch(() => okResponse())
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.image.dataUrl, RESULT_DATA_URL)
    assert.equal(result.image.contentType, 'image/png')
    assert.equal(result.image.width, 1000)
    assert.equal(result.image.height, 1000)
    assert.equal(result.requestId, 'req-123')
  })

  test('a temporary URL is fetched server-side and returned as data', async () => {
    const { calls } = stubFetch(call => call === 1
      ? okResponse([{ url: 'https://v3.fal.media/files/abc/result.png', content_type: 'image/png' }])
      : new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200, headers: { 'Content-Type': 'image/png' },
        }))

    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, true)
    if (!result.ok) return

    // Downloaded here, so the browser is never handed a provider URL.
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://v3.fal.media/files/abc/result.png')
    assert.match(result.image.dataUrl, /^data:image\/png;base64,/)
  })

  test('the download of a result carries no credentials', async () => {
    const { calls } = stubFetch(call => call === 1
      ? okResponse([{ url: 'https://v3.fal.media/files/abc/result.png' }])
      : new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/png' } }))

    await generateProductShot({ ...PHOTO, apiKey: KEY })
    const headers = (calls[1].init.headers ?? {}) as Record<string, string>
    assert.equal(headers.Authorization, undefined)
  })

  test('a result URL from anywhere but fal is not fetched', () => {
    assert.equal(isAllowedResultUrl('https://v3.fal.media/files/a.png'), true)
    assert.equal(isAllowedResultUrl('https://fal.run/x.png'), true)
    assert.equal(isAllowedResultUrl('https://evil.test/x.png'), false)
    assert.equal(isAllowedResultUrl('http://v3.fal.media/x.png'), false, 'plain http is refused')
    assert.equal(isAllowedResultUrl('https://fal.media.evil.test/x.png'), false)
    assert.equal(isAllowedResultUrl('not a url'), false)
  })

  test('a URL from an unexpected host fails instead of being downloaded', async () => {
    const { calls } = stubFetch(() => okResponse([{ url: 'https://evil.test/x.png' }]))
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })

    assert.equal(!result.ok && result.reason, 'empty_result')
    assert.equal(calls.length, 1, 'nothing was downloaded')
  })

  test('an empty image list fails clearly', async () => {
    stubFetch(() => okResponse([]))
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'empty_result')
  })

  test('a malformed body fails clearly', async () => {
    stubFetch(() => new Response('<html>gateway</html>', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'empty_result')
  })

  test('an image entry with no url fails clearly', async () => {
    stubFetch(() => okResponse([{ content_type: 'image/png' }]))
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'empty_result')
  })

  test('a downloaded result that is not an image fails clearly', async () => {
    stubFetch(call => call === 1
      ? okResponse([{ url: 'https://v3.fal.media/files/a.json' }])
      : new Response('{"nope":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'empty_result')
  })
})

describe('failure categories', () => {
  test('each fal status becomes the failure it actually is', () => {
    assert.equal(classifyFailure(401, ''), 'invalid_key')
    assert.equal(classifyFailure(403, 'forbidden'), 'invalid_key')
    assert.equal(classifyFailure(402, ''), 'insufficient_credit')
    // fal answers 403 for an exhausted balance as well as a bad key.
    assert.equal(classifyFailure(403, '{"detail":"Exhausted balance"}'), 'insufficient_credit')
    assert.equal(classifyFailure(429, ''), 'rate_limited')
    assert.equal(classifyFailure(400, ''), 'unsupported_image')
    assert.equal(classifyFailure(413, ''), 'unsupported_image')
    assert.equal(classifyFailure(422, 'validation'), 'unsupported_image')
    assert.equal(classifyFailure(500, ''), 'provider_error')
  })

  test('a moderation refusal is recognised whatever status carries it', () => {
    assert.equal(classifyFailure(400, '{"detail":"content moderation failed"}'), 'moderation')
    assert.equal(classifyFailure(422, 'NSFW content detected'), 'moderation')
  })

  test('the failures nothing but a different photograph can fix are marked', () => {
    for (const reason of ['not_configured', 'invalid_key', 'insufficient_credit', 'unsupported_image', 'moderation'] as const) {
      assert.ok(NO_RETRY_FAILURES.has(reason), `${reason} should not invite a retry`)
    }
    for (const reason of ['rate_limited', 'timeout', 'provider_error', 'empty_result'] as const) {
      assert.ok(!NO_RETRY_FAILURES.has(reason), `${reason} is worth another go`)
    }
  })

  test('provider text never reaches the message, and no body is kept', async () => {
    stubFetch(() => new Response('{"detail":"key fal_secret_abc rejected for team 42"}', {
      status: 401, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-9' },
    }))

    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.ok(!result.message.includes('fal_secret_abc'))
    assert.ok(!result.message.includes('42'))
    // Only a status code and fal's request id are carried out of the adapter —
    // there is no field a response body could travel in.
    assert.deepEqual(Object.keys(result).sort(),
      ['durationMs', 'message', 'ok', 'reason', 'requestId', 'status'].sort())
    assert.equal(result.requestId, 'req-9')
  })

  test('a network failure is a result, not an exception', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'provider_error')
  })

  test('every failure reports how long it took, for the log', async () => {
    stubFetch(() => new Response('nope', { status: 500 }))
    const result = await generateProductShot({ ...PHOTO, apiKey: KEY })
    assert.equal(typeof result.durationMs, 'number')
  })
})

describe('the request body helper', () => {
  test('builds the same body the adapter sends', () => {
    const built = buildRequestBody('data:image/png;base64,AAA')
    assert.equal(built.image_url, 'data:image/png;base64,AAA')
    assert.equal(built.scene_description, STUDIO_SCENE_DESCRIPTION)
    assert.equal(built.num_results, 1)
    assert.equal(built.sync_mode, true)
  })
})
