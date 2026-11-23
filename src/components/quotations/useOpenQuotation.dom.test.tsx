// A row that opens a quotation (23 Nov 2026, page speed): the real hook in jsdom with a fake router and a fake database.
// One press navigates once, however many times it is pressed; the row says it is opening at once; the app's wait mark
// is on while the page is on its way and off when the screen goes away.
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { NAV_PENDING_ATTRIBUTE } from '@/lib/navigation/navWait'
import { useOpenQuotation } from './useOpenQuotation'

const rpcCalls: string[] = []
const SB = { rpc: async (fn: string, args: Record<string, unknown> = {}) => { rpcCalls.push(args.p_id ? `${fn}:${String(args.p_id)}` : fn); return { data: fn === 'quotation_get' ? { quotation: { id: String(args.p_id), quote_no: 'QT-1', status: 'draft' }, owner_name: null, may_edit: true, areas: [], lines: [], events: [] } : fn === 'quotation_picture_mark_get' ? true : { for_me: false }, error: null } } }

function Rows() {
  const { open, opening } = useOpenQuotation(SB as never)
  return createElement('div', null,
    createElement('button', { onClick: () => open('qa') }, `A${opening === 'qa' ? ' opening' : ''}`),
    createElement('button', { onClick: () => open('qb') }, `B${opening === 'qb' ? ' opening' : ''}`))
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount(); rpcCalls.length = 0 })
function ui() {
  const pushes: string[] = []
  const router = { push: (href: string) => { pushes.push(href) }, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} }
  const m = mount(createElement(AppRouterContext.Provider, { value: router as never },
    createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }, createElement(Rows))))
  mounted.push(m)
  return { m, pushes }
}

describe('useOpenQuotation', () => {
  test('one press goes to the quotation once, however often it is pressed, and no other row can start a second', async () => {
    const { m, pushes } = ui()
    m.click(m.button('A')); m.click(m.button(/^A/)); m.click(m.button(/^B/))
    await m.settle()
    assert.deepEqual(pushes, ['/quotations/qa'])
    assert.equal(rpcCalls.filter(c => c.startsWith('quotation_get')).length, 1, 'the quotation is read once')
  })

  test('the pressed row says it is opening at once; the others do not', () => {
    const { m } = ui()
    m.click(m.button('A'))
    assert.match(m.text(), /A opening/)
    assert.doesNotMatch(m.text(), /B opening/)
  })

  test('the app\'s wait mark is on while the page is on its way and off once the screen is gone', async () => {
    const { m } = ui()
    assert.equal(document.documentElement.hasAttribute(NAV_PENDING_ATTRIBUTE), false)
    m.click(m.button('A')); await m.settle()
    assert.equal(document.documentElement.hasAttribute(NAV_PENDING_ATTRIBUTE), true)
    m.unmount(); mounted.length = 0
    assert.equal(document.documentElement.hasAttribute(NAV_PENDING_ATTRIBUTE), false)
  })

  test('the quotation\'s reads leave with the click, before the page has loaded', async () => {
    const { m } = ui()
    m.click(m.button('B')); await m.settle()
    assert.ok(rpcCalls.includes('quotation_get:qb') && rpcCalls.includes('quotation_picture_mark_get:qb') && rpcCalls.includes('quotation_suggestions_get'))
  })
})
