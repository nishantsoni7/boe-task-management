/**
 * The provider call: what goes out, and what every kind of answer becomes.
 *
 * `fetch` is stubbed, so nothing here reaches the network and no API key is
 * needed to run it. What it does check is the part that cannot be checked by
 * looking at a generated image:
 *
 *   * the key travels in a header, never in the URL — a key in a query string
 *     lands in access logs and error traces;
 *   * the photograph is sent as inline data alongside the instruction, so this
 *     is an EDIT of BOE's photograph and not a fresh generation from a
 *     description of it;
 *   * a square output is requested explicitly;
 *   * every failure — refused, timed out, blocked, image-less — comes back as a
 *     result object with a sentence an employee can act on, and NEVER as an
 *     exception the route would have to guess at, and never as a fake image.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/geminiStudioImage.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateStudioImage,
  buildRequestBody,
  supportsImageSize,
  DEFAULT_IMAGE_MODEL,
} from './geminiStudioImage'
import { STUDIO_IMAGE_PROMPT } from './studioPrompt'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const PHOTO = { base64: 'QkFTRTY0LUpQRUc=', mimeType: 'image/jpeg' }
const KEY = 'test-key-not-a-real-one'

type Captured = { url: string; init: RequestInit }

/** Stub `fetch`, capture the one request, answer with `respond`. */
function stubFetch(respond: () => Response): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond()
  }) as typeof globalThis.fetch
  return { calls }
}

function imageResponse(mimeType = 'image/png', data = 'UkVTVUxU') {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] }, finishReason: 'STOP' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('the request', () => {
  test('sends the photograph and the instruction to the image model', async () => {
    const { calls } = stubFetch(() => imageResponse())
    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.includes(`${DEFAULT_IMAGE_MODEL}:generateContent`))

    const body = JSON.parse(String(calls[0].init.body))
    const parts = body.contents[0].parts

    // The instruction is the whole of studioPrompt.ts, not a paraphrase built
    // here — that file is where BOE's preservation rules live.
    assert.equal(parts[0].text, STUDIO_IMAGE_PROMPT)
    // The photograph itself, which is what makes this an edit.
    assert.deepEqual(parts[1].inlineData, { mimeType: 'image/jpeg', data: PHOTO.base64 })
  })

  test('asks for one square image', async () => {
    const { calls } = stubFetch(() => imageResponse())
    await generateStudioImage({ ...PHOTO, apiKey: KEY })

    const body = JSON.parse(String(calls[0].init.body))
    assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE'])
    assert.equal(body.generationConfig.imageConfig.aspectRatio, '1:1')
  })

  test('the API key is a header and appears nowhere in the URL or the body', async () => {
    const { calls } = stubFetch(() => imageResponse())
    await generateStudioImage({ ...PHOTO, apiKey: KEY })

    const { url, init } = calls[0]
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], KEY)
    assert.ok(!url.includes(KEY), 'the key must not be in the URL')
    assert.ok(!String(init.body).includes(KEY), 'the key must not be in the body')
  })

  test('the resolution field is sent only to the models that accept it', () => {
    assert.equal(supportsImageSize('gemini-3.1-flash-image'), true)
    assert.equal(supportsImageSize('gemini-3-pro-image'), true)
    assert.equal(supportsImageSize('gemini-2.5-flash-image'), false)

    const three = buildRequestBody(PHOTO, 'gemini-3.1-flash-image')
    assert.equal(three.generationConfig.imageConfig.imageSize, '2K')

    // gemini-2.5-flash-image has no imageSize; sending it there would risk a
    // rejected request for nothing.
    const twoFive = buildRequestBody(PHOTO, 'gemini-2.5-flash-image')
    assert.equal('imageSize' in twoFive.generationConfig.imageConfig, false)
  })

  test('nothing from the upload reaches the instruction text', async () => {
    // The only user-supplied value in the request is the image. There is no
    // caption, filename or note interpolated into the prompt, so an upload has
    // no text channel through which to rewrite the preservation rules.
    const { calls } = stubFetch(() => imageResponse())
    await generateStudioImage({ ...PHOTO, apiKey: KEY })

    const body = JSON.parse(String(calls[0].init.body))
    const textParts = body.contents[0].parts.filter((p: { text?: string }) => p.text !== undefined)
    assert.equal(textParts.length, 1)
    assert.equal(textParts[0].text, STUDIO_IMAGE_PROMPT)
  })
})

describe('the answer', () => {
  test('an inline image comes back as base64 with its type', async () => {
    stubFetch(() => imageResponse('image/png', 'UkVTVUxU'))
    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.image, { base64: 'UkVTVUxU', mimeType: 'image/png' })
  })

  test('a snake_case response body is read too', async () => {
    stubFetch(() => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'Uk9X' } }] } }],
    }), { status: 200 }))

    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.image.mimeType, 'image/jpeg')
  })

  test('a text part before the image does not hide the image', async () => {
    stubFetch(() => new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: 'Here is the studio image.' },
        { inlineData: { mimeType: 'image/png', data: 'UEFSVA==' } },
      ] } }],
    }), { status: 200 }))

    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.image.base64, 'UEFSVA==')
  })
})

describe('failures', () => {
  test('no API key is reported as not configured, without calling anything', async () => {
    const { calls } = stubFetch(() => imageResponse())
    const result = await generateStudioImage({ ...PHOTO, apiKey: '' })

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'not_configured')
    assert.equal(calls.length, 0, 'a keyless call must not reach the provider')
  })

  test('a provider error keeps its text out of the employee-facing message', async () => {
    stubFetch(() => new Response('{"error":{"message":"quota exceeded for project 12345"}}', { status: 429 }))
    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'provider_error')
    // The detail is for the server log. The message is what the page shows, and
    // it must not carry project ids or quota internals.
    assert.ok(!result.ok && result.detail?.includes('quota exceeded'))
    assert.ok(!result.ok && !result.message.includes('quota'))
  })

  test('a timeout is its own reason, so the page can invite a retry', async () => {
    globalThis.fetch = (async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }) as typeof globalThis.fetch

    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY, timeoutMs: 5 })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'timeout')
    assert.match(!result.ok ? result.message : '', /try again/i)
  })

  test('a network failure is a result, not an exception', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch

    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'provider_error')
  })

  test('a safety block says so, instead of "try again" forever', async () => {
    stubFetch(() => new Response(JSON.stringify({
      candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }],
    }), { status: 200 }))

    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'no_image')
    assert.match(!result.ok ? result.message : '', /declined/i)
  })

  test('a text-only answer is a failure — no image is never a success', async () => {
    stubFetch(() => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'I cannot do that.' }] }, finishReason: 'STOP' }],
    }), { status: 200 }))

    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'no_image')
  })

  test('an unreadable body is a clean failure', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 200 }))
    const result = await generateStudioImage({ ...PHOTO, apiKey: KEY })

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'provider_error')
  })
})
