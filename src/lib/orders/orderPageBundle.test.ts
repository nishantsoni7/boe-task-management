// THE ORDER PAGE'S ONE READ: THE ADAPTER (20270406000000).
//
// order_page_bundle() answers the whole page as one jsonb document. adaptOrderBundle() turns it into the
// same { data, error } shapes the page's separate reads produce, so the page's mapping code runs unchanged on
// either; fetchOrderBundle() decides whether to use it at all. These pin the parts that must never drift:
// a refused part reads as an error and never as an empty list, an Order the reader cannot see reads as "no
// row", anything unexpected means "read the old way", and a database without the function is only asked once.
//
// Run with: npx tsx --test "src/lib/orders/orderPageBundle.test.ts"

import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ORDER_BUNDLE_PARTS,
  adaptOrderBundle,
  fetchOrderBundle,
  isBundleFunctionMissing,
  partToRead,
  resetOrderBundleMemory,
} from './orderPageBundle'

const ok = (data: unknown) => ({ ok: true, data })
const failed = (code: string) => ({ ok: false, code })

function bundle(over: Record<string, unknown> = {}) {
  return {
    found: true,
    order: { id: 'o1', display_number: '0538', requested_by_user: { full_name: 'Asha' }, total_before_gst: 100 },
    advance: ok({ ready: true }),
    submission: ok({ id: 's1', grand_total: 118 }),
    items: ok([{ id: 'i1', sort_order: 0 }]),
    images: ok([]),
    codes: ok([{ submission_item_id: 'i1', boe_sequence: 1 }]),
    versions: ok([{ id: 'v1', version_number: 1 }]),
    trail: ok([]),
    handoffs: ok([]),
    commission: ok(null),
    commission_readable: ok(false),
    payments: ok([{ id: 'p1', amount: 50 }]),
    allocations: ok([]),
    active_totals: ok([{ payment_request_id: 'p1', active_total: '50.00' }]),
    activity: ok([{ id: 'a1' }]),
    approvals: ok([{ id: 'e1', approval_kind: 'fabric' }]),
    change_requests: ok([{ id: 'c1' }]),
    people: ok([{ id: 'u1', full_name: 'Asha', is_active: true }]),
    ...over,
  }
}

describe('adaptOrderBundle', () => {
  test('a well-formed answer becomes the reads the page already maps', () => {
    const r = adaptOrderBundle(bundle())
    assert.ok(r)
    if (!r) return
    assert.deepEqual(r.orderRow, { data: bundle().order, error: null })
    assert.deepEqual(r.pi.items, { data: [{ id: 'i1', sort_order: 0 }], error: null })
    assert.deepEqual(r.payments.data, [{ id: 'p1', amount: 50 }])
    assert.deepEqual(r.approvals.data, [{ id: 'e1', approval_kind: 'fabric' }], 'approvals are approvals')
    assert.deepEqual(r.changeRequests.data, [{ id: 'c1' }], 'change requests are change requests')
    assert.deepEqual(r.activeTotals, [{ payment_request_id: 'p1', active_total: '50.00' }])
    assert.deepEqual(r.advance, { ready: true })
    assert.equal(r.pi.commissionReadable.data, false)
  })

  test('an Order the reader cannot see reads as "no row", with nothing else invented', () => {
    const r = adaptOrderBundle({ found: false })
    assert.ok(r)
    if (!r) return
    assert.deepEqual(r.orderRow, { data: null, error: null })
    assert.deepEqual(r.activeTotals, [])
    assert.equal(r.advance, null)
  })

  test('a part that was refused reads as an ERROR, never as an empty list', () => {
    const r = adaptOrderBundle(bundle({ commission: failed('42501'), payments: failed('42501'), commission_readable: failed('42883') }))
    assert.ok(r)
    if (!r) return
    assert.equal(r.pi.commission.data, null)
    assert.equal(r.pi.commission.error?.code, '42501')
    assert.equal(r.payments.data, null)
    assert.equal(r.payments.error?.code, '42501')
    assert.equal(r.pi.commissionReadable.error?.code, '42883')
    // the page treats an error as unknown ("Restricted"), which it could not do if this were an empty answer
    assert.notDeepEqual(r.payments.data, [])
  })

  test('failed advance readiness and failed totals fall back to "not known", not to a value', () => {
    const r = adaptOrderBundle(bundle({ advance: failed('42883'), active_totals: failed('42501') }))
    assert.ok(r)
    if (!r) return
    assert.equal(r.advance, null)
    assert.deepEqual(r.activeTotals, [])
  })

  test('anything unexpected means "read the old way" (null)', () => {
    assert.equal(adaptOrderBundle(null), null)
    assert.equal(adaptOrderBundle('nope'), null)
    assert.equal(adaptOrderBundle([]), null)
    assert.equal(adaptOrderBundle({}), null)
    assert.equal(adaptOrderBundle({ found: 'yes' }), null)
    assert.equal(adaptOrderBundle({ ...bundle(), order: null }), null)
    for (const part of ORDER_BUNDLE_PARTS) {
      const incomplete: Record<string, unknown> = bundle()
      delete incomplete[part]
      assert.equal(adaptOrderBundle(incomplete), null, `missing ${part}`)
    }
    assert.equal(adaptOrderBundle(bundle({ items: { ok: 'maybe' } })), null)
  })

  test('partToRead keeps a real null as data and a failure as an error', () => {
    assert.deepEqual(partToRead({ ok: true, data: null }), { data: null, error: null })
    assert.deepEqual(partToRead({ ok: false, code: '57014' })?.error?.code, '57014')
    assert.equal(partToRead({ ok: false })?.error?.code, 'unknown')
    assert.equal(partToRead(undefined), null)
  })
})

describe('isBundleFunctionMissing', () => {
  test('recognises a database that does not have the function, and nothing else', () => {
    assert.equal(isBundleFunctionMissing({ code: 'PGRST202' }), true)
    assert.equal(isBundleFunctionMissing({ code: '42883' }), true)
    assert.equal(isBundleFunctionMissing({ message: 'Could not find the function public.order_page_bundle(p_order_id) in the schema cache' }), true)
    assert.equal(isBundleFunctionMissing({ code: '57014', message: 'canceling statement due to statement timeout' }), false)
    assert.equal(isBundleFunctionMissing({ code: '42501' }), false)
    assert.equal(isBundleFunctionMissing(null), false)
  })
})

describe('fetchOrderBundle', () => {
  beforeEach(() => resetOrderBundleMemory())

  const fake = (answers: Array<{ data?: unknown; error?: { code?: string; message?: string } | null } | 'throw'>) => {
    const calls: unknown[][] = []
    const client = {
      rpc: async (name: string, args: unknown) => {
        calls.push([name, args])
        const a = answers[Math.min(calls.length - 1, answers.length - 1)]
        if (a === 'throw') throw new Error('network')
        return { data: a.data ?? null, error: a.error ?? null }
      },
    } as unknown as SupabaseClient
    return { client, calls }
  }

  test('asks for the Order by id and adapts a good answer', async () => {
    const { client, calls } = fake([{ data: bundle() }])
    const r = await fetchOrderBundle(client, 'o1')
    assert.ok(r)
    assert.deepEqual(calls[0], ['order_page_bundle', { p_order_id: 'o1' }])
  })

  test('a database without the function is asked ONCE for the life of the tab', async () => {
    const { client, calls } = fake([{ error: { code: 'PGRST202', message: 'Could not find the function' } }])
    assert.equal(await fetchOrderBundle(client, 'o1'), null)
    assert.equal(await fetchOrderBundle(client, 'o2'), null)
    assert.equal(calls.length, 1)
  })

  test('any other failure reads the old way this time but is asked again next time', async () => {
    const { client, calls } = fake([{ error: { code: '57014', message: 'timeout' } }, { data: bundle() }])
    assert.equal(await fetchOrderBundle(client, 'o1'), null)
    assert.ok(await fetchOrderBundle(client, 'o1'))
    assert.equal(calls.length, 2)
  })

  test('a thrown error and a malformed answer never escape: they mean "read the old way"', async () => {
    assert.equal(await fetchOrderBundle(fake(['throw']).client, 'o1'), null)
    assert.equal(await fetchOrderBundle(fake([{ data: { found: true } }]).client, 'o1'), null)
  })
})
