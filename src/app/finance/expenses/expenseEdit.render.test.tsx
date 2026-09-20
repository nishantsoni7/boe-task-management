/**
 * THE EDIT FORM, RENDERED FROM A ROW SHAPED THE WAY THE WIRE SHAPES IT.
 *
 * The existing render suite builds its fixture from ExpenseRow's TYPE, which
 * said `amount: string`. PostgREST sends a `numeric` column as a JSON number,
 * so every fixture in that suite agreed with the bug instead of catching it.
 *
 * Every row below therefore carries `amount` as a NUMBER, which is what
 * `{"amount":1000.00}` parses to. Rendering is the whole assertion: before the
 * fix, mounting this component threw `amount.trim is not a function` from the
 * validator that runs during render, and with no error boundary in the
 * application that emptied the entire Expenses route.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpenseForm } from './ExpenseForm'
import {
  ExpenseErrorBoundary,
  EXPENSE_ERROR_TITLE,
  EXPENSE_ERROR_BODY,
} from './ExpenseErrorBoundary'
import type { ExpenseCategory, ExpenseRow } from '@/lib/finance/expenses'

const CAT = '8a0b094a-ddfd-4f97-a204-ac96c983e5b1'

const CATEGORIES: ExpenseCategory[] = [
  { id: CAT, name: 'Factory Maintenance', is_active: true },
  { id: 'cat-2', name: 'Fuel', is_active: true },
  { id: 'cat-retired', name: 'Old Thing', is_active: false },
]

/** The exact row production holds, with amount as PostgREST really sends it. */
const ROW: ExpenseRow = {
  id: '5509dffb-df89-47f2-944b-1eeb432319f2',
  expense_date: '2026-09-18',
  amount: 850.5, // ← a NUMBER: {"amount":850.50} parses to 850.5
  payment_mode: 'upi',
  paid_to: 'Sharma Ji',
  category_id: CAT,
  remark: 'welding machine',
  created_by: 'user-1',
  created_at: '2026-09-18T10:00:00Z',
  updated_at: '2026-09-18T10:00:00Z',
  updated_by: null,
  deleted_at: null,
  deleted_by: null,
}

const supabase = {} as Parameters<typeof ExpenseForm>[0]['supabase']

const renderEdit = (expense: ExpenseRow, categories = CATEGORIES) =>
  renderToStaticMarkup(createElement(ExpenseForm, {
    supabase,
    userId: 'user-1',
    mode: 'edit' as const,
    expense,
    categories,
    onCategoryCreated: () => {},
    onSaved: () => {},
    onCancel: () => {},
  }))

// ── The regression ───────────────────────────────────────────────────────────

describe('CLICKING EDIT OPENS THE FORM INSTEAD OF EMPTYING THE PAGE', () => {
  test('a row whose amount is a number renders at all', () => {
    assert.doesNotThrow(() => renderEdit(ROW))
  })

  test('and it is the edit form, not an error state', () => {
    const html = renderEdit(ROW)
    assert.ok(html.includes('id="expense-paid-to"'))
    assert.ok(html.includes('Save changes'))
    assert.equal(html.includes('data-testid="expense-error-boundary"'), false)
  })
})

describe('the form loads the correct existing values', () => {
  const html = renderEdit(ROW)

  test('the date', () => {
    assert.ok(/id="expense-date"[^>]*value="2026-09-18"/.test(html))
  })

  test('THE AMOUNT — the same figure, as text the field can hold', () => {
    // 850.5 on the wire is ₹850.50 in the ledger. The input is not focused on
    // the first frame, so it shows the shared Indian grouping every Finance
    // amount field shows.
    const amount = /inputMode="decimal"[^>]*value="([^"]*)"/.exec(html)
      ?? /value="([^"]*)"[^>]*inputMode="decimal"/.exec(html)
    assert.ok(amount, 'the amount field is rendered')
    assert.equal(amount![1], '850.5')
  })

  test('the paid-to name', () => {
    assert.ok(/id="expense-paid-to"[^>]*value="Sharma Ji"/.test(html))
  })

  test('the remark', () => {
    assert.ok(/id="expense-remark"[^>]*value="welding machine"/.test(html))
  })

  test('the payment mode is the stored one, selected', () => {
    assert.ok(html.includes('>UPI</option>'))
    assert.ok(/<select[^>]*id="expense-mode"[\s\S]*?<\/select>/.test(html))
  })

  test('the category is the stored one, and every active category is offered', () => {
    assert.ok(html.includes('>Factory Maintenance</option>'))
    assert.ok(html.includes('>Fuel</option>'))
  })

  test('nothing is in an error state merely because the form opened', () => {
    assert.equal(html.includes('role="alert"'), false)
    assert.equal(html.includes('aria-invalid="true"'), false)
  })
})

// ── The awkward rows ─────────────────────────────────────────────────────────

describe('an awkward row opens safely rather than crashing the page', () => {
  test('AN INACTIVE CATEGORY IS PRESERVED and stays selectable', () => {
    const html = renderEdit({ ...ROW, category_id: 'cat-retired' })
    assert.ok(html.includes('>Old Thing</option>'),
      'the retired category it names stays in the picker, so an edit cannot silently change it')
  })

  test('a category that no longer exists still opens the form', () => {
    assert.doesNotThrow(() => renderEdit({ ...ROW, category_id: 'gone' }))
  })

  test('no categories loaded at all still opens the form', () => {
    assert.doesNotThrow(() => renderEdit(ROW, []))
  })

  test('a null remark opens as an empty field', () => {
    const html = renderEdit({ ...ROW, remark: null })
    assert.equal(html.includes('welding machine'), false)
    assert.ok(html.includes('id="expense-remark"'))
  })

  test('NOT-NULL columns arriving null are a message, never a crash', () => {
    for (const row of [
      { ...ROW, amount: null as unknown as number },
      { ...ROW, paid_to: null as unknown as string },
      { ...ROW, expense_date: null as unknown as string },
      { ...ROW, payment_mode: null as unknown as string },
    ]) assert.doesNotThrow(() => renderEdit(row))
  })

  test('a whole-rupee amount renders as the figure, not as "[object]" or a blank', () => {
    const html = renderEdit({ ...ROW, amount: 1000 })
    assert.ok(html.includes('1,000'), 'the grouped figure reaches the field')
  })
})

// ── A deleted expense ────────────────────────────────────────────────────────

describe('A DELETED EXPENSE IS STILL NOT EDITABLE', () => {
  const dead = { ...ROW, deleted_at: '2026-09-19T08:00:00Z', deleted_by: 'user-1' }

  test('the form refuses to render its fields', () => {
    const html = renderEdit(dead)
    assert.ok(html.includes('This expense has been deleted, so it can no longer be changed.'))
    assert.equal(html.includes('id="expense-paid-to"'), false)
    assert.equal(html.includes('Save changes'), false)
  })

  test('and it offers a way out', () => {
    assert.ok(renderEdit(dead).includes('>Close</button>'))
  })
})

// ── The safe error state ─────────────────────────────────────────────────────

describe('ONE BAD RECORD CANNOT EMPTY THE WHOLE PAGE ANY MORE', () => {
  /**
   * THE FALLBACK, RENDERED DIRECTLY.
   *
   * react-dom/server does NOT run error boundaries — a throw during a server
   * render propagates rather than being caught — so mounting a throwing child
   * here would test react-dom, not this component. What matters is the pair the
   * boundary is made of: getDerivedStateFromError turning an error into state,
   * and render() turning that state into a message. Both are exercised below.
   */
  const fallbackHtml = () => {
    const boundary = new ExpenseErrorBoundary({ label: 'test', children: null })
    boundary.state = ExpenseErrorBoundary.getDerivedStateFromError(new Error('boom'))
    return renderToStaticMarkup(boundary.render() as React.ReactElement)
  }

  test('the boundary renders its children when nothing is wrong', () => {
    const html = renderToStaticMarkup(createElement(
      ExpenseErrorBoundary, { label: 'test' },
      createElement('p', null, 'the list'),
    ))
    assert.ok(html.includes('the list'))
    assert.equal(html.includes('data-testid="expense-error-boundary"'), false)
  })

  test('an error becomes state, and that state becomes a controlled message', () => {
    assert.deepEqual(
      Object.keys(ExpenseErrorBoundary.getDerivedStateFromError(new Error('boom'))), ['error'])
    const html = fallbackHtml()
    assert.ok(html.includes('data-testid="expense-error-boundary"'))
    assert.ok(html.includes(EXPENSE_ERROR_TITLE))
    assert.ok(html.includes(EXPENSE_ERROR_BODY))
    assert.ok(html.includes('role="alert"'))
  })

  test('IT PROMISES NOTHING IT CANNOT KEEP — it says nothing was changed, and offers a retry', () => {
    const html = fallbackHtml()
    assert.ok(html.includes('Nothing has been changed'))
    assert.ok(html.includes('>Try again</button>'))
  })
})
