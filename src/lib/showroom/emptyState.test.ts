/**
 * Product Master empty-state copy.
 *
 * The defect this locks down: a brand-new category showed "No products match
 * your filters" and told the user to change filters they had never set.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/emptyState.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { productListEmptyState } from './emptyState'

describe('productListEmptyState', () => {
  test('an empty category with nothing filtered invites the first product', () => {
    const state = productListEmptyState({ hasSearch: false, statusFiltered: false })
    assert.equal(state.message, 'No products in this category yet')
    assert.equal(state.hint,    'Add the first product to start building this category.')
  })

  test('a search that matched nothing still talks about filters', () => {
    const state = productListEmptyState({ hasSearch: true, statusFiltered: false })
    assert.equal(state.message, 'No products match your filters')
    assert.equal(state.hint,    'Try a different search term or status.')
  })

  test('a status filter alone is enough to be the filtered message', () => {
    const state = productListEmptyState({ hasSearch: false, statusFiltered: true })
    assert.equal(state.message, 'No products match your filters')
  })

  test('search and status together are still the filtered message', () => {
    const state = productListEmptyState({ hasSearch: true, statusFiltered: true })
    assert.equal(state.message, 'No products match your filters')
  })

  test('the empty-category copy never tells the user to change a filter', () => {
    const state = productListEmptyState({ hasSearch: false, statusFiltered: false })
    const text = `${state.message} ${state.hint}`.toLowerCase()
    for (const word of ['filter', 'search term', 'status']) {
      assert.ok(!text.includes(word), `empty-category copy must not mention "${word}"`)
    }
  })

  test('the old copy is gone from both branches', () => {
    // It sent the reader to the sidebar to pick another category, which is not
    // the next step when the category they chose is simply empty.
    for (const input of [
      { hasSearch: false, statusFiltered: false },
      { hasSearch: true,  statusFiltered: false },
      { hasSearch: false, statusFiltered: true },
    ]) {
      const state = productListEmptyState(input)
      assert.ok(!state.hint.includes('pick another category'), JSON.stringify(input))
    }
  })

  test('both branches always give a message and a hint', () => {
    for (const hasSearch of [true, false]) {
      for (const statusFiltered of [true, false]) {
        const state = productListEmptyState({ hasSearch, statusFiltered })
        assert.ok(state.message.length > 0)
        assert.ok(state.hint.length > 0)
      }
    }
  })
})
