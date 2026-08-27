/**
 * The PhotoRoom call: what goes out, and what every kind of answer becomes.
 *
 * `fetch` is stubbed, so nothing here reaches the network and no API key is
 * needed to run it. What it checks is the part no finished image can show you:
 *
 *   * the request goes to the Remove Background endpoint (`/v1/segment`) and
 *     NOT to an image-editing or background-generation endpoint — those cost
 *     differently and, far worse, would return a product PhotoRoom drew rather
 *     than the one BOE photographed;
 *   * the photograph is sent as multipart `image_file`, asking for a
 *     transparent RGBA PNG, with no background colour requested;
 *   * the key travels in the `x-api-key` header — never the URL, never the body;
 *   * every failure maps to a reason and a sentence that says whether trying
 *     again is worth the employee's time, and never carries PhotoRoom's own
 *     error text to the browser.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/photoroomCutout.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { removeBackground, buildForm, failureForStatus } from './photoroomCutout'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const PHOTO = { bytes: Buffer.from('JPEG-BYTES-HERE'), mimeType: 'image/jpeg' }
const KEY = 'test-key-not-a-real-one'
const CUTOUT = Buffer.from('\x89PNG\r\n\x1a\n-transparent-cutout', 'binary')

type Captured = { url: string; init: RequestInit }

function stubFetch(respond: () => Response): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond()
  }) as typeof globalThis.fetch
  return { calls }
}

const pngResponse = () =>
  new Response(new Uint8Array(CUTOUT), { status: 200, headers: { 'Content-Type': 'image/png' } })

describe('the request', () => {
  test('goes to the Remove Background endpoint, and to nothing else', async () => {
    const { calls } = stubFetch(pngResponse)
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://sdk.photoroom.com/v1/segment')

    // The endpoints this must never reach: generative editing and generated
    // backgrounds. Either would return a product that is not BOE's.
    assert.ok(!calls[0].url.includes('/v2/edit'))
    assert.ok(!calls[0].url.includes('instant-background'))
    assert.equal(String(calls[0].init.method), 'POST')
  })

  test('sends the photograph as multipart image_file', async () => {
    const { calls } = stubFetch(pngResponse)
    await removeBackground({ ...PHOTO, fileName: 'chair.jpg', apiKey: KEY })

    const form = calls[0].init.body as FormData
    assert.ok(form instanceof FormData, 'the body must be multipart form data')

    const part = form.get('image_file')
    assert.ok(part instanceof Blob, 'image_file must carry the photograph')
    assert.equal((part as File).name, 'chair.jpg')
    assert.equal(Buffer.from(await (part as Blob).arrayBuffer()).toString(), PHOTO.bytes.toString())
  })

  test('asks for a transparent PNG and never for a background', async () => {
    const form = buildForm({ ...PHOTO })
    assert.equal(form.get('format'), 'png')
    assert.equal(form.get('channels'), 'rgba')

    // `bg_color` is what turns a transparent cut-out into a flat-coloured one,
    // and the background here is composed locally instead.
    assert.equal(form.get('bg_color'), null)
    // None of the generative parameters may appear.
    for (const generative of ['background.prompt', 'prompt', 'template', 'scenario']) {
      assert.equal(form.get(generative), null, `${generative} must never be sent`)
    }
  })

  test('the API key is a header and appears nowhere else', async () => {
    const { calls } = stubFetch(pngResponse)
    await removeBackground({ ...PHOTO, apiKey: KEY })

    const { url, init } = calls[0]
    assert.equal((init.headers as Record<string, string>)['x-api-key'], KEY)
    assert.ok(!url.includes(KEY), 'the key must not be in the URL')

    const form = init.body as FormData
    for (const [, value] of form.entries()) {
      if (typeof value === 'string') assert.ok(!value.includes(KEY), 'the key must not be in the body')
    }
  })
})

describe('the answer', () => {
  test('a PNG comes back as bytes, unmodified', async () => {
    stubFetch(pngResponse)
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    assert.ok(result.ok && result.png.equals(CUTOUT))
  })

  test('a 200 that is not an image is a failure, not a cut-out', async () => {
    // An HTML error page or a JSON body with a 200 would otherwise be handed to
    // sharp as if it were a product.
    stubFetch(() => new Response('{"error":"something"}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))

    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'provider_error')
  })

  test('an empty 200 body is a failure', async () => {
    stubFetch(() => new Response(new Uint8Array(0), {
      status: 200, headers: { 'Content-Type': 'image/png' },
    }))

    const result = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
  })
})

describe('failure mapping', () => {
  test('each PhotoRoom status becomes the failure it actually is', () => {
    assert.equal(failureForStatus(401), 'invalid_key')
    assert.equal(failureForStatus(403), 'invalid_key')
    // Out of credits. The one most likely to be mistaken for a bug.
    assert.equal(failureForStatus(402), 'insufficient_credits')
    assert.equal(failureForStatus(429), 'rate_limited')
    assert.equal(failureForStatus(400), 'unsupported_image')
    assert.equal(failureForStatus(415), 'unsupported_image')
    assert.equal(failureForStatus(422), 'unsupported_image')
    assert.equal(failureForStatus(500), 'provider_error')
    assert.equal(failureForStatus(503), 'provider_error')
  })

  test('no API key is reported as not configured, without calling anything', async () => {
    const { calls } = stubFetch(pngResponse)
    const result = await removeBackground({ ...PHOTO, apiKey: '' })

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'not_configured')
    assert.equal(calls.length, 0, 'a keyless call must not reach the provider')
  })

  test('a refused key tells the employee to fetch an administrator, not to retry', async () => {
    stubFetch(() => new Response('{"detail":"Invalid API key sk_live_xxx"}', { status: 401 }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(!result.ok && result.reason, 'invalid_key')
    assert.match(!result.ok ? result.message : '', /administrator/i)
    assert.ok(!result.ok && !/try again/i.test(result.message), 'retrying a bad key is pointless')
  })

  test('no credits says so, in words an employee can pass on', async () => {
    stubFetch(() => new Response('{"detail":"Insufficient credits"}', { status: 402 }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(!result.ok && result.reason, 'insufficient_credits')
    assert.match(!result.ok ? result.message : '', /credits/i)
  })

  test('a rate limit and a timeout both invite a retry', async () => {
    stubFetch(() => new Response('rate limited', { status: 429 }))
    const limited = await removeBackground({ ...PHOTO, apiKey: KEY })
    assert.equal(!limited.ok && limited.reason, 'rate_limited')
    assert.match(!limited.ok ? limited.message : '', /try again/i)

    globalThis.fetch = (async () => {
      const err = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as typeof globalThis.fetch
    const timedOut = await removeBackground({ ...PHOTO, apiKey: KEY, timeoutMs: 5 })
    assert.equal(!timedOut.ok && timedOut.reason, 'timeout')
    assert.match(!timedOut.ok ? timedOut.message : '', /try again/i)
  })

  test('an unreadable image is named as such', async () => {
    stubFetch(() => new Response('{"detail":"Unsupported file"}', { status: 415 }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(!result.ok && result.reason, 'unsupported_image')
    assert.match(!result.ok ? result.message : '', /different photograph/i)
  })

  test('a network failure is a result, not an exception', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'provider_error')
  })

  test('provider text stays in detail and out of the message', async () => {
    // A PhotoRoom error body can quote the request and, in the worst case, a
    // credential. The employee-facing sentence must be ours.
    stubFetch(() => new Response('{"detail":"key sk_live_secret rejected for project 12345"}', { status: 400 }))
    const result = await removeBackground({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.detail?.includes('sk_live_secret'), 'the log keeps the detail')
    assert.ok(!result.ok && !result.message.includes('sk_live_secret'), 'the browser never sees it')
    assert.ok(!result.ok && !result.message.includes('12345'))
  })
})
