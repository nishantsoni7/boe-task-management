import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { orderPaymentFacts, type PaymentFactRow } from './orderPaymentFacts'
import type { AdvanceReadiness } from './advanceReadiness'

const money = (v: string | number | null) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = (iso: string | null) => `d:${iso}`
const row = (over: Partial<PaymentFactRow> = {}): PaymentFactRow => ({
  status: 'approved_linked', payment_date: '2026-10-19', payment_mode: 'hdfc', exactAllocatedAmount: '250000.00', ...over,
})
const advance = (over: Partial<AdvanceReadiness> = {}): AdvanceReadiness => ({
  order_value: 1070000, advance_base: 907000, value_known: true, verified: 400000, awaiting: 0,
  required: 362800, shortfall: null, percent: 44.1, threshold_percent: 40, below: false, ready: true, exception: null, ...over,
})
const facts = (over: Partial<Parameters<typeof orderPaymentFacts>[0]> = {}) =>
  orderPaymentFacts({ rows: [row()], orderValue: '1070260.00', advance: advance(), formatMoney: money, formatDate: date, ...over })
const byKey = (list: ReturnType<typeof facts>, key: string) => list.find(f => f.key === key)

describe('the Payment card facts', () => {
  test('order value, the advance requirement, the last verified payment and the modes, in that order', () => {
    const list = facts({ rows: [row(), row({ payment_date: '2026-10-23', exactAllocatedAmount: '100000.00' })] })
    assert.deepEqual(list.map(f => f.key), ['order_value', 'advance', 'last_verified', 'modes'])
    assert.equal(byKey(list, 'order_value')?.value, '₹10,70,260.00')
    assert.equal(byKey(list, 'last_verified')?.value, '₹1,00,000.00')
    assert.equal(byKey(list, 'last_verified')?.detail, 'd:2026-10-23 · HDFC PRI')
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

  test('only verified payments count; money awaiting Finance or refused is never in the modes or the last payment', () => {
    const list = facts({ rows: [row({ exactAllocatedAmount: '100000.00' }), row({ status: 'pending_approval', exactAllocatedAmount: '999999.00' }), row({ status: 'rejected', exactAllocatedAmount: '888888.00' })] })
    assert.equal(byKey(list, 'last_verified')?.value, '₹1,00,000.00')
    assert.equal(byKey(list, 'modes')?.value, 'HDFC PRI ₹1,00,000.00')
  })

  test('modes add up per mode, largest first', () => {
    const list = facts({ rows: [row({ payment_mode: 'hdfc', exactAllocatedAmount: '100000.00' }), row({ payment_mode: 'hdfc', exactAllocatedAmount: '50000.50' }), row({ payment_mode: 'pnb', exactAllocatedAmount: '200000.00' })] })
    const value = byKey(list, 'modes')?.value ?? ''
    assert.ok(value.startsWith('PNB ₹2,00,000.00'))
    assert.ok(value.includes('HDFC PRI ₹1,50,000.50'))
  })

  test('a fact with nothing to say is left out, not drawn as a dash', () => {
    const none = facts({ rows: [], orderValue: null, advance: null })
    assert.deepEqual(none, [])
    const unknown = facts({ advance: advance({ required: null, value_known: false }) })
    assert.equal(byKey(unknown, 'advance'), undefined)
    assert.equal(byKey(facts({ rows: [] }), 'last_verified'), undefined)
  })
})
