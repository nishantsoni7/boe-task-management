/**
 * GET /api/integrations/minop/partner/punches, the handler run against a stand-in for Supabase behind a stubbed
 * `fetch`. Proves the door (no key set means closed, a wrong key reads nothing), that bad queries read nothing,
 * and exactly what a good call asks the database: in the order rows were added, only rows two minutes old, a
 * cursor that cannot skip rows that share an insert time, and the machine-id filter.
 *
 * Run: npx tsx --test src/app/api/integrations/minop/partner/punches/route.test.ts
 */
import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { GET } from './route'
import { decodeCursor, encodeCursor } from '@/lib/minop/partnerFeed'

const KEY = 'pull-key-0123456789-0123456789-abcdef'
const ROW_ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'
const realFetch = globalThis.fetch
const saved = { ...process.env }
let dbCalls: URL[]
let rows: Record<string, unknown>[]
let dbError: boolean

const get = (qs = '', authorization: string | null = `Bearer ${KEY}`) =>
  GET(new Request(`http://localhost/api/integrations/minop/partner/punches${qs}`, { headers: authorization ? { authorization } : {} }))

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, dvc_id: '1', minop_user_id: '7', punch_local: '2026-11-03T10:04:12', punch_at: '2026-11-03T04:34:12+00:00',
  first_seen_at: '2026-11-03T04:36:10.123456+00:00', created_at: '2026-11-03T04:36:11.654321+00:00', ...over,
})

beforeEach(() => {
  dbCalls = []
  rows = []
  dbError = false
  process.env.MINOP_PARTNER_PULL_KEY = KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    dbCalls.push(new URL(String(input)))
    return dbError ? Response.json({ message: 'boom' }, { status: 500 }) : Response.json(rows)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...saved }
})

describe('the door', () => {
  test('with no key set, or a short one, it is closed and reads nothing', async () => {
    delete process.env.MINOP_PARTNER_PULL_KEY
    assert.equal((await get()).status, 503)
    process.env.MINOP_PARTNER_PULL_KEY = 'short'
    assert.equal((await get('', 'Bearer short')).status, 503)
    assert.equal(dbCalls.length, 0)
  })

  test('no key, or a wrong one of any length, reads nothing', async () => {
    for (const auth of [null, 'Bearer ', 'Bearer wrong', `Bearer ${KEY}x`, KEY]) {
      assert.equal((await get('', auth)).status, 401, String(auth))
    }
    assert.equal(dbCalls.length, 0)
  })

  test('a bad query is refused before the database is asked', async () => {
    for (const qs of ['?since=nonsense', '?limit=0', '?limit=501', '?machineIds=7;drop', '?machineIds=']) {
      assert.equal((await get(qs)).status, 400, qs)
    }
    assert.equal(dbCalls.length, 0)
  })
})

describe('a good call', () => {
  test('asks for punches in the order they were added, two minutes old or more, 500 at a time', async () => {
    rows = [row(ROW_ID)]
    const before = Date.now()
    const res = await get()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(dbCalls.length, 1)
    const url = dbCalls[0]
    assert.equal(url.pathname, '/rest/v1/minop_punches')
    assert.equal(url.searchParams.get('order'), 'created_at.asc,id.asc')
    assert.equal(url.searchParams.get('limit'), '500')
    assert.equal(url.searchParams.get('or'), null)
    assert.equal(url.searchParams.get('minop_user_id'), null)
    const settle = url.searchParams.get('created_at') ?? ''
    assert.match(settle, /^lt\./)
    const bound = Date.parse(settle.slice(3))
    assert.ok(bound <= before - 120_000 + 1_000 && bound >= before - 120_000 - 5_000, `settle bound ${settle} is two minutes back`)
    assert.deepEqual(await res.json(), {
      punches: [{ id: '1|7|2026-11-03 10:04:12', machineId: '7', deviceId: '1', punchTime: '2026-11-03T10:04:12+05:30', receivedAt: '2026-11-03T10:06:10.123+05:30' }],
      cursor: encodeCursor({ t: '2026-11-03T04:36:11.654321+00:00', i: ROW_ID }),
      more: false,
    })
  })

  test('a cursor asks for rows added after it, or at the same moment with a later id, so a tie cannot skip a row', async () => {
    const t = '2026-11-03T04:36:11.654321+00:00'
    await get(`?since=${encodeURIComponent(encodeCursor({ t, i: ROW_ID }))}&limit=2`)
    const url = dbCalls[0]
    assert.equal(url.searchParams.get('or'), `(created_at.gt.${t},and(created_at.eq.${t},id.gt.${ROW_ID}))`)
    assert.equal(url.searchParams.get('limit'), '2')
  })

  test('machineIds narrows the read to those people', async () => {
    await get('?machineIds=7,12')
    assert.equal(dbCalls[0].searchParams.get('minop_user_id'), 'in.(7,12)')
  })

  test('a full page says there is more, and its cursor is the last row', async () => {
    const second = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b91'
    rows = [row(ROW_ID), row(second, { minop_user_id: '8' })]
    const body = await (await get('?limit=2')).json()
    assert.equal(body.more, true)
    assert.equal(body.punches.length, 2)
    assert.equal(decodeCursor(body.cursor)?.i, second)
  })

  test("Minop's 2018 sample punch is not handed out", async () => {
    rows = [row(ROW_ID, { minop_user_id: '1000', punch_local: '2018-05-11T12:00:00', punch_at: '2018-05-11T06:30:00+00:00' })]
    const body = await (await get()).json()
    assert.deepEqual(body.punches, [])
    assert.equal(decodeCursor(body.cursor)?.i, ROW_ID)
  })

  test('a database failure answers 500 and says nothing about why', async () => {
    dbError = true
    const res = await get()
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'The feed could not read the punches.' })
  })
})
