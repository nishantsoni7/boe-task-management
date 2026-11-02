/**
 * What the Meta Ads screens draw, from stored rows. Every number here is made up: nothing from the owner's ad account
 * belongs in this public repository.
 *
 * Run: npx tsx --test src/lib/meta/report.test.ts
 */
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  budgetLabel, buildReport, dayLabel, money, rangeOf, rupees, rupeesWhole, STALE_RUN_MINUTES, syncBadge, syncView,
  type MetaAdSet, type MetaCampaign, type MetaInsight, type MetaRun,
} from './report'
import { CHAT_ACTION } from './results'
import { STALE_RUNNING_MINUTES } from './sync'

const rs = (n: number) => n * 100
const campaign = (id: string, over: Partial<MetaCampaign> = {}): MetaCampaign => ({
  campaign_id: id, name: `Campaign ${id}`, effective_status: 'ACTIVE', daily_budget_paise: null, lifetime_budget_paise: null, ...over,
})
const adSet = (id: string, campaignId: string, over: Partial<MetaAdSet> = {}): MetaAdSet => ({
  ad_set_id: id, campaign_id: campaignId, name: `Ad set ${id}`, effective_status: 'ACTIVE', optimization_goal: 'CONVERSATIONS',
  daily_budget_paise: rs(500), lifetime_budget_paise: null, ...over,
})
const day = (adSetId: string, campaignId: string, spend: number, chats: number, date = '2026-10-10'): MetaInsight => ({
  ad_set_id: adSetId, campaign_id: campaignId, day: date, spend_paise: rs(spend), actions: [{ action_type: CHAT_ACTION, value: String(chats) }],
})

describe('money and dates', () => {
  test('rupees, always two places; whole rupees for headlines; a budget keeps paise only when it has them', () => {
    assert.equal(rupees(158570), '₹1,585.70')
    assert.equal(rupeesWhole(944412), '₹9,444')
    assert.equal(money(rs(500)), '₹500')
    assert.equal(money(50050), '₹500.50')
    assert.equal(rupees(1234567890), '₹1,23,45,678.90')
  })

  test('a budget reads per day, or in total, or as the fallback', () => {
    assert.equal(budgetLabel(rs(200), null), '₹200 a day')
    assert.equal(budgetLabel(null, rs(9000)), '₹9,000 in total')
    assert.equal(budgetLabel(null, null), '—')
    assert.equal(budgetLabel(null, null, 'Per ad set'), 'Per ad set')
  })

  test('the range ends yesterday, like Ads Manager, and names its days', () => {
    const r = rangeOf(30, '2026-11-02')
    assert.deepEqual([r.from, r.to], ['2026-10-03', '2026-11-01'])
    assert.equal(r.label, 'Last 30 days · 3 Oct to 1 Nov 2026')
    assert.equal(rangeOf(365, '2026-11-02').short, 'Last 12 months')
    assert.equal(dayLabel('2026-01-09'), '9 Jan')
  })
})

describe('buildReport', () => {
  test('an ad set is its own results; the campaign is the sum; the account is everything', () => {
    const report = buildReport({
      campaigns: [campaign('1001')],
      adSets: [adSet('2001', '1001'), adSet('2002', '1001')],
      insights: [day('2001', '1001', 4000, 40), day('2001', '1001', 1000, 10, '2026-10-11'), day('2002', '1001', 2000, 5)],
      targetPaise: null,
    })
    const [c] = report.campaigns
    assert.equal(c.spendPaise, rs(7000))
    assert.equal(c.chats, 55)
    assert.equal(Math.round(c.costPaise ?? 0), Math.round(rs(7000) / 55))
    assert.deepEqual(c.adSets.map(a => [a.id, a.spendPaise, a.chats]), [['2001', rs(5000), 50], ['2002', rs(2000), 5]])
    assert.equal(report.totals.spendPaise, rs(7000))
    assert.equal(report.totals.chats, 55)
  })

  test('a campaign is judged on its totals and an ad set on its own', () => {
    const report = buildReport({
      campaigns: [campaign('1001')],
      adSets: [adSet('2001', '1001'), adSet('2002', '1001')],
      insights: [day('2001', '1001', 4000, 50), day('2002', '1001', 1500, 4)],
      targetPaise: null,
    })
    assert.equal(report.campaigns[0].verdict, 'watch')
    assert.deepEqual(report.campaigns[0].adSets.map(a => a.verdict), ['watch', 'too_early'])
  })

  test('a goal with no result count has spend but no results and no verdict', () => {
    const report = buildReport({
      campaigns: [campaign('1001')],
      adSets: [adSet('2001', '1001', { optimization_goal: 'PROFILE_VISIT' })],
      insights: [day('2001', '1001', 900, 33)],
      targetPaise: rs(100),
    })
    const [c] = report.campaigns
    assert.equal(c.spendPaise, rs(900))
    assert.equal(c.chats, null)
    assert.equal(c.costPaise, null)
    assert.equal(c.verdict, 'other_goal')
    assert.equal(report.totals.chats, null)
  })

  test('a campaign with no delivery in the period reads as no data, never as zero chats', () => {
    const report = buildReport({ campaigns: [campaign('1001', { effective_status: 'PAUSED' })], adSets: [adSet('2001', '1001', { effective_status: 'PAUSED' })], insights: [], targetPaise: rs(100) })
    assert.equal(report.campaigns[0].verdict, 'no_data')
    assert.equal(report.campaigns[0].chats, null)
    assert.deepEqual(report.campaigns[0].adSets, [])
  })

  test('a mixed campaign is judged on the part that chases chats', () => {
    const report = buildReport({
      campaigns: [campaign('1001')],
      adSets: [adSet('2001', '1001'), adSet('2002', '1001', { optimization_goal: 'PROFILE_VISIT' })],
      insights: [day('2001', '1001', 4000, 40), day('2002', '1001', 9000, 70)],
      targetPaise: rs(100),
    })
    const [c] = report.campaigns
    assert.equal(c.spendPaise, rs(13000))
    assert.equal(c.chats, 40)
    assert.equal(Math.round(c.costPaise ?? 0), rs(100)) // 4,000 over 40 chats, not 13,000 over 40
    assert.equal(c.verdict, 'winning')
  })

  test('running campaigns come first, then by spend', () => {
    const report = buildReport({
      campaigns: [campaign('1', { effective_status: 'PAUSED' }), campaign('2'), campaign('3', { effective_status: 'PAUSED' })],
      adSets: [adSet('21', '1'), adSet('22', '2'), adSet('23', '3')],
      insights: [day('21', '1', 900, 9), day('22', '2', 100, 1), day('23', '3', 5000, 50)],
      targetPaise: null,
    })
    assert.deepEqual(report.campaigns.map(c => c.id), ['2', '3', '1'])
  })

  test('spend on an ad set Meta no longer lists stays in the campaign and is shown as its own line', () => {
    const report = buildReport({
      campaigns: [campaign('1001')],
      adSets: [adSet('2001', '1001')],
      insights: [day('2001', '1001', 1000, 10), day('9999', '1001', 3000, 30)],
      targetPaise: null,
    })
    const [c] = report.campaigns
    assert.equal(c.spendPaise, rs(4000))
    assert.equal(c.chats, 40)
    assert.equal(c.unlisted?.spendPaise, rs(3000))
    assert.equal(c.unlisted?.chats, 30)
    assert.equal(c.adSets[0].spendPaise + (c.unlisted?.spendPaise ?? 0), c.spendPaise)
  })

  test('spend on a campaign Meta no longer lists still appears', () => {
    const report = buildReport({ campaigns: [], adSets: [], insights: [day('9999', '8888', 700, 7)], targetPaise: null })
    assert.equal(report.campaigns.length, 1)
    assert.equal(report.campaigns[0].spendPaise, rs(700))
  })

  test('the running verdict takes every running chat ad set together; an off ad set does not count', () => {
    const report = buildReport({
      campaigns: [campaign('1001')],
      adSets: [adSet('2001', '1001'), adSet('2002', '1001'), adSet('2003', '1001', { effective_status: 'PAUSED' })],
      insights: [day('2001', '1001', 4000, 40), day('2002', '1001', 1000, 2), day('2003', '1001', 9000, 900)],
      targetPaise: rs(100),
    })
    assert.equal(report.runningAdSets, 2)
    assert.equal(report.runningCampaigns, 1)
    assert.deepEqual([report.runningVerdict?.spendPaise, report.runningVerdict?.chats], [rs(5000), 42])
    assert.equal(report.runningVerdict?.verdict, 'watch') // about 119 a chat against a target of 100
  })

  test('nothing running means no running verdict', () => {
    const report = buildReport({ campaigns: [campaign('1', { effective_status: 'PAUSED' })], adSets: [adSet('21', '1', { effective_status: 'PAUSED' })], insights: [day('21', '1', 100, 1)], targetPaise: null })
    assert.equal(report.runningVerdict, null)
  })

  test('a campaign budget, else per ad set when the ad sets hold it', () => {
    const report = buildReport({
      campaigns: [campaign('1', { daily_budget_paise: rs(150) }), campaign('2'), campaign('3')],
      adSets: [adSet('21', '2'), adSet('31', '3', { daily_budget_paise: null })],
      insights: [], targetPaise: null,
    })
    const budget = (id: string) => report.campaigns.find(c => c.id === id)?.budget
    assert.deepEqual([budget('1'), budget('2'), budget('3')], ['₹150 a day', 'Per ad set', '—'])
  })
})

describe('syncView', () => {
  const now = new Date('2026-11-02T10:00:00Z')
  const run = (over: Partial<MetaRun>): MetaRun => ({
    kind: 'daily', status: 'ok', message: '', campaigns: 1, ad_sets: 1, insight_rows: 1,
    started_at: '2026-11-02T00:40:00Z', finished_at: '2026-11-02T00:41:00Z', ...over,
  })

  test('the same fifteen minutes as the sync itself', () => {
    assert.equal(STALE_RUN_MINUTES, STALE_RUNNING_MINUTES)
  })

  test('no run yet', () => {
    assert.deepEqual(syncView([], now), { kind: 'none' })
  })

  test('a first run still going, and one that died', () => {
    assert.equal(syncView([run({ kind: 'first', status: 'running', finished_at: null, started_at: '2026-11-02T09:50:00Z' })], now).kind, 'first_running')
    const dead = syncView([run({ kind: 'first', status: 'running', finished_at: null, started_at: '2026-11-02T09:30:00Z' })], now)
    assert.equal(dead.kind, 'failed')
  })

  test('a failed run keeps the last good time', () => {
    const view = syncView([run({ status: 'failed', message: 'Meta did not accept the token' }), run({ started_at: '2026-11-01T00:40:00Z', finished_at: '2026-11-01T00:41:00Z' })], now)
    assert.deepEqual(view, { kind: 'failed', message: 'Meta did not accept the token', lastOkAt: '2026-11-01T00:41:00Z' })
  })

  test('a daily run in progress still shows the last good reading as current', () => {
    const view = syncView([run({ status: 'running', finished_at: null, started_at: '2026-11-02T09:55:00Z' }), run({})], now)
    assert.deepEqual(view, { kind: 'ok', lastOkAt: '2026-11-02T00:41:00Z' })
  })

  test('the badge says when, in Indian time, and turns amber when old or failed', () => {
    const today = '2026-11-02'
    const fresh = syncBadge({ kind: 'ok', lastOkAt: '2026-11-02T00:41:00Z' }, now, today)
    assert.deepEqual(fresh, { text: 'Synced today, 6:11 am', tone: 'completed' })
    const old = syncBadge({ kind: 'ok', lastOkAt: '2026-10-30T00:41:00Z' }, now, today)
    assert.deepEqual(old, { text: 'Synced 30 Oct, 6:11 am', tone: 'waiting' })
    assert.deepEqual(syncBadge({ kind: 'failed', message: 'x', lastOkAt: null }, now, today), { text: 'Out of date', tone: 'waiting' })
    assert.equal(syncBadge({ kind: 'none' }, now, today), null)
  })
})
