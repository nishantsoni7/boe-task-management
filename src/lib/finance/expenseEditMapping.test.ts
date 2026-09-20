/**
 * THE EDIT CRASH, AND THE MAPPING THAT CAUSED IT.
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────
 *
 * Clicking Edit on any existing expense took down the whole Expenses page with
 * Next.js's generic "This page couldn't load".
 *
 * The reproduction, in one line: `ExpenseRow.amount` was typed `string`, and
 * PostgREST sends a `numeric` column as a JSON NUMBER. `expenseFormFromRow`
 * put that number straight into `ExpenseFormState.amount`, every field of
 * which is text, and `validateExpenseForm` — which runs during RENDER, not on
 * submit — immediately called `.trim()` on it:
 *
 *     TypeError: amount.trim is not a function
 *
 * With no React error boundary anywhere in the application, a throw during
 * render unmounts the whole route.
 *
 * ── WHY NO TEST CAUGHT IT ──────────────────────────────────────────────────
 *
 * Every fixture in the suite was written from the TYPE, so every fixture used
 * a string and every test agreed with the bug. The tests below are written
 * from what the WIRE actually carries, verified against a real PostgREST:
 *
 *     $ curl .../expenses?select=amount
 *     [{"amount":1000.00}]        ← unquoted. JSON.parse gives a number.
 *
 * So the first test here is the one that would have caught it.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyExpenseForm,
  expenseAmountText,
  expenseFormFromRow,
  expenseWritePayload,
  isExpenseFormValid,
  validateExpenseForm,
  type ExpenseRow,
} from './expenses'

const TODAY = '2026-09-20'

/** The exact row production holds, with amount as PostgREST really sends it. */
const ROW: ExpenseRow = {
  id: '5509dffb-df89-47f2-944b-1eeb432319f2',
  expense_date: '2026-09-20',
  amount: 1000, // ← a NUMBER, because {"amount":1000.00} parses to one
  payment_mode: 'cash',
  paid_to: 'MCD',
  category_id: '8a0b094a-ddfd-4f97-a204-ac96c983e5b1',
  remark: 'Sewage Cleaning',
  created_by: '6507df9f-cdeb-4ebd-849f-8498c165d596',
  created_at: '2026-09-20T08:24:19.818794Z',
  updated_at: '2026-09-20T08:24:19.818794Z',
  updated_by: null,
  deleted_at: null,
  deleted_by: null,
}

// ── The regression ───────────────────────────────────────────────────────────

describe('THE CRASH: a stored amount arrives as a number, not a string', () => {
  test('opening the edit form on it does not throw', () => {
    // Before the fix this threw `amount.trim is not a function` — not here, but
    // one call later, inside the validator that runs during render.
    const form = expenseFormFromRow(ROW)
    assert.doesNotThrow(() => validateExpenseForm(form, TODAY))
  })

  test('and every field of the form it produces is a STRING', () => {
    // The root cause in one assertion: ExpenseFormState is text, all of it.
    // Anything that is not a string here will meet a string method later.
    const form = expenseFormFromRow(ROW)
    for (const [key, value] of Object.entries(form)) {
      assert.equal(typeof value, 'string', `${key} must be text, got ${typeof value}`)
    }
  })

  test('the form is VALID, so Save changes is not dead either', () => {
    assert.deepEqual(validateExpenseForm(expenseFormFromRow(ROW), TODAY), {})
    assert.equal(isExpenseFormValid(expenseFormFromRow(ROW), TODAY), true)
  })
})

// ── The mapping ──────────────────────────────────────────────────────────────

describe('every existing value populates correctly', () => {
  const form = expenseFormFromRow(ROW)

  test('date, paid-to, payment mode, category and remark are the stored ones', () => {
    assert.equal(form.expenseDate, '2026-09-20')
    assert.equal(form.paidTo, 'MCD')
    assert.equal(form.paymentMode, 'cash')
    assert.equal(form.categoryId, '8a0b094a-ddfd-4f97-a204-ac96c983e5b1')
    assert.equal(form.remark, 'Sewage Cleaning')
  })

  test('THE AMOUNT IS THE SAME FIGURE, shown the way the list shows it', () => {
    assert.equal(form.amount, '1000.00')
  })

  test('a null remark opens as an empty field, and saves back as null', () => {
    const f = expenseFormFromRow({ ...ROW, remark: null })
    assert.equal(f.remark, '')
    assert.equal(expenseWritePayload(f).remark, null)
  })

  test('the write payload carries the corrected values, and the amount as text', () => {
    const payload = expenseWritePayload({ ...form, paidTo: 'MCD Ward 4' })
    assert.equal(payload.amount, '1000.00')
    assert.equal(payload.paid_to, 'MCD Ward 4')
    assert.equal(payload.expense_date, '2026-09-20')
    assert.equal(payload.payment_mode, 'cash')
  })
})

describe('expenseAmountText — the number/text boundary', () => {
  test('a whole number gains the two decimals an expense amount always has', () => {
    assert.equal(expenseAmountText(1000), '1000.00')
    assert.equal(expenseAmountText(0.5), '0.50')
    assert.equal(expenseAmountText(7), '7.00')
  })

  test('paise survive exactly', () => {
    assert.equal(expenseAmountText(850.5), '850.50')
    assert.equal(expenseAmountText(850.55), '850.55')
    assert.equal(expenseAmountText(1234567.89), '1234567.89')
  })

  test('IT NEVER ROUNDS — a third decimal is preserved for validation to refuse', () => {
    // Nothing is silently reshaped into a different figure. The form shows it
    // and says why it cannot be saved, exactly as if it had been typed.
    assert.equal(expenseAmountText(10.005), '10.005')
    assert.ok(validateExpenseForm(
      { ...emptyExpenseForm(TODAY), amount: expenseAmountText(10.005), paidTo: 'X', categoryId: 'c' },
      TODAY).amount)
  })

  test('IT NEVER REWRITES TEXT — a string is returned verbatim', () => {
    // A figure somebody typed reaches validation as typed.
    assert.equal(expenseAmountText('1000.00'), '1000.00')
    assert.equal(expenseAmountText('850.5'), '850.5')
    assert.equal(expenseAmountText('  12 '), '  12 ')
    assert.equal(expenseAmountText('not a number'), 'not a number')
  })

  test('a missing or impossible amount becomes an EMPTY field, never a zero', () => {
    // "I could not read an amount" and "the amount is nothing" must not be the
    // same answer. Empty makes the form say "Enter the amount paid."
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      assert.equal(expenseAmountText(value as number), '')
    }
    const form = { ...emptyExpenseForm(TODAY), amount: expenseAmountText(null), paidTo: 'X', categoryId: 'c' }
    assert.equal(validateExpenseForm(form, TODAY).amount, 'Enter the amount paid.')
  })

  test('it does not go through a double, so a large figure keeps its digits', () => {
    assert.equal(expenseAmountText('1234567890123.45'), '1234567890123.45')
  })
})

// ── The awkward rows ─────────────────────────────────────────────────────────

describe('an awkward row still opens safely rather than crashing', () => {
  const opens = (row: ExpenseRow) =>
    assert.doesNotThrow(() => validateExpenseForm(expenseFormFromRow(row), TODAY))

  test('an expense whose category is inactive keeps that category', () => {
    // The row names it; the form must not drop it. selectableCategories keeps a
    // retired category selectable when the form already holds it.
    const form = expenseFormFromRow(ROW)
    assert.equal(form.categoryId, ROW.category_id)
    opens(ROW)
  })

  test('an expense whose category no longer exists still opens', () => {
    const row = { ...ROW, category_id: '00000000-0000-0000-0000-0000000000ff' }
    opens(row)
    assert.equal(expenseFormFromRow(row).categoryId, '00000000-0000-0000-0000-0000000000ff')
  })

  test('an unknown payment mode opens, and is reported rather than replaced', () => {
    const row = { ...ROW, payment_mode: 'neft' }
    opens(row)
    assert.equal(expenseFormFromRow(row).paymentMode, 'neft', 'not silently swapped for Cash')
    assert.equal(validateExpenseForm(expenseFormFromRow(row), TODAY).paymentMode,
      'Choose how it was paid.')
  })

  test('NOT-NULL columns arriving null do not crash the render', () => {
    // These cannot happen — the columns are NOT NULL — but the cost of being
    // wrong was the whole page, so the mapping coerces instead of trusting.
    for (const row of [
      { ...ROW, paid_to: null as unknown as string },
      { ...ROW, amount: null as unknown as number },
      { ...ROW, expense_date: null as unknown as string },
      { ...ROW, payment_mode: null as unknown as string },
      { ...ROW, category_id: null as unknown as string },
    ]) opens(row)
  })

  test('and each of those is reported as a field to fill, not as a crash', () => {
    const errors = validateExpenseForm(
      expenseFormFromRow({ ...ROW, paid_to: null as unknown as string }), TODAY)
    assert.equal(errors.paidTo, 'Enter who was paid.')
  })
})

// ── What must not have changed ───────────────────────────────────────────────

describe('REGRESSION — Add is untouched by this fix', () => {
  test('a fresh form is still empty, and still refuses to save', () => {
    const fresh = emptyExpenseForm(TODAY)
    assert.equal(fresh.amount, '')
    assert.equal(fresh.paidTo, '')
    assert.equal(isExpenseFormValid(fresh, TODAY), false)
  })

  test('a typed amount is still stored exactly as typed', () => {
    const form = { ...emptyExpenseForm(TODAY), amount: '850.50', paidTo: 'Ramesh', categoryId: 'c' }
    assert.deepEqual(validateExpenseForm(form, TODAY), {})
    assert.equal(expenseWritePayload(form).amount, '850.50')
  })

  test('the amount rules are unchanged — still two decimals, still never rounded', () => {
    const over = { ...emptyExpenseForm(TODAY), amount: '10.005', paidTo: 'R', categoryId: 'c' }
    assert.ok(validateExpenseForm(over, TODAY).amount, 'a third decimal is still refused')
    const zero = { ...emptyExpenseForm(TODAY), amount: '0', paidTo: 'R', categoryId: 'c' }
    assert.ok(validateExpenseForm(zero, TODAY).amount, 'zero is still refused')
  })

  test('a future date is still refused', () => {
    const future = expenseFormFromRow({ ...ROW, expense_date: '2026-09-21' })
    assert.equal(validateExpenseForm(future, TODAY).expenseDate,
      'An expense cannot be dated in the future.')
  })
})
