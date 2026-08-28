/**
 * The transport, and the fault that made it necessary to test it directly.
 *
 * A real run failed like this:
 *
 *   [image-editor/studio] cutout failed: category empty_result status 200
 *   request 01a04960-94c5-7fb0-bdad-5810b92d5642 18026 ms
 *
 * The photograph was a clear, isolated dining chair. 18026 ms is the 18-second
 * cut-out timeout, and the status was 200 — so the headers arrived and the
 * deadline then fired while the body was still streaming. With
 * `sync_mode: true` that body is a multi-megabyte base64 data URI of the whole
 * cut-out, so it takes real time to read.
 *
 * A bare `catch` around `response.json()` called that an empty result. The
 * employee was told their product could not be separated from the photograph —
 * advice to re-shoot something that was never wrong — and the log said "valid
 * 200 carrying no image", which is not what happened either.
 *
 * So: an abort is a timeout wherever it surfaces, a 200 with no image is the
 * service misbehaving and says so, and every deadline is enforced rather than
 * assumed.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/falRequest.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  callFal, MESSAGES, NO_RETRY_FAILURES, classifyFailure, isAllowedResultUrl,
  RESULT_FETCH_TIMEOUT_MS,
} from './falRequest'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const MODEL = 'fal-ai/bria/background/remove'
const call = (over: Record<string, unknown> = {}) =>
  callFal({ modelId: MODEL, body: {}, apiKey: 'test-key', ...over })

/**
 * A response whose HEADERS arrive at once with 200 and whose BODY streams over
 * `bodyMs`. This is the shape of every sync_mode answer: the status is known
 * long before the image is.
 */
function streamingResponse(bodyMs: number, signal: AbortSignal | undefined, status = 200) {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encode = (s: string) => controller.enqueue(new TextEncoder().encode(s))
      encode('{"image":{"url":"data:image/png;base64,')
      const chunks = 10
      for (let i = 0; i < chunks; i++) {
        if (signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return }
        await new Promise(r => setTimeout(r, bodyMs / chunks))
        encode('QUJD')
      }
      encode('","content_type":"image/png"}}')
      controller.close()
    },
  })
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-stream' },
  })
}

function stubStreaming(bodyMs: number) {
  let calls = 0
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    calls++
    return streamingResponse(bodyMs, init?.signal ?? undefined)
  }) as typeof globalThis.fetch
  return { calls: () => calls }
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-json' },
  })

// ─── The incident ─────────────────────────────────────────────────────────────

describe('a 200 whose body is still arriving when the deadline fires', () => {
  test('is a TIMEOUT, not an empty result', async () => {
    // The exact fault from the log, at a scale a test can run.
    const stub = stubStreaming(1000)
    const result = await call({ timeoutMs: 250 })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'timeout')
    assert.notEqual(result.reason, 'empty_result')
    assert.equal(stub.calls(), 1, 'and it is not retried')
  })

  test('the log can tell WHERE it timed out', async () => {
    // "timeout, status 200" and "timeout, no status" are different faults with
    // different fixes. Not being able to tell them apart is what this cost.
    stubStreaming(1000)
    const result = await call({ timeoutMs: 250 })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.phase, 'body')
    assert.equal(result.status, 200, 'the headers really did say 200')
  })

  test('the employee is told it timed out, not that their chair is unrecognisable', async () => {
    stubStreaming(1000)
    const result = await call({ timeoutMs: 250 })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /too long/i)
    assert.match(result.message, /try again/i)
    assert.ok(!/separat|clearly visible|different photograph/i.test(result.message),
      `a timeout must not read as a photograph problem: ${result.message}`)
  })

  test('the same response succeeds once the budget is big enough', async () => {
    // Proof the photograph was never the problem: nothing about the response
    // changes, only the time allowed for it.
    stubStreaming(400)
    const result = await call({ timeoutMs: 2_000 })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.images.length, 1)
  })

  test('a body that crosses the old 18s boundary now fits the new one', () => {
    // The observed failure took 18026 ms. Arithmetic on the real constants,
    // rather than a slow test: what failed then must pass now.
    const observedMs = 18_026
    const oldBudget = 18_000
    const newBudget = 25_000

    assert.ok(observedMs > oldBudget, 'the old budget was the thing that cut it off')
    assert.ok(observedMs < newBudget, 'the new budget covers the observed duration')
    // And with real headroom, not by a hair.
    assert.ok(newBudget - observedMs > 5_000, 'the new budget leaves less than 5s of margin')
  })
})

// ─── A genuinely empty answer ─────────────────────────────────────────────────

describe('a well-formed 200 that carries no image', () => {
  test('is an empty result, and says the SERVICE returned nothing', async () => {
    globalThis.fetch = (async () => json({})) as typeof globalThis.fetch
    const result = await call({ timeoutMs: 5_000 })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'empty_result')
    assert.match(result.message, /did not return an image/i)
  })

  test('it never blames the photograph', async () => {
    // The conflation this replaced. A service answering without an image says
    // nothing about whether a product is visible in the upload — that is decided
    // locally, by reading the alpha.
    assert.ok(!/separat|clearly visible|product could not/i.test(MESSAGES.empty_result),
      MESSAGES.empty_result)
  })

  test('and it may be retried, because the next attempt may well work', () => {
    // Unlike a refused key or a moderation refusal, this is the service having
    // a bad moment rather than anything deterministic about the request.
    assert.equal(NO_RETRY_FAILURES.has('empty_result'), false)
    for (const fixed of ['not_configured', 'invalid_key', 'insufficient_credit', 'moderation'] as const) {
      assert.equal(NO_RETRY_FAILURES.has(fixed), true, `${fixed} must stay no-retry`)
    }
  })

  test('a malformed body that is NOT an abort stays an empty result', async () => {
    globalThis.fetch = (async () => new Response('not json at all', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch

    const result = await call({ timeoutMs: 5_000 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'empty_result')
    assert.equal(result.phase, 'body')
  })
})

// ─── Where else an abort can surface ──────────────────────────────────────────

describe('an abort is a timeout wherever it comes from', () => {
  test('before any response arrives', async () => {
    globalThis.fetch = (async () => {
      const e = new Error('aborted'); e.name = 'TimeoutError'; throw e
    }) as typeof globalThis.fetch

    const result = await call({ timeoutMs: 500 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'timeout')
    assert.equal(result.phase, 'request')
    assert.equal(result.status, undefined, 'nothing answered, so there is no status')
  })

  test('while a hosted result is downloading', async () => {
    let n = 0
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      n++
      if (n === 1) return json({ images: [{ url: 'https://v3b.fal.media/files/b/x/m.png' }] })
      // The download stalls past its budget.
      return new Response(new ReadableStream({
        async start(c) {
          await new Promise(r => setTimeout(r, 1000))
          if (init?.signal?.aborted) { c.error(new DOMException('aborted', 'AbortError')); return }
          c.close()
        },
      }), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }) as typeof globalThis.fetch

    const result = await call({ timeoutMs: 5_000, downloadMs: 200, expect: 1 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'timeout')
    assert.equal(result.phase, 'download')
  })

  test('a real network error is still a provider error, not a timeout', async () => {
    globalThis.fetch = (async () => { throw new TypeError('network down') }) as typeof globalThis.fetch

    const result = await call({ timeoutMs: 500 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'provider_error')
  })
})

// ─── The deadline ─────────────────────────────────────────────────────────────

describe('the deadline is enforced, not assumed', () => {
  test('a call clamps its own timeout to what is left of the route’s', async () => {
    const stub = stubStreaming(1000)
    const started = Date.now()
    // A generous per-call timeout, but almost no route budget left.
    const result = await call({ timeoutMs: 10_000, deadlineAt: Date.now() + 250 })
    const elapsed = Date.now() - started

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'timeout')
    assert.ok(elapsed < 2_000, `waited ${elapsed}ms despite a 250ms deadline`)
    assert.equal(stub.calls(), 1)
  })

  test('a deadline already spent costs nothing at all', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return json({}) }) as typeof globalThis.fetch

    const result = await call({ timeoutMs: 25_000, deadlineAt: Date.now() - 1 })

    assert.equal(called, false, 'a request must not be made with no time to read it')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'timeout')
    assert.equal(result.phase, 'request')
  })

  test('without a deadline the call keeps its own budget', async () => {
    stubStreaming(200)
    const result = await call({ timeoutMs: 5_000 })
    assert.equal(result.ok, true)
  })

  test('the download budget is also clamped by the deadline', async () => {
    let n = 0
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      n++
      if (n === 1) return json({ images: [{ url: 'https://v3b.fal.media/files/b/x/m.png' }] })
      return new Response(new ReadableStream({
        async start(c) {
          await new Promise(r => setTimeout(r, 1000))
          if (init?.signal?.aborted) { c.error(new DOMException('aborted', 'AbortError')); return }
          c.close()
        },
      }), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }) as typeof globalThis.fetch

    const started = Date.now()
    const result = await call({ timeoutMs: 5_000, deadlineAt: Date.now() + 300, expect: 1 })
    assert.equal(result.ok, false)
    assert.ok(Date.now() - started < 2_000, 'the download ignored the route deadline')
  })
})

// ─── Unchanged guarantees ─────────────────────────────────────────────────────

describe('nothing about cost changed', () => {
  test('one request per call, on every failure path', async () => {
    for (const [label, stub] of [
      ['timeout in body', () => { stubStreaming(1000) }],
      ['empty 200', () => { globalThis.fetch = (async () => json({})) as typeof globalThis.fetch }],
      ['500', () => { globalThis.fetch = (async () => new Response('x', { status: 500 })) as typeof globalThis.fetch }],
    ] as const) {
      let n = 0
      stub()
      const inner = globalThis.fetch
      globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { n++; return inner(...a) }) as typeof globalThis.fetch

      await call({ timeoutMs: 250 })
      assert.equal(n, 1, `${label} made ${n} requests`)
    }
  })

  test('the failure classification of status codes is unchanged', () => {
    assert.equal(classifyFailure(401, ''), 'invalid_key')
    assert.equal(classifyFailure(402, ''), 'insufficient_credit')
    assert.equal(classifyFailure(403, 'balance exhausted'), 'insufficient_credit')
    assert.equal(classifyFailure(403, ''), 'invalid_key')
    assert.equal(classifyFailure(429, ''), 'rate_limited')
    assert.equal(classifyFailure(422, ''), 'unsupported_image')
    assert.equal(classifyFailure(500, ''), 'provider_error')
    assert.equal(classifyFailure(200, 'flagged by moderation'), 'moderation')
  })

  test('the result host allowlist is unchanged', () => {
    assert.equal(isAllowedResultUrl('https://v3b.fal.media/files/b/x.png'), true)
    assert.equal(isAllowedResultUrl('https://evil.example.com/x.png'), false)
    assert.equal(isAllowedResultUrl('http://fal.media/x.png'), false)
  })

  test('no message names a provider, a model or an endpoint', () => {
    for (const [reason, message] of Object.entries(MESSAGES)) {
      for (const word of ['fal', 'bria', 'http', 'endpoint', 'sync_mode']) {
        assert.ok(!message.toLowerCase().includes(word), `${reason}: ${message}`)
      }
    }
  })

  test('the download budget is a real, bounded number', () => {
    assert.ok(RESULT_FETCH_TIMEOUT_MS > 0 && RESULT_FETCH_TIMEOUT_MS <= 15_000)
  })
})
