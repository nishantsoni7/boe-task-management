/**
 * AN AMOUNT IS NEVER TRUNCATED (launch audit, 2026-09-19, PR #172).
 *
 * The amount inputs used to strip every character but digits and one dot and
 * cut the fraction to two digits, so TYPING or PASTING "1000.005" left
 * "1000.00" in the field — a different amount, silently. Now the text stays as
 * entered, every payment surface refuses it, and the field says why.
 *
 * TYPING is simulated keystroke by keystroke, and PASTING as one change event,
 * through the exact function every input's onChange calls; then the real
 * /finance AmountInput is rendered with the result, and every surface's
 * validator is asked for its verdict.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AMOUNT_NOT_A_NUMBER,
  AMOUNT_TOO_MANY_DECIMALS,
  amountInputProblem,
  groupIndianDigits,
  isValidAmount,
  sanitizeAmountInput,
} from '@/lib/currency'
import { AmountInput } from './components/AmountInput'
import { validatePiPaymentForm, type PiPaymentFormState } from '@/lib/finance/piPaymentView'
import { splitPaymentBlockedReason } from '@/lib/finance/splitPaymentEntry'

/** One keystroke at a time, as a controlled <input> receives them. */
function type(text: string, start = ''): string {
  let value = start
  for (const ch of text) value = sanitizeAmountInput(value + ch)
  return value
}
/** A paste replaces the selection with the clipboard in ONE change event. */
const paste = (clipboard: string, before = '') => sanitizeAmountInput(before + clipboard)

const render = (value: string) =>
  renderToStaticMarkup(createElement(AmountInput, { value, onChange: () => {} }))

describe('typing and pasting 1000.005', () => {
  for (const [how, value] of [['typed', type('1000.005')], ['pasted', paste('1000.005')], ['pasted after 1000', paste('.005', '1000')]] as const) {
    test(`${how}: the field keeps 1000.005, refuses it and says why`, () => {
      assert.equal(value, '1000.005', 'never 1000.00, never 1000.01')
      assert.equal(isValidAmount(value), false)
      assert.equal(amountInputProblem(value), AMOUNT_TOO_MANY_DECIMALS)
      const html = render(value)
      assert.ok(html.includes('value="1000.005"'), 'the input shows exactly what was entered')
      assert.ok(html.includes('aria-invalid="true"'))
      assert.ok(html.includes('role="alert"') && html.includes('Nothing has been rounded'))
    })
  }

  test('the grouped display never rounds it either', () => {
    assert.equal(groupIndianDigits('1000.005'), '1000.005')
    assert.equal(groupIndianDigits('1000000.5'), '10,00,000.5')
  })

  test('every payment surface refuses it', () => {
    const pi = validatePiPaymentForm(
      { amount: '1000.005', paymentDate: '2026-09-19', paymentMode: 'hdfc', reference: '', remarks: '' } as PiPaymentFormState,
      '2026-09-19')
    assert.ok(pi.amount, 'PI payment')
    const split = splitPaymentBlockedReason({
      amount: '1000.005', paymentDate: '2026-09-19', paymentMode: 'hdfc', destination: 'suspense', rows: [],
    } as never)
    assert.equal(split, AMOUNT_TOO_MANY_DECIMALS, 'Record Payment names the reason')
  })

  test('the surfaces without a reason line of their own show it inline, at once', () => {
    const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
    // The PI form's button is disabled while the amount is wrong, so a message
    // that waited for a press would never appear.
    const pi = read('src/components/orders/PiPaymentCard.tsx')
    assert.ok(pi.includes('const amountMessage = amountInputProblem(form.amount) ?? (touched ? errors.amount ?? null : null)'))
    assert.ok(pi.includes('{amountMessage && <div role="alert" style={ERR}>{amountMessage}</div>}'))
    // The Received Payments edit form.
    const edit = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(edit.includes('{amountInputProblem(form.amount)}'))
  })
})

describe('what still works exactly as before', () => {
  for (const ok of ['1000', '1000.5', '1000.50', '.5', '12.']) {
    test(`${ok} is kept as typed and accepted`, () => {
      assert.equal(type(ok), ok)
      assert.equal(paste(ok), ok)
      assert.equal(isValidAmount(ok), true)
      assert.equal(amountInputProblem(ok), null)
      assert.ok(!render(ok).includes('role="alert"'))
    })
  }

  test('formatting that cannot change the figure is removed: ₹, spaces, grouping commas', () => {
    assert.equal(paste('₹10,00,000.50'), '1000000.50')
    assert.equal(paste(' 2 500 '), '2500')
    assert.equal(isValidAmount(paste('₹10,00,000.50')), true)
  })
})

describe('anything else stays visible and is refused — never re-read as another amount', () => {
  const CASES: [string, string][] = [
    ['1.2.3', AMOUNT_NOT_A_NUMBER],   // used to become 1.23
    ['-500', AMOUNT_NOT_A_NUMBER],    // used to become 500
    ['1e5', AMOUNT_NOT_A_NUMBER],     // used to become 15
    ['12a', AMOUNT_NOT_A_NUMBER],     // used to become 12
    ['12.345', AMOUNT_TOO_MANY_DECIMALS],
  ]
  for (const [entered, problem] of CASES) {
    test(`${entered}`, () => {
      assert.equal(type(entered), entered)
      assert.equal(paste(entered), entered)
      assert.equal(isValidAmount(entered), false)
      assert.equal(amountInputProblem(entered), problem)
    })
  }

  test('an incomplete entry is not scolded', () => {
    assert.equal(amountInputProblem(''), null)
    assert.equal(amountInputProblem('.'), null)
  })
})
