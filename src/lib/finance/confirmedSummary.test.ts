import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeConfirmed } from './confirmedSummary'

test('an empty list is all zeros', () => {
  const s = summarizeConfirmed([])
  assert.equal(s.all.count, 0)
  assert.equal(Number(s.all.amount), 0)
})

test('buckets by the complete allocation status, with exact sums', () => {
  const s = summarizeConfirmed([
    { amount: '750000.00', complete_allocation_status: 'full' },
    { amount: '300000.00', complete_allocation_status: 'zero' },
    { amount: '0.10',      complete_allocation_status: 'partial' },
    { amount: '0.20',      complete_allocation_status: 'partial' },
  ])
  assert.equal(s.all.count, 4)
  assert.equal(Number(s.all.amount), 1050000.3)
  assert.equal(s.full.count, 1)
  assert.equal(s.zero.count, 1)
  assert.equal(s.partial.count, 2)
  assert.equal(s.partial.amount.replace(/0+$/, ''), '0.3', 'no float drift')
  assert.equal(s.over.count, 0)
})

test('a row with no status counts toward All only', () => {
  const s = summarizeConfirmed([{ amount: 5, complete_allocation_status: null }])
  assert.equal(s.all.count, 1)
  assert.equal(s.zero.count + s.partial.count + s.full.count + s.over.count, 0)
})
