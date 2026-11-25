/**
 * The Order page's facts line, in words: the advance cell and the due date's
 * countdown.
 *
 * Nothing here recomputes a figure; these check the WORDS for each state the
 * real builders can hand in.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderBarGates.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { advanceGate, orderBarGates } from './orderBarGates'
import type { AdvanceReadiness } from './advanceReadiness'

const advance = (over: Partial<AdvanceReadiness> = {}): AdvanceReadiness => ({
  order_value: 1240000, advance_base: 1240000, value_known: true, verified: 645000, awaiting: 0, required: 496000,
  shortfall: 0, percent: 52.01, threshold_percent: 40, below: false, ready: true, exception: null, hold: null,
  ...over,
})

describe('the advance gate', () => {
  test('is a dash until the readiness has been read', () => {
    const g = advanceGate(null)
    assert.equal(g.value, '—')
    assert.equal(g.chip, null)
  })

  test('met: the percentage and a green Met, with the base said in words', () => {
    const g = advanceGate(advance())
    assert.equal(g.value, '52.01%')
    assert.deepEqual(g.chip, { text: 'Met', tone: 'green' })
    assert.match(g.label, /of the Total before GST/)
    assert.match(g.label, /40% requirement is met/)
  })

  test('below: red, and the threshold is the database\'s, never a literal 40', () => {
    const g = advanceGate(advance({ percent: 25, below: true, ready: false, threshold_percent: 35 }))
    assert.deepEqual(g.chip, { text: 'Below 35%', tone: 'red' })
    assert.doesNotMatch(JSON.stringify(g), /40/)
  })

  test('approved below the threshold is amber, not red', () => {
    const g = advanceGate(advance({ percent: 30, below: true, ready: true, exception: { source: 'order', approved_by: 'u', approved_at: null } }))
    assert.deepEqual(g.chip, { text: 'Approved below 40%', tone: 'amber' })
  })

  test('a hold is red and says so', () => {
    const g = advanceGate(advance({ percent: 20, below: true, ready: false, hold: { id: 'h', cause: 'payment_changed', held_at: null, order_value: 1, previous_order_value: 1, verified: 1, percent: 20, shortfall: 1 } }))
    assert.deepEqual(g.chip, { text: 'On hold', tone: 'red' })
  })

  test('no Total before GST on record: says it cannot be measured instead of inventing a percentage', () => {
    const g = advanceGate(advance({ value_known: false, percent: null, below: true, ready: false }))
    assert.equal(g.value, '—')
    assert.equal(g.chip?.text, 'Cannot measure')
  })
})

describe('the due date on the facts line', () => {
  test('counts down, and turns late once it has passed', () => {
    const ok = orderBarGates({ advance: advance(), dueDate: '20 Dec', daysToDue: 26 })
    assert.equal(ok.due.countdown, '26 days left')
    assert.equal(ok.due.late, false)
    const late = orderBarGates({ advance: advance(), dueDate: '1 Nov', daysToDue: -3 })
    assert.equal(late.due.countdown, '3 days overdue')
    assert.equal(late.due.late, true)
    const none = orderBarGates({ advance: null, dueDate: null, daysToDue: null })
    assert.equal(none.due.countdown, null)
  })
})
