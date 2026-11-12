import '@/lib/testing/cssModuleStub'
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SeoData } from '@/lib/seo/report'
import { SAMPLE_BRIEF, SAMPLE_CASE, SAMPLE_REVIEW } from '@/lib/seo/sixMonthSample'
import { BoardBody } from './SeoBoard'
import { BriefBody } from './SeoBrief'
import { axisTicks, positionChange } from './SeoBriefCase'
import { CompetitorsBody } from './SeoCompetitors'
import { OverviewBody } from './SeoOverview'
import { RankingsBody } from './SeoRankings'
import { ReviewBody } from './SeoSixMonth'
import { ReviewsBody } from './SeoReviews'
import { TasksBody } from './SeoTasks'
import { YearBody } from './SeoYear'

const empty: SeoData = { sixMonth: null, metrics: [], watchlist: [], planItems: [], reviews: [], log: [], runs: [] }
const TODAY = '2026-11-02'

const full: SeoData = {
  sixMonth: null,
  metrics: [
    { metric_date: '2026-11-01', metric: 'plan.target', scope: 'Website leads a month', value: 50, detail: { order: 1, months: { '2026-11': 55, '2027-04': 100 } }, source: 'board' },
    { metric_date: '2026-10-26', metric: 'keyword.india', scope: 'hotel chairs', value: 18.6, detail: { order: 1, previous: 16.4, clicks: 2, views: 300, demand: '500', step: 'Rebuild the page.', shown: ['/old-page/ at 18.6'], want: '/hotel-chairs/ at 40' }, source: 'search_console' },
    { metric_date: '2026-10-26', metric: 'keyword.india', scope: 'bar stools', value: 30, detail: { order: 2, previous: 28, clicks: 0, views: 9 }, source: 'search_console' },
    { metric_date: '2026-10-26', metric: 'city.position', scope: 'Pune | hotel furniture', value: 2, detail: { top: ['justdial.com', 'bestofexports.com', 'nakhtal.com'] }, source: 'google' },
    { metric_date: '2026-10-24', metric: 'competitor.snapshot', scope: 'bestofexports.com', value: 29, detail: { ref_domains: 1400, keywords: 904, visits: 4828, visits_year_ago: 2174 }, source: 'ahrefs' },
    { metric_date: '2026-09-01', metric: 'site.month.clicks', scope: '', value: 5312, detail: null, source: 'search_console' },
    { metric_date: '2026-10-16', metric: 'pages.clicks', scope: 'Category pages', value: 1463, detail: { before: 2201 }, source: 'search_console' },
    { metric_date: '2026-10-01', metric: 'work.count', scope: 'Guest posts', value: 0, detail: { useful: true }, source: 'worksheet' },
    { metric_date: '2026-11-01', metric: 'plan.progress', scope: 'Pages on the work list live', value: 0, detail: { of: 9 }, source: 'board' },
  ],
  watchlist: [{ kind: 'keyword', entry_key: 'cafe chairs', label: 'cafe chairs', note: null, active: true }],
  planItems: [{ id: 'n1', window_key: 'd30', title: 'Put the category sitemap back on the live site', who: 'Agent, owner OK', due_date: '2026-11-08', status: 'waiting_owner', evidence: 'Fixed on staging' }],
  reviews: [{ review_date: '2026-11-02', verdict: 'watch', items_due: 5, items_done: 3, numbers_on_target: 2, summary: 'Hold course.' }],
  log: [
    { id: 'p1', kind: 'proposal', log_date: '2026-11-01', title: 'Move city pages to January', body: 'City words are tiny.', before_value: null, after_value: null, source: 'board' },
    { id: 'w1', kind: 'work', log_date: '2026-10-15', title: 'Hostinger CDN enabled', body: '', before_value: 'PSI 65', after_value: 'PSI 69', source: 'Live' },
  ],
  runs: [{ feed: 'ahrefs_research', run_date: '2026-11-01', status: 'logged_out', message: '', row_count: 0 }],
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('the 6-month review and the discussion brief', () => {
  test('the review draws the verdict, the good and bad lists, the moves in order and the proof behind a line', () => {
    const page = html(<ReviewBody review={SAMPLE_REVIEW} />)
    assert.ok(page.includes(SAMPLE_REVIEW.verdict.title))
    assert.ok(page.includes(SAMPLE_REVIEW.period))
    assert.ok(page.includes(SAMPLE_REVIEW.good[0].title))
    assert.ok(page.includes(SAMPLE_REVIEW.bad[0].title))
    assert.ok(page.includes('<b>Limit: </b>'), 'a labelled proof line keeps its label')
    assert.ok(page.indexOf(SAMPLE_REVIEW.moves.items[0].title) < page.indexOf(SAMPLE_REVIEW.moves.items[1].title))
    assert.ok(page.includes(SAMPLE_REVIEW.moves.then!))
    assert.ok(page.includes('class="boe-badge tag '), 'badges hold sentences, so they opt out of the shared capitalising')
    assert.ok(page.includes(SAMPLE_REVIEW.targets.warning!))
    assert.ok(page.includes('/seo/year'), 'the 12-month view stays reachable')
  })

  test('a keyword that moved shows both positions, and one past the scale stays on the chart', () => {
    const page = html(<ReviewBody review={SAMPLE_REVIEW} />)
    assert.ok(page.includes('5.0 → 50.0'))
    assert.ok(page.includes('left:100%'), 'position 50 sits at the right edge, not off the chart')
  })

  test('the brief separates what is scored from what is not, and keeps each question', () => {
    const page = html(<BriefBody brief={SAMPLE_BRIEF} />)
    assert.ok(page.includes(SAMPLE_BRIEF.message))
    assert.ok(page.includes(SAMPLE_BRIEF.raise[0].ask))
    assert.ok(page.indexOf('Scored: SEO person') < page.indexOf(SAMPLE_BRIEF.scored[0].title))
    assert.ok(page.indexOf(SAMPLE_BRIEF.scored[0].title) < page.indexOf('Not scored against them'))
    assert.ok(page.indexOf('Not scored against them') < page.indexOf(SAMPLE_BRIEF.others[0].title))
  })

  test('a brief with claims is drawn as a case: evidence, then the claims, then the conversation', () => {
    const page = html(<BriefBody brief={SAMPLE_CASE} />)
    const order = [SAMPLE_CASE.message, 'Sample quarters', 'Sample traffic', 'Sample trend', 'Sample flow', 'Sample finding', 'Sample base', 'Sample risers', 'Sample claim', 'Sample his plan', 'Sample miss', 'Sample counter', 'Sample freelance', 'Give credit first', 'Sample plan', 'Sample talk', 'Proof', 'Sample source.']
    order.forEach((text, i) => {
      assert.ok(page.includes(text), text)
      if (i) assert.ok(page.indexOf(order[i - 1]) < page.indexOf(text), `${order[i - 1]} before ${text}`)
    })
    assert.equal(page.includes('Scored: SEO person'), false, 'the review\'s scoring is not part of a case')
    assert.ok(page.includes('Sample answer.'))
    assert.ok(page.includes('Sample line.'))
  })

  test('a quarter cell is coloured by where it sits, and a blank one says so', () => {
    const page = html(<BriefBody brief={SAMPLE_CASE} />)
    for (const [value, tone] of [['2.9', 'qTop'], ['10.9', 'qPage1'], ['11.0', 'qPage2'], ['21.0', 'qLow'], ['3.5', 'qTop']]) {
      assert.ok(page.includes(`class="qCell ${tone}">${value}<`), `${value} is ${tone}`)
    }
    assert.ok(page.includes('class="qCell qNone">—<'))
  })

  test('each proof opens its source in a new tab, and a file with no link is only named', () => {
    const page = html(<BriefBody brief={SAMPLE_CASE} />)
    const newTab = 'target="_blank" rel="noopener noreferrer"'
    for (const url of ['https://example.com/report', 'https://example.com/policy', 'https://example.com/evidence', 'https://example.com/q2']) {
      assert.ok(page.includes(`href="${url}" ${newTab}`), url)
    }
    assert.ok(page.includes('Check it yourself'))
    assert.ok(page.includes('Sample file'))
    assert.equal(/<a[^>]*>Sample file/.test(page), false, 'a proof with no link is not a link')
    assert.ok(page.includes('1 click<') && page.includes('26 clicks<'), 'clicks sit under each quarter')
  })

  test('searches sit under their category, which adds up its clicks; thin readings are grey and left out of the change', () => {
    const page = html(<BriefBody brief={SAMPLE_CASE} />)
    assert.ok(page.indexOf('Sample summary line') < page.indexOf('Sample group'), 'the summary sits above the table')
    assert.ok(page.indexOf('Sample group') < page.indexOf('sample keyword') && page.indexOf('second keyword') < page.indexOf('Second group'))
    assert.ok(page.includes('>1 click<') && page.includes('>26 clicks<'), 'the category row adds its clicks')
    assert.ok(page.includes('▼ 8.0 places'), '2.9 to 10.9 is 8 places worse')
    assert.ok(page.includes('▲ 7.5 places'), '11 to 3.5 is 7.5 places better')
    assert.ok(page.includes('class="qCell qFew"'), 'a position from 3 showings is grey')
    assert.ok(page.includes('Since Q1'))
    assert.equal(positionChange(SAMPLE_CASE.quarters.rows[2]), null, 'a thin first reading gives no change')
    assert.equal(positionChange({ keyword: 'k', demand: '', values: [5, null, 7], shown: [20, null, 25] }), 2)
  })

  test('the traffic split draws its figures and table after the rankings', () => {
    const page = html(<BriefBody brief={SAMPLE_CASE} />)
    assert.ok(page.includes('+100') && page.includes('Sample tile note') && page.includes('To blog posts'))
    assert.ok(page.indexOf('Sample quarters') < page.indexOf('Sample traffic'))
  })

  test('a case may leave out the worksheet chart, credit and fairness', () => {
    const { proof: _chart, ...rest } = SAMPLE_CASE
    void _chart
    const page = html(<BriefBody brief={{ ...rest, credit: [], fair: [] }} />)
    assert.equal(page.includes('Give credit first'), false)
    assert.equal(page.includes(`aria-label="${SAMPLE_BRIEF.proof.title}"`), false)
    assert.ok(page.includes('Sample talk'))
  })

  test('the chart axis rounds up to an easy number', () => {
    assert.deepEqual(axisTicks(7070), [0, 2500, 5000, 7500])
    assert.deepEqual(axisTicks(485), [0, 200, 400, 600])
    assert.deepEqual(axisTicks(700), [0, 250, 500, 750])
  })
})

describe('each screen draws saved data', () => {
  test('Overview: the verdict with its sum, the numbers, what needs the owner, the task states', () => {
    const page = html(<OverviewBody data={full} today={TODAY} />)
    for (const text of ['Watch', '3 of 5 due items done, 2 of 5 numbers on target', 'Hold course.', '55 / 100', 'Log in to tools.toolsurf.com in Chrome', 'Put the category sitemap back on the live site', 'Answer 1 strategy change', 'Logged out 1 Nov', 'No run yet', 'Needs you']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Rankings: the keyword, its move and step, the wrong page, the thin keyword, the city', () => {
    const page = html(<RankingsBody data={full} />)
    for (const text of ['16.4 → 18.6', '2 / 300', 'Rebuild the page.', '/old-page/ at 18.6', '/hotel-chairs/ at 40', 'Too few views to act on', 'Pune', '1 in top 3, 1 in top 10', 'nakhtal.com 1']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Competitors: our row is marked, with its figures and the date they were read', () => {
    const page = html(<CompetitorsBody data={full} />)
    assert.ok(page.includes('bestofexports.com (us)'))
    assert.ok(page.includes('4,828'))
    assert.ok(page.includes('+122%'))
    assert.ok(page.includes('24 Oct'))
  })
  test('Competitors: our own fall reads as a fall', () => {
    const fell: SeoData = { ...full, metrics: full.metrics.map(m => (m.metric === 'competitor.snapshot' ? { ...m, detail: { ...m.detail, visits: 100, visits_year_ago: 200 } } : m)) }
    assert.ok(html(<CompetitorsBody data={fell} />).includes('Down from 200 a year ago'))
    assert.ok(html(<CompetitorsBody data={full} />).includes('Up from 2,174 a year ago'))
  })
  test('Year: the months, the page groups with their change, the work and its gap', () => {
    const page = html(<YearBody data={full} />)
    for (const text of ['Search clicks per month', 'Category pages', '-34%', 'Guest posts', 'November 2025 to March 2026 is not counted yet', 'Hostinger CDN enabled', 'PSI 65 to PSI 69']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Board: the status in words, its evidence, the targets, what is waiting for an answer', () => {
    const page = html(<BoardBody data={full} today={TODAY} />)
    for (const text of ['Waiting on you', '1 waiting on you', 'Fixed on staging', 'Due 8 Nov', '100', '0 of 9', 'Move city pages to January', 'City words are tiny.']) {
      assert.ok(page.includes(text), text)
    }
  })
})

describe('who sees which control', () => {
  const save = async () => {}
  const decide = async () => {}

  test('a reader sees the board and the proposal, and no way to change either', () => {
    const page = html(<BoardBody data={full} today={TODAY} />)
    assert.equal(page.includes('>Update<'), false)
    assert.equal(page.includes('Change the plan'), false)
    assert.ok(page.includes('Waiting for an answer'))
  })
  test('edit alone gives Update and never the strategy answer', () => {
    const page = html(<BoardBody data={full} today={TODAY} onSave={save} />)
    assert.ok(page.includes('>Update<'))
    assert.equal(page.includes('Change the plan'), false)
  })
  test('approve gives both answers, on the board and on the review', () => {
    for (const page of [html(<BoardBody data={full} today={TODAY} onDecide={decide} />), html(<ReviewsBody data={full} onDecide={decide} />)]) {
      assert.ok(page.includes('Change the plan'))
      assert.ok(page.includes('Keep the plan'))
    }
  })
  test('an answered proposal shows its answer and offers nothing, whoever is looking', () => {
    const answered: SeoData = {
      ...full,
      log: full.log.map(l => (l.kind === 'proposal' ? { ...l, decision: 'keep', decision_note: 'Not yet', decided_at: '2026-11-03T10:00:00Z' } : l)),
    }
    const page = html(<ReviewsBody data={answered} onDecide={decide} />)
    for (const text of ['Plan kept', '3 Nov', 'Not yet']) assert.ok(page.includes(text), text)
    assert.equal(page.includes('Change the plan'), false)
    assert.equal(html(<BoardBody data={answered} today={TODAY} onDecide={decide} />).includes('Move city pages to January'), false)
  })
})

describe('the Weekly review and Scheduled tasks screens', () => {
  test('a proposal shows its recommendation', () => {
    const data: SeoData = { ...full, log: full.log.map(l => (l.kind === 'proposal' ? { ...l, after_value: 'Change. Category pages first.' } : l)) }
    assert.ok(html(<BoardBody data={data} today={TODAY} />).includes('Change. Category pages first.'))
  })
  test('the notes the Monday session wrote replace the plain summary', () => {
    const data: SeoData = {
      ...full,
      reviews: [{ ...full.reviews[0], detail: { pages: { overview: { kicker: 'Monday', title: 'Clicks fell.', text: 'Why they fell.', lenses: [{ label: 'Plan', tag: { text: 'Hold', tone: 'good' } }], checks: { numbers: 'Read this first.' }, foot: 'Where it comes from.' } } } }],
    }
    const page = html(<OverviewBody data={data} today={TODAY} />)
    for (const text of ['Clicks fell.', 'Why they fell.', 'Hold', 'Read this first.', 'Expert check', 'Where it comes from.']) assert.ok(page.includes(text), text)
    assert.equal(page.includes('Hold course.'), false)
  })
  test('Weekly review: the verdict, its sum, and the page the Monday session wrote', () => {
    const data: SeoData = {
      ...full,
      reviews: [{
        ...full.reviews[0],
        detail: { direction: 'Better', numbers: [{ measure: 'Website leads', this_week: 12, last_week: 10, target: 55, note: 'September' }], next_tasks: ['Rebuild the page'], risk: 'Photos are late' },
      }],
    }
    const page = html(<ReviewsBody data={data} />)
    for (const text of ['Week of 2 Nov', 'Watch', '3 of 5', '2 of 5', 'Better than last week', 'Hold course.', 'Website leads', 'Rebuild the page', 'Photos are late', 'Past weeks']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Weekly review with none yet says so', () => {
    assert.ok(html(<ReviewsBody data={{ ...empty }} />).includes('No Monday review yet'))
  })
  test('Scheduled tasks: every task, its time, its state, what to do and its recent runs', () => {
    const page = html(<TasksBody data={full} today={TODAY} />)
    for (const text of ['Daily SEO numbers', 'Every day, about 10:09 am', 'Mondays, about 11:07 am', 'Login', 'Log in to tools.toolsurf.com', 'No run yet']) {
      assert.ok(page.includes(text), text)
    }
  })
})

describe('an empty module still draws, and says why', () => {
  test('Overview names when the first verdict comes, and nothing waits on the owner', () => {
    const page = html(<OverviewBody data={empty} today={TODAY} />)
    assert.ok(page.includes('No Monday review yet'))
    assert.ok(page.includes('Nothing is waiting on you.'))
  })
  test('the others name what is missing', () => {
    assert.ok(html(<RankingsBody data={empty} />).includes('No India keyword reading saved yet.'))
    assert.ok(html(<RankingsBody data={empty} />).includes('No city results saved yet.'))
    assert.ok(html(<CompetitorsBody data={empty} />).includes('No competitor figures saved yet.'))
    assert.ok(html(<YearBody data={empty} />).includes('No monthly figures saved yet.'))
    assert.ok(html(<BoardBody data={empty} today={TODAY} />).includes('0 done'))
  })
})
