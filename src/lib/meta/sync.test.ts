/**
 * The sync, run against a stand-in store and a stand-in Meta: what it reads, how far back, what it writes, and that
 * a failure leaves the earlier rows alone. The figures are made up; the repository is public.
 *
 * Run: npx tsx --test src/lib/meta/sync.test.ts
 */
import { strict as assert } from 'node:assert'
import { beforeEach, describe, test } from 'node:test'
import { FIRST_SYNC_DAYS, insightWindows, runMetaSync } from './sync'
import type { MetaStore, MetaTable, RunFinish, RunKind } from './store'

const NOW = new Date('2026-11-02T03:00:00Z') // 08:30 in India, so the Indian day is 2026-11-02
const ACCOUNT = '1111111'
const TOKEN = 'test-token'

type Upsert = { table: MetaTable; rows: Record<string, unknown>[]; onConflict: string }
let upserts: Upsert[]
let runs: { id: string; kind?: RunKind; finish?: RunFinish }[]
let running: boolean
let hasOk: boolean
let failWriteTo: MetaTable | null

const store: MetaStore = {
  async hasRunningSince() { return running },
  async hasOkRun() { return hasOk },
  async startRun(kind) { runs.push({ id: 'run-1', kind }); return 'run-1' },
  async finishRun(id, finish) { runs.find(r => r.id === id)!.finish = finish },
  async upsert(table, rows, onConflict) {
    if (table === failWriteTo) throw new Error('Saving ' + table + ' failed: boom')
    upserts.push({ table, rows: rows as Record<string, unknown>[], onConflict })
  },
}

type Meta = { account?: Record<string, unknown>; status?: number; insightsFor?: (range: { since: string; until: string }) => Record<string, unknown>[] }
let urls: string[]
function fakeMeta(meta: Meta = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (meta.status) return new Response(JSON.stringify({ error: { code: 190 } }), { status: meta.status })
    const path = new URL(url).pathname.replace(/^\/v[0-9.]+\//, '')
    const params = new URL(url).searchParams
    if (path === `act_${ACCOUNT}`) {
      return Response.json(meta.account ?? { account_id: ACCOUNT, name: 'Main', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1, created_time: '2026-10-01T10:00:00+0530' })
    }
    if (path.endsWith('/campaigns')) return Response.json({ data: [{ id: '2222222', name: 'Spring', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' }] })
    if (path.endsWith('/adsets')) return Response.json({ data: [{ id: '3333333', campaign_id: '2222222', name: 'Chats', optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP' }] })
    if (path.endsWith('/insights')) {
      const range = JSON.parse(params.get('time_range')!) as { since: string; until: string }
      return Response.json({ data: meta.insightsFor ? meta.insightsFor(range) : [{ adset_id: '3333333', campaign_id: '2222222', date_start: range.since, spend: '100.50', impressions: '900', clicks: '12', actions: [] }] })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

const run = (fetchImpl: typeof fetch) => runMetaSync({ store, token: TOKEN, accountIds: [ACCOUNT], fetchImpl, now: NOW })
const tables = () => upserts.map(u => u.table)

beforeEach(() => { upserts = []; runs = []; running = false; hasOk = false; failWriteTo = null; urls = [] })

describe('the windows', () => {
  test('cover the range with no gap and no overlap, and the last one ends on the day asked', () => {
    const windows = insightWindows('2026-01-01', '2026-11-02')
    assert.equal(windows[0].since, '2026-01-01')
    assert.equal(windows.at(-1)!.until, '2026-11-02')
    for (let i = 1; i < windows.length; i++) {
      const previous = new Date(`${windows[i - 1].until}T00:00:00Z`).getTime()
      assert.equal(new Date(`${windows[i].since}T00:00:00Z`).getTime() - previous, 86_400_000)
    }
    for (const w of windows) assert.ok((new Date(w.until).getTime() - new Date(w.since).getTime()) / 86_400_000 <= 89)
  })

  test('one day is one window, and a start after the end is none', () => {
    assert.deepEqual(insightWindows('2026-11-02', '2026-11-02'), [{ since: '2026-11-02', until: '2026-11-02' }])
    assert.deepEqual(insightWindows('2026-11-03', '2026-11-02'), [])
  })
})

describe('a first sync', () => {
  test('reads from the day the account was created, in the order the tables need, and records an ok run', async () => {
    const result = await run(fakeMeta())
    assert.deepEqual(result, { status: 'ok', message: '', campaigns: 1, adSets: 1, insightRows: 1 })
    assert.equal(runs[0].kind, 'first')
    assert.deepEqual(runs[0].finish, { status: 'ok', message: '', campaigns: 1, ad_sets: 1, insight_rows: 1 })
    // Parents before children, so the foreign keys hold.
    assert.deepEqual(tables(), ['meta_ad_accounts', 'meta_campaigns', 'meta_ad_sets', 'meta_insights_daily', 'meta_ad_accounts'])
    const range = JSON.parse(new URL(urls.find(u => u.includes('/insights'))!).searchParams.get('time_range')!)
    assert.deepEqual(range, { since: '2026-10-01', until: '2026-11-02' })
  })

  test('writes whole paise and the day on which each row is unique', async () => {
    await run(fakeMeta())
    const insights = upserts.find(u => u.table === 'meta_insights_daily')!
    assert.equal(insights.onConflict, 'ad_set_id,day')
    assert.equal(insights.rows[0].spend_paise, 10050)
    assert.equal(upserts.find(u => u.table === 'meta_campaigns')!.rows[0].daily_budget_paise, 50000)
    const synced = upserts.at(-1)!
    assert.equal(synced.rows[0].last_synced_at, NOW.toISOString())
  })

  test('an old account is read back about three years, in windows', async () => {
    await run(fakeMeta({ account: { account_id: ACCOUNT, name: 'Main', currency: 'INR', created_time: '2019-01-01T00:00:00+0530' } }))
    const ranges = urls.filter(u => u.includes('/insights')).map(u => JSON.parse(new URL(u).searchParams.get('time_range')!) as { since: string; until: string })
    assert.equal(ranges.length, insightWindows(ranges[0].since, '2026-11-02').length)
    assert.ok(ranges.length > 10)
    const days = (new Date('2026-11-02').getTime() - new Date(ranges[0].since).getTime()) / 86_400_000
    assert.equal(days, FIRST_SYNC_DAYS)
  })
})

describe('a daily sync', () => {
  test('reads the last 30 days again, because Meta settles late results', async () => {
    hasOk = true
    await run(fakeMeta())
    assert.equal(runs[0].kind, 'daily')
    const range = JSON.parse(new URL(urls.find(u => u.includes('/insights'))!).searchParams.get('time_range')!)
    assert.deepEqual(range, { since: '2026-10-03', until: '2026-11-02' })
  })

  test('does nothing when a sync started in the last 15 minutes is still running', async () => {
    running = true
    const result = await run(fakeMeta())
    assert.equal(result.status, 'busy')
    assert.equal(runs.length, 0)
    assert.equal(urls.length, 0)
    assert.equal(upserts.length, 0)
  })
})

describe('a failure', () => {
  test('a token Meta refuses fails the run, says why, and writes no data', async () => {
    const result = await run(fakeMeta({ status: 401 }))
    assert.equal(result.status, 'failed')
    assert.match(result.message, /did not accept the token/)
    assert.equal(runs[0].finish?.status, 'failed')
    assert.equal(upserts.length, 0)
  })

  test('an account that is not in rupees is refused before anything is written for it', async () => {
    const result = await run(fakeMeta({ account: { account_id: ACCOUNT, name: 'Main', currency: 'USD' } }))
    assert.equal(result.status, 'failed')
    assert.match(result.message, /Only rupee ad accounts/)
    assert.equal(upserts.length, 0)
  })

  test('Meta answering for another account is refused', async () => {
    const result = await run(fakeMeta({ account: { account_id: '9999999', name: 'Other', currency: 'INR' } }))
    assert.equal(result.status, 'failed')
    assert.match(result.message, /different ad account/)
    assert.equal(upserts.length, 0)
  })

  test('a result Meta sends without a date fails the run and keeps what was read before it', async () => {
    const result = await run(fakeMeta({ insightsFor: () => [{ adset_id: '3333333', campaign_id: '2222222', spend: '1' }] }))
    assert.equal(result.status, 'failed')
    assert.match(result.message, /without a date/)
    assert.ok(!tables().includes('meta_insights_daily'))
  })

  test('a write that fails is recorded as the run failing, with the counts so far', async () => {
    failWriteTo = 'meta_ad_sets'
    const result = await run(fakeMeta())
    assert.equal(result.status, 'failed')
    assert.match(result.message, /meta_ad_sets failed/)
    assert.equal(runs[0].finish?.status, 'failed')
    assert.equal(runs[0].finish?.insight_rows, 0)
  })

  test('the token never appears in a message that is saved', async () => {
    const result = await run(fakeMeta({ status: 401 }))
    assert.ok(!result.message.includes(TOKEN))
    assert.ok(!(runs[0].finish?.message ?? '').includes(TOKEN))
  })
})
