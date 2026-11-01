/**
 * GET /api/integrations/seo/decisions, the handler executed against a stand-in for Supabase behind a stubbed `fetch`.
 * Proves the door stays shut without the secret, and that the sessions get edits and answers in the shape they read.
 *
 * Run: npx tsx --test src/app/api/integrations/seo/decisions/route.test.ts
 */
import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { GET } from './route'

const SECRET = 'test-secret'
const realFetch = globalThis.fetch
const saved = { ...process.env }
let urls: string[]
let failing: boolean

const get = (authorization: string | null = `Bearer ${SECRET}`) =>
  GET(new Request('http://localhost/api/integrations/seo/decisions', { headers: authorization ? { authorization } : {} }))

beforeEach(() => {
  urls = []
  failing = false
  process.env.SEO_INGEST_SECRET = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input))
    urls.push(url)
    if (failing) return new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
    const rows = url.includes('seo_plan_items')
      ? [{ id: 'n1', status: 'done', evidence: 'Live', edited_at: '2026-11-02T10:00:00Z' }]
      : [{ id: 'proposal-2026-11-01-0', decision: 'change', decision_note: 'Yes', decided_at: '2026-11-02T11:00:00Z' }]
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...saved }
})

describe('the decisions door', () => {
  test('with no secret configured it is closed and reads nothing', async () => {
    delete process.env.SEO_INGEST_SECRET
    assert.equal((await get()).status, 503)
    assert.equal(urls.length, 0)
  })

  test('no secret, or the wrong one, reads nothing', async () => {
    for (const auth of [null, 'Bearer wrong', 'Bearer test-secreT']) assert.equal((await get(auth)).status, 401, String(auth))
    assert.equal(urls.length, 0)
  })

  test('it asks only for what people changed, and answers in the shape the sender reads', async () => {
    const response = await get()
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      items: [{ id: 'n1', status: 'done', evidence: 'Live', edited_at: '2026-11-02T10:00:00Z' }],
      proposals: [{ id: 'proposal-2026-11-01-0', decision: 'change', note: 'Yes', decided_at: '2026-11-02T11:00:00Z' }],
    })
    assert.ok(urls.some(u => /seo_plan_items\?.*edited_at=not\.is\.null/.test(u)), 'items')
    assert.ok(urls.some(u => /seo_log\?.*kind=eq\.proposal/.test(u) && /decision=not\.is\.null/.test(u)), 'proposals')
  })

  test('a database failure answers 500, so the sender holds the board back', async () => {
    failing = true
    assert.equal((await get()).status, 500)
  })
})
