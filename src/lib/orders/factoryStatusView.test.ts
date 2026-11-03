/**
 * Factory Status says where the Order is and how much has left (owner,
 * 2026-11-03), and the Confirmed Orders list opens on Running.
 *
 * Run:
 *   npx tsx --test src/lib/orders/factoryStatusView.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { enumParam } from '../listState'
import { factoryView, parseDispatchProgress, type DispatchProgress } from './orderListValue'

const progress = (ordered: number, dispatched: number, last: string | null = '2026-10-28'): DispatchProgress =>
  ({ ordered, dispatched, lastDispatchedOn: last })
const running = (alignment: string | null) => ({ status: 'running', production_alignment: alignment })

describe('Factory Status, from the Order\'s status', () => {
  test('a Running Order says Aligned or Not Aligned, as it always did', () => {
    assert.deepEqual(factoryView(running('aligned')), { tone: 'aligned', label: 'Aligned', note: null })
    assert.deepEqual(factoryView(running('not_aligned')), { tone: 'not_aligned', label: 'Not Aligned', note: null })
    assert.deepEqual(factoryView(running(null)), { tone: 'not_aligned', label: 'Not Aligned', note: null })
  })

  test('the other statuses say their own words, and never Aligned', () => {
    assert.deepEqual(factoryView({ status: 'on_hold', production_alignment: 'aligned' }), { tone: 'on_hold', label: 'On hold', note: null })
    assert.deepEqual(factoryView({ status: 'ready_for_dispatch', production_alignment: 'aligned' }), { tone: 'ready', label: 'Ready for dispatch', note: null })
    assert.deepEqual(factoryView({ status: 'dispatched', production_alignment: 'aligned' }), { tone: 'dispatched', label: 'Dispatched', note: null })
  })

  test('part dispatched is a line under the status, not a status: Running keeps Aligned, Ready keeps Ready', () => {
    assert.deepEqual(factoryView(running('aligned'), progress(74, 22)),
      { tone: 'aligned', label: 'Aligned', note: 'Part dispatched · 22 of 74 pcs' })
    assert.deepEqual(factoryView({ status: 'ready_for_dispatch', production_alignment: 'aligned' }, progress(40, 18)),
      { tone: 'ready', label: 'Ready for dispatch', note: 'Part dispatched · 18 of 40 pcs' })
    assert.deepEqual(factoryView({ status: 'on_hold', production_alignment: 'aligned' }, progress(10, 4)),
      { tone: 'on_hold', label: 'On hold', note: 'Part dispatched · 4 of 10 pcs' })
  })

  test('Dispatched says what went and when, read as written (no time-zone shift)', () => {
    const v = factoryView({ status: 'dispatched', production_alignment: 'aligned' }, progress(74, 74, '2026-10-28'))
    assert.deepEqual(v, { tone: 'dispatched', label: 'Dispatched', note: '74 pcs · last 28 Oct' })
    assert.equal(factoryView({ status: 'dispatched', production_alignment: null }, progress(20, 20, '2026-01-01')).note, '20 pcs · last 1 Jan')
    assert.equal(factoryView({ status: 'dispatched', production_alignment: null }, progress(20, 20, null)).note, '20 pcs')
  })

  test('Dispatched by hand with pieces unrecorded says how much is recorded, and no more', () => {
    assert.equal(factoryView({ status: 'dispatched', production_alignment: null }, progress(74, 22)).note, '22 of 74 pcs recorded')
  })

  test('everything sent but the Order not closed yet says that and claims nothing else', () => {
    assert.equal(factoryView(running('aligned'), progress(74, 74)).note, 'All dispatched · 74 pcs')
    assert.equal(factoryView(running('aligned'), progress(1, 1)).note, 'All dispatched · 1 pc')
  })

  test('no progress, or nothing sent: no line, never a claim', () => {
    assert.equal(factoryView(running('aligned'), null).note, null)
    assert.equal(factoryView(running('aligned'), undefined).note, null)
    assert.equal(factoryView(running('aligned'), progress(74, 0)).note, null)
  })

  test('quantities read the Indian way, with two decimals at most', () => {
    assert.equal(factoryView(running('aligned'), progress(3000, 1200)).note, 'Part dispatched · 1,200 of 3,000 pcs')
    assert.equal(factoryView(running('aligned'), progress(10, 2.5)).note, 'Part dispatched · 2.5 of 10 pcs')
  })
})

describe('orders_dispatch_progress(), made safe', () => {
  test('numbers arrive as numbers or as strings, and a date keeps its day', () => {
    const m = parseDispatchProgress([
      { order_id: 'a', ordered: '74', dispatched: 22, last_dispatched_on: '2026-10-28' },
      { order_id: 'b', ordered: 10, dispatched: '2.50', last_dispatched_on: '2026-10-28T00:00:00Z' },
    ])
    assert.deepEqual(m.get('a'), { ordered: 74, dispatched: 22, lastDispatchedOn: '2026-10-28' })
    assert.deepEqual(m.get('b'), { ordered: 10, dispatched: 2.5, lastDispatchedOn: '2026-10-28' })
  })

  test('a row that is not a pair of real numbers, or sent nothing, is dropped; so is a non-list', () => {
    const m = parseDispatchProgress([
      { order_id: 'a', ordered: 'x', dispatched: 1 },
      { order_id: 'b', ordered: 10, dispatched: 0 },
      { order_id: '', ordered: 10, dispatched: 1 },
      null,
      'row',
      { order_id: 'c', ordered: 10, dispatched: 1, last_dispatched_on: 'yesterday' },
    ])
    assert.deepEqual([...m.keys()], ['c'])
    assert.equal(m.get('c')?.lastDispatchedOn, null)
    assert.equal(parseDispatchProgress(null).size, 0)
    assert.equal(parseDispatchProgress({ order_id: 'a' }).size, 0)
  })
})

describe('the Confirmed Orders list opens on Running (owner, 2026-11-03)', () => {
  const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
  const statuses = ['all', 'running', 'on_hold', 'ready_for_dispatch', 'dispatched', 'cancelled'] as const

  test('the page\'s own status codec defaults to running, and All orders is written to the URL', () => {
    assert.ok(/status:\s+enumParam<StatusFilter>\(\['all', 'running', 'on_hold', 'ready_for_dispatch', 'dispatched', 'cancelled'\], 'running'\)/.test(page))
    const codec = enumParam(statuses, 'running')
    assert.equal(codec.parse(null), 'running')
    assert.equal(codec.parse('all'), 'all')
    assert.equal(codec.parse('nonsense'), 'running')
    assert.equal(codec.serialize('running'), null, 'the default is never written, so /orders/all is a clean URL')
    assert.equal(codec.serialize('all'), 'all')
  })

  test('a search or the operations queue looks at every status, and the pressed card says so', () => {
    assert.ok(page.includes("const widened = statusTab === 'running' && (search.trim() !== '' || opsFilter === 'awaiting')"))
    assert.ok(page.includes("const effectiveStatus: StatusFilter = widened ? 'all' : statusTab"))
    assert.ok(page.includes('active={effectiveStatus}'))
    assert.ok(page.includes(": baseFiltered.filter(o => o.status === effectiveStatus)"), 'the rows follow the same status as the pressed card')
    assert.ok(page.includes('Searching every status for “{search.trim()}”, so a finished order is never hidden.'))
    assert.ok(page.includes('Back to Running'))
  })

  test('Running and All orders are not "filters": neither shows Clear filters', () => {
    assert.ok(page.includes("(effectiveStatus !== 'all' && effectiveStatus !== 'running') || assignee !== 'all' ||"))
  })

  test('an empty Running view says so and offers the rest, instead of "No Confirmed Orders yet."', () => {
    assert.ok(page.includes("effectiveStatus === 'running' && orders.length > 0"))
    assert.ok(page.includes('No running orders right now.'))
    assert.ok(page.includes('Show all orders'))
  })

  test('Factory Status is drawn by FactoryCell in the table and in the phone card, from one extra read', () => {
    assert.equal((page.match(/<FactoryCell view=\{factoryView\(o, dispatch\.get\(o\.id\)\)\} \/>/g) ?? []).length, 2)
    assert.equal((page.match(/rpc\('orders_dispatch_progress'\)/g) ?? []).length, 1)
    assert.ok(page.includes('loadAdvance(), loadDispatch()]'), 'Refresh re-reads it')
    assert.ok(page.includes('setDispatch(error ? new Map() : parseDispatchProgress(data))'), 'a failed read draws no line')
    assert.equal(page.includes('FactoryBadge'), false)
  })

  test('the column is wide enough that "Part dispatched · 22 of 74 pcs" is not cut', () => {
    assert.ok(page.includes("<col style={{ width: '21%' }} />{/* Factory Status:"))
    assert.equal((page.match(/<col /g) ?? []).length, 9)
    const css = readFileSync('src/app/globals.css', 'utf8')
    assert.ok(css.includes('.fin-table--orders { min-width: 1240px; }'))
    assert.ok(css.includes('.fin-table--orders .orders-after-value { padding-left: 56px; }'), 'the air before Factory Status is the other session\'s 56px')
    assert.ok(css.includes('.orders-dispatch .fin-sub {'))
    assert.ok(css.includes('.orders-status-done {'))
    assert.ok(css.includes('.orders-search-note {'))
  })
})

describe('the Order page offers what the database allows', () => {
  const page = readFileSync('src/app/orders/[id]/page.tsx', 'utf8')

  test('Ready for Dispatch can go back to Running; Dispatched stays terminal here', () => {
    assert.ok(page.includes("ready_for_dispatch: ['running',   'dispatched','cancelled'],"))
    assert.ok(page.includes('  dispatched:         [],'))
  })

  test('once something has left, Cancel is not in the menu', () => {
    assert.ok(page.includes("allowedTransitions(profile, order.status).filter(s => !(hasDispatch && s === 'cancelled'))"))
    assert.ok(page.includes('hasDispatch={!!dispatchLedger && dispatchLedger.dispatched > 0}'))
  })
})
