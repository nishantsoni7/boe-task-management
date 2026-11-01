// The small pieces of the Confirmed Orders table that hold a decision: what the
// Advance and Pendencies cells say, and what a sorting heading announces and asks for.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdvanceCell } from './AdvanceCell'
import { PendencyCell } from './PendenciesPopup'
import { SortHeader } from './SortHeader'
import type { OrderPendencyOverview } from '@/lib/orders/pendencyOverview'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}

const overview = (count: number): OrderPendencyOverview => ({
  approved: count === 0,
  pending: Array.from({ length: count }, (_, i) => ({ key: `k${i}`, label: `Item ${i}`, detail: 'Not Approved' })),
})

describe('the Advance cell (owner, 2026-11-01)', () => {
  const cell = (percent: number | string | null | undefined) => renderToStaticMarkup(<AdvanceCell percent={percent} />)

  test('below 40%: the percentage on the red background, with no dot', () => {
    assert.equal(text(cell(35.5)), '35.5%')
    assert.ok(cell('39.99').includes('fin-pill--over'))
    assert.equal(cell(35.5).includes('fin-pill '), false)
  })

  test('40% and above: the percentage, plain', () => {
    for (const [value, shown] of [['40.00', '40%'], [40.01, '40.01%'], [100, '100%']] as const) {
      assert.equal(text(cell(value)), shown)
      assert.equal(cell(value).includes('fin-pill--over'), false)
    }
  })

  test('no figure: a dash, plain, never 0%', () => {
    for (const none of [null, undefined]) {
      assert.equal(text(cell(none)), '—')
      assert.equal(cell(none).includes('fin-pill--over'), false)
    }
  })
})

describe('the Pendencies cell (owner, 2026-10-31)', () => {
  test('something outstanding: how many, in a red pill that opens the list', () => {
    const html = renderToStaticMarkup(<PendencyCell overview={overview(3)} onOpen={noop} />)
    assert.equal(text(html), '3 pending')
    assert.ok(html.startsWith('<button'))
    assert.ok(html.includes('fin-pill--over'))
    assert.ok(html.includes('aria-haspopup="dialog"'))
    assert.equal(html.includes('Not Approved'), false)
  })

  test('one outstanding reads the same way', () => {
    assert.equal(text(renderToStaticMarkup(<PendencyCell overview={overview(1)} onOpen={noop} />)), '1 pending')
  })

  test('nothing outstanding: a dot and the word, not a pill, and nothing to press', () => {
    const html = renderToStaticMarkup(<PendencyCell overview={overview(0)} onOpen={noop} />)
    assert.equal(text(html), 'Approved')
    assert.ok(html.includes('orders-status-ok'))
    assert.equal(html.includes('fin-pill'), false)
    assert.equal(html.includes('<button'), false)
  })

  test('not read yet: a dash, never a status nobody checked', () => {
    assert.equal(text(renderToStaticMarkup(<PendencyCell overview={undefined} onOpen={noop} />)), '—')
  })
})

describe('a heading that sorts', () => {
  type Key = 'number_desc' | 'number_asc' | 'value_desc' | 'value_asc'
  const head = (current: Key, onSort: (next: Key) => void = noop) =>
    <SortHeader<Key> label="Project Code" current={current} high="number_desc" low="number_asc" onSort={onSort} />

  // The element renderToStaticMarkup would draw, without a DOM to click.
  const pressed = (current: Key) => {
    let next: Key | null = null
    const th = SortHeader<Key>({ label: 'Project Code', current, high: 'number_desc', low: 'number_asc', onSort: k => { next = k } })
    const button = th.props.children as { props: { onClick: () => void } }
    button.props.onClick()
    return next
  }

  test('it says which way the list is sorted, and only on the sorted column', () => {
    const wrap = (el: React.ReactElement) => renderToStaticMarkup(<table><thead><tr>{el}</tr></thead></table>)
    assert.ok(wrap(head('number_desc')).includes('aria-sort="descending"'))
    assert.ok(wrap(head('number_asc')).includes('aria-sort="ascending"'))
    assert.equal(wrap(head('value_desc')).includes('aria-sort'), false)
    assert.ok(wrap(head('number_desc')).includes('orders-sort is-active'))
    assert.equal(wrap(head('value_desc')).includes('is-active'), false)
  })

  test('the first press is highest first, the next turns it round', () => {
    assert.equal(pressed('value_desc'), 'number_desc', 'from another column')
    assert.equal(pressed('number_desc'), 'number_asc')
    assert.equal(pressed('number_asc'), 'number_desc')
  })
})
