// The Status and Lead rows of a quotation (20270811000000; one status since 25 Nov 2026), the real component in jsdom with the database calls answered here.
// What it must do: show the lead's stage as the status, read only, with a link to Lead Board where it is changed (no status button on this page); offer the one
// lead action that is not a status change (Log on the lead); never write to the lead until that button is pressed, and call the lead's own function
// (add_sales_lead_comment) with what the person confirmed.
// Run: npm run test:file -- src/components/quotations/leadCard.dom.test.tsx
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { istToday } from '@/lib/istDate'
import type { LeadInfo, Quotation, QuotationStatus } from '@/lib/quotations/api'
import { followUpDefault } from '@/lib/quotations/leadLink'
import { LeadCard } from './LeadCard'

// next/link's link observer reads `self`, which the jsdom harness does not define.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') (globalThis as { self?: unknown }).self = globalThis

const LEAD = { id: 'lead-1', lead_no: 1201, name: 'Hotel Aravali', stage: 'potential', holder_name: 'Mohit Sharma', dead_reason: null, next_step: 'Follow up', next_due_on: '2026-11-25', may_work: true, last_logged_at: null }
const info = (o: Partial<LeadInfo> = {}): LeadInfo => ({ sales_open: true, linked: true, lead: LEAD, suggest: null, version_no: 2, value: 450000, ...o })
const quote = (status: QuotationStatus, o: Partial<Quotation> = {}) => ({
  id: 'q1', quote_no: 'QT-MS-01001', status, may_edit: true, events: [], ...o }) as unknown as Quotation

type Reply = { data: unknown; error: { message: string } | null }
/** `answers`: what a function returns; `refuse`: a function the database refuses, with its message. */
function fake(i: LeadInfo, answers: Record<string, unknown> = {}, refuse: Record<string, string> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    writes: () => calls.filter(c => c.fn !== 'quotation_lead_info' && c.fn !== 'sales_leads_page').map(c => c.fn),
    client: {
      rpc: async (fn: string, args: Record<string, unknown> = {}): Promise<Reply> => {
        calls.push({ fn, args })
        if (fn in refuse) return { data: null, error: { message: refuse[fn] } }
        if (fn === 'quotation_lead_info') return { data: i, error: null }
        if (fn in answers) return { data: answers[fn], error: null }
        return { data: null, error: null }
      },
    },
  }
}
// Whatever a test leaves on screen is removed after it, so one failure cannot make the next test read its leftovers.
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
const ui = (sb: ReturnType<typeof fake>, base: Quotation, o: { dirty?: boolean; onChanged?: () => void } = {}) => {
  const m = mount(
    createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) },
      createElement(LeadCard, { supabase: sb.client as never, base, dirty: o.dirty ?? false, onChanged: o.onChanged ?? (() => {}) })))
  const real = m.unmount; let gone = false
  m.unmount = () => { if (!gone) { gone = true; real() } }
  mounted.push(m)
  return m
}

describe('the Lead card: what it offers', () => {
  test('Sent: one button, "Log on the lead"; the lead shows its number, stage, holder, follow-up and that nothing is logged yet', async () => {
    const sb = fake(info()); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    assert.match(u.text(), /#1201 Hotel Aravali/); assert.match(u.text(), /Potential Clients/); assert.match(u.text(), /Held by Mohit Sharma/)
    assert.match(u.text(), /Follow-up 25 Nov/); assert.match(u.text(), /Not logged on the lead yet/)
    assert.deepEqual(u.all('button').map(b => b.textContent?.trim()), ['Log on the lead', 'Unlink'])
    // the lead's stage IS the status: a chip, and four of the five steps of the sale filled for Potential Clients
    assert.match(u.one('.stage').textContent ?? '', /^Potential Clients$/)
    assert.equal(u.all('.meter i').length, 5); assert.equal(u.all('.meter i.meterOn').length, 4)
    assert.equal(u.one('.meter').getAttribute('aria-label'), 'Stage 4 of 5')
    assert.ok(u.all('a').some(a => a.textContent?.trim() === 'Change in Lead Board' && a.getAttribute('href') === '/sales/board?lead=lead-1'), 'the status is changed in Lead Board')
    assert.deepEqual(sb.writes(), [], 'showing the card writes nothing')
    u.unmount()
  })
  test('there is no status button for any quotation status: Confirmed and Lost do not offer to move the lead, the page only links to Lead Board', async () => {
    for (const status of ['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived'] as const) {
      const sb = fake(info()); const u = ui(sb, quote(status)); await u.settle(); await u.settle()
      assert.ok(!u.all('button').some(b => /Mark lead|Converted|Dead|Lost/.test(b.textContent ?? '')), status)
      assert.ok(u.all('a').some(a => a.textContent?.trim() === 'Change in Lead Board'), status)
      assert.deepEqual(sb.writes(), [], status)
      u.unmount()
    }
  })
  test('a draft, an archived quotation, a closed lead, or a lead somebody else holds: no action button', async () => {
    const cases: Array<[string, Quotation, LeadInfo]> = [
      ['draft', quote('draft'), info()],
      ['archived', quote('archived'), info()],
      ['closed lead', quote('confirmed'), info({ lead: { ...LEAD, stage: 'converted' } })],
      ['not the holder', quote('sent'), info({ lead: { ...LEAD, may_work: false } })],
    ]
    for (const [name, base, i] of cases) {
      const u = ui(fake(i), base); await u.settle(); await u.settle()
      assert.ok(!u.all('button').some(b => /Log on the lead|Mark lead/.test(b.textContent ?? '')), name)
      if (name === 'not the holder') assert.match(u.text(), /only they, or a sales manager, can update the lead/)
      u.unmount()
    }
  })
  test('with unsaved edits the buttons are off and each says "Save first" in its tooltip (the panel says it once, in words)', async () => {
    const u = ui(fake(info()), quote('sent'), { dirty: true }); await u.settle(); await u.settle()
    assert.equal(u.button('Log on the lead').disabled, true)
    assert.equal(u.button('Log on the lead').title, 'Save first'); assert.equal(u.button('Unlink').title, 'Save first')
    u.unmount()
  })
  test('the chip wears the lead\'s outcome, and a lead off the path of a sale has no meter', async () => {
    for (const [stage, tone, meter] of [['converted', 'stageDone', 0], ['dead', 'stageDead', 0], ['follow_up_later', 'stageLater', 0], ['negotiation', '', 5]] as const) {
      const u = ui(fake(info({ lead: { ...LEAD, stage } })), quote('sent')); await u.settle(); await u.settle()
      assert.equal(u.one('.stage').className.includes(tone || 'stage'), true, stage)
      if (tone) assert.ok(u.one('.stage').className.includes(tone), stage)
      assert.equal(u.all('.meter i.meterOn').length, meter, stage)
      u.unmount()
    }
  })
  test('a person with no Sales and no link sees no card; a link they cannot open is only said, never named', async () => {
    const none = ui(fake(info({ sales_open: false, linked: false, lead: null })), quote('sent')); await none.settle(); await none.settle()
    assert.equal(none.text().trim(), ''); none.unmount()
    const hidden = ui(fake(info({ sales_open: false, lead: null })), quote('sent')); await hidden.settle(); await hidden.settle()
    assert.match(hidden.text(), /Linked to a lead you cannot open/); assert.ok(!/Aravali/.test(hidden.text()))
    hidden.unmount()
  })
})

describe('the Lead card: nothing happens until a button is pressed, then the lead\'s own function is called', () => {
  test('Log: shows exactly what will be written and the follow-up, then calls add_sales_lead_comment with the quotation tag', async () => {
    const sb = fake(info(), { add_sales_lead_comment: { status: 'saved' } }); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    u.click(u.button('Log on the lead')); await u.settle()
    assert.match(u.text(), /QT-MS-01001 v2 sent to the client, ₹4,50,000 before GST/)
    const due = u.one<HTMLInputElement>('#q-lead-due')
    assert.equal(due.value, followUpDefault(istToday()))
    assert.deepEqual(sb.writes(), [])
    u.click(u.button('Log it')); await u.settle(); await u.settle()
    const w = sb.calls.find(c => c.fn === 'add_sales_lead_comment')!
    assert.deepEqual([w.args.p_id, w.args.p_note, w.args.p_tag, w.args.p_next_due], ['lead-1', 'QT-MS-01001 v2 sent to the client, ₹4,50,000 before GST', 'quotation', followUpDefault(istToday())])
    assert.match(u.text(), /Logged on the lead\. Follow-up/); assert.match(u.text(), /move the lead to Negotiation/)
    assert.deepEqual(sb.writes(), ['add_sales_lead_comment'])
    u.unmount()
  })
  test('Log: another day can be chosen, and a day in the past cannot be logged', async () => {
    const sb = fake(info()); const u = ui(sb, quote('negotiating')); await u.settle(); await u.settle()
    u.click(u.button('Log on the lead')); await u.settle()
    u.type(u.one<HTMLInputElement>('#q-lead-due'), '2020-01-01')
    assert.equal(u.button('Log it').disabled, true)
    u.type(u.one<HTMLInputElement>('#q-lead-due'), '2099-01-05')
    u.click(u.button('Log it')); await u.settle()
    assert.equal(sb.calls.find(c => c.fn === 'add_sales_lead_comment')!.args.p_next_due, '2099-01-05')
    u.unmount()
  })
  test('a refusal from the lead is shown as it is and nothing else happens', async () => {
    const sb = fake(info(), {}, { add_sales_lead_comment: 'SALES_CHANGED: This lead has moved since you opened it.' })
    const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    u.click(u.button('Log on the lead')); await u.settle(); u.click(u.button('Log it')); await u.settle(); await u.settle()
    assert.match(u.text(), /This lead has moved since you opened it/)
    assert.ok(!sb.calls.some(c => c.fn === 'move_sales_lead'), 'this page never moves the lead')
    u.unmount()
  })
})

describe('the Lead card: linking', () => {
  test('an unlinked quotation offers the lead with the same phone; "Link this lead" links it and tells the builder to reload', async () => {
    const suggest = { id: 'lead-9', lead_no: 77, name: 'Cafe Lake', stage: 'new', holder_name: 'Prerna Purohit' }
    const sb = fake(info({ linked: false, lead: null, suggest })); let changed = 0
    const u = ui(sb, quote('draft'), { onChanged: () => { changed++ } }); await u.settle(); await u.settle()
    assert.match(u.text(), /Is this the lead\?/); assert.match(u.text(), /#77 Cafe Lake/); assert.match(u.text(), /same phone/)
    assert.deepEqual(sb.writes(), [])
    u.click(u.button('Link this lead')); await u.settle(); await u.settle()
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_link_lead')!.args, { p_id: 'q1', p_lead: 'lead-9' })
    assert.equal(changed, 1)
    u.unmount()
  })
  test('with no suggestion a person searches, picks a result, and it is linked', async () => {
    const rows = [{ id: 'lead-5', lead_no: 5, name: 'Resort Bagh', phone: '+919812345678', holder_name: 'Mohit Sharma' }]
    const sb = fake(info({ linked: false, lead: null }), { sales_leads_page: { rows } }); const u = ui(sb, quote('draft')); await u.settle(); await u.settle()
    u.click(u.button('Link to a lead')); await u.settle()
    u.type(u.one<HTMLInputElement>('#q-lead-search'), 'bagh')
    u.click(u.button('Search')); await u.settle(); await u.settle()
    assert.equal(sb.calls.find(c => c.fn === 'sales_leads_page')!.args.p_q, 'bagh')
    u.click(u.button(/#5 Resort Bagh/)); await u.settle(); await u.settle()
    assert.equal(sb.calls.find(c => c.fn === 'quotation_link_lead')!.args.p_lead, 'lead-5')
    u.unmount()
  })
  test('Unlink sends null; somebody who may only read the quotation sees no link or unlink button', async () => {
    const sb = fake(info()); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    u.click(u.button('Unlink')); await u.settle(); await u.settle()
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_link_lead')!.args, { p_id: 'q1', p_lead: null })
    u.unmount()
    const ro = ui(fake(info()), quote('sent', { may_edit: false })); await ro.settle(); await ro.settle()
    assert.ok(!ro.all('button').some(b => /Unlink|Link/.test(b.textContent ?? '')))
    ro.unmount()
  })
})
