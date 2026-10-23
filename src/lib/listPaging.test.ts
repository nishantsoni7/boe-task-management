/**
 * The shared paging rules: which rows a page means, how many pages a total
 * makes, when a pager is drawn at all, and which page buttons it shows.
 *
 * Run:
 *   npx tsx --test src/lib/listPaging.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIST_PAGE_SIZE, clampListPage, listPageCount, listPageRange, listPageSpan, needsPager, pageSlots,
} from './listPaging'

describe('listPageRange', () => {
  test('page 1 starts at row 0 and spans one page', () => {
    assert.deepEqual(listPageRange(1), { from: 0, to: LIST_PAGE_SIZE - 1 })
  })

  test('page 3 starts two pages in', () => {
    assert.deepEqual(listPageRange(3), { from: 2 * LIST_PAGE_SIZE, to: 3 * LIST_PAGE_SIZE - 1 })
  })

  test('a typed-in page below 1 or a non-number reads as the first page', () => {
    for (const bad of [0, -4, NaN, Infinity]) {
      assert.deepEqual(listPageRange(bad), { from: 0, to: LIST_PAGE_SIZE - 1 })
    }
  })

  test('a page stays far under the 1000-row PostgREST ceiling', () => {
    assert.ok(LIST_PAGE_SIZE < 1000)
  })
})

describe('listPageCount and clampListPage', () => {
  test('an empty or unknown total is still one page', () => {
    assert.equal(listPageCount(0), 1)
    assert.equal(listPageCount(null), 1)
    assert.equal(listPageCount(undefined), 1)
  })

  test('a total is rounded up to whole pages', () => {
    assert.equal(listPageCount(30), 1)
    assert.equal(listPageCount(31), 2)
    assert.equal(listPageCount(90), 3)
    assert.equal(listPageCount(91), 4)
  })

  test('a page beyond the end is pulled back to the last page', () => {
    assert.equal(clampListPage(9, 45), 2)
    assert.equal(clampListPage(2, 45), 2)
    assert.equal(clampListPage(0, 45), 1)
    assert.equal(clampListPage(5, 0), 1)
  })
})

describe('listPageSpan', () => {
  test('describes the rows on a middle and on a short last page', () => {
    assert.deepEqual(listPageSpan(2, 212), { first: 31, last: 60 })
    assert.deepEqual(listPageSpan(8, 212), { first: 211, last: 212 })
  })

  test('an empty list has no span', () => {
    assert.deepEqual(listPageSpan(1, 0), { first: 0, last: 0 })
  })
})

describe('needsPager', () => {
  test('only a list longer than one page gets a pager', () => {
    assert.equal(needsPager(0), false)
    assert.equal(needsPager(30), false)
    assert.equal(needsPager(31), true)
    assert.equal(needsPager(null), false)
  })
})

describe('pageSlots', () => {
  test('a short list shows every page', () => {
    assert.deepEqual(pageSlots(1, 1), [1])
    assert.deepEqual(pageSlots(2, 4), [1, 2, 3, 4])
  })

  test('a long list collapses the middle into gaps', () => {
    assert.deepEqual(pageSlots(1, 20), [1, 2, 'gap', 20])
    assert.deepEqual(pageSlots(10, 20), [1, 'gap', 9, 10, 11, 'gap', 20])
    assert.deepEqual(pageSlots(20, 20), [1, 'gap', 19, 20])
  })

  test('a gap that would hide a single page shows that page instead', () => {
    assert.deepEqual(pageSlots(3, 20), [1, 2, 3, 4, 'gap', 20])
    assert.deepEqual(pageSlots(18, 20), [1, 'gap', 17, 18, 19, 20])
  })
})
