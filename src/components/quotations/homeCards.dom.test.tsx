// The card on top of the Quotations list (owner, 23 Nov 2026): two tiles and the value each candidate quoted, as ranked bars.
// The real HomeCards in jsdom against a fake quotation_cards.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HomeCards, periodDates } from './HomeCards'
import type { Cards, CardsPerson } from '@/lib/quotations/api'

// next/link (inside AppLink) calls `self.requestIdleCallback`; node has no `self`.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true })

const person = (id: string, name: string, made: number, value: number, sent = made, confirmed = 0): CardsPerson => ({ id, name, made, sent, confirmed, value_made: value, value_confirmed: 0 })
// The database sends them by count, not by value: Rahul made the most, Priya quoted the most.
const PEOPLE = [person('u-rahul', 'Rahul Mehta', 9, 3110500, 8, 2), person('u-priya', 'Priya Sharma', 7, 3845000, 6, 3), person('u-vikram', 'Vikram Singh', 1, 192400)]
const me = (o: Partial<Cards['me']> = {}): Cards['me'] => ({ person: 'u-me', name: 'Nishant', open_count: 3, open_value: 2548300, waiting_senior: 0, made: 0, sent: 0, confirmed: 0, value_made: 0, value_confirmed: 0, ...o })
const owner = (o: Partial<Cards> = {}): Cards => ({
  me: me(), desk: { waiting: 3, oldest_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), answered: 0, avg_hours: null },
  team: { made: 17, sent: 14, confirmed: 5, value_made: 7147900, value_confirmed: 0, top: { id: 'u-rahul', name: 'Rahul Mehta', made: 9 }, people: PEOPLE },
  from: '', to: '', ...o,
})

function fake(answer: (args: Record<string, unknown>) => Cards) {
  const calls: Array<Record<string, unknown>> = []
  return { calls, client: { rpc: async (fn: string, args: Record<string, unknown> = {}) => { calls.push({ fn, ...args }); return { data: answer(args), error: null } } } }
}
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const m of mounted.splice(0)) m.unmount() })
const wrap = (child: ReturnType<typeof createElement>) => createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }, child)
const ready = async (u: { settle: () => Promise<void> }) => { await u.settle(); await u.settle(); await u.settle() }
const open = async (sb: ReturnType<typeof fake>, seen: string[] = []) => {
  const m = mount(wrap(createElement(HomeCards, { supabase: sb.client as never, enabled: true, userId: 'u-me', onSeeTheirs: n => { seen.push(n) } }))); mounted.push(m)
  await ready(m); return m
}
const choose = async (m: Awaited<ReturnType<typeof open>>, value: string) => {
  const sel = m.one<HTMLSelectElement>('select'); const w = sel.ownerDocument.defaultView!
  act(() => { Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!.call(sel, value); sel.dispatchEvent(new w.Event('change', { bubbles: true })) }); await ready(m)
}
const rows = (m: Awaited<ReturnType<typeof open>>) => m.all<HTMLButtonElement>('ul button')

describe('the card on top of the Quotations list', () => {
  test('the owner sees two tiles and the candidates ranked by value, and none of the old cards', async () => {
    const sb = fake(() => owner()); const m = await open(sb)
    assert.match(m.text(), /Waiting for you3oldest \d+ days?/); assert.match(m.text(), /Open quotations3₹25,48,300 before GST/)
    assert.match(m.text(), /Quotation value by candidate/); assert.match(m.text(), /₹71,47,900 · 17 quotations/)
    assert.deepEqual(rows(m).map(b => b.getAttribute('aria-label')), [
      'Priya Sharma: ₹38,45,000 before GST, 7 quotations', 'Rahul Mehta: ₹31,10,500 before GST, 9 quotations', 'Vikram Singh: ₹1,92,400 before GST, 1 quotation'])
    // the longest bar is 1; the others are in proportion on the same scale
    assert.equal(rows(m)[0].style.getPropertyValue('--p'), '1'); assert.equal(Number(rows(m)[2].style.getPropertyValue('--p')).toFixed(3), (192400 / 3845000).toFixed(3))
    assert.ok(!/With a senior|Made,|Conversion|Answered|Most quotations|Team total|Team conversion|Candidate/.test(m.text()))
    assert.equal(m.all('table').length, 0)
    assert.equal(m.one<HTMLSelectElement>('select').value, 'this')
    assert.deepEqual({ from: sb.calls[0].p_from, to: sb.calls[0].p_to }, periodDates('this', Date.now()))
  })

  test('hovering a bar gives the counts; the details are in the bar for a screen reader too', async () => {
    const m = await open(fake(() => owner()))
    const tip = rows(m)[0].querySelector('[aria-hidden="true"]')!
    assert.match(tip.textContent ?? '', /Priya Sharma₹38,45,000 before GST · 7 quotations6 sent · 3 confirmed/)
  })

  test('tapping a candidate shows that person\'s open quotations, keeps the bars, and goes back', async () => {
    const seen: string[] = []
    const sb = fake(a => a.p_person === 'u-priya'
      ? owner({ me: me({ person: 'u-priya', name: 'Priya Sharma', open_count: 2, open_value: 1420000 }), desk: null })
      : owner())
    const m = await open(sb, seen)
    m.click(rows(m)[0]); await ready(m)
    assert.equal(sb.calls.at(-1)!.p_person, 'u-priya')
    assert.match(m.text(), /Open · Priya Sharma2₹14,20,000 before GST/); assert.ok(!/Waiting for you/.test(m.text()))
    assert.equal(rows(m).length, 3); assert.equal(rows(m)[0].getAttribute('aria-pressed'), 'true')
    m.click(m.button('See their quotations')); assert.deepEqual(seen, ['Priya Sharma'])
    m.click(m.button('Back to mine')); await ready(m)
    assert.match(m.text(), /Waiting for you3/); assert.equal(rows(m)[0].getAttribute('aria-pressed'), 'false')
  })

  test('a salesperson without team view gets the tiles only', async () => {
    const m = await open(fake(() => ({ me: me(), desk: null, team: null, from: '', to: '' })))
    assert.match(m.text(), /Open quotations3/); assert.ok(!/Quotation value by candidate|Waiting for you/.test(m.text())); assert.equal(m.all('select').length, 0)
  })

  test('an empty period says so and offers this month', async () => {
    const sb = fake(() => owner({ team: { made: 0, sent: 0, confirmed: 0, value_made: 0, value_confirmed: 0, top: null, people: [] } }))
    const m = await open(sb)
    assert.match(m.text(), /No quotations were made this month\./); assert.ok(!/Show this month/.test(m.text()))
    await choose(m, 'last')
    assert.match(m.text(), /No quotations were made last month\./)
    m.click(m.button('Show this month')); await ready(m)
    assert.equal(m.one<HTMLSelectElement>('select').value, 'this')
  })

  test('with more than five candidates the phone shows five until "Show all"', async () => {
    const many = Array.from({ length: 8 }, (_, i) => person(`u${i}`, `Person ${i + 1}`, 8 - i, (8 - i) * 100000))
    const m = await open(fake(() => owner({ team: { ...owner().team!, people: many } })))
    const late = () => m.all('li').filter(li => li.className.includes('barLate')).length
    assert.equal(rows(m).length, 8); assert.equal(late(), 3)
    m.click(m.button('Show all 8')); assert.equal(late(), 0)
    m.click(m.button('Show fewer')); assert.equal(late(), 3)
  })

  test('on a phone the bars are folded until the heading is tapped; the total stays in view', async () => {
    const w = window as unknown as { matchMedia?: unknown }
    w.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      const m = await open(fake(() => owner()))
      const head = m.button(/Quotation value by candidate/)
      assert.equal(head.getAttribute('aria-expanded'), 'false'); assert.equal(rows(m).length, 0); assert.equal(m.all('select').length, 0)
      assert.match(m.text(), /₹71,47,900 · 17 quotations/)
      m.click(head); await ready(m)
      assert.equal(head.getAttribute('aria-expanded'), 'true'); assert.equal(rows(m).length, 3); assert.equal(m.all('select').length, 1)
      m.click(head); await ready(m)
      assert.equal(rows(m).length, 0)
    } finally { delete w.matchMedia }
  })
})
