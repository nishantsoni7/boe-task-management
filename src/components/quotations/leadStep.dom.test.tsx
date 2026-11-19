// Every quotation starts from a Sales lead (owner, 20 Nov 2026): the lead step shows what will be copied, never asks for the client, and
// lets the desk put the quotation on a salesperson's page. Runs the real component in jsdom against a fake database.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LeadStep, type StartChoice } from './LeadStep'

const LEAD = { id: 'lead-1', lead_no: 12406, name: 'Babylon Resort', phone: '+919876543210', email: 'gm@example.invalid', location: 'Hyderabad', requirement: '56 rooms, teak, ready in 12 weeks', assigned_to: 'u-mohit', holder_name: 'Mohit Sharma' }
const NAMELESS = { ...LEAD, id: 'lead-2', lead_no: 12407, name: null, email: null, location: null, requirement: null, assigned_to: null, holder_name: null }

function fake(makers: Array<{ id: string; full_name: string }> = []) {
  const calls: string[] = []
  return {
    calls,
    client: {
      rpc: async (fn: string) => {
        calls.push(fn)
        if (fn === 'sales_leads_page') return { data: { periods: {}, everyone: 2, unallotted: 1, holders: [], total: 2, rows: [LEAD, NAMELESS] }, error: null }
        if (fn === 'quotation_makers') return { data: makers, error: null }
        return { data: null, error: null }
      },
    },
  }
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
function ui(sb: ReturnType<typeof fake>, o: { canAssign?: boolean; askSent?: boolean; onPick?: (c: StartChoice) => Promise<void> } = {}) {
  const picks: StartChoice[] = []
  const m = mount(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) },
    createElement(LeadStep, {
      supabase: sb.client as never, userId: 'u-me', canAssign: o.canAssign ?? false, askSent: o.askSent, title: 'New quotation', action: 'Start quotation',
      onClose: () => {}, onPick: o.onPick ?? (async c => { picks.push(c) }),
    })))
  mounted.push(m)
  return { u: m, picks }
}
const ready = async (u: { settle: () => Promise<void> }) => { await u.settle(); await u.settle(); await u.settle() }

describe('New quotation: choose the lead', () => {
  test('lists the leads the person may see; nothing is typed about the client; Start waits for a lead', async () => {
    const sb = fake(); const { u } = ui(sb); await ready(u)
    assert.match(u.text(), /Babylon Resort/); assert.match(u.text(), /Lead 12407/)
    assert.equal(u.all('input').length, 1, 'only the search box: no client, phone or project fields')
    assert.equal(u.button('Start quotation').disabled, true)
    assert.ok(!sb.calls.includes('quotation_makers'), 'a salesperson does not even ask who it could be put on')
  })
  test('choosing a lead shows what will be copied, and Start hands it on (own page: no owner)', async () => {
    const sb = fake(); const { u, picks } = ui(sb); await ready(u)
    u.click(u.button(/Babylon Resort/)); await u.settle()
    assert.match(u.text(), /Hyderabad/); assert.match(u.text(), /56 rooms, teak/); assert.match(u.text(), /gm@example\.invalid/); assert.match(u.text(), /Mohit Sharma/)
    assert.match(u.text(), /copied into the quotation/)
    u.click(u.button('Start quotation')); await ready(u)
    assert.equal(picks.length, 1); assert.equal(picks[0].lead.id, 'lead-1'); assert.equal(picks[0].ownerId, null); assert.equal(picks[0].alreadySent, false)
  })
  test('a lead with no name is offered as "Lead N"; Change lead goes back to the list', async () => {
    const { u } = ui(fake()); await ready(u)
    u.click(u.button(/Lead 12407/)); await u.settle()
    assert.match(u.text(), /Lead 12407/); assert.match(u.text(), /nobody yet/)
    u.click(u.button('Change lead')); await u.settle()
    assert.match(u.text(), /Babylon Resort/)
  })
  test('the desk may put it on a salesperson\'s page: defaults to the lead\'s holder, and may mark an Excel quotation as already sent', async () => {
    const sb = fake([{ id: 'u-me', full_name: 'Nitish Bansal' }, { id: 'u-mohit', full_name: 'Mohit Sharma' }, { id: 'u-prerna', full_name: 'Prerna Purohit' }])
    const { u, picks } = ui(sb, { canAssign: true, askSent: true }); await ready(u)
    u.click(u.button(/Babylon Resort/)); await ready(u)
    const sel = u.one<HTMLSelectElement>('select')
    assert.equal(sel.value, 'u-mohit'); assert.match(u.text(), /holds the lead/); assert.match(u.text(), /Nitish Bansal \(me\)/)
    u.click(u.one<HTMLInputElement>('input[type="checkbox"]'))
    u.click(u.button('Start quotation')); await ready(u)
    assert.equal(picks[0].ownerId, 'u-mohit'); assert.equal(picks[0].alreadySent, true)
  })
  test('for the desk, a lead nobody holds defaults to the person starting it (no owner is sent)', async () => {
    const sb = fake([{ id: 'u-me', full_name: 'Nitish Bansal' }, { id: 'u-mohit', full_name: 'Mohit Sharma' }])
    const { u, picks } = ui(sb, { canAssign: true }); await ready(u)
    u.click(u.button(/Lead 12407/)); await ready(u)
    u.click(u.button('Start quotation')); await ready(u)
    assert.equal(picks[0].ownerId, null)
  })
  test('a refusal from the database shows its reason and the button works again', async () => {
    const { u } = ui(fake(), { onPick: async () => { throw new Error('Lead 12406 is marked Dead; reopen the lead on the Lead Board before making a quotation') } }); await ready(u)
    u.click(u.button(/Babylon Resort/)); await u.settle()
    u.click(u.button('Start quotation')); await ready(u)
    assert.match(u.text(), /marked Dead/); assert.equal(u.button('Start quotation').disabled, false)
  })
})

describe('the old typed-in start is gone', () => {
  test('the list screen no longer has a client form or createQuotation, and every start goes through quotation_start', () => {
    const list = readFileSync('src/components/quotations/ListScreen.tsx', 'utf8')
    assert.ok(!/createQuotation|NewQuotation|client_name: /.test(list))
    assert.match(list, /startQuotation\(supabase, c\.lead\.id/)
    const api = readFileSync('src/lib/quotations/api.ts', 'utf8')
    assert.ok(!/rpc\('quotation_create'/.test(api)); assert.match(api, /rpc\('quotation_start'/)
    const popup = readFileSync('src/components/salesLeads/LeadQuotes.tsx', 'utf8')
    assert.ok(!/createQuotation|linkLead/.test(popup)); assert.match(popup, /startQuotation\(work\.supabase, lead\.id\)/)
  })
})
