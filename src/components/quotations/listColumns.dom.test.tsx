// A row of the Quotations list (owner, 23 Nov 2026): Client Details, Sales person, Before GST, Status, Pending from, Last activity; on a phone a card.
// The real Row in jsdom (no layout: which cell a phone hides is CSS, drawn separately).
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { Row } from './ListScreen'
import type { ListRow } from '@/lib/quotations/api'

// next/link (AppLink inside the layout imports) calls `self.requestIdleCallback`; node has no `self`.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true })

const NOW = Date.parse('2026-11-23T08:00:00Z'), DAY = 86_400_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const base: ListRow = {
  id: 'q1', quote_no: 'QT-N-01008', status: 'sent', client_name: 'Srujan', project_name: null, owner_id: 'u1', owner_name: 'Namrata',
  created_at: ago(9 * DAY), updated_at: ago(5 * DAY), sent_at: ago(5 * DAY + 3_600_000), valid_days: 15, shared: true, line_count: 15, first_image: null,
  value_before_gst: 817500, last_opened_at: ago(5 * DAY), may_delete: true,
}
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
function show(r: Partial<ListRow>, calls: string[] = []) {
  const m = mount(createElement('table', null, createElement('tbody', null, createElement(Row, { r: { ...base, ...r }, now: NOW, url: p => p, onOpen: () => { calls.push('open') }, onDelete: () => { calls.push('delete') } })))); mounted.push(m)
  return m
}
const cells = (m: ReturnType<typeof show>) => m.all('td').map(td => (td.textContent ?? '').replace(/\s+/g, ' ').trim())

describe('a row of the Quotations list', () => {
  test('Client Details is the client, then the project (only when it differs), the number and the lines; no separate Client cell', () => {
    let m = show({ project_name: 'Udaipur lobby refit' })
    assert.equal(m.all('td').length, 8)
    assert.match(cells(m)[1], /^SrujanUdaipur lobby refit · QT-N-01008 · 15 lines/)
    m.unmount(); mounted.length = 0
    m = show({ project_name: 'Srujan' })
    assert.match(cells(m)[1], /^SrujanQT-N-01008 · 15 lines/); assert.ok(!/Srujan · /.test(cells(m)[1]))
  })

  test('Sales person is the quotation\'s owner; a row with no owner shows a dash', () => {
    assert.equal(cells(show({}))[2], 'Namrata')
    mounted.pop()!.unmount()
    assert.equal(cells(show({ owner_name: null }))[2], '—')
  })

  test('Pending from: a sent quotation counts from when it was sent, with the colour band and the note', () => {
    const m = show({})
    const td = m.all('td')[5]
    assert.equal(td.textContent, '5 dayssince sent 18 Nov 2026'); assert.match(td.className, /pend_late/)
  })

  test('a draft says it was made and not sent; closed quotations show a dash', () => {
    assert.equal(cells(show({ status: 'draft', sent_at: null, created_at: ago(2 * DAY + 3_600_000) }))[5], '2 daysmade 21 Nov 2026, not sent')
    mounted.pop()!.unmount()
    const m = show({ status: 'confirmed' })
    assert.equal(cells(m)[5], '—'); assert.match(m.all('td')[5].className, /pend_none/)
  })

  test('on a phone the status, the wait and the sales person sit under the client', () => {
    const meta = show({}).one('td:nth-child(2)').querySelector('div:last-child')!
    assert.match((meta.textContent ?? '').replace(/\s+/g, ' ').trim(), /^Sent5 days pending Namrata$/)
  })

  test('the value, the status and the last activity stay; the bin only on a row the database marked, and it does not open the row', () => {
    const calls: string[] = []
    const m = show({}, calls)
    assert.equal(cells(m)[3], '₹8,17,500'); assert.equal(cells(m)[4], 'Sent'); assert.match(cells(m)[6], /^Opened by the client 18 Nov 2026/)
    m.click(m.one('button[aria-label="Delete QT-N-01008"]')); assert.deepEqual(calls, ['delete'])
    mounted.pop()!.unmount()
    assert.equal(show({ may_delete: false }).all('button').length, 0)
  })
})
