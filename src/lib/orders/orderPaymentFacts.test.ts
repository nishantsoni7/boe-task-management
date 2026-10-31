import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { orderPaymentFacts } from './orderPaymentFacts'
import type { AdvanceReadiness } from './advanceReadiness'

const money = (v: string | number | null) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const advance = (over: Partial<AdvanceReadiness> = {}): AdvanceReadiness => ({
  order_value: 1070000, advance_base: 907000, value_known: true, verified: 400000, awaiting: 0,
  required: 362800, shortfall: null, percent: 44.1, threshold_percent: 40, below: false, ready: true, exception: null, ...over,
})
const facts = (over: Partial<Parameters<typeof orderPaymentFacts>[0]> = {}) =>
  orderPaymentFacts({ orderValue: '1070260.00', advance: advance(), formatMoney: money, ...over })
const byKey = (list: ReturnType<typeof facts>, key: string) => list.find(f => f.key === key)

describe('the Payment card facts', () => {
  test('order value, then the advance requirement, and nothing else (owner, 2026-10-31)', () => {
    const list = facts()
    assert.deepEqual(list.map(f => f.key), ['order_value', 'advance'])
    assert.equal(byKey(list, 'order_value')?.value, '₹10,70,260.00')
    assert.deepEqual(list.map(f => f.label), ['Order value (incl. GST)', 'Advance (40% of Total before GST)'])
  })

  test('the advance says met, short or approved below — in words, with the figure', () => {
    assert.equal(byKey(facts(), 'advance')?.value, '₹3,62,800.00')
    assert.equal(byKey(facts(), 'advance')?.detail, 'Requirement met')
    assert.equal(byKey(facts(), 'advance')?.tone, 'green')
    const short = byKey(facts({ advance: advance({ below: true, ready: false, shortfall: 62800 }) }), 'advance')
    assert.equal(short?.detail, '₹62,800.00 short of the requirement')
    assert.equal(short?.tone, 'amber')
    const excepted = byKey(facts({ advance: advance({ below: true, exception: { source: 'order', approved_by: 'a', approved_at: null } }) }), 'advance')
    assert.equal(excepted?.detail, 'Approved below the requirement by an administrator')
  })

  test('a fact with nothing to say is left out, not drawn as a dash', () => {
    const none = facts({ orderValue: null, advance: null })
    assert.deepEqual(none, [])
    const unknown = facts({ advance: advance({ required: null, value_known: false }) })
    assert.equal(byKey(unknown, 'advance'), undefined)
  })
})
