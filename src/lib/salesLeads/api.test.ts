/**
 * Sales, Lead Master: the typed wrappers over the database functions, with a stand-in for the Supabase client.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/api.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  allotLead, checkPhone, classifySalesError, createLead, fetchLeadPage, fetchPeople, updateLead, SalesRequestError,
} from './api'

type Reply = { data?: unknown; error?: { message: string; code?: string } | null }

function fake(reply: Reply = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const supabase = {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args: args ?? {} })
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null })
    },
  }
  return { supabase: supabase as unknown as Parameters<typeof fetchLeadPage>[0], calls }
}

describe('what the database says, in words a person can act on', () => {
  const kind = (message: string, code = '') => classifySalesError({ message, code }).kind
  test('each refusal has its own kind', () => {
    assert.equal(kind('SALES_FORBIDDEN', '42501'), 'forbidden')
    assert.equal(kind('permission denied for table x', '42501'), 'forbidden')
    assert.equal(kind('SALES_NOT_FOUND'), 'not_found')
    assert.equal(kind('SALES_CHANGED: Somebody changed who holds this lead.'), 'changed')
    assert.equal(kind('SALES_INVALID: Choose a person from the Sales team.'), 'invalid')
    assert.equal(kind('JWT expired'), 'auth')
    assert.equal(kind('Failed to fetch'), 'uncertain')
    assert.equal(kind('something unexpected'), 'unknown')
  })
  test('the database sentence is shown without its code prefix', () => {
    assert.equal(classifySalesError({ message: 'SALES_INVALID: Enter a valid mobile number' }).message, 'Enter a valid mobile number')
    assert.match(classifySalesError({ message: 'SALES_CHANGED: Somebody changed who holds this lead. The list has been refreshed.' }).message, /^Somebody changed who holds this lead/)
  })
  test('an unknown error never leaks its text', () => {
    assert.doesNotMatch(classifySalesError({ message: 'relation "sales_leads" does not exist' }).message, /relation/)
  })
})

describe('the calls', () => {
  test('the list: nothing chosen means everyone, every source, no search', async () => {
    const { supabase, calls } = fake({ data: { rows: [] } })
    await fetchLeadPage(supabase, { period: 'today', from: '', to: '', holder: '', source: '', q: '', limit: 50, offset: 0 })
    assert.deepEqual(calls, [{
      fn: 'sales_leads_page',
      args: { p_period: 'today', p_holder: 'all', p_source: null, p_q: null, p_limit: 50, p_offset: 0 },
    }])
  })
  test('the list: a person, a source and a search go through as they are', async () => {
    const { supabase, calls } = fake({ data: { rows: [] } })
    await fetchLeadPage(supabase, { period: 'month', from: '', to: '', holder: 'none', source: 'website', q: '98765', limit: 50, offset: 100 })
    assert.deepEqual(calls[0].args, { p_period: 'month', p_holder: 'none', p_source: 'website', p_q: '98765', p_limit: 50, p_offset: 100 })
  })
  test('the list: chosen days are sent, a missing side as nothing; with no days the call is the one every database version knows', async () => {
    const { supabase, calls } = fake({ data: { rows: [] } })
    const base = { period: 'all' as const, holder: '', source: '', q: '', limit: 50, offset: 0 }
    await fetchLeadPage(supabase, { ...base, from: '2026-11-01', to: '2026-11-05' })
    await fetchLeadPage(supabase, { ...base, from: '2026-11-01', to: '' })
    await fetchLeadPage(supabase, { ...base, from: '', to: '2026-11-05' })
    await fetchLeadPage(supabase, { ...base, from: '', to: '' })
    assert.equal(calls[0].args.p_from, '2026-11-01'); assert.equal(calls[0].args.p_to, '2026-11-05')
    assert.equal(calls[1].args.p_from, '2026-11-01'); assert.equal(calls[1].args.p_to, null)
    assert.equal(calls[2].args.p_from, null); assert.equal(calls[2].args.p_to, '2026-11-05')
    assert.ok(!('p_from' in calls[3].args) && !('p_to' in calls[3].args), 'no days: neither argument is sent')
  })
  test('adding a lead sends a blank optional field as nothing', async () => {
    const { supabase, calls } = fake({ data: { status: 'created' } })
    await createLead(supabase, { phone: '+919876543210', source: 'website', name: '', email: '  ', location: 'Jaipur', requirement: '' })
    assert.deepEqual(calls[0], {
      fn: 'create_sales_lead',
      args: { p_phone: '+919876543210', p_source: 'website', p_name: null, p_email: null, p_location: 'Jaipur', p_requirement: null },
    })
  })
  test('editing sends the lead, the whole form and the version it started from', async () => {
    const { supabase, calls } = fake({ data: { status: 'saved' } })
    await updateLead(supabase, 'lead-1', { phone: '+919876543210', source: 'whatsapp', name: 'Rohan', email: '', location: '', requirement: '' }, '2026-11-02T05:50:00.123456+00:00')
    assert.equal(calls[0].fn, 'update_sales_lead')
    assert.equal(calls[0].args.p_id, 'lead-1')
    assert.equal(calls[0].args.p_name, 'Rohan')
    assert.equal(calls[0].args.p_email, null)
    assert.equal(calls[0].args.p_expected_updated_at, '2026-11-02T05:50:00.123456+00:00', 'the microseconds go back untouched')
  })
  test('allotting says who the screen saw holding the lead, so a stale change is refused', async () => {
    const first = fake({ data: { status: 'saved' } })
    await allotLead(first.supabase, 'lead-1', 'mohit', null)
    assert.deepEqual(first.calls[0], { fn: 'allot_sales_lead', args: { p_id: 'lead-1', p_to: 'mohit', p_expected_from: null } })
    const change = fake({ data: { status: 'saved' } })
    await allotLead(change.supabase, 'lead-1', 'dhruv', 'mohit')
    assert.equal(change.calls[0].args.p_expected_from, 'mohit')
  })
  test('the live check sends the number as typed; the database normalises it', async () => {
    const { supabase, calls } = fake({ data: { state: 'free', phone: '+919876543210' } })
    const r = await checkPhone(supabase, '098765 43210')
    assert.equal(r.state, 'free')
    assert.deepEqual(calls[0], { fn: 'sales_lead_phone_check', args: { p_phone: '098765 43210' } })
  })
  test('the people to choose from are everybody with a Sales job, by name', async () => {
    const { supabase, calls } = fake({ data: [
      { id: 'b', full_name: 'Saksham' }, { id: 'a', full_name: 'Ashok' }, { id: 'c', full_name: 'Munmun' },
    ] })
    const people = await fetchPeople(supabase)
    assert.equal(calls[0].fn, 'list_sales_lead_holders')
    assert.deepEqual(people.map(p => p.full_name), ['Ashok', 'Munmun', 'Saksham'])
  })
  test('a refusal becomes a SalesRequestError of the right kind', async () => {
    const { supabase } = fake({ error: { message: 'SALES_CHANGED: Somebody changed who holds this lead.' } })
    await assert.rejects(() => allotLead(supabase, 'lead-1', 'dhruv', null), (e: unknown) => e instanceof SalesRequestError && e.kind === 'changed')
  })
})
