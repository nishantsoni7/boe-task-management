// What the Draft Orders list shows: which orders a card and a search leave, the numbers on the cards, and the soft
// colours. Orders are invented; real orders are customer data and never enter the repository.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_ALL, approvalChip, fieldLabel, filterDrafts, groupedFields, statusTone, type DraftListRow } from './clickupDrafts'

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

describe('the order page: the fields in groups', () => {
  test('an all-capitals ClickUp label reads as a word; a mixed-case one is left alone', () => {
    assert.equal(fieldLabel('CUSTOMER BILLING'), 'Customer billing')
    assert.equal(fieldLabel('FABRIC STATUS'), 'Fabric status')
    assert.equal(fieldLabel('Total Product Value'), 'Total Product Value')
    assert.equal(fieldLabel('  Phone '), 'Phone')
    assert.equal(fieldLabel('123'), '123', 'no letters: nothing to change')
  })

  test('the order first (codes, dates, value, statuses), then the client, then the rest alphabetically; empty groups are left out', () => {
    const groups = groupedFields({
      Phone: '1', 'Total Product Value': '2', 'Zeta note': 'z', 'Alpha note': 'a', 'CUSTOMER SHIPPING': 's', 'FINISH STATUS': 'f', 'Confirm Date': 'd',
    })
    assert.deepEqual(groups.map(g => g.key), ['order', 'client', 'other'])
    assert.deepEqual(groups[0].entries.map(e => e[0]), ['Confirm Date', 'Total Product Value', 'FINISH STATUS'])
    assert.deepEqual(groups[1].entries.map(e => e[0]), ['Phone', 'CUSTOMER SHIPPING'])
    assert.deepEqual(groups[2].entries.map(e => e[0]), ['Alpha note', 'Zeta note'])
    assert.deepEqual(groupedFields({ Phone: '1' }).map(g => g.key), ['client'])
    assert.deepEqual(groupedFields({}), [])
  })

  test('every field ClickUp held appears exactly once, whatever its name', () => {
    const fields = { 'New Project Code': 'a', Email: 'b', Whatever: 'c', 'Another one': 'd', 'Dispatch Date': 'e' }
    const shown = groupedFields(fields).flatMap(g => g.entries.map(e => e[0])).sort()
    assert.deepEqual(shown, Object.keys(fields).sort())
  })
})
