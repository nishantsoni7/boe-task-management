/**
 * The builder's properties panel and its floating bar (owner, 25 Nov 2026, from an approved mockup): the amber "what is missing" row, and the bar's total,
 * Share menu and next step, drawn for real from their props, one state at a time. There is no four-step tracker and no status button: the lead's stage is
 * the status, changed in Lead Board (leadCard.dom.test.tsx). The price block that is no longer drawn is driven in statusMore.dom.test.tsx.
 *
 * Run: npm run test:file -- src/components/quotations/topRow.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { waitsFor } from './PropsPanel'
import { dock, panel, quote, type DockOver, type PanelOver } from './topPanel.testkit'
import type { QuotationStatus } from '@/lib/quotations/api'
import type { ConversionProblem } from '@/lib/quotations/piWorkbook'

const names = (n: number) => Array.from({ length: n }, (_, i) => `Chair ${i + 1}`)
const drawPanel = (base: ReturnType<typeof quote>, o: PanelOver = {}) => renderToStaticMarkup(panel(base, o))
const drawDock = (base: ReturnType<typeof quote>, o: DockOver = {}) => renderToStaticMarkup(dock(base, o))
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}[^<]*</button>`))?.[0] ?? null
const READY: DockOver = { canConfirm: true }

// Whatever a test leaves on screen is removed after it.
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
/** The bar mounted for real, with its Share menu opened as a person opens it; returns what the menu offers. One at a time: they share one page body. */
function openShare(base: ReturnType<typeof quote>, o: DockOver = {}) {
  for (const m of mounted.splice(0)) m.unmount()
  const ui = mount(dock(base, o)); mounted.push(ui)
  ui.click(ui.button('Share'))
  const items = () => ui.all<HTMLElement>('[role="menuitem"]')
  const item = (label: string) => {
    const found = items().find(e => (e.textContent ?? '').trim() === label)
    if (!found) throw new Error(`no menu item "${label}"; items: ${items().map(e => (e.textContent ?? '').trim()).join(' | ')}`)
    return found as HTMLButtonElement & HTMLAnchorElement
  }
  return { ui, items, labels: () => items().map(e => (e.textContent ?? '').trim()), item }
}

describe('the lead is the status: nothing of the old tracker or the status buttons is left', () => {
  test('no four-step tracker, no Mark sent, no Negotiating button, no Lost box, whatever the quotation\'s own status', () => {
    for (const status of ['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived'] as QuotationStatus[]) {
      const html = drawPanel(quote({ status }), { canConfirm: true }) + drawDock(quote({ status }), READY)
      assert.ok(!html.includes('<ol') && !html.includes('Mark sent') && !html.includes('>Negotiating<') && !html.includes('Where the quotation is'), status)
      assert.ok(!html.includes('Mark as lost') && !html.includes('Why was it lost') && !html.includes('Confirmed, no PI') && !html.includes('Archive'), status)
    }
  })
})

describe('the floating bar: the total and the next step', () => {
  test('it carries the grand total, the amount before GST, the lines and the pieces', () => {
    const html = drawDock(quote())
    assert.match(html, /Grand total/); assert.match(html, /₹25,96,714/); assert.match(html, /₹22,00,605 before GST · 3 lines · 230 pieces/)
  })
  test('a draft, a sent and a negotiating quotation each offer Create PI draft (the main button) when it is ready; nothing is missing, so it is on', () => {
    for (const status of ['draft', 'sent', 'negotiating'] as QuotationStatus[]) {
      const html = drawDock(quote({ status }), READY)
      assert.ok(button(html, 'Create PI draft')?.includes('btnPrimary'), status)
      assert.doesNotMatch(button(html, 'Create PI draft') ?? '', /disabled/, status)
      assert.match(html, /title="Makes a PI draft in Orders from the saved quotation\. Nothing is sent to anyone: the PI stays a Draft until you submit it there\."/)
    }
    assert.ok(!drawDock(quote(), {}).includes('Create PI draft'), 'the page decides when Create PI draft is offered')
  })
  test('while Create PI draft waits: it is off, one amber row says what is missing, six names show and the rest are counted', () => {
    const problems: ConversionProblem[] = [{ code: 'PRICE_MISSING', lines: names(15) }]
    const base = quote({ status: 'sent' })
    assert.match(button(drawDock(base, { canConfirm: true, piProblems: problems }), 'Create PI draft') ?? '', /disabled/)
    const html = drawPanel(base, { canConfirm: true, piProblems: problems })
    assert.match(html, /15 products need a price above ₹0 before this can become a PI\./)
    assert.match(html, /Show which/)
    assert.equal((html.match(/<span class="chip">Chair \d+<\/span>/g) ?? []).length, 6)
    assert.match(html, /<span class="chip">\+ 9 more<\/span>/)
  })
  test('the amber row draws only while Create PI draft is offered and something is missing', () => {
    const problems: ConversionProblem[] = [{ code: 'NO_LINES', lines: [] }]
    assert.match(drawPanel(quote(), { canConfirm: true, piProblems: problems }), /Add at least one product that is not optional\./)
    assert.ok(!drawPanel(quote(), { canConfirm: false, piProblems: problems }).includes('Add at least one product'), 'a quotation that cannot be confirmed is not nagged')
    assert.ok(!drawPanel(quote(), { canConfirm: true }).includes('class="hintBody"'))
  })
  test('the line is worded for one product, for none, and for several things at once', () => {
    assert.equal(waitsFor([{ code: 'NAME_MISSING', lines: ['Line 3'] }]), '1 product needs a name before this can become a PI.')
    assert.equal(waitsFor([{ code: 'NO_LINES', lines: [] }]), 'Add at least one product that is not optional.')
    assert.equal(waitsFor([{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }]), '2 things to fix before this can become a PI.')
    const html = drawPanel(quote(), { canConfirm: true, piProblems: [{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }] })
    assert.match(html, /<b>Price needed:<\/b>/); assert.match(html, /<b>Picture needed:<\/b>/)
  })
  test('unsaved edits switch Create PI draft and the Share menu\'s downloads and client link off with "Save first", and say so once, beside the buttons', () => {
    const base = quote({ status: 'sent' })
    const html = drawDock(base, { canConfirm: true, dirty: true })
    assert.match(button(html, 'Create PI draft') ?? '', /disabled="" title="Save first"|title="Save first"[^>]*disabled=""|disabled=""[^>]*title="Save first"/)
    assert.equal((html.match(/<span class="dirty hideOnPhone">Save first<\/span>/g) ?? []).length, 1)
    const { item } = openShare(base, { dirty: true })
    for (const w of ['Download PDF', 'Download Excel', 'Create client link']) {
      assert.equal((item(w) as HTMLButtonElement).disabled, true, w)
      assert.equal(item(w).title, 'Save first', w)
    }
  })
  test('the made PI shows beside Open the PI draft; a confirmed quotation offers no Create PI draft', () => {
    const base = quote({ status: 'confirmed', pi: { id: 'p1', draft_reference: 'DR-1042', status: 'under_review' } as never })
    const html = drawDock(base, { canConfirm: false })
    assert.match(html, /PI draft <b>DR-1042<\/b> · under review/)
    assert.match(html, /<a [^>]*class="btn btnLg btnPrimary"[^>]*href="[^"]*p1[^"]*"|<a [^>]*href="[^"]*p1[^"]*"[^>]*class="btn btnLg btnPrimary"/)
    assert.ok(html.includes('Open the PI draft') && !html.includes('Create PI draft'))
  })
  test('a reader who may not edit sees the downloads and nothing that changes the quotation', () => {
    const { labels } = openShare(quote({ status: 'sent', may_edit: false }))
    assert.deepEqual(labels(), ['Download PDF', 'Download Excel'])
  })
})

describe('the Share menu: sharing', () => {
  test('closed until opened; before a link: the two downloads and Create client link (an outline button, not the main one), whose tooltip says what it does', () => {
    const closed = mount(dock(quote())); mounted.push(closed)
    assert.equal(closed.all('[role="menuitem"]').length, 0, 'closed until opened')
    assert.equal(closed.button('Share').getAttribute('aria-expanded'), 'false')
    closed.click(closed.button('Share'))
    assert.equal(closed.button('Share').getAttribute('aria-expanded'), 'true')
    const { labels, item } = openShare(quote())
    assert.deepEqual(labels(), ['Download PDF', 'Download Excel', 'Create client link'])
    assert.ok(!item('Create client link').className.includes('btnPrimary'))
    assert.match(item('Create client link').title, /One link with the pictures and a Save as PDF button; no login\. Turning it on marks a draft as Sent\./)
  })
  test('with a link: Copy link, WhatsApp (to the number) and turning the link off replace Create client link, and each does what it says', () => {
    const copied: number[] = []; const shared: boolean[] = []
    const { labels, item, ui } = openShare(quote({ share_token: 'abc' }), { onCopy: () => { copied.push(1) }, onShare: on => { shared.push(on) } })
    assert.deepEqual(labels(), ['Download PDF', 'Download Excel', 'Copy link', 'WhatsApp', 'Turn the client link off'])
    assert.match(item('WhatsApp').getAttribute('href') ?? '', /^https:\/\/wa\.me\//)
    assert.match(item('WhatsApp').title, /WhatsApp opens with the text ready for 98290 12345; you press send\./)
    ui.click(item('Copy link')); ui.click(item('Turn the client link off'))
    assert.deepEqual(copied, [1]); assert.deepEqual(shared, [false])
  })
  test('the copied state is shown', () => {
    const { item } = openShare(quote({ share_token: 'abc' }), { copied: true })
    assert.match(item('Copied').textContent ?? '', /Copied/)
  })
  test('unsaved edits: the downloads, WhatsApp and the link switch wait; no products, or an archived quotation: no link yet', () => {
    const dirty = openShare(quote({ share_token: 'abc' }), { dirty: true })
    for (const w of ['Download PDF', 'Download Excel', 'WhatsApp', 'Turn the client link off']) assert.equal((dirty.item(w) as HTMLButtonElement).disabled, true, w)
    assert.equal((openShare(quote(), { lineCount: 0 }).item('Create client link') as HTMLButtonElement).disabled, true)
    assert.equal((openShare(quote({ status: 'archived' })).item('Create client link') as HTMLButtonElement).disabled, true)
  })
  test('a price the database still calls blocked no longer holds the link back (the approval is not drawn)', () => {
    assert.equal((openShare(quote({ price: { blocked: true } as never })).item('Create client link') as HTMLButtonElement).disabled, false)
  })
  test('Create client link and turning it off call the share with on or off', () => {
    const shared: boolean[] = []
    const a = openShare(quote(), { onShare: on => { shared.push(on) } })
    a.ui.click(a.item('Create client link'))
    assert.deepEqual(shared, [true])
  })
  test('the logo switch: one switch in the menu, on unless it was turned off, for people who may edit', () => {
    const on = openShare(quote(), { onMark: () => {}, markOn: true })
    assert.equal(on.ui.one<HTMLInputElement>('#q-mark').checked, true)
    assert.match(on.ui.text(), /Logo on pictures/)
    assert.equal(openShare(quote(), { onMark: () => {}, markOn: false }).ui.one<HTMLInputElement>('#q-mark').checked, false)
    const reader = openShare(quote({ may_edit: false }), { onMark: () => {}, markOn: true })
    assert.equal(reader.ui.one<HTMLInputElement>('#q-mark').disabled, true)
    assert.equal(openShare(quote()).ui.all('#q-mark').length, 0, 'no switch without a handler')
  })
  test('Escape closes the menu', () => {
    const { ui, items } = openShare(quote())
    assert.ok(items().length)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(ui.all('[role="menuitem"]').length, 0)
  })
})
