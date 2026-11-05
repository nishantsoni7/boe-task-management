// The one phone Filter button and bottom sheet (owner, 2026-11-05): the shared
// pieces every list uses (Orders, Tasks, Meetings, Sales, Vendors, Reviews,
// Attendance). Each list passes its own classes, so these tests pin both the
// defaults and that a caller's classes, ids and words reach the markup.
//
// Run:
//   npx tsx --import ./scripts/testing/screen-source-preload.mjs --test src/components/ui/phoneSheet/phoneSheet.render.test.tsx

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BottomSheet, PhoneChips, PhoneMultiGroup, PhoneSearchFilter, PhoneSheetButton, PhoneSheetField, showResultsLabel,
  type PhoneSheetGroup,
} from '.'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const pressed = (html: string) => (html.match(/aria-pressed="true"/g) ?? []).length
const noop = () => {}

const single: PhoneSheetGroup = {
  id: 'sort', label: 'Sort', value: 'new', onChange: noop,
  options: [{ value: 'new', label: 'Newest' }, { value: 'old', label: 'Oldest' }],
}
const multi: PhoneSheetGroup = {
  id: 'area', label: 'Area',
  options: [{ value: 'a', label: 'Andheri' }, { value: 'b', label: 'Bandra' }, { value: 'c', label: 'Colaba' }],
  multiple: { value: ['a', 'c'], onChange: noop },
}
const free: PhoneSheetGroup = { id: 'from', label: 'From date', content: <input type="date" aria-label="From date" /> }

describe('BottomSheet', () => {
  test('a dialog named by its title, Close, and the footer words the caller gives', () => {
    const html = renderToStaticMarkup(<BottomSheet title="Filter" onClose={noop} doneLabel="Show 3 tasks"><p>inside</p></BottomSheet>)
    assert.ok(html.startsWith('<div class="orders-sheet-backdrop"></div>'))
    assert.match(html, /class="orders-sheet" role="dialog" aria-modal="true" aria-label="Filter" tabindex="-1"/)
    assert.match(html, /<h2>Filter<\/h2>/)
    assert.ok(html.includes('aria-label="Close"'))
    assert.equal(html.includes('Clear all'), false, 'no Clear all unless asked for')
    assert.match(html, /<p>inside<\/p><button type="button" class="boe-btn boe-btn-primary orders-sheet-apply">Show 3 tasks<\/button>/)
  })
  test('Clear all when given, and the panel takes a caller\'s classes', () => {
    const html = renderToStaticMarkup(<BottomSheet title="Download" className="orders-sheet p3-sheet" onClose={noop} onClearAll={noop} doneLabel="Done" />)
    assert.ok(html.includes('class="orders-sheet p3-sheet"'))
    assert.ok(html.includes('class="orders-sheet-clear">Clear all</button>'))
  })
})

describe('PhoneChips', () => {
  const chips = [
    { key: 'run', label: 'Running', tone: 'partial' as const, count: 13 },
    { key: 'hold', label: 'On Hold', count: 0 },
    { key: 'all', label: 'All', count: null },
    { key: 'mine', label: 'Mine' },
  ]
  test('one chip each: a dot only with a tone, a count only when given, a zero faded', () => {
    const html = renderToStaticMarkup(<PhoneChips label="Tasks" chips={chips} active="hold" onSelect={noop} />)
    assert.ok(html.startsWith('<div class="boe-p3-chips" role="group" aria-label="Tasks">'))
    assert.equal(text(html), 'Running 13 On Hold 0 All — Mine')
    assert.equal((html.match(/fin-dot--partial/g) ?? []).length, 1)
    assert.equal((html.match(/orders-phone-chip-count/g) ?? []).length, 3)
    assert.equal((html.match(/is-zero/g) ?? []).length, 1)
    assert.equal(pressed(html), 1)
  })
  test('the row class can be the Orders one, with a class added', () => {
    const html = renderToStaticMarkup(<PhoneChips label="Order status" rowClassName="orders-phone-chips" className="x" chips={chips} active="run" onSelect={noop} />)
    assert.ok(html.startsWith('<div class="orders-phone-chips x" role="group" aria-label="Order status">'))
  })
})

describe('PhoneSearchFilter', () => {
  const search = { value: 'abc', onChange: noop, placeholder: 'Find', label: 'Find tasks' }

  test('closed: the search, one Filter button with its badge, the page\'s extras, no sheet', () => {
    const html = renderToStaticMarkup(
      <PhoneSearchFilter search={search} groups={[single]} activeCount={2} resultCount={4} noun={['task', 'tasks']} onClearAll={noop}>
        <button type="button">Add</button>
      </PhoneSearchFilter>,
    )
    assert.ok(html.startsWith('<div class="boe-p3-tools" role="search">'))
    assert.ok(html.includes('aria-label="Find tasks"') && html.includes('aria-label="Clear search"'))
    assert.match(html, /class="orders-phone-filter boe-p3-filter is-set" aria-haspopup="dialog" aria-expanded="false" aria-label="Filter, 2 set"/)
    assert.ok(html.includes('<span class="orders-phone-filter-badge" aria-hidden="true">2</span>'))
    assert.ok(html.includes('>Add</button>'))
    assert.equal(html.includes('role="dialog"'), false)
  })

  test('no groups: no Filter button', () => {
    const html = renderToStaticMarkup(<PhoneSearchFilter search={search} groups={[]} activeCount={0} resultCount={0} noun={['task', 'tasks']} onClearAll={noop} />)
    assert.equal(html.includes('orders-phone-filter'), false)
  })

  test('open: single, multi and free groups, each named by its label, and "Show N nouns"', () => {
    const html = renderToStaticMarkup(
      <PhoneSearchFilter groups={[single, multi, free]} activeCount={0} resultCount={1} noun={['meeting', 'meetings']} onClearAll={noop} initiallyOpen />,
    )
    assert.match(html, /aria-label="Filter" tabindex="-1"/)
    for (const id of ['sort', 'area', 'from']) {
      assert.ok(html.includes(`aria-labelledby="p3-sheet-${id}"`) && html.includes(`id="p3-sheet-${id}"`), id)
    }
    assert.equal(pressed(html), 3, 'Newest, Andheri and Colaba')
    assert.ok(html.includes('type="date"'))
    assert.ok(html.includes('Clear all'))
    assert.ok(html.includes('orders-sheet-apply">Show 1 meeting</button>'))
  })

  test('a page can give the result words itself', () => {
    const html = renderToStaticMarkup(
      <PhoneSearchFilter groups={[single]} activeCount={0} resultCount={9} noun={['x', 'xs']} resultLabel="Show the report" onClearAll={noop} initiallyOpen />,
    )
    assert.ok(html.includes('orders-sheet-apply">Show the report</button>'))
  })
})

describe('PhoneSheetButton', () => {
  test('closed: the default look, no badge, no sheet', () => {
    const html = renderToStaticMarkup(<PhoneSheetButton label="Download" title="Download"><p>x</p></PhoneSheetButton>)
    assert.equal(html, '<button type="button" class="orders-phone-filter" aria-haspopup="dialog" aria-expanded="false" aria-label="Download">Download</button>')
  })

  test('a badge, the caller\'s classes in order, and a screen-reader name of its own', () => {
    const html = renderToStaticMarkup(
      <PhoneSheetButton label="Filter" ariaLabel="Filter and sort" title="Filter and sort" badge={3}
        triggerClassName="boe-phone-only orders-phone-filter p3-filter" className="extra" icon={<svg aria-hidden="true" />} />,
    )
    assert.match(html, /class="boe-phone-only orders-phone-filter p3-filter is-set extra"/)
    assert.ok(html.includes('aria-label="Filter and sort, 3 set"'))
    assert.ok(html.includes('<svg aria-hidden="true"></svg>Filter<span class="orders-phone-filter-badge" aria-hidden="true">3</span>'))
  })

  test('open: groups (with their id prefix), then the page\'s own controls, then the footer', () => {
    const html = renderToStaticMarkup(
      <PhoneSheetButton label="Filter" title="Filter" sheetClassName="orders-sheet p3-sheet" groups={[single]} groupIdPrefix="orders-sheet-"
        doneLabel={showResultsLabel(13, ['order', 'orders'])} onClearAll={noop} initiallyOpen>
        <PhoneMultiGroup id="v-area" label="Area" options={[{ value: 'a', label: 'Andheri' }]} value={['a']} onChange={noop} />
        <PhoneMultiGroup id="v-none" label="Team" options={[]} value={[]} onChange={noop} emptyText="No teams yet" />
        <PhoneSheetField label="Month"><select aria-label="Month" /></PhoneSheetField>
      </PhoneSheetButton>,
    )
    assert.ok(html.includes('aria-expanded="true"'))
    assert.ok(html.includes('class="orders-sheet p3-sheet" role="dialog"'))
    assert.ok(html.includes('id="orders-sheet-sort"'), 'the single group takes the prefix given')
    assert.ok(html.includes('id="p3-sheet-v-area"'), 'PhoneMultiGroup keeps its own prefix')
    assert.ok(html.includes('<span class="p3-sheet-empty">No teams yet</span>'))
    assert.ok(html.includes('<div class="orders-sheet-group p3-sheet-field"><div class="orders-sheet-label">Month</div>'))
    assert.equal(pressed(html), 2, 'Newest and Andheri')
    const order = ['Sort', 'Area', 'Team', 'Month', 'Show 13 orders']
    order.reduce((at, word) => { const next = text(html).indexOf(word); assert.ok(next > at, word); return next }, -1)
  })

  test('"Done" by default, and no Clear all unless given', () => {
    const html = renderToStaticMarkup(<PhoneSheetButton label="Download" title="Download" initiallyOpen><p>x</p></PhoneSheetButton>)
    assert.ok(html.includes('orders-sheet-apply">Done</button>'))
    assert.equal(html.includes('Clear all'), false)
  })
})

describe('showResultsLabel', () => {
  test('one and many', () => {
    assert.equal(showResultsLabel(1, ['task', 'tasks']), 'Show 1 task')
    assert.equal(showResultsLabel(0, ['task', 'tasks']), 'Show 0 tasks')
    assert.equal(showResultsLabel(12, ['lead', 'leads']), 'Show 12 leads')
  })
})
