/**
 * OPENING EXPENSES LOADS THE LIST ONCE.
 *
 * Measured on production (2026-09-26): entering /finance/expenses issued the
 * list query twice. The search debounce fires ~300 ms after mount with the
 * unchanged empty search; it built a new `filters` object anyway, the
 * `[filters, loadExpenses]` effect reloaded, the first load was discarded by its
 * load token, and rows appeared only after the SECOND list → names chain
 * (first list answered at 2228 ms and was thrown away; rows at 2874 ms).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_EXPENSE_FILTERS, withExpenseSearch } from '@/lib/finance/expenses'

describe('withExpenseSearch', () => {
  test('an unchanged search returns THE SAME object, so nothing reloads', () => {
    const f = { ...EMPTY_EXPENSE_FILTERS, categoryId: 'fuel' }
    assert.equal(withExpenseSearch(f, ''), f)
    const g = { ...f, search: 'diesel' }
    assert.equal(withExpenseSearch(g, 'diesel'), g)
  })

  test('a changed search returns a new object carrying it, and nothing else changes', () => {
    const f = { ...EMPTY_EXPENSE_FILTERS, paymentMode: 'upi' }
    const next = withExpenseSearch(f, 'sharma')
    assert.notEqual(next, f)
    assert.deepEqual(next, { ...f, search: 'sharma' })
    assert.equal(f.search, '', 'the previous filters are not mutated')
  })

  test('clearing a search is a change', () => {
    const f = { ...EMPTY_EXPENSE_FILTERS, search: 'x' }
    assert.deepEqual(withExpenseSearch(f, ''), EMPTY_EXPENSE_FILTERS)
  })
})

describe('ExpensesView applies the debounced search through it', () => {
  const src = readFileSync(join(__dirname, 'ExpensesView.tsx'), 'utf8').replace(/\r/g, '')

  test('the debounce updater keeps identity when nothing changed', () => {
    assert.ok(src.includes('setFilters(prev => withExpenseSearch(prev, searchTerm))'))
    assert.equal(/setFilters\(prev => \(\{ \.\.\.prev, search: searchTerm \}\)\)/.test(src), false,
      'the unconditional copy that caused the double load is gone')
  })
})
