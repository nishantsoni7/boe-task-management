// The top panel's ⋯ menu (owner, 25 Nov 2026, quotation page version 2), driven the way a person drives it, and the price approval block, which
// the panel does not draw. Nothing in the menu changes a status any more (Confirmed no PI, Mark as lost… and Archive are gone): it holds only
// turning the client link off and Delete…. PriceBlock (owner, 23 Nov 2026: ONLY people the database lets decide, price.may_decide, see the reasons
// and the limits and get Approve prices / Send back…) is kept for when the system is trained, and is tested on its own here.
//
// Run: npm run test:file -- src/components/quotations/statusMore.dom.test.tsx
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { PriceBlock } from './PricingDesk'
import { needsYou } from '@/lib/quotations/needsYou'
import type { PriceState, QuotationStatus } from '@/lib/quotations/api'
import { panel, quote, type PanelOver } from './topPanel.testkit'

const price = (over: Partial<PriceState> = {}): PriceState => ({
  needed: true, reasons: [{ kind: 'below', line: 'High Chair', price: 4500, last: 6200, pct: 72.6, limit: 90 }], state: 'to_ask', blocked: true,
  note: null, by: null, at: null, may_decide: false, ...over,
})
type UI = ReturnType<typeof mount>
const buttons = (ui: UI) => ui.all('button').map(b => (b.textContent ?? '').trim())
const items = (ui: UI) => ui.all('[role="menuitem"]').map(b => (b.textContent ?? '').trim())
const MORE = 'button[aria-label="More actions"]'
const REASON = 'High Chair: ₹4,500 is 72.6% of the last ordered ₹6,200 (limit 90%)'
const DELETE: PanelOver = { canDelete: true, onDelete: () => {} }
/** What the ⋯ menu offers, opened as a person opens it; null when there is no ⋯ button at all. */
const menu = (base: ReturnType<typeof quote>, over: PanelOver = {}) => {
  const ui = mount(panel(base, over))
  const has = ui.all(MORE).length > 0
  if (has) ui.click(ui.one(MORE))
  const got = has ? items(ui) : null
  ui.unmount()
  return got
}

describe('the ⋯ menu', () => {
  test('it holds only the two rare things: turning the client link off and Delete…, in that order, closed until opened', () => {
    const ui = mount(panel(quote({ share_token: 'abc' }), DELETE))
    assert.ok(!items(ui).length, 'closed until opened')
    ui.click(ui.one(MORE))
    assert.deepEqual(items(ui), ['Turn the client link off', 'Delete…'])
    ui.unmount()
  })
  test('no status is changed from it, whatever the quotation\'s status: no Confirmed no PI, no Mark as lost…, no Archive', () => {
    for (const status of ['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived'] as QuotationStatus[]) {
      assert.deepEqual(menu(quote({ status, share_token: 'abc' }), DELETE), ['Turn the client link off', 'Delete…'], status)
    }
  })
  test('no client link and no Delete: no ⋯ button at all; each alone is the only item', () => {
    assert.equal(menu(quote()), null)
    assert.deepEqual(menu(quote({ share_token: 'abc' })), ['Turn the client link off'])
    assert.deepEqual(menu(quote(), DELETE), ['Delete…'])
  })
  test('a reader who may not edit cannot turn the link off: no ⋯ button unless the database lets them delete', () => {
    assert.equal(menu(quote({ may_edit: false, share_token: 'abc' })), null)
    assert.deepEqual(menu(quote({ may_edit: false, share_token: 'abc' }), DELETE), ['Delete…'])
  })
  test('turning the client link off does what the old button did', () => {
    const shared: boolean[] = []
    const ui = mount(panel(quote({ share_token: 'abc' }), { onShare: on => { shared.push(on) } }))
    ui.click(ui.one(MORE))
    ui.click(ui.button('Turn the client link off'))
    assert.deepEqual(shared, [false])
    ui.unmount()
  })
  test('with unsaved edits turning the link off waits ("Save first"); Delete… does not; while busy both wait', () => {
    const dirty = mount(panel(quote({ share_token: 'abc' }), { ...DELETE, dirty: true }))
    dirty.click(dirty.one(MORE))
    assert.equal(dirty.button('Turn the client link off').disabled, true)
    assert.equal(dirty.button('Turn the client link off').title, 'Save first')
    assert.equal(dirty.button('Delete…').disabled, false)
    dirty.unmount()
    const busy = mount(panel(quote({ share_token: 'abc' }), { ...DELETE, busy: true }))
    busy.click(busy.one(MORE))
    assert.ok(['Turn the client link off', 'Delete…'].every(l => busy.button(l).disabled))
    busy.unmount()
  })
  test('Escape closes the menu and gives the focus back to the ⋯ button', () => {
    const ui = mount(panel(quote({ share_token: 'abc' })))
    ui.click(ui.one(MORE))
    assert.ok(items(ui).length)
    // the menu listens on the document (the harness's press() goes to the window)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.ok(!items(ui).length)
    assert.equal(document.activeElement, ui.one(MORE))
    ui.unmount()
  })
})

describe('the panel does not draw the price approval (owner, 24 Nov 2026: the system is not trained for it yet)', () => {
  test('whatever the price state or who is looking, no limits, no reasons, no Approve prices, no Ask for price approval', () => {
    for (const may_decide of [true, false]) {
      const ui = mount(panel(quote({ price: price({ may_decide }) })))
      assert.ok(!/outside the usual limits|Approvers only|High Chair|Price approval|price approval/.test(ui.text()), String(may_decide))
      for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(!buttons(ui).includes(b), b)
      ui.unmount()
    }
  })
  test('a price the database still calls blocked holds nothing back here: Create client link is on', () => {
    const ui = mount(panel(quote({ price: price({ blocked: true }) })))
    assert.equal(ui.button('Create client link').disabled, false)
    ui.unmount()
  })
})

// PriceBlock itself is unchanged and kept for later (it is not on the page now).
describe('PriceBlock: who sees what', () => {
  const block = (p: PriceState, o: Partial<Parameters<typeof PriceBlock>[0]> = {}) => {
    const base = quote({ price: p, may_edit: o.mayEdit ?? true })
    return createElement(PriceBlock, { price: p, needs: needsYou(base), mayEdit: true, dirty: false, busy: false, onAsk: () => {}, onDecide: () => {}, ...o })
  }
  test('an approver sees the reasons, the limits and the "Approvers only" tag, with Approve prices, Send back… and Ask for price approval', () => {
    const ui = mount(block(price({ may_decide: true })))
    assert.match(ui.text(), /Approvers only/)
    assert.ok(ui.text().includes(REASON))
    assert.ok(ui.text().includes('Optional: you can share the client link and Confirm → PI without it.'))
    for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(buttons(ui).includes(b), b)
    ui.unmount()
  })
  test('a salesperson sees one line and their own Ask button: no reasons, no limits, no approver buttons', () => {
    const ui = mount(block(price()))
    assert.match(ui.text(), /These prices need the pricing desk’s approval before the client link can be turned on\./)
    assert.ok(!ui.text().includes('High Chair') && !ui.text().includes('limit 90') && !ui.text().includes('Approvers only') && !ui.text().includes('Optional: you can share'))
    assert.ok(buttons(ui).includes('Ask for price approval') && !buttons(ui).includes('Approve prices') && !buttons(ui).includes('Send back…'))
    ui.unmount()
  })
  test('a salesperson still sees what the desk said when it sent the prices back (that is what must change)', () => {
    const ui = mount(block(price({ state: 'returned', note: 'Hold the bed at ₹55,000', by: 'Nitish' })))
    assert.match(ui.text(), /The pricing desk sent the prices back\./)
    assert.match(ui.text(), /“Hold the bed at ₹55,000” · Nitish/)
    assert.ok(!ui.text().includes('High Chair') && buttons(ui).includes('Ask for price approval'))
    ui.unmount()
  })
  test('approving, and sending back with a reason, call the database functions with what the person typed', () => {
    const calls: unknown[][] = []
    let asked = 0
    const ui = mount(block(price({ may_decide: true, state: 'requested' }), { onDecide: (...a) => { calls.push(a) }, onAsk: () => { asked++ } }))
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
    const ui = mount(block(price(), { onAsk: () => { asked++ } }))
    assert.match(ui.button('Ask for price approval').className, /btnPrimary/)
    ui.click(ui.button('Ask for price approval'))
    assert.equal(asked, 1)
    ui.unmount()
    const both = mount(block(price({ may_decide: true })))
    assert.ok(!/btnPrimary/.test(both.button('Ask for price approval').className), 'Approve prices is the main one for an approver')
    both.unmount()
  })
  test('approved: the line says so and nothing is left to press; nothing needed: nothing is drawn', () => {
    const done = mount(block(price({ state: 'approved', may_decide: true })))
    assert.match(done.text(), /Prices approved/)
    for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(!buttons(done).includes(b), b)
    done.unmount()
    const none = mount(block(price({ state: 'not_needed' })))
    assert.equal(none.text(), '')
    none.unmount()
  })
  test('unsaved edits: approval is for the saved prices, so no price button shows and the block says why', () => {
    const ui = mount(block(price({ may_decide: true }), { dirty: true }))
    assert.match(ui.text(), /Save first: approval is for the saved prices\./)
    for (const b of ['Approve prices', 'Send back…', 'Ask for price approval']) assert.ok(!buttons(ui).includes(b), b)
    ui.unmount()
  })
  test('a reader who may not edit and may not decide sees the line and no button', () => {
    const ui = mount(block(price({ state: 'requested' }), { mayEdit: false }))
    assert.match(ui.text(), /Waiting for the pricing desk/)
    assert.ok(!buttons(ui).some(b => /price|Approve|Send back/i.test(b)))
    ui.unmount()
  })
})
