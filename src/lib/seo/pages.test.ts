import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { indiaKeywords, needsYou, pageNotes, percentChange, sourceAges, spotBars, taskGrid } from './pages'
import type { SeoData, SeoLogRow, SeoMetric, SeoPlanItem, SeoReview, SeoRun } from './report'

const empty: SeoData = { sixMonth: null, metrics: [], watchlist: [], planItems: [], reviews: [], log: [], runs: [] }
const row = (metric: string, scope: string, value: number | null, metric_date = '2026-10-26', detail: SeoMetric['detail'] = null): SeoMetric =>
  ({ metric, scope, value, metric_date, detail, source: 'test' })
const withPages = (pages: unknown): SeoData => ({
  ...empty,
  reviews: [{ review_date: '2026-11-02', verdict: 'none', items_due: 0, items_done: 0, numbers_on_target: 0, summary: '', detail: { pages } } as SeoReview],
})

describe('the notes the Monday session writes', () => {
  test('a good page comes through', () => {
    const notes = pageNotes(withPages({ board: { title: 'T', lenses: [{ label: 'L', tag: { text: 'x', tone: 'good' } }], side: [{ label: 'S', value: '1', tone: 'down' }], checks: { a: 'b' }, needs: [{ item: 'n1', title: 'N' }] } }), 'board')
    assert.equal(notes.title, 'T')
    assert.equal(notes.lenses[0].tag.text, 'x')
    assert.deepEqual(notes.side, [{ label: 'S', note: '', value: '1', tone: 'down' }])
    assert.equal(notes.checks.a, 'b')
    assert.equal(notes.needs[0].item, 'n1')
  })
  test('a page the session got wrong stays blank and never breaks the screen', () => {
    for (const page of [undefined, null, 'x', 1, {}, { lenses: 'x', side: [1], checks: { a: 1 }, notes: [null], rows: [{}], cards: 'x', needs: [{}] }, { lenses: [{ label: 'x', tag: { text: 'x', tone: 'loud' } }] }]) {
      const notes = pageNotes(withPages({ overview: page }), 'overview')
      assert.deepEqual([notes.title, notes.lenses, notes.side, notes.checks, notes.notes, notes.rows, notes.cards, notes.needs], ['', [], [], {}, [], [], [], []])
    }
    assert.equal(pageNotes(empty, 'overview').title, '')
  })
})

test('a change has a real minus sign, and nothing to compare gives a dash', () => {
  assert.equal(percentChange(86, 100), '−14%')
  assert.equal(percentChange(122, 100), '+22%')
  assert.equal(percentChange(100, 100), '0%')
  assert.equal(percentChange(5, null), '—')
  assert.equal(percentChange(5, 0), '—')
})

describe('money keywords in India', () => {
  const keyword = (scope: string, value: number, order: number, views: number, step = '') => row('keyword.india', scope, value, '2026-11-02', { order, previous: 12, clicks: 1, clicks_prev: 2, views, views_prev: views + 1, step })
  const data: SeoData = {
    ...empty,
    metrics: [
      // Rows reach the screen by name, so the sender's order has to come from the detail.
      keyword('a', 10.9, 3, 100, 'Do a'),
      keyword('b', 11, 1, 500, 'Do b'),
      keyword('c', 20.9, 2, 20),
      keyword('d', 21, 4, 5),
      keyword('e', 3, 5, 99),
      row('keyword.india', 'gone', 2, '2026-10-26', { order: 0 }),
    ],
  }
  const k = indiaKeywords(data)

  test('keeps the sender order and leaves out a keyword missing from the newest reading', () => {
    assert.deepEqual(k.rows.map(r => r.keyword), ['b', 'c', 'a', 'd', 'e'])
  })
  test('10.9 is page 1, 11 is page 2, 21 is page 3', () => {
    assert.deepEqual([k.page1, k.page2, k.page3], [2, 2, 1])
  })
  test('page 1 with real views needs 100 of them', () => assert.equal(k.real, 1))
  test('a keyword with a next step is acted on, and the rest are too thin', () => {
    assert.deepEqual(k.main.map(r => r.keyword), ['b', 'a'])
    assert.deepEqual(k.thin.map(r => r.keyword), ['c', 'd', 'e'])
  })
  test('adds clicks and views now and before', () => {
    assert.deepEqual([k.clicks, k.clicksBefore, k.views, k.viewsBefore], [5, 10, 724, 729])
  })
})

test('directory bars add up every host of the same directory', () => {
  const city = (scope: string, top: string[]) => row('city.position', scope, 1, '2026-10-26', { top })
  const bars = spotBars({ ...empty, metrics: [city('A | k', ['dir.indiamart.com', 'justdial.com', 'bestofexports.com', 'indiamart.com']), city('B | k', ['www.indiamart.com', 'mybestofexports.com', 'justdial.com'])] })
  assert.deepEqual(bars.map(b => b.count), [2, 2, 1])
})

describe('what needs the owner', () => {
  const run = (run_date: string, status: SeoRun['status']): SeoRun => ({ feed: 'ahrefs_research', run_date, status, message: '', row_count: 0 })
  const item = (id: string, status: SeoPlanItem['status'], due_date: string | null = '2026-11-06') => ({ id, window_key: 'd30', title: id, who: '', due_date, status, evidence: '' }) as SeoPlanItem
  const proposal = { id: 'p', kind: 'proposal', log_date: '2026-11-01', title: 'p', body: '', before_value: null, after_value: null, source: '' } as SeoLogRow
  const notes = pageNotes(withPages({ overview: { needs: [{ item: 'n1', when: 'By 6 Nov', title: 'Say OK', why: 'w' }, { item: 'n2', when: 'x', title: 'Finished since Monday' }, { when: 'This week', title: 'Send the count' }] } }), 'overview')

  test('the login comes first, then the worded ones, then a waiting item nobody worded, then the answers', () => {
    const data: SeoData = { ...empty, runs: [run('2026-11-01', 'ok'), run('2026-11-02', 'logged_out')], planItems: [item('n1', 'waiting_owner'), item('n2', 'done'), item('n3', 'waiting_owner', null)], log: [proposal] }
    assert.deepEqual(needsYou(data, notes).map(n => n.title), ['Log in to tools.toolsurf.com in Chrome', 'Say OK', 'Send the count', 'n3', 'Answer 1 strategy change'])
  })
  test('a need with no plan item has nowhere to send the owner', () => {
    const need = needsYou(empty, notes).find(n => n.title === 'Send the count')
    assert.equal(need?.href, undefined)
  })
  test('a logged-out day that a later run put right asks for nothing', () => {
    assert.equal(needsYou({ ...empty, runs: [run('2026-10-31', 'logged_out'), run('2026-11-01', 'ok')] }, pageNotes(empty, 'overview')).length, 0)
  })
  test('nothing waiting is an empty list', () => assert.deepEqual(needsYou(empty, pageNotes(empty, 'overview')), []))
})

describe('the last 7 days of tasks', () => {
  const run = (feed: SeoRun['feed'], run_date: string, status: SeoRun['status'] = 'ok', message = ''): SeoRun => ({ feed, run_date, status, message, row_count: 0 })

  test('shows 7 days ending today, and each cell in words', () => {
    const data: SeoData = {
      ...empty,
      runs: [
        run('ahrefs_research', '2026-10-27'),
        run('ahrefs_research', '2026-10-28', 'ok', 'Ran only after you logged in.'),
        run('ahrefs_research', '2026-10-31', 'logged_out'),
        run('ahrefs_research', '2026-11-01', 'blocked'),
        run('ahrefs_research', '2026-10-30', 'failed'),
      ],
    }
    const grid = taskGrid(data, '2026-11-02')
    assert.equal(grid.days.length, 7)
    assert.deepEqual([grid.days[0], grid.days[6]], ['2026-10-27', '2026-11-02'])
    assert.deepEqual(grid.cells('ahrefs_research'), ['ran', 'saved', 'none', 'stopped', 'login', 'stopped', 'due'])
  })
  test('the Monday review is never due on a daily square', () => {
    assert.equal(taskGrid(empty, '2026-11-03').cells('monday_review')[6], 'none')
    assert.equal(taskGrid(empty, '2026-11-03').cells('city_check')[6], 'due')
  })
})

describe('how old each figure is', () => {
  const source = (scope: string, detail: SeoMetric['detail']) => row('source.age', scope, null, '2026-11-02', detail)
  const ages = sourceAges({
    ...empty,
    metrics: [
      source('second', { order: 2, date: '2026-10-25', note: 'exactly 8 days' }),
      source('first', { order: 1, date: '2026-10-26', by_hand: true }),
      source('third', { order: 3, date: '2026-11-01', when: 'Rolling', tag: { text: '2 of 58 old', tone: 'wait' } }),
      source('fourth', { order: 4, date: '2026-11-01' }),
      source('no date', { order: 5 }),
    ],
  }, '2026-11-02')

  test('keeps the order and drops a row with no date', () => assert.deepEqual(ages.map(a => a.name), ['first', 'second', 'third', 'fourth']))
  test('older than 7 days is Old, even when read by hand', () => {
    assert.deepEqual(ages.map(a => a.tag.text), ['By hand', 'Old', '2 of 58 old', 'Fresh'])
  })
  test('shows the date unless the row says it better', () => assert.deepEqual(ages.map(a => a.when), ['26 Oct', '25 Oct', 'Rolling', '1 Nov']))
})
