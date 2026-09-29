/**
 * COMPLETING A CAPTURE, FROM A DRAFT SHAPED THE WAY THE WIRE SHAPES IT.
 *
 * The production crash `e.amount.trim is not a function` (the /finance/expenses
 * page replaced by "This page couldn't load") was traced to the build before
 * #179: its chunk throws in validateExpenseForm, called from ExpenseForm's
 * render. #179 fixed the row → form boundary and pinned it for EDIT
 * (expenseEdit.render.test.tsx). The same pre-#179 build crashed identically
 * when COMPLETING A DRAFT, because expense_drafts.parsed_amount is `numeric`
 * too — but every draft fixture in the suite carries `parsed_amount: '500'`, a
 * string, so nothing would notice that path regressing.
 *
 * Every draft below therefore carries parsed_amount as a NUMBER, which is what
 * `{"parsed_amount":850.50}` parses to.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpenseForm } from './ExpenseForm'
import { NeedsDetailsList } from './NeedsDetailsList'
import type { ExpenseCategory } from '@/lib/finance/expenses'
import {
  draftMissingFields,
  expenseFormFromDraft,
  type ExpenseDraftRow,
} from '@/lib/finance/expenseDrafts'
import { validateExpenseForm } from '@/lib/finance/expenses'

const CATEGORIES: ExpenseCategory[] = [
  { id: 'fuel', name: 'Fuel', is_active: true },
]

/** Synthetic draft, with parsed_amount as PostgREST really sends it. */
const DRAFT: ExpenseDraftRow = {
  id: 'draft-synthetic-1',
  raw_text: '850.50 upi to Synthetic Diesel Co',
  parsed_date: '2026-09-20',
  parsed_amount: 850.5, // ← a NUMBER
  parsed_paid_to: 'Synthetic Diesel Co',
  parsed_payment_mode: 'upi',
  parsed_remark: null,
  category_id: 'fuel',
  status: 'pending',
  expense_id: null,
  finalized_at: null,
  discarded_by: null,
  discarded_at: null,
  created_by: 'author',
  created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-20T09:00:00Z',
}

const supabase = {} as Parameters<typeof ExpenseForm>[0]['supabase']

const renderComplete = (draft: ExpenseDraftRow) =>
  renderToStaticMarkup(createElement(ExpenseForm, {
    supabase,
    userId: 'author',
    mode: 'complete' as const,
    draft,
    categories: CATEGORIES,
    onCategoryCreated: () => {},
    onSaved: () => {},
    onCancel: () => {},
  }))

describe('COMPLETE CAPTURE OPENS THE FORM FROM A NUMERIC parsed_amount', () => {
  test('the form state it starts from holds the amount as TEXT', () => {
    const form = expenseFormFromDraft(DRAFT, '2026-09-26')
    assert.equal(typeof form.amount, 'string')
    assert.equal(form.amount, '850.50')
    assert.deepEqual(validateExpenseForm(form, '2026-09-26'), {})
  })

  test('the form renders at all — this is the render that threw', () => {
    assert.doesNotThrow(() => renderComplete(DRAFT))
  })

  test('and it is the form, prefilled, not an error state', () => {
    const html = renderComplete(DRAFT)
    assert.ok(/id="expense-paid-to"[^>]*value="Synthetic Diesel Co"/.test(html))
    const amount = /inputMode="decimal"[^>]*value="([^"]*)"/.exec(html)
      ?? /value="([^"]*)"[^>]*inputMode="decimal"/.exec(html)
    assert.ok(amount, 'the amount field is rendered')
    assert.equal(Number(amount![1].replace(/,/g, '')), 850.5)
    assert.equal(html.includes('data-testid="expense-error-boundary"'), false)
  })

  test('a whole-rupee amount and a null amount both open safely', () => {
    assert.doesNotThrow(() => renderComplete({ ...DRAFT, parsed_amount: 1000 }))
    assert.doesNotThrow(() => renderComplete({ ...DRAFT, parsed_amount: null }))
  })
})

describe('THE NEEDS DETAILS INBOX reads a numeric parsed_amount', () => {
  test('a numeric amount is not reported missing', () => {
    assert.equal(draftMissingFields(DRAFT).includes('Amount'), false)
  })

  test('the inbox renders the row, with its amount', () => {
    const html = renderToStaticMarkup(createElement(NeedsDetailsList, {
      rows: [DRAFT],
      loading: false,
      error: null,
      personName: () => 'Synthetic Person',
      mayAct: () => true,
      onComplete: () => {},
      onDiscarded: () => {},
      supabase,
      userId: 'author',
    }))
    assert.ok(html.includes('Synthetic Diesel Co'))
    assert.ok(html.includes('850.50'))
  })
})

describe('A CRASH IN COMPLETE COSTS THE FORM, NOT THE ROUTE', () => {
  // Source-level: both places that mount mode="complete" sit inside the same
  // ExpenseErrorBoundary Edit already uses. CRLF is stripped so the check reads
  // the same on a Windows checkout.
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8').replace(/\r/g, '')

  for (const file of ['ExpensesView.tsx', 'new/page.tsx']) {
    test(`${file}: the complete form is inside ExpenseErrorBoundary`, () => {
      const src = read(file)
      const at = src.indexOf('mode="complete"')
      assert.ok(at > 0, 'the complete form is mounted here')
      const open = src.lastIndexOf('<ExpenseErrorBoundary label="complete"', at)
      const close = src.lastIndexOf('</ExpenseErrorBoundary>', at)
      assert.ok(open > 0 && open > close, 'an open boundary encloses mode="complete"')
    })
  }
})
