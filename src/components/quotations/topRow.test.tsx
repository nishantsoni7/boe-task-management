/**
 * The builder's top row (owner-approved layout, 18 Nov 2026): the Status card (a four-step tracker, one main action, the reason it waits,
 * the quiet outcomes) and the Share card, drawn for real from their props, one state at a time.
 *
 * Run: npm run test:file -- src/components/quotations/topRow.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { StatusCard, waitsFor } from './StatusCard'
import { ShareCard } from './ShareCard'
import type { Quotation, QuotationStatus } from '@/lib/quotations/api'
import type { ConversionProblem } from '@/lib/quotations/piWorkbook'

const quote = (o: Partial<Quotation> = {}) => ({ id: 'q1', quote_no: 'QT-1', status: 'sent' as QuotationStatus, may_edit: true, pi: null, price: null, share_token: null, ...o }) as Quotation
const names = (n: number) => Array.from({ length: n }, (_, i) => `Chair ${i + 1}`)
type Over = Partial<Parameters<typeof StatusCard>[0]>
const status = (base: Quotation, o: Over = {}) => renderToStaticMarkup(
  <StatusCard base={base} dirty={false} busy={false} isAdmin={false} canConfirm={false} piProblems={[]} priceBlocked={false} piStage={null}
    lostNote={null} setLostNote={() => {}} lostReason="" setLostReason={() => {}} onMove={() => {}} onConfirm={() => {}} {...o} />)
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}[^<]*</button>`))?.[0] ?? null
const SENT_OK: Over = { canConfirm: true }

describe('the Status card: where the quotation is', () => {
  test('four steps; the ones before the current are done, the current is marked for a screen reader, the rest are plain', () => {
    const html = status(quote({ status: 'sent' }))
    assert.match(html, /<ol class="steps" data-s="sent"/)
    assert.equal((html.match(/<li class="step/g) ?? []).length, 4)
    assert.match(html, /<li class="step stepDone"[^>]*><span class="dot"><svg/, 'Draft is ticked')
    assert.match(html, /<li class="step stepCur" aria-current="step"><span class="dot"><\/span>Sent</)
    assert.match(html, /<li class="step "[^>]*><span class="dot"><\/span>Negotiating</)
    assert.match(status(quote({ status: 'confirmed' })), /<li class="step stepCur" aria-current="step"><span class="dot"><\/span>Confirmed</)
  })
  test('a lost or archived quotation is not on the usual steps: one pill instead of the tracker', () => {
    const html = status(quote({ status: 'lost' }))
    assert.ok(!html.includes('<ol') && html.includes('pill st_lost'))
  })
})

describe('the Status card: what can be done', () => {
  test('a draft offers Mark sent (main) and Negotiating; no Confirm yet', () => {
    const html = status(quote({ status: 'draft' }))
    assert.ok(button(html, 'Mark sent')?.includes('btnPrimary') && button(html, 'Negotiating') && !html.includes('Confirm → make PI draft'))
  })
  test('a sent quotation offers Confirm → make PI draft (main), Negotiating, and the quiet outcomes', () => {
    const html = status(quote({ status: 'sent' }), SENT_OK)
    assert.ok(button(html, 'Confirm → make PI draft')?.includes('btnPrimary'))
    assert.ok(!/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Confirm/.test(html), 'nothing is missing, so it is ready')
    assert.match(html, /Other outcome/)
    for (const w of ['Confirmed, no PI', 'Lost…', 'Archive']) assert.ok(button(html, w)?.includes('btnQuiet'), w)
    assert.match(html, /Nothing is sent to anyone: the PI stays a Draft/)
  })
  test('while the main action waits: it is off, one line says what is missing, six names show and the rest are counted', () => {
    const problems: ConversionProblem[] = [{ code: 'PRICE_MISSING', lines: names(15) }]
    const html = status(quote({ status: 'sent' }), { canConfirm: true, piProblems: problems })
    assert.match(button(html, 'Confirm → make PI draft') ?? '', /disabled/)
    assert.match(html, /15 products need a price above ₹0 before this can become a PI\./)
    assert.match(html, /Show which/)
    assert.equal((html.match(/<span class="chip">Chair \d+<\/span>/g) ?? []).length, 6)
    assert.match(html, /<span class="chip">\+ 9 more<\/span>/)
    assert.ok(!html.includes('Nothing is sent to anyone'))
  })
  test('the line is worded for one product, for none, and for several things at once', () => {
    assert.equal(waitsFor([{ code: 'NAME_MISSING', lines: ['Line 3'] }]), '1 product needs a name before this can become a PI.')
    assert.equal(waitsFor([{ code: 'NO_LINES', lines: [] }]), 'Add at least one product that is not optional.')
    assert.equal(waitsFor([{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }]), '2 things to fix before this can become a PI.')
    const html = status(quote(), { canConfirm: true, piProblems: [{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }] })
    assert.match(html, /<b>Price needed:<\/b>/); assert.match(html, /<b>Picture needed:<\/b>/)
  })
  test('price approval can hold it too, and says so', () => {
    const html = status(quote({ status: 'sent' }), { canConfirm: true, priceBlocked: true })
    assert.match(button(html, 'Confirm → make PI draft') ?? '', /disabled/)
    assert.match(html, /Waiting for price approval/)
  })
  test('unsaved edits switch every status button off with "Save first", and say so', () => {
    const html = status(quote({ status: 'sent' }), { canConfirm: true, dirty: true })
    for (const w of ['Confirm → make PI draft', 'Negotiating', 'Lost…', 'Archive']) assert.match(button(html, w) ?? '', /disabled="" title="Save first"|title="Save first"[^>]*disabled=""|disabled=""[^>]*title="Save first"/, w)
    // Confirmed, no PI keeps its own tooltip, as before
    assert.match(button(html, 'Confirmed, no PI') ?? '', /disabled="" title="Confirmed without making a PI from it"/)
    assert.match(html, /Save your changes before confirming\./)
  })
  test('the made PI shows beside Open the PI draft; a confirmed quotation has no outcomes, and only an administrator can reopen it', () => {
    const base = quote({ status: 'confirmed', pi: { id: 'p1', draft_reference: 'DR-1042', status: 'under_review' } as never })
    const html = status(base)
    assert.match(html, /Confirmed into PI draft <b>DR-1042<\/b> \(under review\)/)
    assert.match(html, /<a class="btn btnPrimary" href="[^"]*p1[^"]*">/)
    assert.ok(!html.includes('Other outcome') && !html.includes('Reopen'))
    assert.ok(status(base, { isAdmin: true }).includes('Reopen'))
  })
  test('a lost quotation can be reopened or archived, not lost again; Lost… opens the box that asks why', () => {
    const html = status(quote({ status: 'lost' }))
    assert.ok(html.includes('Reopen') && html.includes('Archive') && !html.includes('Lost…') && !html.includes('Confirmed, no PI'))
    const asking = status(quote({ status: 'sent' }), { lostNote: '' })
    assert.match(asking, /Why was it lost\?/); assert.match(button(asking, 'Mark lost') ?? '', /disabled/, 'a reason must be chosen first')
  })
  test('the Lost box asks for one of the lead\'s eleven reasons; only "Other" needs words', () => {
    const asking = status(quote({ status: 'sent' }), { lostNote: '' })
    assert.equal((asking.match(/<option /g) ?? []).length, 12, 'a prompt and the eleven reasons')
    assert.match(asking, /Price too high/); assert.match(asking, /Chose another supplier/); assert.match(asking, /Other \(say why\)/)
    assert.match(asking, /Note \(optional\)/)
    assert.doesNotMatch(button(status(quote({ status: 'sent' }), { lostNote: '', lostReason: 'price_too_high' }), 'Mark lost') ?? '', /disabled/, 'a reason alone is enough')
    const other = status(quote({ status: 'sent' }), { lostNote: '', lostReason: 'other' })
    assert.match(other, /Note \(required\)/); assert.match(button(other, 'Mark lost') ?? '', /disabled/)
    assert.doesNotMatch(button(status(quote({ status: 'sent' }), { lostNote: 'Client sold the hotel', lostReason: 'other' }), 'Mark lost') ?? '', /disabled/)
  })
  test('a reader who may not edit sees where it is, and no buttons', () => {
    const html = status(quote({ status: 'sent', may_edit: false }))
    assert.ok(html.includes('<ol') && !html.includes('<button') && !html.includes('Other outcome'))
  })
})

describe('the Share card', () => {
  const share = (base: Quotation, o: Partial<Parameters<typeof ShareCard>[0]> = {}) => renderToStaticMarkup(
    <ShareCard id="q1" base={base} dirty={false} busy={false} lineCount={3} phone="98290 12345" link="https://x.example/q/abc" waText="Hello" copied={false}
      onCopy={() => {}} onExcel={() => {}} onShare={() => {}} {...o} />)
  test('before a link: the two downloads, one line about the link, and Create client link (an outline button, not the main one)', () => {
    const html = share(quote())
    assert.ok(html.includes('Download PDF') && html.includes('Download Excel') && html.includes('One link shows the quotation'))
    assert.ok(!html.includes('id="q-link"'))
    assert.ok(button(html, 'Create client link') && !button(html, 'Create client link')!.includes('btnPrimary'))
  })
  test('with a link: the link, WhatsApp with the number, and Turn the link off', () => {
    const html = share(quote({ share_token: 'abc' }))
    assert.match(html, /id="q-link"[^>]*value="https:\/\/x\.example\/q\/abc"/)
    assert.match(html, /<a class="btn btnPrimary" href="https:\/\/wa\.me\/[^"]*"/)
    assert.match(html, /WhatsApp opens with the text ready for 98290 12345/)
    assert.ok(button(html, 'Turn the link off'))
  })
  test('unsaved edits: the downloads, WhatsApp and the link button all wait, and the card says why', () => {
    const html = share(quote({ share_token: 'abc' }), { dirty: true })
    assert.match(button(html, 'Download PDF') ?? '', /disabled/); assert.match(button(html, 'Download Excel') ?? '', /disabled/)
    assert.match(button(html, 'save first') ?? '', /disabled/)
    assert.match(html, /Save first: the PDF, the Excel and the link all use the saved quotation\./)
  })
  test('no products, a price held for approval, or an archived quotation: no link yet', () => {
    assert.match(button(share(quote(), { lineCount: 0 }), 'Create client link') ?? '', /disabled/)
    assert.match(button(share(quote({ price: { blocked: true } as never })), 'Create client link') ?? '', /disabled="" title="Waiting for price approval"|title="Waiting for price approval"[^>]*disabled/)
    assert.match(button(share(quote({ status: 'archived' })), 'Create client link') ?? '', /disabled/)
  })
})
