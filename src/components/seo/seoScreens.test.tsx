import '@/lib/testing/cssModuleStub'
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SeoData } from '@/lib/seo/report'
import { BoardBody } from './SeoBoard'
import { CompetitorsBody } from './SeoCompetitors'
import { OverviewBody } from './SeoOverview'
import { RankingsBody } from './SeoRankings'
import { YearBody } from './SeoYear'

const empty: SeoData = { metrics: [], watchlist: [], planItems: [], reviews: [], log: [], runs: [] }
const TODAY = '2026-11-02'

const full: SeoData = {
  metrics: [
    { metric_date: '2026-11-01', metric: 'plan.target', scope: 'Website leads a month', value: 50, detail: { order: 1, months: { '2026-11': 55, '2027-04': 100 } }, source: 'board' },
    { metric_date: '2026-10-26', metric: 'keyword.position', scope: 'hotel chairs', value: 18.6, detail: { previous: 16.4 }, source: 'search_console' },
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

describe('each screen draws saved data', () => {
  test('Overview: the verdict with its sum, the numbers, what needs the owner, the task states', () => {
    const page = html(<OverviewBody data={full} today={TODAY} />)
    for (const text of ['Watch', '3 of 5 due items done, 2 of 5 numbers on target', 'Hold course.', 'target 55', 'Put the category sitemap back on the live site', 'Move city pages to January', 'Logged out 1 Nov', 'No run yet']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Rankings: the keyword, its move, the silent keywords, the city', () => {
    const page = html(<RankingsBody data={full} />)
    for (const text of ['18.6', '16.4', 'Down', 'No impressions that week: cafe chairs', 'Pune', '1 of 1', 'nakhtal.com 1']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Competitors: our row is marked, with its figures and the date they were read', () => {
    const page = html(<CompetitorsBody data={full} />)
    assert.ok(page.includes('bestofexports.com (us)'))
    assert.ok(page.includes('4,828'))
    assert.ok(page.includes('24 Oct'))
  })
  test('Year: the months, the page groups with their change, the work and its gap', () => {
    const page = html(<YearBody data={full} />)
    for (const text of ['Search clicks per month', 'Category pages', '-34%', 'Guest posts', 'November 2025 to March 2026 is not counted yet', 'Hostinger CDN enabled', 'PSI 65 to PSI 69']) {
      assert.ok(page.includes(text), text)
    }
  })
  test('Board: the status in words, its evidence, the targets, what is waiting for an answer', () => {
    const page = html(<BoardBody data={full} today={TODAY} />)
    for (const text of ['Waiting on you', '0 done · 0 started · 1 waiting on you · 0 not started', 'Fixed on staging', 'Due 8 Nov', '100', '0 of 9', 'Move city pages to January', 'City words are tiny.']) {
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
    assert.ok(html(<RankingsBody data={empty} />).includes('No keyword positions saved yet.'))
    assert.ok(html(<RankingsBody data={empty} />).includes('No city results saved yet.'))
    assert.ok(html(<CompetitorsBody data={empty} />).includes('No competitor figures saved yet.'))
    assert.ok(html(<YearBody data={empty} />).includes('No monthly figures saved yet.'))
    assert.ok(html(<BoardBody data={empty} today={TODAY} />).includes('0 done'))
  })
})
