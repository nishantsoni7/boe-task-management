// The lead's quotations band in the popup (20270812000000), the real component in jsdom with the database calls answered here.
// Run: npm run test:file -- src/components/salesLeads/leadQuotes.dom.test.tsx
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { LeadQuotation, LeadQuotations } from '@/lib/quotations/api'
import { LeadQuotes } from './LeadQuotes'

// next/link's link observer reads `self`, which the jsdom harness does not define.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') (globalThis as { self?: unknown }).self = globalThis

const LEAD = { id: 'lead-1', lead_no: 1201, name: 'Hotel Aravali', phone: '+919876543210', source: 'website' }
const quote = (n: number, o: Partial<LeadQuotation> = {}): LeadQuotation => ({
  id: `q${n}`, quote_no: `QT-MS-0100${n}`, status: 'sent', updated_at: '2026-11-19T10:00:00Z', owner_name: 'Mohit Sharma', version_no: 2, value: 450000, ...o })
const data = (o: Partial<LeadQuotations> = {}): LeadQuotations => ({ open: true, may_create: true, quotations: [quote(1)], ...o })

type Reply = { data: unknown; error: { message: string } | null }
function fake(d: LeadQuotations, refuse: Record<string, string> = {}, got: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown> = {}): Promise<Reply> => {
        calls.push({ fn, args })
        if (fn in refuse) return { data: null, error: { message: refuse[fn] } }
        if (fn === 'quotation_for_lead') return { data: d, error: null }
        if (fn === 'quotation_start') return { data: 'new-q', error: null }
        if (fn === 'quotation_get') return { data: got, error: null }
        return { data: null, error: null }
      },
    },
  }
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
function ui(sb: ReturnType<typeof fake>, o: { canMake?: boolean; filling?: boolean } = {}) {
  const pushes: string[] = []
  const router = { push: (href: string) => { pushes.push(href) }, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} }
  const m = mount(
    createElement(AppRouterContext.Provider, { value: router as never },
      createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) },
        createElement(LeadQuotes, { lead: LEAD as never, work: { supabase: sb.client } as never, canMake: o.canMake ?? true, filling: o.filling ?? false }))))
  mounted.push(m)
  return { u: m, pushes }
}
const ready = async (u: { settle: () => Promise<void> }) => { await u.settle(); await u.settle() }

describe('the lead popup: its quotations', () => {
  test('one line: the newest quotation (a link, version, status, value) and "+N more"; the rest and who owns them open on a tap', async () => {
    const { u } = ui(fake(data({ quotations: [quote(1), quote(2, { status: 'confirmed', version_no: null, value: 1234567 })] }))); await ready(u)
    assert.match(u.text(), /Quotations/); assert.match(u.text(), /QT-MS-01001/); assert.match(u.text(), /v2 · Sent/); assert.match(u.text(), /₹\s?4\.5 L/)
    assert.ok(!/QT-MS-01002/.test(u.text()), 'only the newest shows at first')
    assert.ok(u.all<HTMLAnchorElement>('a').some(a => a.getAttribute('href') === '/quotations/q1'))
    u.click(u.button('+1 more')); await u.settle()
    assert.match(u.text(), /QT-MS-01002/); assert.match(u.text(), /Confirmed/); assert.match(u.text(), /Mohit Sharma/)
    assert.ok(!/v null|vnull|v0/.test(u.text()), 'a quotation with no version sent shows no "v"')
    u.click(u.button('Show less')); await u.settle()
    assert.ok(!/QT-MS-01002/.test(u.text()))
  })
  test('many quotations: still one line until "+N more" is pressed, then the rest are rows', async () => {
    const { u } = ui(fake(data({ quotations: [1, 2, 3, 4, 5].map(n => quote(n)) }))); await ready(u)
    assert.equal(u.all('li').length, 0)
    u.click(u.button('+4 more')); await u.settle()
    assert.equal(u.all('li').length, 4)
  })
  test('no quotation yet: "none yet" and the "Make quotation" button, on one line', async () => {
    const { u } = ui(fake(data({ quotations: [] }))); await ready(u)
    assert.match(u.text(), /none yet/); assert.ok(u.button(/Make quotation/)); assert.equal(u.all('li').length, 0)
  })
  test('nothing shows when there is nothing to show and nothing to offer, or the person has no Quotations access', async () => {
    const a = ui(fake(data({ quotations: [] })), { canMake: false }); await ready(a.u); assert.equal(a.u.text().trim(), '')
    const b = ui(fake(data({ quotations: [], may_create: false }))); await ready(b.u); assert.equal(b.u.text().trim(), '')
    const c = ui(fake({ open: false, may_create: false, quotations: [] })); await ready(c.u); assert.equal(c.u.text().trim(), '')
  })
  test('a person who cannot make one (lead closed, or no create right) still sees the list, without the button', async () => {
    const a = ui(fake(data()), { canMake: false }); await ready(a.u)
    assert.match(a.u.text(), /QT-MS-01001/); assert.ok(!a.u.all('button').some(b => /Make quotation/.test(b.textContent ?? '')))
    const b = ui(fake(data({ may_create: false }))); await ready(b.u)
    assert.ok(!b.u.all('button').some(x => /Make quotation/.test(x.textContent ?? '')))
  })
  test('while the lead is still being filled in from the list the quotations are already being read (beside the record, not after it), and nothing is drawn yet', async () => {
    const sb = fake(data()); const { u } = ui(sb, { filling: true }); await ready(u)
    assert.deepEqual(sb.calls.map(c => c.fn), ['quotation_for_lead']); assert.equal(u.text().trim(), '')
  })
})

describe('the lead popup: Make quotation', () => {
  test('starts the quotation FROM the lead in one database call (the database copies the details and links it) and opens it', async () => {
    const sb = fake(data({ quotations: [] })); const { u, pushes } = ui(sb); await ready(u)
    assert.deepEqual(sb.calls.map(c => c.fn), ['quotation_for_lead'], 'opening the popup writes nothing')
    u.click(u.button(/Make quotation/)); await ready(u)
    const start = sb.calls.find(c => c.fn === 'quotation_start')!
    assert.deepEqual(start.args, { p_lead: 'lead-1', p_data: {} })
    assert.ok(!sb.calls.some(c => c.fn === 'quotation_create' || c.fn === 'quotation_link_lead'), 'no typed details, no second call to link')
    assert.deepEqual(pushes, ['/quotations/new-q'])
  })
  test('if the quotation cannot be made the reason shows and nothing opens', async () => {
    const sb = fake(data({ quotations: [] }), { quotation_start: 'QUOTATION_LEAD_CLOSED: Lead 7 is marked Dead; reopen the lead on the Lead Board before making a quotation' }); const { u, pushes } = ui(sb); await ready(u)
    u.click(u.button(/Make quotation/)); await ready(u)
    assert.match(u.text(), /marked Dead/)
    assert.deepEqual(pushes, [])
    assert.equal(u.button(/Make quotation/).disabled, false, 'it can be tried again')
  })
})

// The saved quotation as quotation_get returns it: one product with a name, quantity, price and picture (what Orders needs).
const line = (o: Record<string, unknown> = {}) => ({ id: 'l1', area_id: null, name: 'Chair', size_text: '18 × 21', spec: '', material: 'Ash', finish: null,
  qty_per_unit: null, qty_fixed: 10, unit_price: 5000, tax_rate: 18, image_path: 'p/chair.jpg', is_optional: false, client_note: '', ...o })
const got = (o: Record<string, unknown> = {}) => ({ quotation: { id: 'q1', quote_no: 'QT-MS-01001', status: 'sent' }, owner_name: 'Mohit Sharma', may_edit: true,
  areas: [], lines: [line()], events: [], pi: null, ...o })
// The click reads the quotation and loads the PI code on demand: wait for the line to change rather than a fixed number of turns.
async function until(u: { settle: () => Promise<void>; text: () => string }, re: RegExp) { for (let i = 0; i < 40 && !re.test(u.text()); i++) await u.settle() }

describe('the lead popup: Create PI draft (owner, 25 Nov 2026: the PI is made from Lead Management)', () => {
  test('a Draft, Sent or Negotiating quotation offers Create PI draft; a Confirmed one Open the PI draft; a Lost or Archived one nothing', async () => {
    const qs = [quote(1, { status: 'draft' }), quote(2, { status: 'negotiating' }), quote(3, { status: 'confirmed' }), quote(4, { status: 'lost' }), quote(5, { status: 'archived' })]
    const { u } = ui(fake(data({ quotations: qs }))); await ready(u)
    assert.ok(u.button(/Create PI draft/), 'the newest, a Draft')
    u.click(u.button('+4 more')); await u.settle()
    const rows = u.all('li').map(li => li.textContent ?? '')
    assert.match(rows[0], /Create PI draft/); assert.match(rows[1], /Open the PI draft/)
    assert.ok(!/PI draft/.test(rows[2]) && !/PI draft/.test(rows[3]), 'nothing for Lost and Archived')
  })
  test('a quotation that already has its PI opens that PI and changes nothing', async () => {
    const sb = fake(data(), {}, got({ pi: { id: 'sub-9', draft_reference: 'D-9', status: 'draft' } })); const { u, pushes } = ui(sb); await ready(u)
    u.click(u.button(/Create PI draft/))
    for (let i = 0; i < 40 && pushes.length === 0; i++) await u.settle()
    assert.deepEqual(pushes, ['/orders/drafts/sub-9'])
    assert.ok(!sb.calls.some(c => c.fn === 'quotation_set_status'), 'nothing is changed')
  })
  test('what Orders needs is checked first: a product without a picture stops it, the line says so and nothing changes', async () => {
    const sb = fake(data(), {}, got({ lines: [line({ image_path: null })] })); const { u, pushes } = ui(sb); await ready(u)
    u.click(u.button(/Create PI draft/)); await until(u, /Open the quotation to fix it/)
    assert.match(u.text(), /QT-MS-01001: 1 product needs a picture .* before this can become a PI\. Open the quotation to fix it\./)
    assert.deepEqual(pushes, []); assert.ok(!sb.calls.some(c => c.fn === 'quotation_set_status'))
    assert.equal(u.button(/Create PI draft/).disabled, false, 'it can be tried again after the fix')
  })
  test('somebody who may not edit the quotation is told who can, and nothing changes', async () => {
    const sb = fake(data(), {}, got({ may_edit: false })); const { u } = ui(sb); await ready(u)
    u.click(u.button(/Create PI draft/)); await until(u, /Only the owner/)
    assert.match(u.text(), /Only the owner of QT-MS-01001, or someone with Edit and See all, can make its PI draft/)
    assert.ok(!sb.calls.some(c => c.fn === 'quotation_set_status'))
  })
  test('a Confirmed quotation with no PI says so and opens nothing', async () => {
    const sb = fake(data({ quotations: [quote(1, { status: 'confirmed' })] }), {}, got({ quotation: { id: 'q1', quote_no: 'QT-MS-01001', status: 'confirmed' } })); const { u, pushes } = ui(sb); await ready(u)
    u.click(u.button(/Open the PI draft/)); await until(u, /confirmed without a PI/)
    assert.match(u.text(), /QT-MS-01001 was confirmed without a PI/); assert.deepEqual(pushes, [])
  })
})
