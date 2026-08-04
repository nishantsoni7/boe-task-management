/**
 * Product Master sidebar counts — the grouping rule.
 *
 * The counts endpoint reads active products once and groups them here, rather
 * than issuing one head-count query per category. That shape is the whole point
 * (a per-category count is an N+1 that grows with the catalogue), and it moves
 * the correctness risk from the database into this function — which is what
 * these tests pin down:
 *
 *   * a category with no products reports 0 rather than disappearing,
 *   * a product pointing at a category that no longer exists is counted in the
 *     total but in nobody's badge, so the parent can legitimately exceed the sum,
 *   * whitespace and blank category values do not become their own category, and
 *   * matching is exact — "bar chairs" is not "Bar Chairs".
 *
 * Run:
 *   npx tsx --test src/lib/showroom/productCounts.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tallyByCategory } from './productCounts'

const NAMES = ['Bar Chairs', 'Dummy', 'Lounge Chairs', 'Metal Chairs', 'Wooden Chairs']

const rows = (spec: Record<string, number>, extra: (string | null)[] = []) => [
  ...Object.entries(spec).flatMap(([category, n]) =>
    Array.from({ length: n }, () => ({ category }))),
  ...extra.map(category => ({ category })),
]

describe('tallyByCategory', () => {
  test('counts the live catalogue exactly', () => {
    const result = tallyByCategory(
      rows({ 'Bar Chairs': 26, 'Dummy': 16, 'Lounge Chairs': 10, 'Metal Chairs': 73, 'Wooden Chairs': 74 }),
      NAMES,
    )
    assert.equal(result.total, 199)
    assert.deepEqual(result.categories, [
      { name: 'Bar Chairs',    count: 26 },
      { name: 'Dummy',         count: 16 },
      { name: 'Lounge Chairs', count: 10 },
      { name: 'Metal Chairs',  count: 73 },
      { name: 'Wooden Chairs', count: 74 },
    ])
    assert.equal(result.categories.reduce((a, c) => a + c.count, 0), result.total)
  })

  test('categories come back in the order given, not in tally order', () => {
    const result = tallyByCategory(rows({ 'Wooden Chairs': 3, 'Bar Chairs': 1 }), NAMES)
    assert.deepEqual(result.categories.map(c => c.name), NAMES)
  })

  test('an empty category reports 0 rather than vanishing from the sidebar', () => {
    const result = tallyByCategory(rows({ 'Bar Chairs': 2 }), NAMES)
    assert.equal(result.categories.length, NAMES.length)
    assert.deepEqual(result.categories.find(c => c.name === 'Dummy'), { name: 'Dummy', count: 0 })
  })

  test('no products at all gives zeros, not an empty list', () => {
    const result = tallyByCategory([], NAMES)
    assert.equal(result.total, 0)
    assert.deepEqual(result.categories.map(c => c.count), [0, 0, 0, 0, 0])
  })

  test('a product left on a removed category counts toward the total only', () => {
    // The parent badge is the catalogue total, not the sum of the children.
    const result = tallyByCategory(rows({ 'Bar Chairs': 2, 'Retired Range': 3 }), NAMES)
    assert.equal(result.total, 5)
    assert.equal(result.categories.reduce((a, c) => a + c.count, 0), 2)
    assert.equal(result.categories.some(c => c.name === 'Retired Range'), false)
  })

  test('blank and whitespace category values never become a category', () => {
    const result = tallyByCategory(rows({ 'Bar Chairs': 1 }, ['', '   ', null]), NAMES)
    assert.equal(result.total, 4)
    assert.deepEqual(result.categories.find(c => c.name === 'Bar Chairs'), { name: 'Bar Chairs', count: 1 })
    assert.equal(result.categories.length, NAMES.length)
  })

  test('a stored value with stray padding still lands on its category', () => {
    const result = tallyByCategory(rows({}, ['  Bar Chairs  ', 'Bar Chairs']), NAMES)
    assert.deepEqual(result.categories.find(c => c.name === 'Bar Chairs'), { name: 'Bar Chairs', count: 2 })
  })

  test('matching is case-sensitive — a mis-cased value is not silently merged', () => {
    // Merging would hide a real data problem behind a plausible-looking badge.
    const result = tallyByCategory(rows({}, ['bar chairs']), NAMES)
    assert.deepEqual(result.categories.find(c => c.name === 'Bar Chairs'), { name: 'Bar Chairs', count: 0 })
    assert.equal(result.total, 1)
  })

  test('an empty category list yields no badges but still a real total', () => {
    const result = tallyByCategory(rows({ 'Bar Chairs': 4 }), [])
    assert.equal(result.total, 4)
    assert.deepEqual(result.categories, [])
  })
})
