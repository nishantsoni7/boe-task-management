/**
 * The provider call: what goes out, what comes back, and what it must never do.
 *
 * `fetch` is stubbed, so nothing reaches fal and no key is needed. What it
 * checks is what no finished image can show:
 *
 *   * the request goes to the background-REMOVAL endpoint, and to nothing
 *     generative — Product Shot invented a circular backdrop and then shrank
 *     the chair, and the whole architecture changed to stop asking a model to
 *     compose anything;
 *   * one request per photograph, never retried, including after a timeout;
 *   * the key travels in a header and appears nowhere else;
 *   * an opaque or malformed answer is refused rather than composed, because
 *     compositing a JPEG "cut-out" would paste factory floor onto the studio.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/briaBackgroundRemove.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  removeBackground, buildRequestBody, classifyFailure, isAllowedResultUrl,
  MODEL_ID, NO_RETRY_FAILURES, PROVIDER_MAX_IMAGE_BYTES,
} from './briaBackgroundRemove'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const PHOTO = { bytes: Buffer.from('JPEG-BYTES-HERE'), mimeType: 'image/jpeg' }
const KEY = 'test-key-not-a-real-one'
const CUTOUT_DATA_URL = 'data:image/png;base64,Q1VUT1VU'

type Captured = { url: string; init: RequestInit }

function stubFetch(respond: (call: number) => Response): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(calls.length)
  }) as typeof globalThis.fetch
  return { calls }
}

const okResponse = (image: unknown = { url: CUTOUT_DATA_URL, content_type: 'image/png' }) =>
  new Response(JSON.stringify({ image }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-123' },
  })

const body = (calls: Captured[], i = 0) => JSON.parse(String(calls[i].init.body))

describe('the request', () => {
  test('goes to background removal, and to no generative model', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    assert.equal(MODEL_ID, 'fal-ai/bria/background/remove')
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/bria/background/remove')

    // The endpoints this must never reach again.
    for (const banned of ['product-shot', 'background/replace', 'instant-background', '/v2/edit']) {
      assert.ok(!calls[0].url.includes(banned), `must not call ${banned}`)
    }
  })

  test('sends exactly the two fields the schema defines', async () => {
    const { calls } = stubFetch(() => okResponse())
    await removeBackground({ ...PHOTO, apiKey: KEY })
    const sent = body(calls)

    assert.deepEqual(Object.keys(sent).sort(), ['image_url', 'sync_mode'])
    assert.equal(sent.sync_mode, true)
    assert.match(sent.image_url, /^data:image\/jpeg;base64,/)
  })

  test('carries no scene description, prompt or placement setting', async () => {
    // There is nothing to describe: the provider is not composing anything.
    const { calls } = stubFetch(() => okResponse())
    await removeBackground({ ...PHOTO, apiKey: KEY })
    const sent = body(calls)

    for (const generative of [
      'scene_description', 'prompt', 'placement_type', 'shot_size', 'num_results',
      'manual_placement_selection', 'padding_values', 'ref_image_url',
    ]) {
      assert.equal(generative in sent, false, `${generative} must not be sent`)
    }
  })

  test('the photograph travels as a data URI, never as a public URL', () => {
    const built = buildRequestBody('data:image/png;base64,AAA')
    assert.equal(built.image_url, 'data:image/png;base64,AAA')
  })

  test('the API key is a header and appears nowhere else', async () => {
    const { calls } = stubFetch(() => okResponse())
    await removeBackground({ ...PHOTO, apiKey: KEY })

    const { url, init } = calls[0]
    assert.equal((init.headers as Record<string, string>).Authorization, `Key ${KEY}`)
    assert.ok(!url.includes(KEY))
    assert.ok(!String(init.body).includes(KEY))
  })

  test('an image beyond the provider ceiling is refused before it is paid for', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await removeBackground({
      ...PHOTO, bytes: Buffer.alloc(PROVIDER_MAX_IMAGE_BYTES + 1), apiKey: KEY,
    })

    assert.equal(!result.ok && result.reason, 'unsupported_image')
    assert.equal(calls.length, 0)
  })
})

describe('cost', () => {
  test('one call is one request', async () => {
    const { calls } = stubFetch(() => okResponse())
    await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(calls.length, 1)
  })

  test('nothing is retried — not a rate limit, not a server error', async () => {
    for (const status of [429, 500, 503]) {
      const { calls } = stubFetch(() => new Response('nope', { status }))
      await removeBackground({ ...PHOTO, apiKey: KEY })
      assert.equal(calls.length, 1, `status ${status} must not be retried`)
    }
  })

  test('a timeout is not retried either — the request may already have been billed', async () => {
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      const err = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as typeof globalThis.fetch

    const result = await removeBackground({ ...PHOTO, apiKey: KEY, timeoutMs: 5 })
    assert.equal(!result.ok && result.reason, 'timeout')
    assert.equal(attempts, 1)
  })

  test('no key means no request at all', async () => {
    const { calls } = stubFetch(() => okResponse())
    const result = await removeBackground({ ...PHOTO, apiKey: '' })

    assert.equal(!result.ok && result.reason, 'not_configured')
    assert.equal(calls.length, 0)
  })
})

describe('the cut-out that comes back', () => {
  test('a data URI is decoded to bytes', async () => {
    stubFetch(() => okResponse())
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.png.toString(), 'CUTOUT')
    assert.equal(result.contentType, 'image/png')
    assert.equal(result.requestId, 'req-123')
  })

  test('a temporary URL is fetched server-side, from fal hosts only', async () => {
    const { calls } = stubFetch(call => call === 1
      ? okResponse({ url: 'https://v3.fal.media/files/abc/cutout.png' })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }))

    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://v3.fal.media/files/abc/cutout.png')
  })

  test('a URL from anywhere else is refused, not downloaded', async () => {
    const { calls } = stubFetch(() => okResponse({ url: 'https://evil.test/x.png' }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(!result.ok && result.reason, 'empty_result')
    assert.equal(calls.length, 1)
  })

  test('the allowlist is exact', () => {
    assert.equal(isAllowedResultUrl('https://v3.fal.media/files/a.png'), true)
    assert.equal(isAllowedResultUrl('https://fal.run/x.png'), true)
    assert.equal(isAllowedResultUrl('http://v3.fal.media/x.png'), false)
    assert.equal(isAllowedResultUrl('https://fal.media.evil.test/x.png'), false)
    assert.equal(isAllowedResultUrl('nonsense'), false)
  })

  test('a non-image content type is refused', async () => {
    // Compositing this would paste whatever it is onto the studio background.
    stubFetch(() => okResponse({ url: 'data:application/json;base64,e30=' }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'empty_result')
  })

  test('a missing image, an empty body and a malformed body all fail clearly', async () => {
    for (const respond of [
      () => new Response(JSON.stringify({}), { status: 200 }),
      () => new Response(JSON.stringify({ image: {} }), { status: 200 }),
      () => new Response('<html>', { status: 200 }),
    ]) {
      stubFetch(respond)
      const result = await removeBackground({ ...PHOTO, apiKey: KEY })
      assert.equal(!result.ok && result.reason, 'empty_result')
    }
  })

  test('an oversized cut-out is refused rather than held in memory', async () => {
    const huge = 'A'.repeat(45 * 1024 * 1024)
    stubFetch(() => okResponse({ url: `data:image/png;base64,${huge}` }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'empty_result')
  })
})

describe('failure categories', () => {
  test('each status becomes the failure it actually is', () => {
    assert.equal(classifyFailure(401, ''), 'invalid_key')
    assert.equal(classifyFailure(402, ''), 'insufficient_credit')
    assert.equal(classifyFailure(403, '{"detail":"Exhausted balance"}'), 'insufficient_credit')
    assert.equal(classifyFailure(403, 'forbidden'), 'invalid_key')
    assert.equal(classifyFailure(429, ''), 'rate_limited')
    assert.equal(classifyFailure(415, ''), 'unsupported_image')
    assert.equal(classifyFailure(500, ''), 'provider_error')
    assert.equal(classifyFailure(400, 'content moderation failed'), 'moderation')
  })

  test('the failures a retry cannot fix are marked', () => {
    for (const reason of ['not_configured', 'invalid_key', 'insufficient_credit',
      'unsupported_image', 'moderation', 'empty_result'] as const) {
      assert.ok(NO_RETRY_FAILURES.has(reason))
    }
    for (const reason of ['rate_limited', 'timeout', 'provider_error'] as const) {
      assert.ok(!NO_RETRY_FAILURES.has(reason))
    }
  })

  test('provider text never reaches the message, and no body is kept', async () => {
    stubFetch(() => new Response('{"detail":"key fal_secret_abc rejected for team 42"}', {
      status: 401, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-9' },
    }))

    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.ok(!result.message.includes('fal_secret_abc'))
    assert.deepEqual(Object.keys(result).sort(),
      ['durationMs', 'message', 'ok', 'reason', 'requestId', 'status'].sort())
  })

  test('a network failure is a result, not an exception', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(!result.ok && result.reason, 'provider_error')
  })
})
