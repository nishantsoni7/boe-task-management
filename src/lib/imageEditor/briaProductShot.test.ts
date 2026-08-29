/**
 * The Product Shot request: exactly what the accepted playground run sent.
 *
 * `fetch` is stubbed, so nothing reaches fal and no key is needed.
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
  generateProductShot, buildRequestBody, isNoRetry, MODEL_ID, FIXED_SETTINGS,
} from './briaProductShot'
import { REFERENCE_PATH, resetReferenceCache } from './studioReference'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; resetReferenceCache() })

const KEY = 'test-key-not-a-real-one'
const PHOTO = Buffer.from('ORIGINAL-PHOTOGRAPH-BYTES')

let root: string
before(() => {
  root = mkdtempSync(join(tmpdir(), 'boe-ps-ref-'))
  mkdirSync(join(root, 'assets', 'image-editor'), { recursive: true })
  writeFileSync(join(root, REFERENCE_PATH), Buffer.from('REFERENCE-PNG-BYTES'))
})

type Captured = { url: string; init: RequestInit }
function stubFetch(respond: (call: number) => Response) {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(calls.length)
  }) as typeof globalThis.fetch
  return { calls }
}

const ok = () => new Response(JSON.stringify({
  images: [{ url: 'data:image/png;base64,U0hPVA==', content_type: 'image/png' }],
}), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'req-ps' } })

const run = () => generateProductShot({
  photograph: PHOTO, mimeType: 'image/jpeg', apiKey: KEY, referenceRoot: root,
})
const body = (calls: Captured[], i = 0) => JSON.parse(String(calls[i].init.body))

describe('what the accepted playground run establishes', () => {
  test('the ORIGINAL photograph is the main image, not a cut-out', async () => {
    const { calls } = stubFetch(ok)
    await run()
    // Byte-for-byte the upload. Nothing segments it first.
    assert.equal(body(calls).image_url, `data:image/jpeg;base64,${PHOTO.toString('base64')}`)
  })

  test('the approved reference is sent through ref_image_url', async () => {
    const { calls } = stubFetch(ok)
    await run()
    const sent = body(calls)
    assert.ok(typeof sent.ref_image_url === 'string' && sent.ref_image_url.length > 0)
    assert.match(sent.ref_image_url, /^data:image\/png;base64,/)
    // From BOE's own repository, not an expiring provider URL.
    assert.ok(!sent.ref_image_url.includes('fal.media'))
  })

  test('scene_description is ABSENT — not empty, absent', async () => {
    // The playground run had it empty, and the schema documents it and
    // ref_image_url as alternatives. An empty string is still a scene
    // description as far as "but not both" is concerned.
    const { calls } = stubFetch(ok)
    await run()
    assert.equal('scene_description' in body(calls), false)
  })

  test('optimize_description is false', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.equal(body(calls).optimize_description, false)
    assert.equal(FIXED_SETTINGS.optimize_description, false)
  })

  test('one result, and the settings from the accepted request record', async () => {
    const { calls } = stubFetch(ok)
    await run()
    const sent = body(calls)
    assert.equal(sent.num_results, 1)
    assert.equal(sent.fast, true)
    assert.equal(sent.placement_type, 'manual_placement')
    assert.equal(sent.manual_placement_selection, 'bottom_center')
    assert.deepEqual(sent.shot_size, [1000, 1000])
  })

  test('no prompt or scene wording exists in the module at all', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/imageEditor/briaProductShot.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const phrase of ['catalogue studio', 'warm neutral', 'contact shadow', 'diffused', 'rock', 'ocean']) {
      assert.ok(!code.toLowerCase().includes(phrase), `"${phrase}" must not be in code`)
    }
  })

  test('the body carries these keys and no others', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.deepEqual(Object.keys(body(calls)).sort(), [
      'fast', 'image_url', 'manual_placement_selection', 'num_results',
      'optimize_description', 'placement_type', 'ref_image_url', 'shot_size',
    ])
  })

  test('sync_mode is not sent, so the run stays in fal history', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.equal('sync_mode' in body(calls), false)
  })

  test('the endpoint is Product Shot', async () => {
    const { calls } = stubFetch(ok)
    await run()
    assert.equal(MODEL_ID, 'fal-ai/bria/product-shot')
    assert.equal(calls[0].url, 'https://fal.run/fal-ai/bria/product-shot')
  })
})

describe('cost', () => {
  test('exactly one request, whatever comes back', async () => {
    for (const respond of [
      ok,
      () => new Response('nope', { status: 500 }),
      () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ]) {
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

  test('a missing reference costs nothing at all', async () => {
    const { calls } = stubFetch(ok)
    const result = await generateProductShot({
      photograph: PHOTO, mimeType: 'image/jpeg', apiKey: KEY,
      referenceRoot: mkdtempSync(join(tmpdir(), 'boe-no-ref-')),
    })
    assert.equal(calls.length, 0, 'nothing may be billed without the reference')
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'reference_missing')
      assert.equal(isNoRetry('reference_missing'), true)
    }
  })
})

describe('the key and what leaks', () => {
  test('it travels in a header and appears nowhere else', async () => {
    const { calls } = stubFetch(ok)
    await run()
    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Key ${KEY}`)
    assert.ok(!calls[0].url.includes(KEY))
    assert.ok(!String(calls[0].init.body).includes(KEY))
  })

  test('no failure message names the provider or the model', async () => {
    for (const status of [401, 402, 429, 422, 500]) {
      stubFetch(() => new Response('internal detail', { status }))
      const result = await run()
      assert.equal(result.ok, false)
      if (result.ok) continue
      for (const w of ['fal', 'bria', 'http', 'product-shot']) {
        assert.ok(!result.message.toLowerCase().includes(w), `"${w}" in: ${result.message}`)
      }
    }
  })
})

describe('the body builder', () => {
  test('it builds what the adapter sends', () => {
    const built = buildRequestBody('data:image/jpeg;base64,AAA', 'data:image/png;base64,BBB')
    assert.equal(built.image_url, 'data:image/jpeg;base64,AAA')
    assert.equal(built.ref_image_url, 'data:image/png;base64,BBB')
    assert.equal('scene_description' in built, false)
    assert.equal('sync_mode' in built, false)
    assert.equal('padding_values' in built, false)
    assert.equal('original_quality' in built, false)
  })
})
