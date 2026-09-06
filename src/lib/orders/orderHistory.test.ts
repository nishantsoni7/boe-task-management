/**
 * The Confirmed Order's merged chronology (20261116000000).
 *
 * Two trails, one list, newest first; nothing copied between tables. Pure.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderHistory.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ORDER_EVENT_LABEL, describeOrderEvent, mergeOrderHistory } from './orderHistory'
import type { PersistedActivity } from './submissionActivity'

const RAVI = '11111111-1111-4111-8111-111111111111'
const names = new Map([[RAVI, 'Ravi Menon']])
const when = (iso: string | null) => (iso ? `@${iso}` : '—')

const pi = (over: Partial<PersistedActivity>): PersistedActivity => ({
  id: over.id ?? 'p1', action: 'submitted', actor_id: RAVI, note: null,
  created_at: '2026-09-01T09:00:00Z', metadata: null, ...over,
})

describe('one chronology from two trails', () => {
  test('PI events and Order events interleave newest first, and say which record wrote them', () => {
    const merged = mergeOrderHistory({
      orderRows: [
        { id: 'o1', event_type: 'order_created_from_pi_submission', payload: {}, created_at: '2026-09-02T10:00:00Z', actor_name: 'Priya' },
        { id: 'o2', event_type: 'production_alignment_changed', payload: { from: 'not_aligned', to: 'aligned', note: 'costing agreed' }, created_at: '2026-09-03T10:00:00Z' },
      ],
      orderLabel: t => (t === 'order_created_from_pi_submission' ? 'Order created from PI submission' : null),
      orderDetail: () => null,
      piRows: [
        pi({ id: 'p1', action: 'submitted', created_at: '2026-09-01T09:00:00Z' }),
        pi({ id: 'p2', action: 'pi_approved', created_at: '2026-09-02T09:30:00Z' }),
        pi({ id: 'p3', action: 'payment_verified', created_at: '2026-09-02T09:00:00Z',
             metadata: { allocated_amount: 40000, human_payment_id: 'PAY-0007' } }),
      ],
      namesById: names,
      formatWhen: when,
    })
    assert.deepEqual(merged.map(e => e.key), ['order:o2', 'order:o1', 'pi:p2', 'pi:p3', 'pi:p1'])
    assert.deepEqual(merged.map(e => e.source), ['order', 'order', 'pi', 'pi', 'pi'])
    assert.equal(merged[0].label, ORDER_EVENT_LABEL.production_alignment_changed)
    assert.equal(merged[0].detail, 'Not Aligned → Aligned · costing agreed')
    assert.equal(merged[1].label, 'Order created from PI submission', 'the page\'s own words win for its own events')
    assert.equal(merged[2].label, 'PI approved')
    assert.equal(merged[3].label, 'Payment verified by Finance')
    assert.equal(merged[3].detail, 'PAY-0007 · ₹40,000', 'the payment id and the share, from two named keys')
    assert.equal(merged[3].actor, 'Ravi Menon')
  })

  test('a PI action this build cannot name is dropped, not printed raw', () => {
    const merged = mergeOrderHistory({
      orderRows: [], orderLabel: () => null, orderDetail: () => null,
      piRows: [pi({ action: 'not_a_real_action' })], namesById: names, formatWhen: when,
    })
    assert.deepEqual(merged, [])
  })

  test('the revision events read as sentences with the version number', () => {
    assert.equal(describeOrderEvent({ id: 'x', event_type: 'pi_revision_proposed', created_at: '', payload: { version_number: 2, reason: 'client changed line 3' } }),
      'PI V2 · client changed line 3')
    assert.equal(describeOrderEvent({ id: 'x', event_type: 'pi_revision_approved', created_at: '', payload: { version_number: 2, superseded_version_number: 1 } }),
      'PI V2 is now current · PI V1 superseded')
    assert.equal(describeOrderEvent({ id: 'x', event_type: 'pi_revision_rejected', created_at: '', payload: { version_number: 2, reason: 'wrong quantity' } }),
      'PI V2 · wrong quantity')
  })

  test('two events written in the same instant keep a stable order', () => {
    const rows = [
      { id: 'a', event_type: 'note_added', payload: {}, created_at: '2026-09-01T09:00:00Z' },
      { id: 'b', event_type: 'note_added', payload: {}, created_at: '2026-09-01T09:00:00Z' },
    ]
    const first = mergeOrderHistory({ orderRows: rows, orderLabel: () => null, orderDetail: () => null, piRows: [], namesById: names, formatWhen: when })
    const second = mergeOrderHistory({ orderRows: [...rows].reverse(), orderLabel: () => null, orderDetail: () => null, piRows: [], namesById: names, formatWhen: when })
    assert.deepEqual(first.map(e => e.key), second.map(e => e.key))
  })
})
