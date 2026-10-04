/**
 * Total Before GST for the payments on one Payment Requests page.
 *
 * The figure is the PI's stored total_before_gst (BOE transcribes it; it does not
 * recompute it — see the header of paymentCommercialTotals.ts). These tests pin
 * which PI each payment resolves to, that the read is batched, and that nothing
 * unresolved is ever shown as zero.
 *
 * Run: npx tsx --test src/lib/finance/paymentCommercialTotals.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { loadPaymentTotals, piIdForDestination, readTotalBeforeGst } from './paymentCommercialTotals'
import type { PaymentDestination } from './paymentDestination'

const dest = (over: Partial<PaymentDestination> & { paymentId: string }): PaymentDestination => ({
  source: 'allocation', kind: 'pi_draft', orderCount: 0, submissionCount: 1, customerCount: 1,
  orderId: null, orderNumber: null, submissionId: null, reference: null, ...over,
})

/** A recording stand-in for the two tables the loader reads. */
function fakeSupabase(tables: {
  orders?: { id: string; source_order_submission_id: string | null }[]
  order_submissions?: { id: string; total_before_gst: string | number | null }[]
}) {
  const calls: { table: string; column: string; ids: string[] }[] = []
  return {
    calls,
    client: {
      from(table: 'orders' | 'order_submissions') {
        return {
          select: () => ({
            in: async (column: string, ids: string[]) => {
              calls.push({ table, column, ids: [...ids] })
              const rows = (tables[table] ?? []).filter(r => ids.includes(r.id))
              return { data: rows, error: null }
            },
          }),
        }
      },
    },
  }
}

// A PI whose parts reconcile: 120,000 product − 10,000 discount + 15,000 fabric
// + 2,500 packing + 5,000 transport = 132,500 before GST. The loader must hand
// back the STORED figure, whichever way the parts happen to be spelled.
const PI_PLAIN = { id: 'pi-plain', total_before_gst: '132500.00' }
// Fabric supplied by the client, but a fabric charge is still recorded and
// still in the total; a discount already inside the stored product figure must
// not be taken off twice.
const PI_CLIENT_FABRIC = { id: 'pi-fabric', total_before_gst: '98250.50' }
const PI_NO_TOTAL = { id: 'pi-blank', total_before_gst: null }

describe('readTotalBeforeGst', () => {
  test('numeric strings from PostgREST and plain numbers both read', () => {
    assert.equal(readTotalBeforeGst('132500.00'), 132500)
    assert.equal(readTotalBeforeGst(98250.5), 98250.5)
    assert.equal(readTotalBeforeGst('0.00'), 0, 'a genuine zero total is a figure, not "unavailable"')
  })
  test('absent or unparseable is null, never 0', () => {
    for (const v of [null, undefined, '', 'abc', NaN, Infinity]) assert.equal(readTotalBeforeGst(v), null)
  })
})

describe('piIdForDestination', () => {
  test('a PI Draft names its own submission', () => {
    assert.equal(piIdForDestination(dest({ paymentId: 'p', submissionId: 'pi-1' }), new Map()), 'pi-1')
  })
  test("a Confirmed Order resolves through the Order's source PI", () => {
    const d = dest({ paymentId: 'p', kind: 'confirmed_order', orderId: 'o-1' })
    assert.equal(piIdForDestination(d, new Map([['o-1', 'pi-9']])), 'pi-9')
    assert.equal(piIdForDestination(d, new Map()), null)
    assert.equal(piIdForDestination(d, new Map([['o-1', null]])), null)
  })
  test('mixed, suspense and missing destinations name no single record', () => {
    assert.equal(piIdForDestination(dest({ paymentId: 'p', kind: 'mixed', submissionId: 'pi-1' }), new Map()), null)
    assert.equal(piIdForDestination(dest({ paymentId: 'p', kind: 'suspense' }), new Map()), null)
    assert.equal(piIdForDestination(null, new Map()), null)
    assert.equal(piIdForDestination(undefined, new Map()), null)
  })
})

describe('loadPaymentTotals', () => {
  test('PI Drafts and Confirmed Orders each resolve to their PI total', async () => {
    const fake = fakeSupabase({
      orders: [{ id: 'o-1', source_order_submission_id: 'pi-fabric' }],
      order_submissions: [PI_PLAIN, PI_CLIENT_FABRIC],
    })
    const destinations = new Map([
      ['pay-draft', dest({ paymentId: 'pay-draft', submissionId: 'pi-plain' })],
      ['pay-order', dest({ paymentId: 'pay-order', kind: 'confirmed_order', orderId: 'o-1' })],
    ])
    const totals = await loadPaymentTotals(fake.client as never, destinations)
    assert.equal(totals.get('pay-draft'), 132500)
    assert.equal(totals.get('pay-order'), 98250.5)
  })

  test("separate requests against one PI get the same total (their own amounts are not this module's)", async () => {
    const fake = fakeSupabase({ order_submissions: [PI_PLAIN] })
    const destinations = new Map([
      ['pay-1', dest({ paymentId: 'pay-1', submissionId: 'pi-plain' })],
      ['pay-2', dest({ paymentId: 'pay-2', submissionId: 'pi-plain' })],
    ])
    const totals = await loadPaymentTotals(fake.client as never, destinations)
    assert.equal(totals.get('pay-1'), 132500)
    assert.equal(totals.get('pay-2'), 132500)
  })

  test('one batched read per table for the whole page — never one per row', async () => {
    const fake = fakeSupabase({
      orders: [{ id: 'o-1', source_order_submission_id: 'pi-fabric' }, { id: 'o-2', source_order_submission_id: 'pi-plain' }],
      order_submissions: [PI_PLAIN, PI_CLIENT_FABRIC],
    })
    const destinations = new Map<string, PaymentDestination>()
    for (let i = 0; i < 25; i++) {
      destinations.set(`pd-${i}`, dest({ paymentId: `pd-${i}`, submissionId: i % 2 ? 'pi-plain' : 'pi-fabric' }))
      destinations.set(`po-${i}`, dest({ paymentId: `po-${i}`, kind: 'confirmed_order', orderId: i % 2 ? 'o-1' : 'o-2' }))
    }
    await loadPaymentTotals(fake.client as never, destinations)
    assert.equal(fake.calls.length, 2, 'orders once, order_submissions once')
    assert.deepEqual(fake.calls.map(c => c.table), ['orders', 'order_submissions'])
    assert.equal(new Set(fake.calls[1].ids).size, fake.calls[1].ids.length, 'ids de-duplicated')
  })

  test('a page of PI Drafts only never touches orders', async () => {
    const fake = fakeSupabase({ order_submissions: [PI_PLAIN] })
    await loadPaymentTotals(fake.client as never, new Map([
      ['p', dest({ paymentId: 'p', submissionId: 'pi-plain' })],
    ]))
    assert.deepEqual(fake.calls.map(c => c.table), ['order_submissions'])
  })

  test('unresolvable payments get an entry of null, so the screen says Unavailable', async () => {
    const fake = fakeSupabase({
      orders: [{ id: 'o-lost', source_order_submission_id: null }],
      order_submissions: [PI_NO_TOTAL],
    })
    const destinations = new Map([
      ['no-total',  dest({ paymentId: 'no-total', submissionId: 'pi-blank' })],
      ['hidden',    dest({ paymentId: 'hidden', submissionId: 'pi-rls-hidden' })],
      ['no-source', dest({ paymentId: 'no-source', kind: 'confirmed_order', orderId: 'o-lost' })],
      ['mixed',     dest({ paymentId: 'mixed', kind: 'mixed' })],
      ['suspense',  dest({ paymentId: 'suspense', kind: 'suspense', submissionCount: 0 })],
    ])
    const totals = await loadPaymentTotals(fake.client as never, destinations)
    for (const id of destinations.keys()) {
      assert.equal(totals.has(id), true, `${id} is settled`)
      assert.equal(totals.get(id), null, `${id} is unavailable, not zero`)
    }
  })

  test('an empty page asks nothing', async () => {
    const fake = fakeSupabase({})
    const totals = await loadPaymentTotals(fake.client as never, new Map())
    assert.equal(totals.size, 0)
    assert.equal(fake.calls.length, 0)
  })
})
