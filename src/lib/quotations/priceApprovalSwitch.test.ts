import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalIsOn, readLimit } from './priceApprovalSwitch'

test('price approval is off only when both limits are empty', () => {
  assert.equal(approvalIsOn({ max_discount_pct: null, min_price_pct: null }), false)
  assert.equal(approvalIsOn({ max_discount_pct: 5, min_price_pct: null }), true)
  assert.equal(approvalIsOn({ max_discount_pct: null, min_price_pct: 90 }), true)
  assert.equal(approvalIsOn({ max_discount_pct: 0, min_price_pct: null }), true)
})

test('a limit as typed: empty is off, a number is kept, anything else is refused', () => {
  assert.equal(readLimit(''), null)
  assert.equal(readLimit('  '), null)
  assert.equal(readLimit('5'), 5)
  assert.equal(readLimit(' 87.5 '), 87.5)
  assert.throws(() => readLimit('five'))
  assert.throws(() => readLimit('5%'))
})
