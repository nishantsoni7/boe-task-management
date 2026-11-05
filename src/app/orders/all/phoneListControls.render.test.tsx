// Confirmed Orders on a phone (owner, 2026-11-04, "Option A: compact list"):
// the status chips, the one Filter button and its sheet, and how the page wires
// them to the same URL state as the desktop controls.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlidersHorizontal } from 'lucide-react'
import { PhoneChips, PhoneSheetButton, showResultsLabel, type PhoneSheetGroup } from '@/components/ui/phoneSheet'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}

describe('the status chips', () => {
  const html = renderToStaticMarkup(
    <PhoneChips
      label="Order status"
      rowClassName="orders-phone-chips"
      active="running"
      onSelect={noop}
      chips={[
        { key: 'running', label: 'Running', tone: 'partial', count: 13 },
        { key: 'on_hold', label: 'On Hold', tone: 'zero', count: 0 },
        { key: 'all', label: 'All orders', tone: 'neutral', count: null },
      ]}
    />,
  )

  test('one button per status, in the order given, with its count', () => {
    assert.equal(text(html), 'Running 13 On Hold 0 All orders —')
    assert.equal((html.match(/<button/g) ?? []).length, 3)
  })

  test('the pressed chip is the one shown, and a zero count is faded', () => {
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.ok(html.indexOf('aria-pressed="true"') < html.indexOf('Running'))
    assert.equal((html.match(/is-zero/g) ?? []).length, 1, 'only On Hold 0; a count not read yet is not zero')
  })
})

describe('the Filter button and its sheet', () => {
  const groups = [
    { id: 'person', label: 'Sales person', value: 'all', onChange: noop, options: [{ value: 'all', label: 'Anyone' }, { value: 'u1', label: 'Meera' }] },
    { id: 'sort', label: 'Sort', value: 'number_desc', onChange: noop, options: [{ value: 'number_desc', label: 'Project code high–low' }] },
  ]
  // The Filter button as the page draws it (src/app/orders/all/page.tsx).
  const PhoneFilterButton = ({ activeCount, groups, resultCount, onClearAll, initiallyOpen }: {
    activeCount: number; groups: PhoneSheetGroup[]; resultCount: number; onClearAll: () => void; initiallyOpen?: boolean
  }) => (
    <PhoneSheetButton
      label="Filter" ariaLabel="Filter and sort" title="Filter and sort"
      icon={<SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />}
      badge={activeCount} groups={groups} groupIdPrefix="orders-sheet-"
      doneLabel={showResultsLabel(resultCount, ['order', 'orders'])}
      onClearAll={onClearAll} initiallyOpen={initiallyOpen}
    />
  )

  test('closed: one button, no badge when nothing is set', () => {
    const html = renderToStaticMarkup(<PhoneFilterButton activeCount={0} groups={groups} resultCount={13} onClearAll={noop} />)
    assert.equal(text(html), 'Filter')
    assert.equal(html.includes('orders-phone-filter-badge'), false)
    assert.equal(html.includes('role="dialog"'), false)
  })

  test('a badge says how many filters are set', () => {
    const html = renderToStaticMarkup(<PhoneFilterButton activeCount={2} groups={groups} resultCount={4} onClearAll={noop} />)
    assert.ok(html.includes('orders-phone-filter-badge'))
    assert.ok(html.includes('aria-label="Filter and sort, 2 set"'))
  })

  test('open: every group, the chosen option pressed, Clear all, and the live count', () => {
    const html = renderToStaticMarkup(<PhoneFilterButton activeCount={0} groups={groups} resultCount={13} onClearAll={noop} initiallyOpen />)
    assert.ok(html.includes('role="dialog"'))
    for (const word of ['Sales person', 'Anyone', 'Meera', 'Sort', 'Clear all', 'Show 13 orders']) assert.ok(text(html).includes(word), word)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2, 'one per group')
    assert.ok(html.includes('id="orders-sheet-person"'), 'the groups keep the Orders label ids')
  })

  test('the count reads as words', () => {
    assert.equal(showResultsLabel(1, ['order', 'orders']), 'Show 1 order')
    assert.equal(showResultsLabel(0, ['order', 'orders']), 'Show 0 orders')
  })
})

describe('the page wires the phone controls to the desktop state', () => {
  const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')

  test('Running first and All orders last on a phone', () => {
    assert.ok(page.includes("const PHONE_STATUS_ORDER: StatusFilter[] = ['running', 'on_hold', 'ready_for_dispatch', 'dispatched', 'cancelled', 'all']"))
  })

  test('the chips and the cards select with the same setter and the same counts', () => {
    assert.equal((page.match(/onSelect=\{setStatusTab\}/g) ?? []).length, 2)
    assert.ok(page.includes('count: statusCount(c.key)'))
    assert.ok(page.includes('count: statusCount(key)'))
  })

  test('the sheet uses the desktop setters, and Clear all leaves the status and the search alone', () => {
    for (const setter of ['onChange: setAssignee', 'v => setDateFilter(v as DateFilter)', 'onChange: setSource', 'v => setSortKey(v as SortKey)']) {
      assert.ok(page.includes(setter), setter)
    }
    assert.ok(page.includes("onClearAll={() => setListState({ assignee: '', source: '', date: 'all', sort: 'number_desc' })}"))
  })

  test('the phone row is three lines and has no Sales person', () => {
    const cards = page.slice(page.indexOf('<ul className="orders-list-cards"'), page.indexOf('</ul>'))
    const card = cards.slice(cards.indexOf("className={`orders-list-card${"))
    const order = ['orders-list-card-top', 'orders-list-card-line', 'orders-list-card-status']
    order.reduce((at, cls) => { const next = card.indexOf(cls); assert.ok(next > at, cls); return next }, -1)
    assert.equal(card.includes('assigned_to_name'), false)
  })

  test('CSS shows one set of controls: the desktop set is hidden on a phone, the phone set everywhere else', () => {
    assert.ok(css.includes('.orders-desktop-controls, .orders-desktop-viewbar { display: none; }'))
    assert.ok(/\.orders-phone-chips,\r?\n\.orders-phone-tools,\r?\n\.orders-phone-summary \{ display: none; \}/.test(css))
  })

  test('only this page asks for the compact header', () => {
    assert.ok(page.includes('phoneSubtitle={phoneSubtitle}'))
  })
})
