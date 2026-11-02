/**
 * The Monday review, with made-up figures: the week's figures, the check on Claude's answer, what is saved, and that a
 * failed or repeated run leaves good rows alone.
 *
 * Run: npx tsx --test src/lib/meta/review.test.ts
 */
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { MetaStructure } from './api'
import type { MetaAdSet, MetaCampaign, MetaInsight, MetaRun } from './report'
import { CHAT_ACTION } from './results'
import { planLearnings, planNeeds, runMetaReview, type Ask, type Loaded, type ReviewStore } from './review'
import { parseReviewAnswer, unknownFigures } from './reviewAnswer'
import { lessonStrength, reviewedWeek, ruleNeeds, weeklyFacts, weekVerdict } from './weekly'

const NOW = new Date('2026-11-09T02:30:00Z') // Monday 9 Nov, 8 am in India
const TODAY = '2026-11-09'
const rs = (n: number) => n * 100

const campaigns: MetaCampaign[] = [
  { campaign_id: '1001', name: 'Alpha', effective_status: 'ACTIVE', created_time: '2026-01-01T00:00:00Z', daily_budget_paise: null, lifetime_budget_paise: null },
  { campaign_id: '1002', name: 'Beta Boost', effective_status: 'ACTIVE', created_time: '2026-01-01T00:00:00Z', daily_budget_paise: rs(100), lifetime_budget_paise: null },
  { campaign_id: '1003', name: 'Gamma New', effective_status: 'ACTIVE', created_time: '2026-11-08T00:00:00Z', daily_budget_paise: rs(100), lifetime_budget_paise: null },
]
const adSets: MetaAdSet[] = [
  { ad_set_id: '2001', campaign_id: '1001', name: 'City 400 Chats', effective_status: 'ACTIVE', optimization_goal: 'CONVERSATIONS', daily_budget_paise: rs(500), lifetime_budget_paise: null },
  { ad_set_id: '2002', campaign_id: '1001', name: 'Auto Chats', effective_status: 'PAUSED', optimization_goal: 'CONVERSATIONS', daily_budget_paise: null, lifetime_budget_paise: null },
]
const row = (id: string, day: string, spend: number, chats: number): MetaInsight => ({
  ad_set_id: id, campaign_id: '1001', day, spend_paise: rs(spend), actions: [{ action_type: CHAT_ACTION, value: String(chats) }],
})
const insights = [row('2001', '2026-11-03', 4000, 40), row('2002', '2026-11-04', 1000, 10), row('2001', '2026-10-27', 3000, 60), row('2001', '2026-11-09', 9999, 9999)]
const settings = { monthly_cap_paise: null, target_cost_per_enquiry_paise: null }
const facts = weeklyFacts({ campaigns, adSets, insights, settings, today: TODAY })

const answer = {
  headline: 'Dearer week', summary: 'Spend was ₹5,000.00 for 50 chats.',
  keep: [{ title: 'City 400 Chats', why: '40 chats at ₹100.00', refs: ['2001'] }],
  lookAt: [{ title: 'Auto Chats', why: '10 chats', refs: ['2002'] }],
  tryNext: [{ title: 'A second city', why: 'Worth a test', refs: [] }],
  learnings: [{ key: 'city-beats-auto', title: 'City holds up', evidence: 'City 400 Chats at ₹100.00', refs: ['2001'] }],
}

const run = (over: Partial<MetaRun> = {}): MetaRun => ({
  kind: 'daily', status: 'ok', message: '', campaigns: 1, ad_sets: 1, insight_rows: 1, started_at: '2026-11-09T00:40:00Z', finished_at: '2026-11-09T00:41:00Z', ...over,
})

function fakeStore(over: Partial<Loaded> = {}) {
  const saved = { reviews: [] as Record<string, unknown>[], learnings: [] as object[], needs: [] as object[] }
  const structure: MetaStructure = { accounts: [], campaigns, adSets, runs: [run()], settings, monthSpendPaise: 0 }
  const store: ReviewStore = {
    load: async () => ({ structure, insights, learnings: [], needs: [], reviewStatus: null, ...over }),
    saveReview: async row => { saved.reviews.push(row as Record<string, unknown>) },
    saveLearnings: async rows => { saved.learnings.push(...rows) },
    saveNeeds: async rows => { saved.needs.push(...rows) },
  }
  return { store, saved }
}
const says = (input: unknown): Ask & { calls: string[] } => {
  const calls: string[] = []
  return Object.assign(async (_system: string, prompt: string) => { calls.push(prompt); return { input, model: 'claude-test' } }, { calls })
}

describe('the week', () => {
  test('is the last full Monday to Sunday, whatever day it runs', () => {
    assert.deepEqual(reviewedWeek('2026-11-09'), { start: '2026-11-02', end: '2026-11-08', previousStart: '2026-10-26', previousEnd: '2026-11-01' })
    assert.equal(reviewedWeek('2026-11-15').start, '2026-11-02')
  })

  test('today is left out, and the figures compare with the week before', () => {
    assert.equal(facts.thisWeek.spendPaise, rs(5000))
    assert.equal(facts.thisWeek.chats, 50)
    assert.equal(facts.lastWeek.spendPaise, rs(3000))
    assert.deepEqual(facts.changePercent, { spent: 67, chats: -17, costPerChat: 100 })
    assert.equal(facts.verdict, 'worse')
  })

  test('cost per chat must move 10% to count, and a week too small to judge is quiet', () => {
    const p = (cost: number, chats = 100) => ({ spendPaise: cost * chats, chatSpendPaise: cost * chats, chats, costPaise: cost, spent: '', costPerChat: '' })
    assert.equal(weekVerdict(p(89), p(100)), 'better')
    assert.equal(weekVerdict(p(91), p(100)), 'same')
    assert.equal(weekVerdict(p(109), p(100)), 'same')
    assert.equal(weekVerdict(p(110), p(100)), 'worse')
    assert.equal(weekVerdict(p(1000, 5), p(100)), 'quiet')
  })

  test('a running campaign older than the week that spent nothing is named; a new one is not', () => {
    assert.deepEqual(facts.silentCampaigns.map(c => c.name), ['Beta Boost'])
  })

  test('how far a lesson can be trusted comes from the chats behind it, not from Claude', () => {
    assert.equal(lessonStrength(['2002'], facts), 'thin')
    assert.equal(lessonStrength(['2001'], facts), 'solid')
  })
})

describe('the check on the answer', () => {
  test('a good answer passes', () => {
    assert.equal(parseReviewAnswer(answer, facts).keep[0].title, 'City 400 Chats')
  })

  test('a figure that is not in the data is refused, in rupees, as a percent or as a decimal', () => {
    assert.deepEqual(unknownFigures('₹5,001 and 37% and 12.5', facts), ['₹5,001', '37%', '12.5'])
  })

  test('figures from the data, names, dates and small counts pass', () => {
    assert.deepEqual(unknownFigures('₹5,000 up 67%, City 400 Chats, 3 Oct 2026, 2 ad sets', facts), [])
  })

  test('an invented ad set is refused, and Keep and Look at must cite one', () => {
    assert.throws(() => parseReviewAnswer({ ...answer, keep: [{ title: 'x', why: 'y', refs: ['9999'] }] }, facts), /does not exist/)
    assert.throws(() => parseReviewAnswer({ ...answer, lookAt: [{ title: 'x', why: 'y', refs: [] }] }, facts), /cites no ad set/)
  })

  test('a malformed answer is refused, not half saved', () => {
    assert.throws(() => parseReviewAnswer(null, facts))
    assert.throws(() => parseReviewAnswer({ ...answer, learnings: [{ ...answer.learnings[0], key: 'Bad Key' }] }, facts), /wrong shape/)
    assert.throws(() => parseReviewAnswer({ ...answer, keep: [...Array(4)].map(() => answer.keep[0]) }, facts), /at most 3/)
  })
})

describe('saving', () => {
  test('a person\'s decision on a lesson is never overwritten', () => {
    const parsed = parseReviewAnswer(answer, facts)
    assert.equal(planLearnings(parsed, [{ lesson_key: 'city-beats-auto', title: 't', status: 'rejected' }], facts, 'now').length, 0)
    assert.equal(planLearnings(parsed, [{ lesson_key: 'city-beats-auto', title: 't', status: 'open' }], facts, 'now').length, 1)
  })

  test('a rule need closes when the rule stops applying, reopens when it applies, and a dismissed one stays dismissed', () => {
    assert.deepEqual(planNeeds([], [{ need_key: 'set_target', status: 'open' }], 'now'), [{ need_key: 'set_target', status: 'done', resolved_at: 'now', updated_at: 'now' }])
    const draft = { need_key: 'set_cap', title: 't', why: 'w', next_step: 'set_cap' as const }
    assert.equal((planNeeds([draft], [{ need_key: 'set_cap', status: 'done' }], 'now')[0] as { status: string }).status, 'open')
    assert.equal(planNeeds([draft], [{ need_key: 'set_cap', status: 'dismissed' }], 'now').length, 0)
  })

  test('a finished Look at need is not reopened by the next review', () => {
    assert.equal(planNeeds([{ need_key: 'look:2002', title: 't', why: 'w', next_step: 'task' }], [{ need_key: 'look:2002', status: 'done' }], 'now').length, 0)
  })

  test('the rule needs name what is missing', () => {
    assert.deepEqual(ruleNeeds(facts, settings, 2).map(n => n.need_key), ['set_target', 'set_cap', 'silent_campaigns', 'confirm_learnings'])
    assert.deepEqual(ruleNeeds({ ...facts, silentCampaigns: [] }, { monthly_cap_paise: 1, target_cost_per_enquiry_paise: 1 }, 0), [])
  })
})

describe('a run', () => {
  test('saves the review, the lesson and the needs; history stays out of the saved row', async () => {
    const { store, saved } = fakeStore()
    assert.equal((await runMetaReview({ store, ask: says(answer), now: NOW })).status, 'ok')
    assert.equal(saved.reviews[0].status, 'ok')
    assert.equal(saved.reviews[0].verdict, 'worse')
    assert.equal((saved.reviews[0].numbers as Record<string, unknown>).history, undefined)
    assert.equal(saved.learnings.length, 1)
    assert.ok(saved.needs.some(n => (n as { need_key: string }).need_key === 'look:2002'))
    assert.ok(saved.needs.some(n => (n as { need_key: string }).need_key === 'confirm_learnings'))
  })

  test('a week already reviewed is not asked for again', async () => {
    const { store, saved } = fakeStore({ reviewStatus: 'ok' })
    const ask = says(answer)
    assert.equal((await runMetaReview({ store, ask, now: NOW })).status, 'done')
    assert.equal(ask.calls.length, 0)
    assert.equal(saved.reviews.length, 0)
  })

  test('a refused answer is tried once more with the reason, then saved as failed', async () => {
    const { store, saved } = fakeStore()
    const ask = says({ ...answer, summary: 'Spent ₹77,777' })
    const result = await runMetaReview({ store, ask, now: NOW })
    assert.equal(result.status, 'failed')
    assert.equal(ask.calls.length, 2)
    assert.match(ask.calls[1], /₹77,777/)
    assert.equal(saved.reviews[0].status, 'failed')
    assert.equal(saved.learnings.length + saved.needs.length, 0)
  })

  test('a Claude failure is a failed row, not a crash', async () => {
    const { store, saved } = fakeStore()
    const result = await runMetaReview({ store, ask: async () => { throw new Error('Claude refused the request (500).') }, now: NOW })
    assert.equal(result.status, 'failed')
    assert.equal(saved.reviews[0].message, 'Claude refused the request (500).')
  })

  test('a stale daily read stops the review before Claude is asked', async () => {
    const structure: MetaStructure = { accounts: [], campaigns, adSets, runs: [run({ finished_at: '2026-11-01T00:41:00Z' })], settings, monthSpendPaise: 0 }
    const { store } = fakeStore({ structure })
    const ask = says(answer)
    assert.equal((await runMetaReview({ store, ask, now: NOW })).status, 'failed')
    assert.equal(ask.calls.length, 0)
  })

  test('a quiet week costs no call and says so', async () => {
    const { store, saved } = fakeStore({ insights: [row('2001', '2026-11-03', 100, 1)] })
    const ask = says(answer)
    assert.equal((await runMetaReview({ store, ask, now: NOW })).status, 'ok')
    assert.equal(ask.calls.length, 0)
    assert.equal(saved.reviews[0].verdict, 'quiet')
  })
})
