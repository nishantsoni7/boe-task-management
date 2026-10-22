// THE 2026-10-22 CONSISTENCY PASS ON ORDERS AND FINANCE.
//
// Measured on the live site (computed styles of the real pages, as admin), these were the places where
// one screen disagreed with the rest. They are small and easy to undo by accident, so each is pinned.
//
//   * Payment Requests' "+ New" drew its text at 12 px; every other primary button is 13 px.
//   * The Expenses date lost the end of its year ("18 Oct 20…") on 25 of 41 rows, because the text was
//     one pixel wider than its cell; and its column headers were bold where every other table's are medium.
//   * The PI Draft's Back sat in the top-right header, and the Order's sat top-left. Same component, now
//     the same place.
//
// Run with: npx tsx --test "src/lib/navigation/uiConsistencyPass.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r/g, '')

describe('one size for the primary button', () => {
  test('Payment Requests "+ New" carries no size override of its own', () => {
    const page = read('app/finance/page.tsx')
    const at = page.indexOf('+ New\n')
    const button = page.slice(page.lastIndexOf('<button', at), at)
    assert.match(button, /className="boe-btn boe-btn-primary"/)
    assert.equal(/style=/.test(button), false, 'no inline style on the button')
  })
})

describe('the Expenses table', () => {
  const view = read('app/finance/expenses/ExpensesView.tsx')

  test('the date cell has room for a two-digit day and a full year', () => {
    assert.match(view, /\{fmtDate\(row\.expense_date\)\}/)
    assert.match(view, /color: colors\.secondary, paddingRight: '4px' \}\}>\{fmtDate\(row\.expense_date\)\}/)
    assert.match(view, /key: 'date',\s+label: 'Date',\s+align: 'left',\s+width: '96px'/, 'the column budget did not move')
  })

  test('its headers are medium weight, like every other table\'s', () => {
    const th = view.slice(view.indexOf('const TH'), view.indexOf('const TH') + 400)
    assert.match(th, /fontSize: '12px', fontWeight: 500, color: colors\.muted/)
  })
})

describe('Back on a record', () => {
  test('the PI Draft puts Back top-left in the Order page\'s style, not in the header actions', () => {
    const pi = read('app/orders/drafts/[submissionId]/page.tsx')
    const order = read('app/orders/[id]/page.tsx')
    assert.match(order, /<RecordBackLink fallbackHref="\/orders\/all" className="order-back" \/>/)
    assert.match(pi, /<RecordBackLink fallbackHref="\/orders\/drafts" className="order-back" \/>/)
    const actions = pi.slice(pi.indexOf('actions={<>'), pi.indexOf('actions={<>') + 160)
    assert.equal(actions.includes('backButton'), false)
  })
})
