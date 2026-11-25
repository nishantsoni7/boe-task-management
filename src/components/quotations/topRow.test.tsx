/**
 * The builder's top panel (owner, 24 Nov 2026, from an approved mockup): the Share row with the next step, the Lost box and the amber row, drawn for
 * real from their props, one state at a time. There is no four-step tracker and no Mark sent / Negotiating: the lead's stage is the status
 * (leadCard.dom.test.tsx). The ⋯ menu and the price block that is no longer drawn are driven in statusMore.dom.test.tsx.
 *
 * Run: npm run test:file -- src/components/quotations/topRow.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { waitsFor } from './TopPanel'
import { panel, quote, type PanelOver } from './topPanel.testkit'
import type { QuotationStatus } from '@/lib/quotations/api'
import type { ConversionProblem } from '@/lib/quotations/piWorkbook'

const names = (n: number) => Array.from({ length: n }, (_, i) => `Chair ${i + 1}`)
const draw = (base: ReturnType<typeof quote>, o: PanelOver = {}) => renderToStaticMarkup(panel(base, o))
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}[^<]*</button>`))?.[0] ?? null
const READY: PanelOver = { canConfirm: true }

describe('the lead is the status: nothing of the old tracker is left', () => {
  test('no four-step tracker, no Mark sent, no Negotiating button, whatever the quotation\'s own status', () => {
    for (const status of ['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived'] as QuotationStatus[]) {
      const html = draw(quote({ status }), READY)
      assert.ok(!html.includes('<ol') && !html.includes('Mark sent') && !html.includes('>Negotiating<') && !html.includes('Where the quotation is'), status)
    }
  })
  test('the quotation\'s own status shows only once it has left the usual path (Confirmed, Lost or Archived)', () => {
    for (const status of ['draft', 'sent', 'negotiating'] as QuotationStatus[]) assert.ok(!draw(quote({ status })).includes('pill st_'), status)
    for (const status of ['confirmed', 'lost', 'archived'] as QuotationStatus[]) assert.ok(draw(quote({ status })).includes(`pill st_${status}`), status)
  })
})

describe('the Share row: what can be done', () => {
  test('a draft, a sent and a negotiating quotation each offer Confirm → PI draft (the main button) when it is ready; nothing is missing, so it is on', () => {
    for (const status of ['draft', 'sent', 'negotiating'] as QuotationStatus[]) {
      const html = draw(quote({ status }), READY)
      assert.ok(button(html, 'Confirm → PI draft')?.includes('btnPrimary'), status)
      assert.doesNotMatch(button(html, 'Confirm → PI draft') ?? '', /disabled/, status)
      assert.match(html, /title="Makes a PI draft in Orders from the saved quotation\. Nothing is sent to anyone: the PI stays a Draft until you submit it there\."/)
    }
    assert.ok(!draw(quote(), {}).includes('Confirm → PI draft'), 'the page decides when Confirm is offered')
  })
  test('while Confirm waits: it is off, one amber row says what is missing, six names show and the rest are counted', () => {
    const problems: ConversionProblem[] = [{ code: 'PRICE_MISSING', lines: names(15) }]
    const html = draw(quote({ status: 'sent' }), { canConfirm: true, piProblems: problems })
    assert.match(button(html, 'Confirm → PI draft') ?? '', /disabled/)
    assert.match(html, /15 products need a price above ₹0 before this can become a PI\./)
    assert.match(html, /Show which/)
    assert.equal((html.match(/<span class="chip">Chair \d+<\/span>/g) ?? []).length, 6)
    assert.match(html, /<span class="chip">\+ 9 more<\/span>/)
  })
  test('the amber row draws only while Confirm is offered and something is missing', () => {
    const problems: ConversionProblem[] = [{ code: 'NO_LINES', lines: [] }]
    assert.match(draw(quote(), { canConfirm: true, piProblems: problems }), /Add at least one product that is not optional\./)
    assert.ok(!draw(quote(), { canConfirm: false, piProblems: problems }).includes('Add at least one product'), 'a quotation that cannot be confirmed is not nagged')
    assert.ok(!draw(quote(), READY).includes('class="hintBody"'))
  })
  test('the line is worded for one product, for none, and for several things at once', () => {
    assert.equal(waitsFor([{ code: 'NAME_MISSING', lines: ['Line 3'] }]), '1 product needs a name before this can become a PI.')
    assert.equal(waitsFor([{ code: 'NO_LINES', lines: [] }]), 'Add at least one product that is not optional.')
    assert.equal(waitsFor([{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }]), '2 things to fix before this can become a PI.')
    const html = draw(quote(), { canConfirm: true, piProblems: [{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }] })
    assert.match(html, /<b>Price needed:<\/b>/); assert.match(html, /<b>Picture needed:<\/b>/)
  })
  test('unsaved edits switch Confirm, the downloads and the client link off with "Save first", and say so once, beside the buttons', () => {
    const html = draw(quote({ status: 'sent' }), { canConfirm: true, dirty: true })
    for (const w of ['Confirm → PI draft', 'Download PDF', 'Download Excel', 'Create client link']) {
      assert.match(button(html, w) ?? '', /disabled="" title="Save first"|title="Save first"[^>]*disabled=""|disabled=""[^>]*title="Save first"/, w)
    }
    assert.equal((html.match(/<span class="dirty">Save first<\/span>/g) ?? []).length, 1)
    // the items of the ⋯ menu wait too: statusMore.dom.test.tsx
  })
  test('the made PI shows beside Open the PI draft; a confirmed quotation has no ⋯ menu, and only an administrator can reopen it', () => {
    const base = quote({ status: 'confirmed', pi: { id: 'p1', draft_reference: 'DR-1042', status: 'under_review' } as never })
    const html = draw(base)
    assert.match(html, /PI draft <b>DR-1042<\/b> · under review/)
    assert.match(html, /<a class="btn btnPrimary pnext" href="[^"]*p1[^"]*">/)
    assert.ok(!html.includes('aria-haspopup="menu"') && !html.includes('Reopen') && !html.includes('Confirm → PI draft'))
    assert.ok(draw(base, { isAdmin: true }).includes('Reopen'))
  })
  test('a lost quotation can be reopened, not lost again (its menu is in statusMore.dom.test.tsx); Mark as lost… opens the box that asks why', () => {
    const html = draw(quote({ status: 'lost' }))
    assert.ok(html.includes('Reopen') && !html.includes('Mark lost'))
    const asking = draw(quote({ status: 'sent' }), { lostNote: '' })
    assert.match(asking, /Why was it lost\?/); assert.match(button(asking, 'Mark lost') ?? '', /disabled/, 'a reason must be chosen first')
  })
  test('the Lost box asks for one of the lead\'s eleven reasons; only "Other" needs words', () => {
    const asking = draw(quote({ status: 'sent' }), { lostNote: '' })
    assert.equal((asking.match(/<option /g) ?? []).length, 12, 'a prompt and the eleven reasons')
    assert.match(asking, /Price too high/); assert.match(asking, /Chose another supplier/); assert.match(asking, /Other \(say why\)/)
    assert.match(asking, /Note \(optional\)/)
    assert.doesNotMatch(button(draw(quote({ status: 'sent' }), { lostNote: '', lostReason: 'price_too_high' }), 'Mark lost') ?? '', /disabled/, 'a reason alone is enough')
    const other = draw(quote({ status: 'sent' }), { lostNote: '', lostReason: 'other' })
    assert.match(other, /Note \(required\)/); assert.match(button(other, 'Mark lost') ?? '', /disabled/)
    assert.doesNotMatch(button(draw(quote({ status: 'sent' }), { lostNote: 'Client sold the hotel', lostReason: 'other' }), 'Mark lost') ?? '', /disabled/)
  })
  test('a reader who may not edit sees the downloads and nothing that changes the quotation', () => {
    const html = draw(quote({ status: 'sent', may_edit: false }))
    assert.ok(html.includes('Download PDF') && html.includes('Download Excel'))
    assert.ok(!html.includes('Create client link') && !html.includes('Confirm') && !html.includes('aria-haspopup'))
  })
})

describe('the Share row: sharing', () => {
  test('before a link: the two downloads and Create client link (an outline button, not the main one), whose tooltip says what it does', () => {
    const html = draw(quote())
    assert.ok(html.includes('Download PDF') && html.includes('Download Excel'))
    assert.ok(!html.includes('Copy link') && !html.includes('WhatsApp') && !html.includes('id="q-link"'))
    const create = button(html, 'Create client link') ?? ''
    assert.ok(create && !create.includes('btnPrimary'))
    assert.match(create, /title="One link with the pictures and a Save as PDF button; no login\. Turning it on marks a draft as Sent\."/)
  })
  test('with a link: Copy link and WhatsApp (to the number) replace Create client link, and the link is no longer a box on the page', () => {
    const html = draw(quote({ share_token: 'abc' }))
    assert.ok(button(html, 'Copy link') && !html.includes('Create client link') && !html.includes('id="q-link"'))
    assert.match(html, /<a class="btn" href="https:\/\/wa\.me\/[^"]*"[^>]*title="WhatsApp opens with the text ready for 98290 12345; you press send\./)
    assert.match(draw(quote({ share_token: 'abc' }), { copied: true }), /Copied/)
  })
  test('unsaved edits: the downloads and WhatsApp wait; no products, or an archived quotation: no link yet', () => {
    const html = draw(quote({ share_token: 'abc' }), { dirty: true })
    assert.match(button(html, 'Download PDF') ?? '', /disabled/); assert.match(button(html, 'Download Excel') ?? '', /disabled/)
    assert.match(button(html, 'WhatsApp') ?? '', /disabled/)
    assert.match(button(draw(quote(), { lineCount: 0 }), 'Create client link') ?? '', /disabled/)
    assert.match(button(draw(quote({ status: 'archived' })), 'Create client link') ?? '', /disabled/)
  })
  test('a price the database still calls blocked no longer holds the link back (the approval is not drawn)', () => {
    assert.doesNotMatch(button(draw(quote({ price: { blocked: true } as never })), 'Create client link') ?? '', /disabled/)
  })
  test('the logo switch: one switch, on unless it was turned off, for people who may edit', () => {
    const on = draw(quote(), { onMark: () => {}, markOn: true })
    assert.match(on, /<input type="checkbox" role="switch" id="q-mark" checked=""/)
    assert.match(on, /Logo on pictures/)
    assert.doesNotMatch(draw(quote(), { onMark: () => {}, markOn: false }), /id="q-mark" checked/)
    assert.match(draw(quote({ may_edit: false }), { onMark: () => {}, markOn: true }), /id="q-mark" disabled="" checked=""/)
    assert.ok(!draw(quote()).includes('q-mark'), 'no switch without a handler')
  })
})
