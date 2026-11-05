// The one phone filter set (components/ui/PhoneFilters.tsx): chips, the search
// box, the Filter button with its bottom sheet, and the sheet's groups. The
// pages that use it pin their own wiring in their phone tests
// (orders/all/phoneListControls, tasks/phoneTasksAdmin, phoneSalesShowroom,
// attendancePayroll/phoneAttendancePayroll).
//
// Run:
//   npx tsx --import ./scripts/testing/screen-source-preload.mjs --test src/components/ui/phoneFilters.render.test.tsx

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PhoneChips, PhoneFilterSheet, PhoneMultiGroup, PhoneOptionGroup, PhoneSearchBox, PhoneSearchFilter, PhoneSheetField, showResultsLabel,
} from './PhoneFilters'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}

describe('PhoneChips', () => {
  test('the row class defaults to boe-p3-chips; Orders can name its own; extras are added', () => {
    const chips = [{ key: 'a', label: 'A' }]
    assert.ok(renderToStaticMarkup(<PhoneChips label="L" chips={chips} active="a" onSelect={noop} />).startsWith('<div class="boe-p3-chips" role="group" aria-label="L">'))
    assert.ok(renderToStaticMarkup(<PhoneChips label="L" chips={chips} active="a" onSelect={noop} className="boe-p3-inset" />).startsWith('<div class="boe-p3-chips boe-p3-inset"'))
    assert.ok(renderToStaticMarkup(<PhoneChips label="Order status" rowClassName="orders-phone-chips" chips={chips} active="a" onSelect={noop} />).startsWith('<div class="orders-phone-chips" role="group" aria-label="Order status">'))
  })

  test('a tone draws a dot, a count draws a number, null draws a dash, no count draws nothing', () => {
    const html = renderToStaticMarkup(
      <PhoneChips label="L" active="a" onSelect={noop} chips={[
        { key: 'a', label: 'A', tone: 'partial', count: 2 },
        { key: 'b', label: 'B', count: null },
        { key: 'c', label: 'C' },
      ]} />,
    )
    assert.equal((html.match(/fin-dot--partial/g) ?? []).length, 1)
    assert.equal(text(html), 'A 2 B — C')
    assert.equal((html.match(/orders-phone-chip-count/g) ?? []).length, 2)
  })
})

describe('PhoneFilterSheet', () => {
  test('closed, defaults: "Filter" with the sliders icon, named by its title, no sheet', () => {
    const html = renderToStaticMarkup(<PhoneFilterSheet />)
    assert.ok(html.startsWith('<button type="button" class="orders-phone-filter" aria-haspopup="dialog" aria-expanded="false" aria-label="Filter">'))
    assert.ok(html.includes('<svg'), 'the sliders icon')
    assert.equal(text(html), 'Filter')
    assert.equal(html.includes('role="dialog"'), false)
  })

  test('the caller\'s classes, the badge, and the name: ariaLabel wins over title', () => {
    const html = renderToStaticMarkup(<PhoneFilterSheet triggerClassName="boe-phone-only p3-filter" activeCount={3} title="Filter and sort" />)
    assert.ok(html.includes('class="orders-phone-filter boe-phone-only p3-filter is-set"'))
    assert.ok(html.includes('aria-label="Filter and sort, 3 set"'))
    assert.ok(html.includes('<span class="orders-phone-filter-badge" aria-hidden="true">3</span>'))
    assert.ok(renderToStaticMarkup(<PhoneFilterSheet ariaLabel="Filter" title="Filter records" />).includes('aria-label="Filter"'))
  })

  test('another label and icon (a Download sheet), or no icon at all', () => {
    const html = renderToStaticMarkup(<PhoneFilterSheet label="Download" title="Download" icon={<i data-icon="dl" />} />)
    assert.ok(html.includes('<i data-icon="dl"></i>Download'))
    assert.equal(renderToStaticMarkup(<PhoneFilterSheet icon={null} />).includes('<svg'), false)
  })

  test('open: heading, Clear all only when given, groups before children, the apply label', () => {
    const html = renderToStaticMarkup(
      <PhoneFilterSheet title="Filter and sort" sheetClassName="p3-sheet" applyLabel={showResultsLabel(12, ['lead', 'leads'])} onClearAll={noop} initiallyOpen
        groups={[{ id: 'sort', label: 'Sort', value: 'b', onChange: noop, options: [{ value: 'a', label: 'Name' }, { value: 'b', label: 'Newest' }] }]}>
        <PhoneSheetField label="Month"><select aria-label="Month" /></PhoneSheetField>
      </PhoneFilterSheet>,
    )
    assert.ok(html.includes('class="orders-sheet p3-sheet" role="dialog" aria-modal="true" aria-label="Filter and sort"'))
    assert.ok(html.includes('<h2>Filter and sort</h2>'))
    assert.equal(text(html).replace(/^Filter /, ''), 'Filter and sort Clear all Sort Name Newest Month Show 12 leads')
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.equal(renderToStaticMarkup(<PhoneFilterSheet initiallyOpen />).includes('Clear all'), false)
    assert.ok(renderToStaticMarkup(<PhoneFilterSheet initiallyOpen />).includes('orders-sheet-apply">Done<'))
  })
})

describe('the sheet groups', () => {
  test('one choice: labelled by its own heading; content replaces the options', () => {
    const html = renderToStaticMarkup(<PhoneOptionGroup id="d" label="Date" value="x" onChange={noop} options={[{ value: 'x', label: 'Today' }]} />)
    assert.ok(html.includes('aria-labelledby="p3-sheet-d"') && html.includes('id="p3-sheet-d"'))
    assert.ok(html.includes('aria-pressed="true">Today<'))
    const own = renderToStaticMarkup(<PhoneOptionGroup id="f" label="Filters" content={<select aria-label="P" />} />)
    assert.equal(own.includes('orders-sheet-options'), false)
    assert.ok(own.includes('aria-label="P"'))
  })

  test('several choices at once, and the empty text', () => {
    const html = renderToStaticMarkup(<PhoneMultiGroup id="a" label="Area" value={['A', 'B']} onChange={noop} options={[{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }]} />)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2)
    assert.ok(renderToStaticMarkup(<PhoneMultiGroup id="a" label="Area" value={[]} onChange={noop} options={[]} emptyText="None yet" />).includes('p3-sheet-empty">None yet<'))
  })
})

describe('PhoneSearchFilter and PhoneSearchBox', () => {
  test('the search box clears only when it has text', () => {
    assert.equal(renderToStaticMarkup(<PhoneSearchBox value="" onChange={noop} placeholder="Find" label="Find tasks" />).includes('Clear search'), false)
    assert.ok(renderToStaticMarkup(<PhoneSearchBox value="x" onChange={noop} placeholder="Find" label="Find tasks" />).includes('aria-label="Clear search"'))
  })

  test('the tools row: search, the boe-p3-filter button, then the page\'s extras; no button without groups', () => {
    const groups = [{ id: 'p', label: 'Priority', value: '', onChange: noop, options: [{ value: '', label: 'All' }] }]
    const html = renderToStaticMarkup(
      <PhoneSearchFilter className="boe-p3-inset" search={{ value: '', onChange: noop, placeholder: 'Find', label: 'Find tasks' }}
        groups={groups} activeCount={0} resultCount={2} noun={['task', 'tasks']} onClearAll={noop}><a href="/new">New</a></PhoneSearchFilter>,
    )
    assert.ok(html.startsWith('<div class="boe-p3-tools boe-p3-inset" role="search">'))
    const at = (s: string) => html.indexOf(s)
    assert.ok(at('aria-label="Find tasks"') < at('class="orders-phone-filter boe-p3-filter"') && at('class="orders-phone-filter boe-p3-filter"') < at('href="/new"'))
    const none = renderToStaticMarkup(<PhoneSearchFilter groups={[]} activeCount={0} resultCount={0} noun={['task', 'tasks']} onClearAll={noop} />)
    assert.equal(none.includes('orders-phone-filter'), false)
  })

  test('showResultsLabel', () => {
    assert.equal(showResultsLabel(1, ['order', 'orders']), 'Show 1 order')
    assert.equal(showResultsLabel(0, ['meeting', 'meetings']), 'Show 0 meetings')
  })
})

describe('there is one set', () => {
  test('no copy of the sheet is left elsewhere in src', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !p.endsWith(join('ui', 'PhoneFilters.tsx')) && !/\.test\.tsx?$/.test(name)) {
          if (readFileSync(p, 'utf8').includes('className="orders-sheet-head"')) offenders.push(p)
        }
      }
    }
    walk('src')
    assert.deepEqual(offenders, [], 'draw the sheet with PhoneFilterSheet')
  })
})
