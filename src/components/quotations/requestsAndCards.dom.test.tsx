// Ask a senior, the price brief and the report-card dates (owner, 20 Nov 2026). Real components in jsdom against a fake database.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeniorRow } from './AskCard'
import { PriceBrief } from './PriceBrief'
import { periodDates } from './HomeCards'
import type { AskRequest, AskState, Quotation } from '@/lib/quotations/api'
import type { QuoteLine } from '@/lib/quotations/math'

const REQ: AskRequest = { id: 'r1', kind: 'price', note: 'Teak, 56 rooms', status: 'pending', created_at: '2026-11-19T04:00:00Z', answered_at: null, answer_note: null, from_id: 'u-shravi', from_name: 'Shravi', to_id: 'u-nitish', to_name: 'Nitish Bansal', answered_by_name: null }
const state = (o: Partial<AskState> = {}): AskState => ({ open: null, last: null, may_ask: true, may_answer: false, may_withdraw: false, ...o })

function fake(st: AskState, extra: Record<string, unknown> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        calls.push({ fn, args })
        if (fn in extra) return { data: extra[fn], error: null }
        if (fn === 'quotation_ask_state') return { data: st, error: null }
        if (fn === 'quotation_desk_people') return { data: [{ id: 'u-nitish', full_name: 'Nitish Bansal' }, { id: 'u-owner', full_name: 'Nishant Soni' }], error: null }
        return { data: null, error: null }
      },
    },
  }
}
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
const wrap = (child: ReturnType<typeof createElement>) => createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }, child)
const ready = async (u: { settle: () => Promise<void> }) => { await u.settle(); await u.settle(); await u.settle() }
const BASE = { id: 'q1' } as Quotation
// The Senior row of the properties panel: what was asked and what came back, with the Ask a senior button in the same row.
const askUi = (sb: { client: unknown }, o: { dirty?: boolean; onChanged?: () => void; onSentBack?: (id: string) => void } = {}) => wrap(
  createElement(SeniorRow, { supabase: sb.client as never, base: BASE, dirty: o.dirty ?? false, onChanged: o.onChanged ?? (() => {}), onSentBack: o.onSentBack }))

describe('Ask a senior', () => {
  test('a salesperson sends their own quotation to a chosen senior for prices; the pick is remembered', async () => {
    const sb = fake(state()); let changed = 0
    const m = mount(askUi(sb, { onChanged: () => { changed++ } })); mounted.push(m)
    await ready(m)
    assert.match(m.text(), /Nothing asked yet/, 'nothing was asked: the Senior row says so')
    m.click(m.button('Ask a senior')); await ready(m)
    assert.ok(sb.calls.some(c => c.fn === 'quotation_desk_people'))
    m.click(m.button('Send')); await ready(m)
    assert.match(m.text(), /Choose who to send it to/); assert.ok(!sb.calls.some(c => c.fn === 'quotation_request_send'))
    const sel = m.one<HTMLSelectElement>('select'); const w = sel.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!.call(sel, 'u-nitish'); sel.dispatchEvent(new w.Event('change', { bubbles: true })); await m.settle()
    m.type(m.one<HTMLInputElement>('#ask-note'), 'Teak, 56 rooms')
    m.click(m.button('Send')); await ready(m)
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_request_send')!.args, { p_quotation: 'q1', p_to: 'u-nitish', p_kind: 'price', p_note: 'Teak, 56 rooms' })
    assert.ok(changed >= 1)
  })
  test('Save first: nothing can be sent or sent back while the page has unsaved edits', async () => {
    const m = mount(askUi(fake(state()), { dirty: true })); mounted.push(m)
    await ready(m)
    assert.equal(m.button('Ask a senior').disabled, true); assert.equal(m.button('Ask a senior').title, 'Save first')
  })
  test('the asker sees who it is with and how long; they can withdraw', async () => {
    const sb = fake(state({ open: REQ, may_ask: false, may_withdraw: true }))
    const m = mount(askUi(sb)); mounted.push(m)
    await ready(m)
    assert.match(m.text(), /Sent to Nitish Bansal/); assert.match(m.text(), /waiting/); assert.match(m.text(), /Teak, 56 rooms/)
    m.click(m.button('Withdraw')); await ready(m)
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_request_withdraw')!.args, { p_id: 'r1' })
  })
  test('the senior is told who sent it, sends it back with a note, and the brief is offered', async () => {
    const sb = fake(state({ open: REQ, may_ask: false, may_answer: true })); const sent: string[] = []
    const m = mount(askUi(sb, { onSentBack: id => { sent.push(id) } })); mounted.push(m)
    await ready(m)
    assert.match(m.text(), /Shravi/); assert.match(m.text(), /sent this to you/)
    m.click(m.button(/Send back to Shravi/)); await ready(m)
    m.type(m.one<HTMLInputElement>('#ask-answer'), 'Priced at the usual teak rate')
    m.click(m.button('Send back')); await ready(m)
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_request_answer')!.args, { p_id: 'r1', p_note: 'Priced at the usual teak rate' })
    assert.deepEqual(sent, ['r1'])
  })
  test('the form is a pop-over under the button, and Escape closes it', async () => {
    const m = mount(askUi(fake(state()))); mounted.push(m)
    await ready(m)
    assert.equal(m.all('[role="dialog"]').length, 0)
    m.click(m.button('Ask a senior')); await ready(m)
    assert.equal(m.all('[role="dialog"]').length, 1)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(m.all('[role="dialog"]').length, 0)
  })
  test('what the senior sent back is the Senior row, with the date and the note', async () => {
    const last = { ...REQ, status: 'answered', answered_at: '2026-11-23T10:00:00Z', answer_note: 'Shared the costing', answered_by_name: 'Nishant Soni' } as AskRequest
    const m = mount(askUi(fake(state({ last })))); mounted.push(m)
    await ready(m)
    assert.match(m.text(), /Senior/); assert.match(m.text(), /Nishant Soni sent it back 23 Nov: “Shared the costing”/)
    assert.ok(m.button('Ask a senior'), 'they may still ask again')
  })
  test('nothing shows when there is nothing to do and nothing was asked', async () => {
    const m = mount(askUi(fake(state({ may_ask: false })))); mounted.push(m)
    await ready(m)
    assert.equal(m.text().trim(), '')
  })
})

const line = (key: string, name: string, price: number | null, o: Partial<QuoteLine> = {}) =>
  ({ key, area_key: null, name, size_text: '72 x 36', spec: '', material: 'Teak', finish: '', category: '', qty_mode: 'fixed', qty: 5, unit_price: price, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...o }) as QuoteLine

describe('the price brief', () => {
  const lines = [line('a', 'Lounge table', 12000), line('b', 'Chair', 5000), line('c', 'Unpriced stool', null), line('d', 'Optional rug', 900, { is_optional: true })]
  test('lists the priced products only, pre-fills an earlier brief, and saves only what was explained', async () => {
    const sb = fake(state(), { quotation_price_briefs_get: { 'Lounge table': 'Teak 2 cft at 4,200' }, quotation_price_briefs_save: 1 }); const closed: number[] = []
    const m = mount(wrap(createElement(PriceBrief, { supabase: sb.client as never, quotationId: 'q1', lines, onClose: n => { closed.push(n) } }))); mounted.push(m)
    await ready(m)
    assert.match(m.text(), /Lounge table/); assert.match(m.text(), /Chair/); assert.ok(!/Unpriced stool|Optional rug/.test(m.text()))
    const boxes = m.all<HTMLTextAreaElement>('textarea')
    assert.equal(boxes.length, 2); assert.equal(boxes[0].value, 'Teak 2 cft at 4,200'); assert.equal(boxes[1].value, '')
    m.click(m.button('Save the briefs')); await ready(m)
    const items = (sb.calls.find(c => c.fn === 'quotation_price_briefs_save')!.args as { p_items: Array<{ name: string; price: number; reason: string }> }).p_items
    assert.deepEqual(items.map(i => [i.name, i.price, i.reason]), [['Lounge table', 12000, 'Teak 2 cft at 4,200']])
    assert.deepEqual(closed, [1])
  })
  test('Skip writes nothing, and a brief left entirely blank is not even sent', async () => {
    const sb = fake(state(), { quotation_price_briefs_get: {} }); const closed: number[] = []
    const m = mount(wrap(createElement(PriceBrief, { supabase: sb.client as never, quotationId: 'q1', lines, onClose: n => { closed.push(n) } }))); mounted.push(m)
    await ready(m)
    m.click(m.button('Skip')); m.click(m.button('Save the briefs')); await ready(m)
    assert.ok(!sb.calls.some(c => c.fn === 'quotation_price_briefs_save')); assert.deepEqual(closed, [0, 0])
  })
})

describe('report card dates (India calendar months)', () => {
  const at = (iso: string) => Date.parse(iso)
  test('last month, this month and the last three months', () => {
    const now = at('2026-11-20T09:00:00Z')
    assert.deepEqual(periodDates('last', now), { from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(periodDates('this', now), { from: '2026-11-01', to: '2026-11-30' })
    assert.deepEqual(periodDates('three', now), { from: '2026-08-01', to: '2026-10-31' })
  })
  test('January looks back into December, and 00:30 IST on the 1st is already the new month', () => {
    assert.deepEqual(periodDates('last', at('2027-01-15T09:00:00Z')), { from: '2026-12-01', to: '2026-12-31' })
    assert.deepEqual(periodDates('this', at('2026-11-30T19:00:00Z')), { from: '2026-12-01', to: '2026-12-31' })
    assert.deepEqual(periodDates('last', at('2028-03-10T09:00:00Z')), { from: '2028-02-01', to: '2028-02-29' })
  })
})
