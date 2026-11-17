// The salesperson's details on their quotations (owner, 18 Nov 2026: "Ask Sales person to fill in the data once (and keep it
// editable for future usage)"). The real reminder and form in jsdom, with the two database calls answered here.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MyDetailsReminder } from './MyDetails'

function fakeSupabase(saved: boolean) {
  const calls: Array<{ fn: string; args: unknown }> = []
  let card = { saved, name: 'Mohit Sharma', title: '', phone: '+91 90000 00001', email: 'mohit@boe.example' }
  return {
    calls,
    client: {
      rpc: async (fn: string, args?: { p?: typeof card }) => {
        calls.push({ fn, args })
        if (fn === 'quotation_my_card_save' && args?.p) card = { ...args.p, saved: true }
        return { data: card, error: null }
      },
    },
  }
}
const ui = (sb: ReturnType<typeof fakeSupabase>) => mount(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } }) },
  createElement(MyDetailsReminder, { supabase: sb.client as never })))

describe('your details on quotations', () => {
  test('until they are saved, the reminder asks; the form starts from the profile and saves what was typed; then the reminder goes', async () => {
    const sb = fakeSupabase(false)
    const u = ui(sb)
    await u.settle()
    assert.match(u.text(), /Fill them in once/)
    u.click(u.button('Fill in my details'))
    await u.settle()
    const inputs = u.all<HTMLInputElement>('form input')
    assert.deepEqual(inputs.map(i => i.value), ['Mohit Sharma', '', '+91 90000 00001', 'mohit@boe.example'])
    u.type(inputs[1], 'Sales Manager')
    u.click(u.button('Save my details'))
    await u.settle(); await u.settle()
    assert.deepEqual(sb.calls.find(c => c.fn === 'quotation_my_card_save')?.args, { p: { name: 'Mohit Sharma', title: 'Sales Manager', phone: '+91 90000 00001', email: 'mohit@boe.example' } })
    assert.doesNotMatch(u.text(), /Fill them in once|Your details on quotations/)
    u.unmount()
  })
  test('once saved, nothing is shown', async () => {
    const u = ui(fakeSupabase(true))
    await u.settle()
    assert.equal(u.text().trim(), '')
    u.unmount()
  })
})
