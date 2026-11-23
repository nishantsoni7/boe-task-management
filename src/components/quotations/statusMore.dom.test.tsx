// The Status card's More menu and its price approval block (owner, 23 Nov 2026), driven the way a person drives them.
// The menu replaces the "Other outcome" row: the same four outcomes under the same conditions, behind one button. The price approval block
// replaces the card at the bottom of the page and the "Needs you" strip: ONLY people the database lets decide (price.may_decide) see the
// reasons and the limits and get Approve prices / Send back…; a salesperson sees one line, what the desk said, and Ask for price approval.
//
// Run: npm run test:file -- src/components/quotations/statusMore.dom.test.tsx
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { StatusCard } from './StatusCard'
import { needsYou } from '@/lib/quotations/needsYou'
import type { PriceState, Quotation, QuotationStatus } from '@/lib/quotations/api'

const price = (over: Partial<PriceState> = {}): PriceState => ({
  needed: true, reasons: [{ kind: 'below', line: 'High Chair', price: 4500, last: 6200, pct: 72.6, limit: 90 }], state: 'to_ask', blocked: true,
  note: null, by: null, at: null, may_decide: false, ...over,
})
const quote = (o: Partial<Quotation> = {}) => ({ id: 'q1', quote_no: 'QT-1', status: 'draft' as QuotationStatus, may_edit: true, pi: null, price: null, share_token: null, ...o }) as Quotation
type Over = Partial<Parameters<typeof StatusCard>[0]>
const card = (base: Quotation, over: Over = {}) => createElement(StatusCard, {
  base, dirty: false, busy: false, isAdmin: false, canConfirm: false, piProblems: [], priceBlocked: false, piStage: null,
  lostNote: null, setLostNote: () => {}, lostReason: '', setLostReason: () => {}, onMove: () => {}, onConfirm: () => {},
  needs: needsYou(base), onAskPrice: () => {}, onDecidePrice: () => {}, ...over,
})
const buttons = (ui: ReturnType<typeof mount>) => ui.all('button').map(b => (b.textContent ?? '').trim())
const items = (ui: ReturnType<typeof mount>) => ui.all('[role="menuitem"]').map(b => (b.textContent ?? '').trim())
const REASON = 'High Chair: ₹4,500 is 72.6% of the last ordered ₹6,200 (limit 90%)'

describe('the More menu', () => {
  test('a draft offers Confirmed, no PI, Mark as lost… and Archive, behind one More button', () => {
    const ui = mount(card(quote()))
    assert.ok(!items(ui).length, 'closed until opened')
    ui.click(ui.button('More'))
    assert.deepEqual(items(ui), ['Confirmed, no PI', 'Mark as lost…', 'Archive'])
    ui.unmount()
  })
  test('choosing an item does what the old quiet button did', () => {
    const moves: unknown[][] = []
    let lost: string | null = null
    const run = (label: string) => {
      const ui = mount(card(quote({ status: 'sent' }), { onMove: (...a) => { moves.push(a) }, setLostNote: v => { lost = v } }))
      ui.click(ui.button('More')); ui.click(ui.button(label)); ui.unmount()
    }
    run('Confirmed, no PI'); run('Archive'); run('Mark as lost…')
    assert.deepEqual(moves, [['confirmed'], ['archived']])
    assert.equal(lost, '', 'Mark as lost… opens the box that asks why')
  })
  test('a confirmed quotation, a reader, and a lost one: no More button, no More button, Archive only', () => {
    const confirmed = mount(card(quote({ status: 'confirmed' }))); assert.ok(!buttons(confirmed).includes('More')); confirmed.unmount()
    const reader = mount(card(quote({ may_edit: false }))); assert.ok(!buttons(reader).includes('More')); reader.unmount()
    const lost = mount(card(quote({ status: 'lost' })))
    lost.click(lost.button('More'))
    assert.deepEqual(items(lost), ['Archive'])
    lost.unmount()
  })
  test('with unsaved edits every outcome waits ("Save first"), except that Confirmed, no PI keeps its own tooltip', () => {
    const ui = mount(card(quote(), { dirty: true }))
    ui.click(ui.button('More'))
    const by = (label: string) => ui.button(label)
    assert.ok(by('Mark as lost…').disabled && by('Archive').disabled && by('Confirmed, no PI').disabled)
    assert.equal(by('Archive').title, 'Save first')
    assert.equal(by('Confirmed, no PI').title, 'Confirmed without making a PI from it')
    ui.unmount()
  })
  test('Escape closes the menu and gives the focus back to More', () => {
    const ui = mount(card(quote()))
    ui.click(ui.button('More'))
    assert.ok(items(ui).length)
    // the menu listens on the document (the harness's press() goes to the window)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.ok(!items(ui).length)
    assert.equal(document.activeElement, ui.button('More'))
    ui.unmount()
  })
})

describe('the price approval block: who sees what', () => {
  test('an approver sees the reasons, the limits and the "Approvers only" tag, with Approve prices, Send back… and Ask for price approval', () => {
    const ui = mount(card(quote({ price: price({ may_decide: true }) })))
    assert.match(ui.text(), /Approvers only/)
    assert.ok(ui.text().includes(REASON))
    assert.ok(ui.text().includes('Optional: you can share the client link and Confirm → PI without it.'))
    for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(buttons(ui).includes(b), b)
    ui.unmount()
  })
  test('a salesperson sees one line and their own Ask button: no reasons, no limits, no approver buttons', () => {
    const ui = mount(card(quote({ price: price() })))
    assert.match(ui.text(), /These prices need the pricing desk’s approval before the client link can be turned on\./)
    assert.ok(!ui.text().includes('High Chair') && !ui.text().includes('limit 90') && !ui.text().includes('Approvers only') && !ui.text().includes('Optional: you can share'))
    assert.ok(buttons(ui).includes('Ask for price approval') && !buttons(ui).includes('Approve prices') && !buttons(ui).includes('Send back…'))
    ui.unmount()
  })
  test('a salesperson still sees what the desk said when it sent the prices back (that is what must change)', () => {
    const ui = mount(card(quote({ price: price({ state: 'returned', note: 'Hold the bed at ₹55,000', by: 'Nitish' }) })))
    assert.match(ui.text(), /The pricing desk sent the prices back\./)
    assert.match(ui.text(), /“Hold the bed at ₹55,000” · Nitish/)
    assert.ok(!ui.text().includes('High Chair') && buttons(ui).includes('Ask for price approval'))
    ui.unmount()
  })
  test('approving, and sending back with a reason, call the database functions with what the person typed', () => {
    const calls: unknown[][] = []
    let asked = 0
    const ui = mount(card(quote({ price: price({ may_decide: true, state: 'requested' }) }), { onDecidePrice: (...a) => { calls.push(a) }, onAskPrice: () => { asked++ } }))
    assert.match(ui.text(), /Prices are waiting for your approval\./)
    ui.click(ui.button('Approve prices'))
    ui.click(ui.button('Send back…'))
    const box = ui.one<HTMLInputElement>('#price-note')
    assert.ok(ui.button('Send back').disabled, 'a reason of at least 3 characters is needed')
    ui.type(box, 'Hold the bed at ₹55,000')
    ui.click(ui.button('Send back'))
    assert.deepEqual(calls, [[true, null], [false, 'Hold the bed at ₹55,000']])
    assert.equal(asked, 0)
    ui.unmount()
  })
  test('asking for approval calls the ask once, and the salesperson\'s button is the main one when there is nothing else to press', () => {
    let asked = 0
    const ui = mount(card(quote({ price: price() }), { onAskPrice: () => { asked++ } }))
    assert.match(ui.button('Ask for price approval').className, /btnPrimary/)
    ui.click(ui.button('Ask for price approval'))
    assert.equal(asked, 1)
    ui.unmount()
    const both = mount(card(quote({ price: price({ may_decide: true }) })))
    assert.ok(!/btnPrimary/.test(both.button('Ask for price approval').className), 'Approve prices is the main one for an approver')
    both.unmount()
  })
  test('approved: the line says so and nothing is left to press; nothing needed: nothing is drawn', () => {
    const done = mount(card(quote({ price: price({ state: 'approved', may_decide: true }) })))
    assert.match(done.text(), /Prices approved/)
    for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(!buttons(done).includes(b), b)
    done.unmount()
    const none = mount(card(quote({ price: price({ state: 'not_needed' }) })))
    assert.ok(!none.text().includes('Price approval') && !none.one('section').querySelector('[aria-label="Price approval"]'))
    none.unmount()
  })
  test('unsaved edits: approval is for the saved prices, so no price button shows and the block says why', () => {
    const ui = mount(card(quote({ price: price({ may_decide: true }) }), { dirty: true }))
    assert.match(ui.text(), /Save first: approval is for the saved prices\./)
    for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(!buttons(ui).includes(b), b)
    ui.unmount()
  })
  test('a reader who may not edit and may not decide sees the line and no button', () => {
    const ui = mount(card(quote({ may_edit: false, price: price({ state: 'requested' }) })))
    assert.match(ui.text(), /Waiting for the pricing desk/)
    assert.ok(!buttons(ui).some(b => /price|Approve|Send back/i.test(b)))
    ui.unmount()
  })
})
