import test from 'node:test'
import assert from 'node:assert/strict'
import { DASHBOARD_PREVIEW_LIMIT, previewFooterLabel, previewRows } from './dashboardPreview'

test('the preview keeps the first five rows in the list\'s own order', () => {
  const list = Array.from({ length: 128 }, (_, i) => i)
  assert.deepEqual(previewRows(list), [0, 1, 2, 3, 4])
  assert.equal(list.length, 128, 'the input list is not mutated')
})

test('lists of 0 to 5 are shown whole and have no footer', () => {
  for (const n of [0, 1, 5]) {
    const list = Array.from({ length: n }, (_, i) => i)
    assert.equal(previewRows(list).length, n)
    for (const kind of ['overdue', 'acknowledgement', 'quotation'] as const) {
      assert.equal(previewFooterLabel(kind, n), null)
    }
  }
})

test('the footer states the full live total with the right noun', () => {
  assert.equal(previewFooterLabel('overdue', 128), 'View all 128 overdue tasks')
  assert.equal(previewFooterLabel('acknowledgement', 12), 'View all 12 tasks awaiting acknowledgement')
  assert.equal(previewFooterLabel('quotation', 9), 'View all 9 quotation requests')
  assert.equal(previewFooterLabel('overdue', DASHBOARD_PREVIEW_LIMIT + 1), 'View all 6 overdue tasks')
})
