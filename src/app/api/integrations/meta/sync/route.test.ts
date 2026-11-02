/**
 * GET /api/integrations/meta/sync, the handler run against a stand-in for Supabase and for Meta behind a stubbed
 * `fetch`. Proves the door (no secret set means closed, a wrong secret reads nothing), that without Meta settings it
 * is quiet, and that a configured run only ever asks Meta with GET and the token in a header.
 *
 * Run: npx tsx --test src/app/api/integrations/meta/sync/route.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { GET } from './route'

const SECRET = 'cron-secret'
const TOKEN = 'EAAB-test-token'
const realFetch = globalThis.fetch
const saved = { ...process.env }
let calls: { url: string; method: string; body: string; headers: Record<string, string> }[]
let metaStatus: number

const get = (authorization: string | null = `Bearer ${SECRET}`) =>
  GET(new Request('http://localhost/api/integrations/meta/sync', { headers: authorization ? { authorization } : {} }))

const metaCalls = () => calls.filter(c => c.url.startsWith('https://graph.facebook.com'))
const dbCalls = () => calls.filter(c => c.url.startsWith('http://supabase.test'))

beforeEach(() => {
  calls = []
  metaStatus = 200
  process.env.CRON_SECRET = SECRET
  process.env.META_ACCESS_TOKEN = TOKEN
  process.env.META_AD_ACCOUNT_IDS = 'act_1111111'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? String(init.body) : '', headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    if (url.startsWith('https://graph.facebook.com')) {
      if (metaStatus !== 200) return new Response(JSON.stringify({ error: { code: 190 } }), { status: metaStatus })
      const path = new URL(url).pathname
      if (path.endsWith('/act_1111111')) return Response.json({ account_id: '1111111', name: 'Main', currency: 'INR', timezone_name: 'Asia/Kolkata', created_time: '2019-01-01T00:00:00+0530' })
      if (path.endsWith('/campaigns')) return Response.json({ data: [{ id: '2222222', name: 'Spring', daily_budget: '50000' }] })
      if (path.endsWith('/adsets')) return Response.json({ data: [{ id: '3333333', campaign_id: '2222222', name: 'Chats', optimization_goal: 'CONVERSATIONS' }] })
      return Response.json({ data: [] })
    }
    if (url.includes('/rest/v1/meta_sync_runs') && method === 'POST') return Response.json({ id: 'run-1' }, { status: 201 })
    if (method === 'POST') return new Response(null, { status: 201 })
    if (method === 'PATCH' || method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json([])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...saved }
})

describe('the door', () => {
  test('with no CRON_SECRET it is closed and does nothing', async () => {
    delete process.env.CRON_SECRET
    assert.equal((await get()).status, 503)
    assert.equal(calls.length, 0)
  })

  test('no secret, or the wrong one of any length, reads nothing', async () => {
    for (const auth of [null, 'Bearer ', 'Bearer wrong', 'Bearer cron-secreT', `Bearer ${SECRET}x`]) {
      assert.equal((await get(auth)).status, 401, String(auth))
    }
    assert.equal(calls.length, 0)
  })
})

describe('before the owner adds a token', () => {
  test('it says not_configured, with a 200, and reads nothing', async () => {
    for (const unset of ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_IDS'] as const) {
      process.env.META_ACCESS_TOKEN = TOKEN
      process.env.META_AD_ACCOUNT_IDS = 'act_1111111'
      delete process.env[unset]
      const res = await get()
      assert.equal(res.status, 200, unset)
      assert.deepEqual(await res.json(), { status: 'not_configured' })
    }
    process.env.META_AD_ACCOUNT_IDS = 'not-an-id'
    assert.deepEqual(await (await get()).json(), { status: 'not_configured' })
    assert.equal(calls.length, 0)
  })
})

describe('a configured run', () => {
  test('reads Meta only with GET and the token in a header, and saves what it read', async () => {
    const res = await get()
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.campaigns, 1)
    assert.equal(body.adSets, 1)

    assert.ok(metaCalls().length >= 4)
    for (const c of metaCalls()) {
      assert.equal(c.method, 'GET')
      assert.equal(c.headers.authorization, `Bearer ${TOKEN}`)
      assert.ok(!c.url.includes(TOKEN))
    }
    assert.ok(dbCalls().some(c => c.method === 'POST' && c.url.includes('/rest/v1/meta_campaigns')))
    assert.ok(dbCalls().some(c => c.method === 'POST' && c.url.includes('/rest/v1/meta_ad_sets')))
    const finished = dbCalls().find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/meta_sync_runs'))
    assert.ok(finished, 'the run is finished')
    assert.match(finished.body, /"status":"ok"/)
  })

  test('the token never goes to the database', async () => {
    await get()
    assert.ok(dbCalls().every(c => !c.body.includes(TOKEN) && !c.url.includes(TOKEN)))
  })

  test('a token Meta refuses answers 502, records the failure and saves no data', async () => {
    metaStatus = 401
    const res = await get()
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.status, 'failed')
    assert.match(body.message, /did not accept the token/)
    const finished = dbCalls().find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/meta_sync_runs'))
    assert.match(finished!.body, /"status":"failed"/)
    assert.ok(!dbCalls().some(c => c.method === 'POST' && /meta_(campaigns|ad_sets|insights_daily)/.test(c.url)))
  })
})

describe('the schedule', () => {
  test('vercel.json calls it every day at 00:40 UTC, which is 06:10 in India', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] }
    assert.deepEqual(config.crons.filter(c => c.path === '/api/integrations/meta/sync'), [{ path: '/api/integrations/meta/sync', schedule: '40 0 * * *' }])
  })
})
