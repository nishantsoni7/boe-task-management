/**
 * POST /api/integrations/seo/ingest, the handler executed against a stand-in for Supabase behind a stubbed `fetch`.
 * Proves the door: no secret set means closed, a wrong secret writes nothing, a bad body writes nothing, and a good
 * delivery upserts on the right key.
 *
 * Run: npx tsx --test src/app/api/integrations/seo/ingest/route.test.ts
 */
import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { POST } from './route'
import { SEO_MAX_INGEST_BYTES } from '@/lib/seo/ingest'

const SECRET = 'test-secret'
const realFetch = globalThis.fetch
const saved = { ...process.env }
let calls: { url: string; method: string; body: string }[]
let answer: { status: number; body: unknown }

const post = (body: string, authorization: string | null = `Bearer ${SECRET}`, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/integrations/seo/ingest', {
    method: 'POST',
    body,
    headers: { ...(authorization ? { authorization } : {}), ...headers },
  }))

const good = JSON.stringify({ metrics: [{ metric_date: '2026-10-26', metric: 'keyword.position', scope: 'hotel chairs', value: 18.6, source: 'test' }] })

beforeEach(() => {
  calls = []
  answer = { status: 201, body: [] }
  process.env.SEO_INGEST_SECRET = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body) })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...saved }
})

describe('the door', () => {
  test('with no secret configured it is closed and writes nothing', async () => {
    delete process.env.SEO_INGEST_SECRET
    assert.equal((await post(good)).status, 503)
    assert.equal(calls.length, 0)
  })

  test('no secret, or the wrong one of any length, writes nothing', async () => {
    for (const auth of [null, 'Bearer ', 'Bearer wrong', 'Bearer test-secreT', `Bearer ${SECRET}x`]) {
      assert.equal((await post(good, auth)).status, 401, String(auth))
    }
    assert.equal(calls.length, 0)
  })

  test('too large is refused, by what it declares and by what it really is', async () => {
    assert.equal((await post(good, undefined, { 'content-length': String(SEO_MAX_INGEST_BYTES + 1) })).status, 413)
    assert.equal((await post('x'.repeat(SEO_MAX_INGEST_BYTES + 1))).status, 413)
    assert.equal(calls.length, 0)
  })

  test('a body that is not JSON, or not what the door accepts, writes nothing', async () => {
    assert.equal((await post('{not json')).status, 400)
    const refused = await post(JSON.stringify({ users: [] }))
    assert.equal(refused.status, 400)
    assert.match((await refused.json()).error, /not something this door accepts/)
    assert.equal(calls.length, 0)
  })

  test('a good delivery upserts on the key the sender chose', async () => {
    const response = await post(good)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, written: { seo_metrics: 1 } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.match(calls[0].url, /\/rest\/v1\/seo_metrics\?/)
    assert.match(decodeURIComponent(calls[0].url), /on_conflict=metric_date,metric,scope/)
    assert.equal(JSON.parse(calls[0].body)[0].scope, 'hotel chairs')
  })

  test('a database failure answers 500 with what was saved so far, and never says ok', async () => {
    answer = { status: 500, body: { message: 'boom' } }
    const response = await post(good)
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.ok, undefined)
    assert.deepEqual(body.written, {})
  })
})
