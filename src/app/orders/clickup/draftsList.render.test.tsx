// What the Draft Orders list draws: the status cards that are the filter, the search box in its wrapper, one table
// with its own columns, soft pills, and the words when nothing is there. Orders are invented; real orders are
// customer data and never enter the repository.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { DraftsList } from './DraftsList'
import type { DraftListRow } from '@/lib/orders/clickupDrafts'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => undefined

const row = (n: number, client: string, status: string, fields: Record<string, string> = {}, assignees = ['Salesperson One']): DraftListRow => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, order_no: String(n), name: `${n} ${client}`, client_name: client, status, assignees,
  due_date: '2026-11-20', fields: { 'Total Product Value': '361900', 'Confirm Date': '2026-09-30', 'FABRIC STATUS': 'FABRIC PENDING', 'FINISH STATUS': 'FINISH APPROVED', ...fields },
  file_count: 2, comment_count: 0,
})

const ROWS = [
  row(535, 'Aarav Textiles', 'running orders'),
  row(534, 'Mahant Hospitality', 'running orders', { 'Total Product Value': '2795000' }, ['Saksham Bhardwaj']),
  row(520, 'Gulmohar Estate', 'hold'),
  row(518, 'Pacific Residency', 'dispatched', { 'FABRIC STATUS': '', 'FINISH STATUS': '', 'Total Product Value': '' }, []),
]

const draw = (over: Partial<React.ComponentProps<typeof DraftsList>> = {}) =>
  renderToStaticMarkup(<DraftsList rows={ROWS} tab="running orders" query="" onTab={noop} onQuery={noop} onClear={noop} onOpen={noop} onDownload={noop} downloading={false} {...over} />)

describe('the Draft Orders list', () => {
  test('the status cards are the filter: counts under each, the pressed one marked, All last', () => {
    const html = draw()
    assert.ok(html.includes('aria-label="Order status"'))
    const t = text(html)
    for (const word of ['Running orders', 'Ready for dispatch', 'On hold', 'Cancelled', 'Dispatched', 'All orders']) assert.ok(t.includes(word), word)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.ok(/aria-pressed="true"[^>]*>\s*<span[^>]*><span[^>]*><\/span>Running orders/.test(html), 'Running orders is the pressed card')
    assert.ok(html.indexOf('All orders') > html.indexOf('Dispatched'))
    assert.ok(t.includes('All orders 4 orders'))
  })

  test('the search box is a label around the input: the wrapper class is never put on the bare input (it made the box 220px tall)', () => {
    const html = draw()
    assert.ok(/<label class="boe-list-search"><svg[^>]*>.*?<\/svg><input type="search"/.test(html))
    assert.equal(/<input[^>]*class="[^"]*boe-list-search/.test(html), false)
    assert.ok(html.includes('aria-label="Search draft orders"'))
    assert.equal(html.includes('boe-list-search-clear'), false, 'no clear button while the box is empty')
    assert.ok(draw({ query: 'aarav' }).includes('boe-list-search-clear'))
  })

  test('one table: each column has its own width, numbers sit right, and under a status card there is no Status column', () => {
    const html = draw()
    assert.ok(html.includes('class="fin-table"'))
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1])
    assert.deepEqual(heads, ['Order', 'Client', 'Assigned', 'Confirm date', 'Due', 'Value', 'Fabric', 'Finish', 'Files'])
    const widths = [...html.matchAll(/<col style="width:([\d.]+)%"/g)].map(m => Number(m[1]))
    assert.equal(widths.length, heads.length)
    assert.equal(Math.round(widths.reduce((a, b) => a + b, 0)), 100, 'the columns add up to the whole table')
    assert.equal((html.match(/<th class="fin-num"/g) ?? []).length, 2, 'Value and Files are right-aligned')
  })

  test('under All orders each row also says its status, in its own soft colour', () => {
    const html = draw({ tab: 'all' })
    assert.ok([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]).includes('Status'))
    assert.ok(html.includes('fin-pill fin-pill--partial'), 'running is blue')
    assert.ok(html.includes('fin-pill fin-pill--zero'), 'on hold is amber')
    assert.ok(html.includes('fin-pill fin-pill--neutral'), 'dispatched is grey')
    assert.equal([...html.matchAll(/<col /g)].length, 10)
  })

  test('a row: the order number is a link to the order, the value is in rupees, fabric and finish are pills, a missing value is a dash', () => {
    const html = draw({ tab: 'all' })
    assert.ok(html.includes('href="/orders/clickup/00000000-0000-4000-8000-000000000535"'))
    const t = text(html)
    for (const word of ['535', 'Aarav Textiles', 'Salesperson One', '30 Sept 2026', '20 Nov 2026', '₹3,61,900', '₹27,95,000', 'Pending', 'Approved']) assert.ok(t.includes(word), word)
    assert.ok(html.includes('fin-pill fin-pill--zero">Pending'))
    assert.ok(html.includes('fin-pill fin-pill--full">Approved'))
    assert.ok(html.includes('<span class="fin-muted">—</span>'), 'no assignee and no fabric status are dashes, not blanks')
  })

  test('a phone gets cards, not a sideways table: the table sits inside the shared phone card wrapper', () => {
    assert.ok(draw().includes('class="boe-cardtable"'))
  })

  test('the buttons: Download Excel is quiet, Import is the one primary action, a download in progress says so', () => {
    const html = draw()
    assert.ok(html.includes('boe-btn boe-btn-secondary'))
    assert.ok(/href="\/orders\/clickup\/import"[^>]*boe-btn-primary|boe-btn boe-btn-primary"[^>]*href="\/orders\/clickup\/import"/.test(html))
    assert.ok(text(draw({ downloading: true })).includes('Preparing…'))
    assert.ok(draw({ rows: [] }).includes('disabled'), 'nothing to download from an empty list')
  })

  test('Clear filters shows only when the view is narrowed, and the way out is offered under "no results"', () => {
    assert.equal(text(draw()).includes('Clear filters'), false)
    assert.ok(text(draw({ tab: 'hold' })).includes('Clear filters'))
    const t = text(draw({ tab: 'all', query: 'zzzz' }))
    assert.ok(t.includes('No results for “zzzz”.'))
    assert.ok(t.includes('Try an order number, a client or a person, or clear the filters.'))
    assert.equal(draw({ tab: 'all', query: 'zzzz' }).includes('<table'), false)
  })

  test('an empty copy and an empty status say what to do', () => {
    assert.ok(text(draw({ rows: [] })).includes('No draft orders yet'))
    assert.ok(text(draw({ rows: [], tab: 'all' })).includes('Use Import from backup folder'))
    const none = text(draw({ tab: 'cancelled', rows: ROWS.filter(r => r.status !== 'cancelled') }))
    assert.ok(none.includes('No orders with this status.'))
  })
})
