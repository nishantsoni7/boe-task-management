import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  boardCounts, cityTable, competitors, halfOnHalf, latestReview, moneyKeywords, months, targetForMonth, targets, taskStates,
  type SeoData, type SeoMetric, type SeoPlanItem,
} from './report'

const empty: SeoData = { metrics: [], watchlist: [], planItems: [], reviews: [], log: [], runs: [] }
const row = (metric: string, scope: string, value: number | null, metric_date = '2026-10-26', detail: SeoMetric['detail'] = null): SeoMetric =>
  ({ metric, scope, value, metric_date, detail, source: 'test' })

describe('money keywords', () => {
  const data: SeoData = {
    ...empty,
    watchlist: [
      { kind: 'keyword', entry_key: 'a', label: 'a', note: null, active: true },
      { kind: 'keyword', entry_key: 'b', label: 'b', note: null, active: true },
      { kind: 'keyword', entry_key: 'gone', label: 'gone', note: null, active: true },
    ],
    metrics: [
      row('keyword.position', 'a', 10.9, '2026-10-26', { previous: 12 }),
      row('keyword.position', 'b', 20, '2026-10-26', { previous: 15 }),
      row('keyword.position', 'a', 12, '2026-10-19'),
      // Ranked last week, nothing this week: silent now, never carried forward as a position.
      row('keyword.position', 'gone', 5, '2026-10-19'),
    ],
  }

  test('reads the newest date, best position first, and a lower position is a rise', () => {
    const { rows, asOf } = moneyKeywords(data)
    assert.equal(asOf, '2026-10-26')
    assert.deepEqual(rows.map(r => [r.keyword, r.move]), [['a', 'up'], ['b', 'down']])
  })
  test('10.9 counts as top 10, 11 does not', () => {
    assert.equal(moneyKeywords(data).inTop10, 1)
    assert.equal(moneyKeywords({ ...data, metrics: [row('keyword.position', 'a', 11)] }).inTop10, 0)
  })
  test('a keyword missing from the newest reading is silent, not old news', () => {
    assert.deepEqual(moneyKeywords(data).silent, ['gone'])
  })
  test('no data gives no date', () => assert.equal(moneyKeywords(empty).asOf, null))
})

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
  test('the newest review is the verdict', () => {
    const review = (review_date: string) => ({ review_date, verdict: 'watch', items_due: 1, items_done: 0, numbers_on_target: 1, summary: '' }) as const
    assert.equal(latestReview({ ...empty, reviews: [review('2026-11-02'), review('2026-11-09')] })?.review_date, '2026-11-09')
    assert.equal(latestReview(empty), null)
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
  test('a login or CAPTCHA stop outranks late, because it says what to do', () => {
    assert.deepEqual(state('Daily Ahrefs research', [run('ahrefs_research', '2026-10-20', 'logged_out')]), { label: 'Daily Ahrefs research', state: 'problem', text: 'Logged out 20 Oct' })
    assert.equal(state('Daily city check', [run('city_check', '2026-11-02', 'blocked')])?.state, 'problem')
  })
  test('only the newest run counts', () => {
    assert.equal(state('Daily city check', [run('city_check', '2026-11-01', 'blocked'), run('city_check', '2026-11-02')])?.state, 'ok')
  })
})
