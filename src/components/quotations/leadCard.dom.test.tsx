// The Status and Lead rows of the quotation's top panel (20270811000000; owner, 25 Nov 2026, quotation page version 2), the real component in
// jsdom with the database calls answered here. What it must do: show the lead's stage as the status, read only, with the way to Lead Management;
// open the lead's brief from its name (LeadBrief, read with get_sales_lead); offer ONE button, "Log on the lead", while the quotation is out with
// the client; never write to the lead until that button is pressed; and never move the lead (no Mark lead Converted / Dead, no move_sales_lead).
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
/** What get_sales_lead answers for the brief: the lead and its activity, newest first. */
const DETAIL = {
  clickup: [], can_work: true, quotation_sent: true, events: [],
  lead: {
    id: 'lead-1', lead_no: 1201, name: 'Hotel Aravali', stage: 'potential', dead_reason: null, temperature: 'hot', location: 'Udaipur',
    phone: '+919829012345', email: 'gm@aravali.example', client_type: 'hotel', holder_name: 'Mohit Sharma', next_due_on: '2026-11-25',
    source: 'website', received_on: '2026-11-03', quantity: '40 rooms', expected_value_paise: 45000000, requirement: 'Outdoor chairs for the pool deck',
  },
  activities: [
    { id: 'a2', kind: 'comment', outcome: '', note: '  ', next_step: null, next_due_on: null, actor_name: null, at: '2026-11-22T06:00:00Z' },
    { id: 'a1', kind: 'comment', outcome: '', note: 'Wants teak, not acacia', next_step: null, next_due_on: null, actor_name: 'Mohit Sharma', at: '2026-11-20T06:00:00Z' },
  ],
}
const READS = ['quotation_lead_info', 'sales_leads_page', 'get_sales_lead']

type Reply = { data: unknown; error: { message: string } | null }
/** `answers`: what a function returns; `refuse`: a function the database refuses, with its message. */
function fake(i: LeadInfo, answers: Record<string, unknown> = {}, refuse: Record<string, string> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    writes: () => calls.filter(c => !READS.includes(c.fn)).map(c => c.fn),
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
type UI = ReturnType<typeof ui>
const row = (u: UI, name: string) => u.all(`[role="group"][aria-label="${name}"]`)[0] ?? null
const LEAD_HREF = '/sales/board?lead=lead-1'

describe('the Status row: the lead\'s stage, read only', () => {
  test('a linked lead: its stage as a chip with the five-step meter, "changed only in Lead Management", and the way there', async () => {
    const sb = fake(info()); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    const st = row(u, 'Status')!
    assert.ok(st, 'the Status row is drawn')
    assert.match(st.querySelector('.stage')?.textContent ?? '', /^Potential Clients$/)
    // four of the five steps of the sale filled for Potential Clients
    assert.equal(st.querySelectorAll('.meter i').length, 5); assert.equal(st.querySelectorAll('.meter i.meterOn').length, 4)
    assert.equal(st.querySelector('.meter')?.getAttribute('aria-label'), 'Stage 4 of 5')
    assert.match(st.textContent ?? '', /Comes from the lead\. Changed only in Lead Management\./)
    const link = st.querySelector('a')!
    assert.equal(link.textContent?.trim(), 'Open in Lead Management'); assert.equal(link.getAttribute('href'), LEAD_HREF)
    assert.equal(st.querySelectorAll('button').length, 0, 'nothing in the row changes the status')
    assert.ok(!st.querySelector('.pill'), 'the quotation\'s own status is not shown beside the lead\'s')
  })
  test('the chip wears the lead\'s outcome, and a lead off the path of a sale has no meter', async () => {
    for (const [stage, tone, meter] of [['converted', 'stageDone', 0], ['dead', 'stageDead', 0], ['follow_up_later', 'stageLater', 0], ['negotiation', '', 5]] as const) {
      const u = ui(fake(info({ lead: { ...LEAD, stage } })), quote('sent')); await u.settle(); await u.settle()
      if (tone) assert.ok(u.one('.stage').className.includes(tone), stage)
      assert.equal(u.all('.meter i.meterOn').length, meter, stage)
      u.unmount()
    }
  })
  test('a dead lead says why on its chip', async () => {
    const u = ui(fake(info({ lead: { ...LEAD, stage: 'dead', dead_reason: 'price_too_high' } })), quote('lost')); await u.settle(); await u.settle()
    assert.match(u.one('.stage').textContent ?? '', /^Dead · Price too high$/)
  })
  test('no lead linked: the quotation\'s own status as a pill, and how to follow the lead\'s instead', async () => {
    const u = ui(fake(info({ linked: false, lead: null })), quote('negotiating')); await u.settle(); await u.settle()
    const st = row(u, 'Status')!
    assert.ok(st.querySelector('.pill.st_negotiating')); assert.match(st.textContent ?? '', /Negotiating/)
    assert.match(st.textContent ?? '', /Link a lead to follow its status here\./)
    assert.ok(!st.querySelector('a') && !st.querySelector('.stage'))
  })
  test('a lead the person cannot open: the quotation\'s own status, and that the lead\'s stage shows once they can', async () => {
    const u = ui(fake(info({ sales_open: false, lead: null })), quote('sent')); await u.settle(); await u.settle()
    const st = row(u, 'Status')!
    assert.ok(st.querySelector('.pill.st_sent'))
    assert.match(st.textContent ?? '', /The lead’s stage shows here once you can open the lead\./)
  })
  test('no Sales and no link, or no lead information at all: only the Status row is drawn', async () => {
    const none = ui(fake(info({ sales_open: false, linked: false, lead: null })), quote('sent')); await none.settle(); await none.settle()
    assert.ok(row(none, 'Status') && !row(none, 'Lead')); none.unmount()
    const unset = ui(fake(null as unknown as LeadInfo), quote('sent')); await unset.settle(); await unset.settle()
    assert.ok(row(unset, 'Status') && !row(unset, 'Lead'))
    assert.match(unset.text(), /Link a lead to follow its status here\./)
  })
})

describe('the Lead row: what it offers', () => {
  test('Sent: the lead\'s name is a button that opens its brief, then who holds it, the follow-up, that nothing is logged yet, Log on the lead and Unlink', async () => {
    const sb = fake(info()); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    const lr = row(u, 'Lead')!
    assert.deepEqual([...lr.querySelectorAll('button')].map(b => b.textContent?.trim()), ['#1201 Hotel Aravali', 'Log on the lead', 'Unlink'])
    assert.equal(u.button('#1201 Hotel Aravali').getAttribute('aria-haspopup'), 'dialog')
    assert.match(lr.textContent ?? '', /Held by Mohit Sharma · follow-up 25 Nov · not logged on the lead yet/)
    assert.deepEqual(sb.writes(), [], 'showing the card writes nothing')
  })
  test('a lead logged on before says how long ago', async () => {
    const u = ui(fake(info({ lead: { ...LEAD, last_logged_at: `${istToday()}T05:00:00Z` } })), quote('negotiating')); await u.settle(); await u.settle()
    assert.match(row(u, 'Lead')!.textContent ?? '', /logged on the lead today/)
  })
  test('nothing on the page moves the lead: no Mark lead Converted or Mark lead Dead, whatever the quotation\'s status', async () => {
    for (const status of ['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived'] as QuotationStatus[]) {
      const sb = fake(info()); const u = ui(sb, quote(status)); await u.settle(); await u.settle()
      assert.ok(!u.all('button').some(b => /Mark lead|Converted|Dead/.test(b.textContent ?? '')), status)
      assert.ok(!u.all('select').length, status)
      assert.ok(!sb.calls.some(c => c.fn === 'move_sales_lead'), status)
      u.unmount()
    }
  })
  test('a draft, a confirmed, lost or archived quotation, a closed lead, or a lead somebody else holds: no Log on the lead', async () => {
    const cases: Array<[string, Quotation, LeadInfo]> = [
      ['draft', quote('draft'), info()],
      ['confirmed', quote('confirmed'), info()],
      ['lost', quote('lost'), info()],
      ['archived', quote('archived'), info()],
      ['closed lead', quote('sent'), info({ lead: { ...LEAD, stage: 'converted' } })],
      ['not the holder', quote('sent'), info({ lead: { ...LEAD, may_work: false } })],
    ]
    for (const [name, base, i] of cases) {
      const u = ui(fake(i), base); await u.settle(); await u.settle()
      assert.ok(!u.all('button').some(b => /Log on the lead/.test(b.textContent ?? '')), name)
      if (name === 'not the holder') assert.match(u.text(), /only they, or a sales manager, can update the lead/)
      u.unmount()
    }
  })
  test('with unsaved edits the buttons are off and each says "Save first" in its tooltip (the panel says it once, in words)', async () => {
    const u = ui(fake(info()), quote('sent'), { dirty: true }); await u.settle(); await u.settle()
    assert.equal(u.button('Log on the lead').disabled, true)
    assert.equal(u.button('Log on the lead').title, 'Save first'); assert.equal(u.button('Unlink').title, 'Save first')
    assert.equal(u.button('#1201 Hotel Aravali').disabled, false, 'the brief only reads, so it opens with unsaved edits')
  })
  test('a link the person cannot open is only said, never named', async () => {
    const hidden = ui(fake(info({ sales_open: false, lead: null })), quote('sent')); await hidden.settle(); await hidden.settle()
    assert.match(hidden.text(), /Linked to a lead you cannot open \(your account has no Sales access\)/); assert.ok(!/Aravali/.test(hidden.text()))
  })
})

describe('the lead\'s brief (LeadBrief), opened from its name', () => {
  const open = async (answers: Record<string, unknown> = { get_sales_lead: DETAIL }, refuse: Record<string, string> = {}) => {
    const sb = fake(info(), answers, refuse); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    assert.ok(!sb.calls.some(c => c.fn === 'get_sales_lead'), 'the lead is not read until the brief is opened')
    u.click(u.button('#1201 Hotel Aravali')); await u.settle(); await u.settle()
    return { sb, u }
  }
  const dialog = (u: UI) => u.all('[role="dialog"]')[0] ?? null
  test('it is a dialog named for the lead, read with the Lead Board\'s own call, and shows who the client is and what they want', async () => {
    const { sb, u } = await open()
    const d = dialog(u)!
    assert.ok(d, 'the brief is open')
    assert.equal(d.getAttribute('aria-modal'), 'true')
    assert.equal(u.one(`#${d.getAttribute('aria-labelledby')}`).textContent, 'Hotel Aravali')
    assert.deepEqual(sb.calls.find(c => c.fn === 'get_sales_lead')!.args, { p_id: 'lead-1' })
    const t = d.textContent ?? ''
    for (const w of ['Lead #1201', 'Udaipur', 'Potential Clients', 'Hot', 'Phone+919829012345', 'Client typeHotel', 'Held byMohit Sharma',
      'Follow-up25 Nov 2026', 'Came fromWebsite, 3 Nov 2026', 'Quantity40 rooms', 'Expected value₹ 4.5 L', 'Outdoor chairs for the pool deck']) {
      assert.ok(t.includes(w), w)
    }
    assert.equal(d.querySelector('a[href^="mailto:"]')?.getAttribute('href'), 'mailto:gm@aravali.example')
  })
  test('the last update is the newest activity that says something, with its day and who wrote it', async () => {
    const { u } = await open()
    assert.match(dialog(u)!.textContent ?? '', /Last update · 20 Nov 2026 · Mohit SharmaWants teak, not acacia/)
  })
  test('it only reads: nothing is written to the lead, and the way to change it is Open in Lead Management', async () => {
    const { sb, u } = await open()
    assert.deepEqual(sb.writes(), [])
    const d = dialog(u)!
    const link = [...d.querySelectorAll('a')].find(a => a.textContent?.trim() === 'Open in Lead Management')!
    assert.equal(link.getAttribute('href'), LEAD_HREF)
    assert.deepEqual([...d.querySelectorAll('button')].map(b => b.textContent?.trim() || b.getAttribute('aria-label')), ['Close', 'Close'])
  })
  test('facts the lead does not have are left out, not shown blank', async () => {
    const bare = { ...DETAIL, activities: [], lead: { ...DETAIL.lead, email: null, client_type: null, next_due_on: null, quantity: null, expected_value_paise: null, requirement: '', location: null, temperature: null } }
    const { u } = await open({ get_sales_lead: bare })
    const t = dialog(u)!.textContent ?? ''
    for (const w of ['Email', 'Client type', 'Follow-up', 'Quantity', 'Expected value', 'Requirement', 'Last update', 'Udaipur']) assert.ok(!t.includes(w), w)
    assert.ok(t.includes('Phone') && t.includes('Held by') && t.includes('Came from'))
  })
  test('a lead that cannot be read here says so and still offers Lead Management', async () => {
    const { u } = await open({}, { get_sales_lead: 'SALES_FORBIDDEN: not yours' })
    const d = dialog(u)!
    assert.match(d.textContent ?? '', /This lead could not be read here\. Open it in Lead Management\./)
    assert.ok([...d.querySelectorAll('a')].some(a => a.getAttribute('href') === LEAD_HREF))
  })
  test('Close, the ×, Escape and a click outside each close it; a click inside does not', async () => {
    const { u } = await open()
    u.click(dialog(u)!); assert.ok(dialog(u), 'a click inside keeps it open')
    u.click(u.button('Close')); assert.equal(dialog(u), null, 'Close')
    u.click(u.button('#1201 Hotel Aravali')); await u.settle()
    u.click(u.one('[role="dialog"] button[aria-label="Close"]')); assert.equal(dialog(u), null, '×')
    u.click(u.button('#1201 Hotel Aravali')); await u.settle()
    u.press('Escape'); assert.equal(dialog(u), null, 'Escape')
    u.click(u.button('#1201 Hotel Aravali')); await u.settle()
    u.click(u.one('.scrim')); assert.equal(dialog(u), null, 'a click outside')
  })
})

describe('the Lead row: nothing happens until a button is pressed, then the lead\'s own function is called', () => {
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
    assert.match(u.text(), /Logged on the lead\. Follow-up/); assert.match(u.text(), /move the lead to Negotiation, open it in Lead Management/)
    assert.deepEqual(sb.writes(), ['add_sales_lead_comment'])
  })
  test('Log: another day can be chosen, and a day in the past cannot be logged', async () => {
    const sb = fake(info()); const u = ui(sb, quote('negotiating')); await u.settle(); await u.settle()
    u.click(u.button('Log on the lead')); await u.settle()
    u.type(u.one<HTMLInputElement>('#q-lead-due'), '2020-01-01')
    assert.equal(u.button('Log it').disabled, true)
    u.type(u.one<HTMLInputElement>('#q-lead-due'), '2099-01-05')
    u.click(u.button('Log it')); await u.settle()
    assert.equal(sb.calls.find(c => c.fn === 'add_sales_lead_comment')!.args.p_next_due, '2099-01-05')
  })
  test('Log: Cancel closes the form and writes nothing', async () => {
    const sb = fake(info()); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    u.click(u.button('Log on the lead')); await u.settle()
    u.click(u.button('Cancel'))
    assert.equal(u.all('#q-lead-due').length, 0)
    assert.deepEqual(sb.writes(), [])
  })
  test('a refusal from the lead is shown as it is and nothing else happens', async () => {
    const sb = fake(info(), {}, { add_sales_lead_comment: 'SALES_CHANGED: This lead has moved since you opened it.' })
    const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    u.click(u.button('Log on the lead')); await u.settle(); u.click(u.button('Log it')); await u.settle(); await u.settle()
    assert.match(u.text(), /This lead has moved since you opened it/)
    assert.deepEqual(sb.writes(), ['add_sales_lead_comment'])
  })
})

describe('the Lead row: linking', () => {
  test('an unlinked quotation offers the lead with the same phone; "Link this lead" links it and tells the builder to reload', async () => {
    const suggest = { id: 'lead-9', lead_no: 77, name: 'Cafe Lake', stage: 'new', holder_name: 'Prerna Purohit' }
    const sb = fake(info({ linked: false, lead: null, suggest })); let changed = 0
    const u = ui(sb, quote('draft'), { onChanged: () => { changed++ } }); await u.settle(); await u.settle()
    assert.match(u.text(), /Is this the lead\?/); assert.match(u.text(), /#77 Cafe Lake/); assert.match(u.text(), /same phone/)
    assert.ok(u.button('Not this one'))
    assert.deepEqual(sb.writes(), [])
    u.click(u.button('Link this lead')); await u.settle(); await u.settle()
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_link_lead')!.args, { p_id: 'q1', p_lead: 'lead-9' })
    assert.equal(changed, 1)
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
  })
  test('Unlink sends null; somebody who may only read the quotation sees no link or unlink button', async () => {
    const sb = fake(info()); const u = ui(sb, quote('sent')); await u.settle(); await u.settle()
    u.click(u.button('Unlink')); await u.settle(); await u.settle()
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_link_lead')!.args, { p_id: 'q1', p_lead: null })
    u.unmount()
    const ro = ui(fake(info()), quote('sent', { may_edit: false })); await ro.settle(); await ro.settle()
    assert.ok(!ro.all('button').some(b => /Unlink|Link/.test(b.textContent ?? '')))
  })
})
