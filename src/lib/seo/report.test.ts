import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  answeredProposals, boardCounts, cityTable, competitors, halfOnHalf, latestReview, months, openProposals,
  reviewPage, tagOf, targetForMonth, targets, taskHistories, taskStates,
  type SeoData, type SeoLogRow, type SeoMetric, type SeoPlanItem, type SeoReview,
} from './report'

const empty: SeoData = { sixMonth: null, metrics: [], watchlist: [], planItems: [], reviews: [], log: [], runs: [] }
const row = (metric: string, scope: string, value: number | null, metric_date = '2026-10-26', detail: SeoMetric['detail'] = null): SeoMetric =>
  ({ metric, scope, value, metric_date, detail, source: 'test' })

describe('cities', () => {
  const city = (scope: string, value: number | null, top: string[], date = '2026-10-26') => row('city.position', scope, value, date, { top })
  const data: SeoData = {
    ...empty,
    metrics: [
      row('city.demand', 'Pune', 12),
      row('city.demand', 'Delhi NCR', 25),
      city('Pune | k1', 2, ['justdial.com', 'bestofexports.com', 'nakhtal.com']),
      city('Pune | k2', 7, ['indiamart.com', 'nakhtal.com', 'other.com']),
      city('Delhi NCR | k1', null, ['metalavenues.com', 'justdial.com', 'decorum.in']),
      city('India (country) | k3', 1, ['bestofexports.com', 'a.com', 'b.com']),
      // An older reading of the same search is replaced, not added.
      city('Pune | k1', 9, ['old.com', 'old.com', 'old.com'], '2026-09-01'),
    ],
  }

  test('counts top 3 and top 10 per city, biggest demand first, India-wide left out', () => {
    const { cities } = cityTable(data)
    assert.deepEqual(cities.map(c => [c.city, c.searches, c.top3, c.top10]), [['Delhi NCR', 1, 0, 0], ['Pune', 2, 1, 2]])
  })
  test('leaders leave out us and the directories', () => {
    const pune = cityTable(data).cities.find(c => c.city === 'Pune')
    assert.deepEqual(pune?.leaders, [{ domain: 'nakhtal.com', spots: 2 }, { domain: 'other.com', spots: 1 }])
  })
  test('directories are counted across every search, India-wide included', () => {
    const { directorySpots, totalSpots } = cityTable(data)
    assert.equal(directorySpots, 3)
    assert.equal(totalSpots, 12)
  })
})

describe('competitors', () => {
  test('we come first, then most city top-3 spots, and each row keeps its own date', () => {
    const rows = competitors({
      ...empty,
      watchlist: [{ kind: 'competitor', entry_key: 'b.com', label: 'b.com', note: 'Delhi NCR', active: true }],
      metrics: [
        row('competitor.snapshot', 'a.com', 5, '2026-10-24', { visits: 900 }),
        row('competitor.snapshot', 'b.com', 1, '2026-11-01', { visits: 10, ref_domains: 297 }),
        row('competitor.snapshot', 'bestofexports.com', 29, '2026-10-24', {}),
        row('city.position', 'Pune | k', null, '2026-10-26', { top: ['b.com', 'x.com', 'y.com'] }),
      ],
    })
    assert.deepEqual(rows.map(r => r.domain), ['bestofexports.com', 'b.com', 'a.com'])
    assert.equal(rows[1].cityTop3, 1)
    assert.equal(rows[1].wins, 'Delhi NCR')
    assert.equal(rows[1].linkingSites, 297)
    assert.equal(rows[1].asOf, '2026-11-01')
    assert.equal(rows[2].keywords, null)
  })
})

describe('the year', () => {
  test('the last 12 months, oldest first, joined by month', () => {
    const metrics = Array.from({ length: 14 }, (_, i) => {
      const month = new Date(Date.UTC(2025, 8 + i, 1)).toISOString().slice(0, 10)
      return row('site.month.clicks', '', i, month)
    })
    const rows = months({ ...empty, metrics: [...metrics, row('site.month.website_leads', '', 50, '2026-10-01')] })
    assert.equal(rows.length, 12)
    assert.equal(rows[0].month, '2025-11')
    assert.deepEqual(rows.at(-1), { month: '2026-10', label: 'Oct', clicks: 13, impressions: null, position: null, sessions: null, leads: 50 })
  })
  test('half on half uses the real figures: clicks +31%, leads -11%', () => {
    assert.deepEqual(halfOnHalf([3050, 3834, 4232, 5850, 6092, 6744, 6522, 6644, 6805, 7070, 6680, 5312]), { before: 29802, after: 39033, percent: 31 })
    assert.deepEqual(halfOnHalf([103, 79, 98, 94, 76, 54, 53, 58, 72, 129, 86, 50]), { before: 504, after: 448, percent: -11 })
  })
  test('half on half refuses to compare a short or gappy year', () => {
    assert.equal(halfOnHalf([1, 2, 3]), null)
    assert.equal(halfOnHalf([1, 2, 3, 4, 5, 6, null, 8, 9, 10, 11, 12]), null)
  })
})

describe('the board and targets', () => {
  test('counts each status', () => {
    const item = (status: SeoPlanItem['status']) => ({ status }) as SeoPlanItem
    assert.deepEqual(boardCounts([item('done'), item('started'), item('started'), item('waiting_owner')]), { total: 4, done: 1, started: 2, waiting: 1, notStarted: 0 })
  })
  test('a month with no target uses the next one set, and after the last there is none', () => {
    const set = { '2026-11': 2, '2026-12': 3, '2027-04': 12 }
    assert.equal(targetForMonth(set, '2026-11'), 2)
    assert.equal(targetForMonth(set, '2027-01'), 12)
    assert.equal(targetForMonth(set, '2027-05'), null)
  })
  test('a number is on target at or above its target, and order is kept', () => {
    const data = { ...empty, metrics: [
      row('plan.target', 'second', 1, '2026-11-01', { order: 2, months: { '2026-11': 2, '2027-04': 12 } }),
      row('plan.target', 'first', 55, '2026-11-01', { order: 1, months: { '2026-11': 55 } }),
    ] }
    assert.deepEqual(targets(data, '2026-11-02').map(t => [t.measure, t.onTarget, t.april]), [['first', true, null], ['second', false, 12]])
  })
  test('a target keeps its own words and state, and falls back to the sum', () => {
    const data = { ...empty, metrics: [
      row('plan.target', 'old name', 5, '2026-11-01', { order: 1, label: 'New name', now_text: '5, 1 real', state: { text: 'New measure', tone: 'pending' }, months: { '2026-11': 2, '2026-12': 3 } }),
      row('plan.target', 'plain', 1, '2026-11-01', { order: 2, state: { text: 'x', tone: 'nonsense' }, months: { '2026-11': 2 } }),
      row('plan.target', 'unread', null, '2026-11-01', { order: 3, months: { '2026-11': 2 } }),
    ] }
    const [first, second, third] = targets(data, '2026-11-02')
    assert.deepEqual([first.label, first.nowText, first.state.text, first.december], ['New name', '5, 1 real', 'New measure', 3])
    assert.deepEqual([second.label, second.nowText, second.state], ['plain', '1', { text: 'Behind', tone: 'bad' }])
    assert.deepEqual([third.nowText, third.state.text], ['—', 'No reading'])
  })
  test('the newest review is the verdict', () => {
    const review = (review_date: string) => ({ review_date, verdict: 'watch', items_due: 1, items_done: 0, numbers_on_target: 1, summary: '' }) as const
    assert.equal(latestReview({ ...empty, reviews: [review('2026-11-02'), review('2026-11-09')] })?.review_date, '2026-11-09')
    assert.equal(latestReview(empty), null)
  })
})

describe('proposals and what needs the owner', () => {
  const proposal = (id: string, decision: SeoLogRow['decision'], decided_at: string | null = null): SeoLogRow =>
    ({ id, kind: 'proposal', log_date: '2026-11-01', title: id, body: '', before_value: null, after_value: null, source: 'board', decision, decided_at })
  const log = [proposal('open', null), proposal('older', 'keep', '2026-11-01T10:00:00Z'), proposal('newer', 'change', '2026-11-02T10:00:00Z')]

  test('an answered proposal leaves the open list, newest answer first', () => {
    assert.deepEqual(openProposals({ ...empty, log }).map(p => p.id), ['open'])
    assert.deepEqual(answeredProposals({ ...empty, log }).map(p => p.id), ['newer', 'older'])
  })
  test('a proposal not yet answered may have no decision column at all', () => {
    assert.equal(openProposals({ ...empty, log: [{ ...proposal('x', null), decision: undefined }] }).length, 1)
  })
  test('other log rows are never proposals', () => {
    assert.equal(openProposals({ ...empty, log: [{ ...proposal('w', null), kind: 'work' }] }).length, 0)
  })
})

describe('the Monday page', () => {
  const review = (detail: SeoReview['detail']): SeoReview =>
    ({ review_date: '2026-11-09', verdict: 'watch', items_due: 1, items_done: 0, numbers_on_target: 1, summary: '', detail })

  test('reads a full page', () => {
    const page = reviewPage(review({
      direction: 'Better', done: ['a'], pending: ['b'], competitors: ['e'], next_tasks: ['f'], biggest_move: 'g', risk: 'h',
      biggest_move_tag: { text: 'Noise', tone: 'pending' }, risk_tag: { text: 'x', tone: 'nonsense' },
      numbers: [{ measure: 'Leads', this_week: 12, last_week: '10', target: 55, note: 'monthly', tag: { text: 'Behind', tone: 'bad' } }],
    }))
    assert.deepEqual(page.numbers, [{ measure: 'Leads', thisWeek: '12', lastWeek: '10', target: '55', note: 'monthly', tag: { text: 'Behind', tone: 'bad' } }])
    assert.deepEqual([page.direction, page.done, page.nextTasks, page.biggestMove, page.risk], ['Better', ['a'], ['f'], 'g', 'h'])
    assert.deepEqual([page.moveTag, page.riskTag], [{ text: 'Noise', tone: 'pending' }, null])
  })
  test('a tag needs words and a known tone', () => {
    for (const bad of [null, undefined, 'x', {}, { text: '', tone: 'good' }, { text: 'x', tone: 'loud' }]) assert.equal(tagOf(bad), null)
  })
  test('a page the session got wrong stays blank and never breaks the screen', () => {
    for (const detail of [null, undefined, {}, { numbers: 'x', done: 'x', pending: [1, null, ''], risk: {} }, { numbers: [null, 1, { this_week: 1 }] }]) {
      const page = reviewPage(review(detail))
      assert.deepEqual([page.numbers, page.done, page.pending, page.risk], [[], [], [], ''])
    }
  })
})

describe('scheduled tasks', () => {
  const run = (feed: SeoData['runs'][number]['feed'], run_date: string, status: SeoData['runs'][number]['status'] = 'ok') =>
    ({ feed, run_date, status, message: '', row_count: 0 })
  const state = (label: string, runs: SeoData['runs'], today = '2026-11-03') => taskStates({ ...empty, runs }, today).find(t => t.label === label)

  test('a task that never ran says so', () => assert.equal(state('Daily SEO numbers', [])?.state, 'never'))
  test('a daily task that ran today or yesterday is fine, older is late', () => {
    assert.equal(state('Daily SEO numbers', [run('daily_numbers', '2026-11-02')])?.state, 'ok')
    assert.equal(state('Daily SEO numbers', [run('daily_numbers', '2026-11-01')])?.state, 'late')
  })
  test('the Monday review may be 7 days old, not 8', () => {
    assert.equal(state('Monday review', [run('monday_review', '2026-10-27')])?.state, 'ok')
    assert.equal(state('Monday review', [run('monday_review', '2026-10-26')])?.state, 'late')
  })
  test('a login stop needs the owner and a CAPTCHA stop retries, and both outrank late', () => {
    assert.deepEqual(state('Daily Ahrefs research', [run('ahrefs_research', '2026-10-20', 'logged_out')]), { label: 'Daily Ahrefs research', state: 'problem', text: 'Logged out 20 Oct' })
    assert.equal(state('Daily city check', [run('city_check', '2026-10-20', 'blocked')])?.state, 'retry')
  })
  test('only the newest run counts', () => {
    assert.equal(state('Daily city check', [run('city_check', '2026-11-01', 'blocked'), run('city_check', '2026-11-02')])?.state, 'ok')
  })
  test('each task says what to do, from its newest run', () => {
    const days = Array.from({ length: 9 }, (_, i) => run('ahrefs_research', `2026-10-2${i}`))
    const history = taskHistories({ ...empty, runs: [...days, run('ahrefs_research', '2026-11-02', 'logged_out'), run('city_check', '2026-11-02', 'blocked')] }, '2026-11-03')
    assert.match(history.find(t => t.label === 'Daily Ahrefs research')?.advice ?? '', /Log in to tools.toolsurf.com/)
    assert.match(history.find(t => t.label === 'Daily city check')?.advice ?? '', /Nothing to do/)
  })
  test('a late task points at the PC, and a task that is fine says nothing', () => {
    const history = taskHistories({ ...empty, runs: [run('daily_numbers', '2026-10-20'), run('city_check', '2026-11-02')] }, '2026-11-03')
    assert.match(history.find(t => t.label === 'Daily SEO numbers')?.advice ?? '', /PC was on/)
    assert.equal(history.find(t => t.label === 'Daily city check')?.advice, null)
    assert.equal(history.find(t => t.label === 'Monday review')?.advice, null)
  })
})
