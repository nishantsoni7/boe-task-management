/**
 * The punch feed for the operations ERP: what a punch looks like on the way out,
 * the push with its retries, the pull cursor and its checks, and the guarantees
 * around Minop's own reply. No database and no network are touched.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/partnerFeed.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PARTNER_MIN_SECRET_LENGTH,
  buildPartnerPage,
  decodeCursor,
  encodeCursor,
  forwardPunchesToPartner,
  parsePartnerQuery,
  partnerKeyMatches,
  partnerPunchId,
  partnerPushConfig,
  pushPartnerPunches,
  toPartnerPunch,
  type PartnerPunch,
} from './partnerFeed'
import { handleMinopPathTokenWebhook } from './pathTokenWebhook'

const TOKEN = 'push-token-0123456789-0123456789-abcd'
const URL_OK = 'https://erp.example.test/functions/receiveBoePunches'
const KEY = 'pull-key-0123456789-0123456789-abcdef'
const RECEIVED = '2026-11-03T04:36:10.000Z'
const ROW_ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'

const message = {
  trans: [{ txnId: '21', dvcId: '1', dvcIP: '127.0.0.2', punchId: '7', txnDateTime: '2026-11-03 10:04:12', mode: 'IN' }],
}

const config = { url: URL_OK, token: TOKEN }
const punch: PartnerPunch = toPartnerPunch({ dvc_id: '1', minop_user_id: '7', punch_local: '2026-11-03 10:04:12', first_seen_at: RECEIVED })

type Call = { url: string; init: RequestInit }
function fakeDeps(statuses: (number | 'network')[]) {
  const calls: Call[] = []
  const sleeps: number[] = []
  let n = 0
  return {
    calls,
    sleeps,
    deps: {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        const next = statuses[Math.min(n++, statuses.length - 1)]
        if (next === 'network') throw new Error('socket hang up')
        return new Response(null, { status: next })
      }) as typeof fetch,
      sleep: async (ms: number) => { sleeps.push(ms) },
    },
  }
}

// ---- the shape of a punch ------------------------------------------------

test('a punch goes out with its machine id, device, and both times on India clock', () => {
  assert.deepEqual(punch, {
    id: '1|7|2026-11-03 10:04:12',
    machineId: '7',
    deviceId: '1',
    punchTime: '2026-11-03T10:04:12+05:30',
    receivedAt: '2026-11-03T10:06:10.000+05:30',
  })
  assert.equal(Date.parse(punch.receivedAt), Date.parse(RECEIVED), 'the same instant, only written in IST')
})

test('a receipt late in the UTC evening is the next day in India', () => {
  const late = toPartnerPunch({ dvc_id: '1', minop_user_id: '7', punch_local: '2026-11-04 01:29:00', first_seen_at: '2026-11-03T20:00:00.123456+00:00' })
  assert.equal(late.receivedAt, '2026-11-04T01:30:00.123+05:30')
})

test('the same punch has the same id whether it came from a message or from the table', () => {
  assert.equal(partnerPunchId('1', '7', '2026-11-03 10:04:12'), partnerPunchId('1', '7', '2026-11-03T10:04:12'))
  assert.equal(partnerPunchId('1', '7', '2026-11-03T10:04:12.000'), '1|7|2026-11-03 10:04:12')
})

test('the feed is raw: no names, no attendance, no transaction number', () => {
  assert.deepEqual(Object.keys(punch).sort(), ['deviceId', 'id', 'machineId', 'punchTime', 'receivedAt'])
})

// ---- push settings -------------------------------------------------------

test('push is off until both settings are there, and stays off for an unsafe address or a short token', () => {
  assert.equal(partnerPushConfig({}), null)
  assert.equal(partnerPushConfig({ MINOP_PARTNER_PUSH_URL: URL_OK }), null)
  assert.equal(partnerPushConfig({ MINOP_PARTNER_PUSH_TOKEN: TOKEN }), null)
  assert.equal(partnerPushConfig({ MINOP_PARTNER_PUSH_URL: 'http://erp.example.test/x', MINOP_PARTNER_PUSH_TOKEN: TOKEN }), null)
  assert.equal(partnerPushConfig({ MINOP_PARTNER_PUSH_URL: 'not a url', MINOP_PARTNER_PUSH_TOKEN: TOKEN }), null)
  assert.equal(partnerPushConfig({ MINOP_PARTNER_PUSH_URL: URL_OK, MINOP_PARTNER_PUSH_TOKEN: 'x'.repeat(PARTNER_MIN_SECRET_LENGTH - 1) }), null)
  assert.deepEqual(partnerPushConfig({ MINOP_PARTNER_PUSH_URL: ` ${URL_OK} `, MINOP_PARTNER_PUSH_TOKEN: ` ${TOKEN} ` }), config)
})

// ---- the push ------------------------------------------------------------

test('a good reply ends it: one post, the token as a Bearer header, the punches as JSON', async () => {
  const { calls, sleeps, deps } = fakeDeps([200])
  assert.equal(await pushPartnerPunches([punch], config, deps), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, URL_OK)
  assert.equal(calls[0].init.method, 'POST')
  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.equal(headers.get('content-type'), 'application/json')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { punches: [punch] })
  assert.deepEqual(sleeps, [])
})

test('a busy or failing ERP is tried three times, one second then three seconds apart', async () => {
  const { calls, sleeps, deps } = fakeDeps([503, 'network', 200])
  assert.equal(await pushPartnerPunches([punch], config, deps), true)
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 3000])
})

test('after three failed tries it gives up quietly and the pull call stays the way to catch up', async () => {
  const { calls, deps } = fakeDeps(['network'])
  assert.equal(await pushPartnerPunches([punch], config, deps), false)
  assert.equal(calls.length, 3)
})

test('a refusal such as 401 is not retried: another try would not change it', async () => {
  for (const status of [400, 401, 403, 404]) {
    const { calls, sleeps, deps } = fakeDeps([status])
    assert.equal(await pushPartnerPunches([punch], config, deps), false, String(status))
    assert.equal(calls.length, 1, String(status))
    assert.deepEqual(sleeps, [])
  }
})

test('nothing to send means no call at all', async () => {
  const { calls, deps } = fakeDeps([200])
  assert.equal(await pushPartnerPunches([], config, deps), true)
  assert.equal(calls.length, 0)
})

// ---- what is forwarded from one stored message ----------------------------

const env = { MINOP_PARTNER_PUSH_URL: URL_OK, MINOP_PARTNER_PUSH_TOKEN: TOKEN }

test('every real punch in a message is forwarded, once, and nobody is filtered out by who they are', async () => {
  const { calls, deps } = fakeDeps([200])
  const two = { trans: [
    { txnId: '21', dvcId: '1', punchId: '7', txnDateTime: '2026-11-03 10:04:12' },
    { txnId: '22', dvcId: '1', punchId: '12', txnDateTime: '2026-11-03 10:05:00' },
    { txnId: '23', dvcId: '1', punchId: '7', txnDateTime: '2026-11-03 10:04:12' },
  ] }
  await forwardPunchesToPartner(RECEIVED, two, env, deps)
  assert.equal(calls.length, 1)
  const sent = JSON.parse(String(calls[0].init.body)).punches as PartnerPunch[]
  assert.deepEqual(sent.map(p => p.machineId).sort(), ['12', '7'])
})

test("Minop's own 2018 sample message is never forwarded", async () => {
  const { calls, deps } = fakeDeps([200])
  await forwardPunchesToPartner(RECEIVED, { trans: [{ txnId: '1', dvcId: '1', punchId: '1000', txnDateTime: '2018-05-11 12:00:00' }] }, env, deps)
  assert.equal(calls.length, 0)
})

test('with no settings, or a message with no punches, nothing is sent', async () => {
  const { calls, deps } = fakeDeps([200])
  await forwardPunchesToPartner(RECEIVED, message, {}, deps)
  await forwardPunchesToPartner(RECEIVED, { trans: [] }, env, deps)
  await forwardPunchesToPartner(RECEIVED, { status: 'hello' }, env, deps)
  assert.equal(calls.length, 0)
})

test("a dead ERP can never change what Minop is told: the reply is still the acknowledgement", async () => {
  const { deps } = fakeDeps(['network'])
  const response = await handleMinopPathTokenWebhook(
    new Request('https://boe.example.test/api/integrations/minop/webhook/t', { method: 'POST', body: JSON.stringify(message), headers: { 'content-type': 'application/json' } }),
    'a'.repeat(40),
    {
      configuredToken: 'a'.repeat(40),
      insertDelivery: async () => ({ ok: true, receivedAt: RECEIVED }),
      recordPunches: (receivedAt, payload) => forwardPunchesToPartner(receivedAt, payload, env, deps),
    },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { transStatus: [{ txnId: '21', status: 1 }] })
})

// ---- the pull: cursor and query ------------------------------------------

test('a cursor survives the round trip exactly, microseconds and all', () => {
  const cursor = { t: '2026-11-03T04:36:10.123456+00:00', i: ROW_ID }
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor)
})

test('anything that is not a cursor made by this feed is refused, including filter tricks', () => {
  const bad = [
    '', 'abc', '!!!',
    encodeCursor({ t: '2026-11-03T04:36:10Z),or(id.not.is.null', i: ROW_ID }),
    encodeCursor({ t: '2026-11-03T04:36:10Z', i: `${ROW_ID},id.gt.0` }),
    encodeCursor({ t: 'yesterday', i: ROW_ID }),
    Buffer.from('{"t":1,"i":2}').toString('base64url'),
  ]
  for (const text of bad) assert.equal(decodeCursor(text), null, text)
})

const q = (qs: string) => parsePartnerQuery(new URL(`https://boe.example.test/api/integrations/minop/partner/punches${qs}`))

test('the query: defaults, limits and machine ids are all checked', () => {
  assert.deepEqual(q(''), { ok: true, query: { cursor: null, limit: 500, machineIds: null } })
  assert.deepEqual(q('?limit=50&machineIds=7, 8,12'), { ok: true, query: { cursor: null, limit: 50, machineIds: ['7', '8', '12'] } })
  for (const bad of ['?limit=0', '?limit=501', '?limit=abc', '?limit=-1', '?machineIds=', '?machineIds=7;drop', '?machineIds=a)b', '?since=nonsense']) {
    assert.equal(q(bad).ok, false, bad)
  }
  assert.equal(q(`?machineIds=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`).ok, false)
})

const row = (n: number, over: Record<string, string> = {}) => ({
  id: `3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b${String(n).padStart(2, '0')}`,
  dvc_id: '1',
  minop_user_id: '7',
  punch_local: '2026-11-03T10:04:12',
  punch_at: '2026-11-03T04:34:12+00:00',
  first_seen_at: '2026-11-03T04:36:10.123456+00:00',
  ...over,
})

test('a page lists the punches and a cursor that picks up after the last row; a full page says there is more', () => {
  const rows = [row(10), row(11, { minop_user_id: '8' })]
  const page = buildPartnerPage(rows, { cursor: null, limit: 2, machineIds: null })
  assert.equal(page.punches.length, 2)
  assert.equal(page.more, true)
  assert.deepEqual(decodeCursor(page.cursor!), { t: '2026-11-03T04:36:10.123456+00:00', i: rows[1].id })
  assert.equal(buildPartnerPage(rows, { cursor: null, limit: 3, machineIds: null }).more, false)
})

test('no new rows: the cursor you sent comes back, so you can keep asking from the same place', () => {
  const since = { t: '2026-11-03T04:36:10.123456+00:00', i: ROW_ID }
  const page = buildPartnerPage([], { cursor: since, limit: 500, machineIds: null })
  assert.deepEqual(page.punches, [])
  assert.equal(page.more, false)
  assert.deepEqual(decodeCursor(page.cursor!), since)
  assert.equal(buildPartnerPage([], { cursor: null, limit: 500, machineIds: null }).cursor, null)
})

test("a row that is not a real punch is left out but the cursor still moves past it", () => {
  const sample = row(20, { punch_local: '2018-05-11T12:00:00', punch_at: '2018-05-11T06:30:00+00:00', minop_user_id: '1000' })
  const page = buildPartnerPage([sample], { cursor: null, limit: 500, machineIds: null })
  assert.deepEqual(page.punches, [])
  assert.deepEqual(decodeCursor(page.cursor!)?.i, sample.id)
})

test('the pull key: exact match only, and a short or missing key opens nothing', () => {
  assert.equal(partnerKeyMatches(`Bearer ${KEY}`, KEY), true)
  assert.equal(partnerKeyMatches(`bearer ${KEY}`, KEY), true)
  for (const header of [null, '', 'Bearer ', `Bearer ${KEY}x`, `Bearer ${KEY.slice(1)}`, KEY, 'Basic abc']) {
    assert.equal(partnerKeyMatches(header, KEY), false, String(header))
  }
  assert.equal(partnerKeyMatches('Bearer short', 'short'), false)
  assert.equal(partnerKeyMatches(`Bearer ${KEY}`, undefined), false)
})

// ---- wiring ---------------------------------------------------------------

test('the Minop receiver hands punches to the push after answering Minop, and may run long enough to retry', () => {
  const route = readFileSync('src/app/api/integrations/minop/webhook/[token]/route.ts', 'utf8')
  assert.match(route, /after\(\(\) => forwardPunchesToPartner\(receivedAt, payload\)\)/)
  assert.match(route, /export const maxDuration = 30/)
  assert.ok(route.indexOf('after(') < route.indexOf('const svc = serviceClient()', route.indexOf('async function recordPunches')),
    'the push is scheduled before attendance is rebuilt, so a failure there cannot skip it')
})

test('the header-authenticated route does not push: only the route the real machine reaches does', () => {
  assert.doesNotMatch(readFileSync('src/app/api/integrations/minop/webhook/route.ts', 'utf8'), /partnerFeed/)
})
