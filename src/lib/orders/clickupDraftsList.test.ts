// What the Draft Orders list shows: which orders a card and a search leave, the numbers on the cards, and the soft
// colours. Orders are invented; real orders are customer data and never enter the repository.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_ALL, approvalChip, filterDrafts, statusTone, type DraftListRow } from './clickupDrafts'

const row = (order_no: string | null, client: string, status: string, assignees: string[] = ['Salesperson One']): DraftListRow => ({
  id: `id-${order_no}-${client}`, order_no, name: `${order_no ?? ''} ${client}`.trim(), client_name: client, status, assignees,
  due_date: null, fields: {}, file_count: 0, comment_count: 0,
})

const ROWS = [
  row('9', 'Early Cafe', 'running orders'),
  row('535', 'Aarav Textiles', 'running orders'),
  row('534', 'Mahant Hospitality', 'running orders', ['Saksham Bhardwaj']),
  row('520', 'Gulmohar Estate', 'hold'),
  row('519', 'Old Quarter Cafe', 'cancelled'),
  row('518', 'Pacific Residency', 'dispatched', ['Mohit Sharma']),
  row(null, 'No Number Yet', 'dispatched'),
]

describe('which orders the list shows', () => {
  test('a card shows its status, newest order number first (numbers compare as numbers, an order with none goes last)', () => {
    assert.deepEqual(filterDrafts(ROWS, 'running orders', '').shown.map(r => r.order_no), ['535', '534', '9'])
    assert.deepEqual(filterDrafts(ROWS, 'dispatched', '').shown.map(r => r.order_no), ['518', null])
    assert.deepEqual(filterDrafts(ROWS, DRAFT_ALL, '').shown.map(r => r.order_no), ['535', '534', '520', '519', '518', '9', null])
  })

  test('the search looks at the order number, the name, the client and the people, in any case', () => {
    assert.deepEqual(filterDrafts(ROWS, DRAFT_ALL, '534').shown.map(r => r.order_no), ['534'])
    assert.deepEqual(filterDrafts(ROWS, DRAFT_ALL, 'CAFE').shown.map(r => r.order_no), ['519', '9'])
    assert.deepEqual(filterDrafts(ROWS, DRAFT_ALL, 'saksham').shown.map(r => r.order_no), ['534'])
    assert.deepEqual(filterDrafts(ROWS, DRAFT_ALL, '  mohit  ').shown.map(r => r.order_no), ['518'])
    assert.deepEqual(filterDrafts(ROWS, DRAFT_ALL, 'zzz').shown, [])
  })

  test('the numbers on the cards follow the search, so a number never contradicts the list under its card', () => {
    const none = filterDrafts(ROWS, DRAFT_ALL, '')
    assert.equal(none.searched, 7)
    assert.equal(none.counts.get('running orders'), 3)
    assert.equal(none.counts.get('dispatched'), 2)
    const cafe = filterDrafts(ROWS, 'running orders', 'cafe')
    assert.equal(cafe.searched, 2)
    assert.equal(cafe.counts.get('running orders'), 1)
    assert.equal(cafe.counts.get('cancelled'), 1)
    assert.equal(cafe.counts.get('dispatched') ?? 0, 0)
    assert.equal(cafe.shown.length, cafe.counts.get('running orders'), 'the list under the pressed card holds exactly its count')
  })

  test('the rows given are never reordered or changed', () => {
    const before = ROWS.map(r => r.order_no)
    filterDrafts(ROWS, DRAFT_ALL, '')
    assert.deepEqual(ROWS.map(r => r.order_no), before)
  })
})

describe('the soft colours', () => {
  test('each status has its own tone; an unknown status is grey', () => {
    assert.deepEqual(['running orders', 'ready for dispatch', 'hold', 'cancelled', 'dispatched', 'something new'].map(statusTone),
      ['partial', 'full', 'zero', 'over', 'neutral', 'neutral'])
  })

  test('FABRIC STATUS / FINISH STATUS become one short word in the column that already names it', () => {
    assert.deepEqual(approvalChip('FABRIC PENDING', 'fabric'), { label: 'Pending', tone: 'zero' })
    assert.deepEqual(approvalChip('FINISH PENDING', 'finish'), { label: 'Pending', tone: 'zero' })
    assert.deepEqual(approvalChip('FINISH APPROVED', 'finish'), { label: 'Approved', tone: 'full' })
    assert.deepEqual(approvalChip('NO FABRIC', 'fabric'), { label: 'No fabric', tone: 'neutral' })
    assert.deepEqual(approvalChip('  Fabric   received ', 'fabric'), { label: 'Received', tone: 'full' })
    assert.deepEqual(approvalChip('Partly with the client', 'fabric'), { label: 'Partly with the client', tone: 'partial' })
    assert.equal(approvalChip('FINISH APPROVED', 'fabric')?.label, 'Finish approved', 'only its own column word is dropped')
  })

  test('nothing in ClickUp is nothing on the screen', () => {
    assert.equal(approvalChip(undefined, 'fabric'), null)
    assert.equal(approvalChip('   ', 'finish'), null)
  })
})
