/**
 * The Old Order destination of a Payment Request (20270607000000): the shared
 * vocabulary, the typed-field rules, the read-back of a pending old-order intent
 * and the way a payment for an old order is named on a list.
 *
 * Run: npm run test:file -- src/lib/finance/paymentRequestOldOrder.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OLD_ORDER_DESTINATION_OPTION,
  PAYMENT_DESTINATIONS,
  PAYMENT_DESTINATION_OPTIONS,
  REQUEST_DESTINATION_LABEL,
  REQUEST_DESTINATION_OPTIONS,
  destinationNeedsTarget,
  destinationTargetKind,
} from './paymentEntry'
import { isLegacyRequestComplete, legacyRequestProblems } from './legacyOrderAllocation'
import {
  isPaymentEntryComplete,
  switchDestination,
  EMPTY_PAYMENT_ENTRY,
} from '@/app/finance/components/PaymentEntryFields'
import { loadPaymentIntent, intentDestinationLabel, intentReferenceLabel } from '@/app/finance/paymentIntents'
import {
  loadPaymentDestinations,
  orderNumberDisplay,
  paymentAgainstDisplay,
  paymentDisplayState,
} from './paymentDestination'

describe('the vocabulary', () => {
  test('Old Order is a fourth card on the Request forms; the three both forms share are unchanged', () => {
    assert.deepEqual([...PAYMENT_DESTINATIONS], ['pi_draft', 'confirmed_order', 'suspense'])
    assert.deepEqual(PAYMENT_DESTINATION_OPTIONS.map(o => o.value), ['pi_draft', 'confirmed_order', 'suspense'])
    assert.deepEqual(REQUEST_DESTINATION_OPTIONS.map(o => o.value), ['pi_draft', 'confirmed_order', 'suspense', 'old_order'])
    assert.equal(OLD_ORDER_DESTINATION_OPTION.label, 'Old Order')
    assert.equal(REQUEST_DESTINATION_LABEL.old_order, 'Old Order')
  })

  test('an old order needs no record to be chosen', () => {
    assert.equal(destinationNeedsTarget('old_order'), false)
    assert.equal(destinationTargetKind('old_order'), null)
    assert.equal(destinationNeedsTarget('pi_draft'), true)
    assert.equal(destinationNeedsTarget('confirmed_order'), true)
    assert.equal(destinationNeedsTarget('suspense'), false)
  })
})

describe('the two typed fields', () => {
  test('both are required, each named', () => {
    assert.deepEqual(legacyRequestProblems(undefined), {
      orderNo: 'Enter the old order number.',
      clientName: 'Enter the client the old order belongs to.',
    })
    assert.deepEqual(legacyRequestProblems({ orderNo: '  ', clientName: 'X' }).clientName, null)
    assert.equal(legacyRequestProblems({ orderNo: 'A', clientName: ' ' }).orderNo, null)
    assert.equal(isLegacyRequestComplete({ orderNo: ' ab-12 ', clientName: ' Mehta   Furnishings ' }), true)
    assert.equal(isLegacyRequestComplete({ orderNo: 'AB-12', clientName: '' }), false)
  })

  test('the database limits are the form limits', () => {
    assert.equal(legacyRequestProblems({ orderNo: '9'.repeat(60), clientName: 'n'.repeat(120) }).orderNo, null)
    assert.match(legacyRequestProblems({ orderNo: '9'.repeat(61), clientName: 'X' }).orderNo ?? '', /at most 60/)
    assert.match(legacyRequestProblems({ orderNo: 'A', clientName: 'n'.repeat(121) }).clientName ?? '', /at most 120/)
  })

  test('an Old Order entry is complete only when both fields are, and keeps what was typed when the card changes', () => {
    const typed = { ...EMPTY_PAYMENT_ENTRY, destination: 'old_order' as const, legacy: { orderNo: 'AB-12', clientName: 'Mehta' } }
    assert.equal(isPaymentEntryComplete({ destination: 'old_order', target: null }), false)
    assert.equal(isPaymentEntryComplete(typed), true)
    assert.equal(isPaymentEntryComplete({ ...typed, legacy: { orderNo: 'AB-12', clientName: '' } }), false)
    const away = switchDestination(typed, 'suspense')
    assert.equal(away.destination, 'suspense')
    assert.equal(away.target, null)
    assert.deepEqual(away.legacy, { orderNo: 'AB-12', clientName: 'Mehta' })
    // The other destinations are judged exactly as before.
    assert.equal(isPaymentEntryComplete({ destination: 'suspense', target: null }), true)
    assert.equal(isPaymentEntryComplete({ destination: 'pi_draft', target: null }), false)
  })
})

// ── A fake client whose tables answer from rows ─────────────────────────────

type Rows = Record<string, unknown[]>

function fakeSupabase(rows: Rows, opts: { failTables?: string[] } = {}) {
  const queried: { table: string; filters: Record<string, unknown> }[] = []
  const client = {
    from: (table: string) => {
      const q = { table, filters: {} as Record<string, unknown> }
      queried.push(q)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'limit']) chain[m] = () => chain
      chain.in = (col: string, v: unknown) => { q.filters[`in:${col}`] = v; return chain }
      chain.eq = (col: string, v: unknown) => { q.filters[`eq:${col}`] = v; return chain }
      chain.not = (col: string, op: string, v: unknown) => { q.filters[`not:${col}`] = [op, v]; return chain }
      chain.maybeSingle = async () => ({ data: null, error: null })
      chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        if (opts.failTables?.includes(table)) return reject(new Error(`${table} unreadable`))
        resolve({ data: rows[table] ?? [], error: null })
      }
      return chain
    },
    rpc: async () => ({ data: [], error: null }),
  }
  return { client: client as never, queried }
}

const viewRow = (id: string, kind = 'suspense') => ({
  payment_request_id: id, destination_source: 'none', destination_kind: kind,
  destination_order_count: 0, destination_submission_count: 0, destination_customer_count: 0,
  destination_order_id: null, destination_order_number: null, destination_submission_id: null,
  destination_reference: null,
})

describe('naming a payment whose only destination is an old order', () => {
  test('active legacy allocations first, pending legacy intents second, Suspense otherwise', async () => {
    const { client } = fakeSupabase({
      finance_payment_destinations: [viewRow('A'), viewRow('B'), viewRow('C'), viewRow('D', 'pi_draft')],
      finance_payment_allocations: [{ payment_request_id: 'A', legacy_order_no: 'AB-12' }],
      finance_payment_allocation_intents: [
        { payment_request_id: 'B', legacy_order_no: 'X-9' },
        { payment_request_id: 'E', legacy_order_no: 'NOT-ASKED' },
      ],
    })
    const map = await loadPaymentDestinations(client, ['A', 'B', 'C', 'D'])

    const a = map.get('A')!
    assert.equal(a.kind, 'old_order')
    assert.equal(a.source, 'allocation')
    assert.equal(a.reference, 'AB-12')
    assert.equal(paymentAgainstDisplay(a), 'Old order AB-12')
    assert.equal(paymentDisplayState('approved_unlinked', a), 'received', 'the money is attached, so it is not "not allocated"')
    assert.deepEqual(orderNumberDisplay(a), { value: 'Old order — not in the system', muted: true })

    const b = map.get('B')!
    assert.equal(b.kind, 'old_order')
    assert.equal(b.source, 'intent')
    assert.equal(paymentAgainstDisplay(b), 'Old order X-9')
    assert.equal(paymentDisplayState('pending_approval', b), 'pending')

    assert.equal(map.get('C')!.kind, 'suspense', 'nothing found: still Suspense')
    assert.equal(map.get('D')!.kind, 'pi_draft', 'a payment the projection names is left alone')
  })

  test('only the payments the projection calls Suspense are looked up, and only for legacy rows', async () => {
    const { client, queried } = fakeSupabase({
      finance_payment_destinations: [viewRow('A'), viewRow('D', 'pi_draft')],
    })
    await loadPaymentDestinations(client, ['A', 'D'])
    const lookups = queried.filter(q => q.table === 'finance_payment_allocations' || q.table === 'finance_payment_allocation_intents')
    assert.equal(lookups.length, 2, 'one batched read of each table, never one per payment')
    for (const q of lookups) {
      assert.deepEqual(q.filters['in:payment_request_id'], ['A'])
      assert.deepEqual(q.filters['not:legacy_order_no'], ['is', null])
    }
    assert.equal(lookups.find(q => q.table === 'finance_payment_allocations')!.filters['eq:status'], 'active')
    assert.equal(lookups.find(q => q.table === 'finance_payment_allocation_intents')!.filters['eq:status'], 'pending')
  })

  test('nothing is read when the projection names every payment', async () => {
    const { client, queried } = fakeSupabase({ finance_payment_destinations: [viewRow('D', 'pi_draft')] })
    await loadPaymentDestinations(client, ['D'])
    assert.equal(queried.some(q => q.table === 'finance_payment_allocations'), false)
  })

  test('several old orders are counted, not sampled', async () => {
    const { client } = fakeSupabase({
      finance_payment_destinations: [viewRow('A')],
      finance_payment_allocations: [
        { payment_request_id: 'A', legacy_order_no: 'AB-12' },
        { payment_request_id: 'A', legacy_order_no: 'CD-34' },
      ],
    })
    const a = (await loadPaymentDestinations(client, ['A'])).get('A')!
    assert.equal(a.reference, '2 old orders')
  })

  test('a failed read changes nothing: the row keeps reading Suspense', async () => {
    const { client } = fakeSupabase(
      { finance_payment_destinations: [viewRow('A')] },
      { failTables: ['finance_payment_allocations'] },
    )
    const a = (await loadPaymentDestinations(client, ['A'])).get('A')!
    assert.equal(a.kind, 'suspense')
  })
})

describe('reading a request back', () => {
  const live = {
    id: 'i2', target_type: 'legacy_order', order_submission_id: null, order_id: null,
    legacy_order_no: 'AB-12', legacy_client_name: 'Mehta', intended_amount: 5000, status: 'pending',
  }
  const dead = {
    id: 'i1', target_type: 'pi_draft', order_submission_id: 'pi-1', order_id: null,
    legacy_order_no: null, legacy_client_name: null, intended_amount: 5000, status: 'cancelled',
  }

  test('the live intent wins over a cancelled one, wherever it sits', async () => {
    for (const rows of [[dead, live], [live, dead]]) {
      const { client } = fakeSupabase({ finance_payment_allocation_intents: rows })
      const found = await loadPaymentIntent(client, 'pay-1')
      assert.equal(found?.id, 'i2')
      assert.equal(found?.targetType, 'old_order')
      assert.equal(found?.legacyOrderNo, 'AB-12')
      assert.equal(found?.legacyClientName, 'Mehta')
      assert.equal(found?.targetId, '')
      assert.equal(intentDestinationLabel(found), 'Old Order')
      assert.equal(intentReferenceLabel(found), 'AB-12')
    }
  })

  test('with nothing live, the newest row is still shown (a rejection keeps its intent)', async () => {
    const { client } = fakeSupabase({ finance_payment_allocation_intents: [dead] })
    const found = await loadPaymentIntent(client, 'pay-1')
    assert.equal(found?.status, 'cancelled')
    assert.equal(found?.targetType, 'pi_draft')
  })

  test('no intent is Suspense', async () => {
    const { client } = fakeSupabase({})
    assert.equal(await loadPaymentIntent(client, 'pay-1'), null)
    assert.equal(intentDestinationLabel(null), 'Suspense Entry')
  })
})
