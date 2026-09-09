/**
 * NO SNAKE_CASE EVER REACHES A READER.
 *
 * The Finance activity trail is written for the database. A manager opening a
 * received payment was shown its raw event names — `allocation_moved`,
 * `allocation_created` — in the one place the record exists to explain itself.
 * Those two were not translated at all: the timeline's switch had no case for
 * them and its default printed `row.event_type` verbatim.
 *
 * THE FIX IS PRESENTATION ONLY, and these assertions pin exactly that. Every
 * test here reads an event and checks the SENTENCE. Nothing in this module can
 * add, remove, reorder or re-time an audit row, and no test here asserts that
 * it does.
 *
 * THE PAYLOADS ARE THE REAL ONES, taken from
 * log_finance_payment_allocation_activity (20260921000000): allocation events
 * carry `target_type`, `target_id`, `allocated_amount` and — on a move —
 * `moved_from_order_submission_id` and `moved_to_order_id`. They carry NO
 * display number, which is why a resolver exists and why its absence must
 * still produce English.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentActivityLabels.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  humanizeEventType,
  paymentActivityLabel,
  type ActivityTargetResolver,
  type PaymentActivityRow,
} from './paymentActivityLabels'

const ORDER_ID      = '11111111-1111-4111-8111-111111111111'
const OTHER_ORDER   = '22222222-2222-4222-8222-222222222222'
const SUBMISSION_ID = '33333333-3333-4333-8333-333333333333'

/** What a modal that has loaded the payment's allocations can name. */
const resolve: ActivityTargetResolver = (kind, id) => {
  if (kind === 'order' && id === ORDER_ID) return '0524'
  if (kind === 'order' && id === OTHER_ORDER) return '0529'
  if (kind === 'submission' && id === SUBMISSION_ID) return '019'
  return null
}

function row(event_type: string, payload: Record<string, unknown> = {}): PaymentActivityRow {
  return { event_type, payload }
}

describe('the two events that used to print their own column value', () => {
  test('allocation_created says where the money went', () => {
    const label = paymentActivityLabel(
      row('allocation_created', {
        target_type: 'confirmed_order', target_id: ORDER_ID, allocated_amount: '750000',
      }),
      resolve,
    )
    assert.equal(label, 'Payment allocated to Order 0524')
  })

  test('allocation_moved names both ends when the payload has both', () => {
    // The PI-to-Order conversion: one allocation, unchanged in amount, leaving
    // the PI it was recorded against for the Order that PI became.
    const label = paymentActivityLabel(
      row('allocation_moved', {
        target_type: 'confirmed_order',
        target_id: ORDER_ID,
        moved_from_order_submission_id: SUBMISSION_ID,
        moved_to_order_id: ORDER_ID,
      }),
      resolve,
    )
    assert.equal(label, 'Payment allocation moved from PI Draft 019 to Order 0524')
  })

  test('allocation_moved still reads as a sentence when the source cannot be named', () => {
    // The submission is not in the live allocation summary — the allocation
    // left it — so a modal often cannot name it. That is the common case, and
    // it must not produce "moved from undefined".
    const label = paymentActivityLabel(
      row('allocation_moved', {
        target_type: 'confirmed_order',
        target_id: ORDER_ID,
        moved_from_order_submission_id: 'unknown-submission',
        moved_to_order_id: ORDER_ID,
      }),
      resolve,
    )
    assert.equal(label, 'Payment allocation moved to Order 0524')
  })

  test('a PI allocation is called a PI Draft, not an order_submission', () => {
    assert.equal(
      paymentActivityLabel(
        row('allocation_created', { target_type: 'order_submission', target_id: SUBMISSION_ID }),
        resolve),
      'Payment allocated to PI Draft 019')
  })

  test('a reversal is named for what was withdrawn', () => {
    assert.equal(
      paymentActivityLabel(
        row('allocation_reversed', {
          target_type: 'confirmed_order', target_id: OTHER_ORDER, reversal_reason: 'wrong order',
        }),
        resolve),
      'Allocation to Order 0529 reversed')
  })
})

describe('a target that cannot be named is described, never guessed and never a uuid', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['an Order the reader may not open',
      { target_type: 'confirmed_order', target_id: 'not-loaded' },
      'Payment allocated to a Confirmed Order'],
    ['a PI the reader may not open',
      { target_type: 'order_submission', target_id: 'not-loaded' },
      'Payment allocated to a PI Draft'],
    ['a payload with no target id at all',
      { target_type: 'confirmed_order' },
      'Payment allocated to a Confirmed Order'],
  ]

  for (const [name, payload, expected] of cases) {
    test(name, () => {
      const label = paymentActivityLabel(row('allocation_created', payload), resolve)
      assert.equal(label, expected)
      assert.ok(!label.includes('not-loaded'), 'a raw id must never be printed')
      assert.ok(!label.includes('undefined') && !label.includes('null'))
    })
  }

  test('with no resolver at all the sentences are still English', () => {
    // The Payment Requests page passes none. It must not therefore print uuids.
    const label = paymentActivityLabel(
      row('allocation_created', { target_type: 'confirmed_order', target_id: ORDER_ID }))
    assert.equal(label, 'Payment allocated to a Confirmed Order')
  })
})

describe('the decision events are named for the decision', () => {
  test('an approval is an approval, not a status transition', () => {
    for (const to of ['approved_unlinked', 'approved_linked']) {
      assert.equal(paymentActivityLabel(row('status_changed', { to_status: to })),
        'Payment approved')
    }
  })

  test('submission, clarification, rejection and resubmission each read plainly', () => {
    assert.equal(paymentActivityLabel(row('request_submitted')), 'Payment request submitted')
    assert.equal(paymentActivityLabel(row('status_changed', { to_status: 'needs_clarification' })),
      'Clarification requested')
    assert.equal(paymentActivityLabel(row('status_changed', { to_status: 'rejected' })),
      'Payment rejected')
    assert.equal(paymentActivityLabel(row('status_changed', { to_status: 'pending_approval' })),
      'Resubmitted for approval')
  })

  test('an unrecognised transition still names the states it knows in words', () => {
    // The four decisions above are named for what was decided. Anything else
    // falls back to describing the transition — and the known end of it is
    // still written the way the badges write it, never as its column value.
    const label = paymentActivityLabel(
      row('status_changed', { from_status: 'pending_approval', to_status: 'archived' }))
    assert.equal(label, 'Status changed from Pending Review to archived')
    assert.ok(!label.includes('pending_approval'))
  })
})

describe('an event this build has never heard of', () => {
  test('renders, and renders as words', () => {
    // A future migration WILL add an event type. The old default printed it
    // exactly as stored; the row must survive and must still read like English.
    assert.equal(paymentActivityLabel(row('allocation_split_across_orders')),
      'Allocation split across orders')
    assert.equal(humanizeEventType('some-future_event'), 'Some future event')
  })

  test('a malformed row does not throw and does not render blank', () => {
    for (const bad of [
      { event_type: 'weird_thing', payload: null },
      { event_type: '', payload: {} },
    ] as PaymentActivityRow[]) {
      const label = paymentActivityLabel(bad)
      assert.ok(label.length > 0, 'an audit row must never render as nothing')
    }
    assert.equal(paymentActivityLabel({ event_type: '', payload: {} }), 'Activity recorded')
  })
})

describe('renaming is all that happened — the trail itself is untouched', () => {
  const timeline = readFileSync(
    join(process.cwd(), 'src/components/PaymentRequestActivity.tsx'), 'utf8')

  test('every row the query returns is still drawn', () => {
    assert.ok(timeline.includes('rows.map('), 'one entry per audit row')
    assert.ok(!/rows\s*\.\s*filter\(/.test(timeline),
      'nothing may be hidden from an audit trail because it reads awkwardly')
    assert.ok(!/rows\s*\.\s*slice\(/.test(timeline), 'and nothing may be truncated')
  })

  test('the actor and the timestamp of each row are still its own', () => {
    assert.ok(timeline.includes('{actorName(row.actor)} · {fmtDateTime(row.created_at)}'))
    assert.ok(timeline.includes("actor:users!actor_id(full_name)"), 'read with the row')
  })

  test('the query and its ordering are unchanged — newest first', () => {
    assert.ok(timeline.includes("from('finance_payment_request_activity_log')"))
    assert.ok(timeline.includes("order('created_at', { ascending: false })"))
  })

  test('the words come from this module, and from nowhere else', () => {
    assert.ok(timeline.includes('paymentActivityLabel(row, resolveTarget)'),
      'one labeller, so the two Finance surfaces cannot describe a row differently')
    assert.ok(!timeline.includes('{row.event_type}'),
      'a raw event type must never be rendered directly')
  })

  test('a note stored on an event is still shown verbatim', () => {
    assert.ok(timeline.includes("typeof row.payload?.note === 'string' ? row.payload.note : ''"))
  })
})

describe('no label leaks an internal identifier', () => {
  const EVERY_EVENT = [
    'request_submitted', 'target_changed', 'order_linked', 'order_unlinked',
    'order_request_linked', 'order_request_unlinked', 'order_link_changed',
    'status_changed', 'collection_details_updated', 'cash_handover_recorded',
    'allocation_created', 'allocation_reversed', 'allocation_moved',
    'an_event_from_the_future',
  ]

  test('every event type in the CHECK constraint, plus one that is not', () => {
    for (const event of EVERY_EVENT) {
      const label = paymentActivityLabel(
        row(event, { target_type: 'confirmed_order', target_id: ORDER_ID }), resolve)
      assert.ok(label.length > 0, `${event} rendered as nothing`)
      assert.ok(!label.includes('_'), `${event} leaked snake_case: ${label}`)
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(label), `${event} leaked a uuid: ${label}`)
    }
  })
})
