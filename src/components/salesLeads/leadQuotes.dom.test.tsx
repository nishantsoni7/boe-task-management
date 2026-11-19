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
function fake(d: LeadQuotations, refuse: Record<string, string> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown> = {}): Promise<Reply> => {
        calls.push({ fn, args })
        if (fn in refuse) return { data: null, error: { message: refuse[fn] } }
        if (fn === 'quotation_for_lead') return { data: d, error: null }
        if (fn === 'quotation_create') return { data: 'new-q', error: null }
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
  test('nothing is asked while the lead is still being filled in from the list', async () => {
    const sb = fake(data()); const { u } = ui(sb, { filling: true }); await ready(u)
    assert.deepEqual(sb.calls, []); assert.equal(u.text().trim(), '')
  })
})

describe('the lead popup: Make quotation', () => {
  test('creates a quotation from the lead (name, number, source), links it, and opens it', async () => {
    const sb = fake(data({ quotations: [] })); const { u, pushes } = ui(sb); await ready(u)
    assert.deepEqual(sb.calls.map(c => c.fn), ['quotation_for_lead'], 'opening the popup writes nothing')
    u.click(u.button(/Make quotation/)); await ready(u)
    const create = sb.calls.find(c => c.fn === 'quotation_create')!
    assert.deepEqual(create.args, { p_data: { client_name: 'Hotel Aravali', contact_name: 'Hotel Aravali', contact_phone: '+91 98765 43210', source: 'Website' } })
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_link_lead')!.args, { p_id: 'new-q', p_lead: 'lead-1' })
    assert.deepEqual(pushes, ['/quotations/new-q'])
  })
  test('if the link fails the quotation is still opened (its own Lead card offers the same lead by phone)', async () => {
    const sb = fake(data({ quotations: [] }), { quotation_link_lead: 'SALES_FORBIDDEN' }); const { u, pushes } = ui(sb); await ready(u)
    u.click(u.button(/Make quotation/)); await ready(u)
    assert.deepEqual(pushes, ['/quotations/new-q'])
  })
  test('if the quotation cannot be made the reason shows, nothing is linked and nothing opens', async () => {
    const sb = fake(data({ quotations: [] }), { quotation_create: 'QUOTATIONS_FORBIDDEN: you may not start quotations' }); const { u, pushes } = ui(sb); await ready(u)
    u.click(u.button(/Make quotation/)); await ready(u)
    assert.match(u.text(), /you may not start quotations/)
    assert.ok(!sb.calls.some(c => c.fn === 'quotation_link_lead')); assert.deepEqual(pushes, [])
    assert.equal(u.button(/Make quotation/).disabled, false, 'it can be tried again')
  })
})
