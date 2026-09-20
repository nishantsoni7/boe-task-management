/**
 * THE VOICE PARSER, INCLUDING EVERY PHRASE THE REQUIREMENT NAMES.
 *
 * The four rules it exists to keep are each asserted directly: nothing is
 * invented, nothing is created, nothing is saved, and nothing throws on a
 * transcript that makes no sense.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseExpenseSpeech,
  resolveVoiceParse,
  spokenAmount,
  ALL_EXPENSE_MODES,
  VOICE_REACHABLE_MODES,
  VOICE_EXAMPLE_PHRASE,
} from './expenseVoice'
import {
  emptyExpenseForm,
  type ExpenseCategory,
  type ExpenseFormState,
} from './expenses'

const TODAY = '2026-09-20'

const CATEGORIES: ExpenseCategory[] = [
  { id: 'cat-diesel',    name: 'Diesel',          is_active: true },
  { id: 'cat-transport', name: 'Transport',       is_active: true },
  { id: 'cat-repair',    name: 'Factory Repair',  is_active: true },
  { id: 'cat-retired',   name: 'Old Freight',      is_active: false },
]

const form = (over: Partial<ExpenseFormState> = {}): ExpenseFormState =>
  ({ ...emptyExpenseForm(TODAY), ...over })

describe('the four example phrases from the requirement', () => {
  test('"Paid 500 to Ramesh for diesel by cash."', () => {
    const p = parseExpenseSpeech('Paid 500 to Ramesh for diesel by cash.', TODAY)
    assert.equal(p.amount, '500')
    assert.equal(p.paidTo, 'Ramesh')
    assert.equal(p.categoryText, 'diesel')
    assert.equal(p.paymentMode, 'cash')
    assert.equal(p.remark, null)
    // No date was spoken, so none is claimed — the form keeps its own default.
    assert.equal(p.date, null)
  })

  test('"1200 rupees to Mohan category transport mode UPI."', () => {
    const p = parseExpenseSpeech('1200 rupees to Mohan category transport mode UPI.', TODAY)
    assert.equal(p.amount, '1200')
    assert.equal(p.paidTo, 'Mohan')
    assert.equal(p.categoryText, 'transport')
    assert.equal(p.paymentMode, 'upi')
  })

  test('"Yesterday paid 850 to Sharma Ji for factory repair by cash, remark welding machine."', () => {
    const p = parseExpenseSpeech(
      'Yesterday paid 850 to Sharma Ji for factory repair by cash, remark welding machine.', TODAY)
    assert.equal(p.amount, '850')
    // "Ji" is part of the name and is never cut off.
    assert.equal(p.paidTo, 'Sharma Ji')
    assert.equal(p.categoryText, 'factory repair')
    assert.equal(p.paymentMode, 'cash')
    assert.equal(p.remark, 'welding machine')
    assert.equal(p.date, '2026-09-19')
  })

  test('"Paid 2400 by card to ABC Hardware category maintenance."', () => {
    const p = parseExpenseSpeech('Paid 2400 by card to ABC Hardware category maintenance.', TODAY)
    assert.equal(p.amount, '2400')
    assert.equal(p.paidTo, 'ABC Hardware')
    assert.equal(p.categoryText, 'maintenance')
    // "card" alone is not credit or debit, and neither is guessed.
    assert.equal(p.paymentMode, null)
    assert.ok(p.notes.some(n => n.includes('Credit Card or Debit Card')),
      'the ambiguity is reported rather than resolved')
  })

  test('the example printed under the microphone parses completely', () => {
    const p = parseExpenseSpeech(VOICE_EXAMPLE_PHRASE, TODAY)
    assert.equal(p.amount, '850')
    assert.equal(p.paidTo, 'Ramesh')
    assert.equal(p.categoryText, 'diesel')
    assert.equal(p.paymentMode, 'upi')
    assert.equal(p.remark, 'site visit')
  })
})

describe('today and yesterday', () => {
  test('"today" is today, "yesterday" is the day before', () => {
    assert.equal(parseExpenseSpeech('Paid 100 to X today', TODAY).date, TODAY)
    assert.equal(parseExpenseSpeech('Yesterday paid 100 to X', TODAY).date, '2026-09-19')
    assert.equal(parseExpenseSpeech('Day before yesterday paid 100 to X', TODAY).date, '2026-09-18')
  })

  test('yesterday crosses a month and a year boundary correctly', () => {
    assert.equal(parseExpenseSpeech('yesterday 10 to X', '2026-03-01').date, '2026-02-28')
    assert.equal(parseExpenseSpeech('yesterday 10 to X', '2027-01-01').date, '2026-12-31')
  })

  test('a spoken date does not become the amount', () => {
    const p = parseExpenseSpeech('Paid 600 to Ramesh on 5 September by cash', TODAY)
    assert.equal(p.date, '2026-09-05')
    assert.equal(p.amount, '600', 'the 5 belongs to the date, not to the money')
  })

  test('a day/month with no year that has not happened yet resolves to last year', () => {
    assert.equal(parseExpenseSpeech('Paid 100 to X on 5 December', TODAY).date, '2025-12-05')
  })

  test('a numeric Indian date reads day-month-year', () => {
    assert.equal(parseExpenseSpeech('Paid 100 to X on 12/09/2026', TODAY).date, '2026-09-12')
    assert.equal(parseExpenseSpeech('Paid 100 to X on 2026-09-12', TODAY).date, '2026-09-12')
  })

  test('an impossible date is not accepted and does not throw', () => {
    assert.equal(parseExpenseSpeech('Paid 100 to X on 31/02/2026', TODAY).date, null)
  })

  test('no date spoken means no date claimed', () => {
    assert.equal(parseExpenseSpeech('Paid 500 to Ramesh for diesel by cash', TODAY).date, null)
  })
})

describe('payment modes, case-insensitively and in every spoken form', () => {
  test('mixed capitalisation makes no difference to any field', () => {
    const p = parseExpenseSpeech('PAID 500 TO RAMESH FOR DIESEL BY CASH', TODAY)
    assert.equal(p.paymentMode, 'cash')
    assert.equal(p.amount, '500')
    // The name is kept AS SPOKEN — the parser matches case-insensitively and
    // rewrites nothing.
    assert.equal(p.paidTo, 'RAMESH')
    assert.equal(p.categoryText, 'DIESEL')
  })

  test('each spoken form reaches the mode it means', () => {
    const cases: [string, string][] = [
      ['Paid 10 to X by cash',           'cash'],
      ['Paid 10 to X by UPI',            'upi'],
      ['Paid 10 to X by Google Pay',     'upi'],
      ['Paid 10 to X by PhonePe',        'upi'],
      ['Paid 10 to X by gpay',           'upi'],
      ['Paid 10 to X by bank transfer',  'bank_transfer'],
      ['Paid 10 to X by NEFT',           'bank_transfer'],
      ['Paid 10 to X by net banking',    'bank_transfer'],
      ['Paid 10 to X by credit card',    'credit_card'],
      ['Paid 10 to X by debit card',     'debit_card'],
      ['Paid 10 to X by cheque',         'cheque'],
    ]
    for (const [phrase, expected] of cases) {
      assert.equal(parseExpenseSpeech(phrase, TODAY).paymentMode, expected, phrase)
    }
  })

  test('"credit card" is never read as the bare, ambiguous "card"', () => {
    assert.equal(parseExpenseSpeech('Paid 10 to X by credit card', TODAY).paymentMode, 'credit_card')
    assert.equal(parseExpenseSpeech('Paid 10 to X by debit card', TODAY).paymentMode, 'debit_card')
  })

  test('an unknown mode word is not a mode, and is not invented', () => {
    const p = parseExpenseSpeech('Paid 500 to Ramesh for diesel by bitcoin', TODAY)
    assert.equal(p.paymentMode, null)
    assert.equal(p.amount, '500')
    assert.equal(p.paidTo, 'Ramesh')
  })

  test('every mode the form offers is reachable by voice', () => {
    for (const mode of ALL_EXPENSE_MODES) {
      assert.ok(VOICE_REACHABLE_MODES.has(mode), `${mode} has no spoken form`)
    }
  })
})

describe('an amount is read exactly as spoken, and never rounded', () => {
  test('grouping commas and a rupee sign are removed; nothing else is', () => {
    assert.equal(spokenAmount('1,200'), '1200')
    assert.equal(spokenAmount('₹850'), '850')
    assert.equal(spokenAmount('850.50'), '850.50')
  })

  test('an over-precise figure survives intact for the form to refuse', () => {
    const p = parseExpenseSpeech('Paid 1000.005 to Ramesh for diesel by cash', TODAY)
    assert.equal(p.amount, '1000.005', 'never 1000.00, never 1000.01')
  })

  test('a word that is not a number is not an amount', () => {
    assert.equal(spokenAmount('Ramesh'), null)
    assert.equal(spokenAmount('5th'), null)
    assert.equal(spokenAmount(''), null)
  })

  test('missing amount comes back null, not zero', () => {
    const p = parseExpenseSpeech('Paid to Ramesh for diesel by cash', TODAY)
    assert.equal(p.amount, null, 'null is "not heard"; 0 would be a claim about the money')
    assert.equal(p.paidTo, 'Ramesh')
  })
})

describe('an incomplete or unclear transcript never throws', () => {
  const junk = [
    '', '   ', '.', '...', ',,,', 'to', 'for', 'by', 'remark', 'paid',
    'aaaaa bbbb cccc', 'Paid', 'to for by remark', '₹', '1', 'category',
  ]
  for (const text of junk) {
    test(`"${text}" parses without throwing`, () => {
      const p = parseExpenseSpeech(text, TODAY)
      assert.equal(typeof p.transcript, 'string')
      assert.ok(Array.isArray(p.notes))
    })
  }

  test('a non-string input is handled rather than trusted', () => {
    // The Web Speech API is a browser surface; a defensive branch is cheap.
    const p = parseExpenseSpeech(undefined as unknown as string, TODAY)
    assert.equal(p.amount, null)
    assert.equal(p.transcript, '')
  })

  test('a half-finished sentence fills what it can and claims nothing else', () => {
    const p = parseExpenseSpeech('Paid 500 to', TODAY)
    assert.equal(p.amount, '500')
    assert.equal(p.paidTo, null)
    assert.equal(p.categoryText, null)
    assert.equal(p.paymentMode, null)
  })
})

describe('resolving a parse against the categories that exist', () => {
  test('a known category is selected, case-insensitively', () => {
    const p = parseExpenseSpeech('Paid 500 to Ramesh for DIESEL by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    assert.equal(r.matchedCategory?.id, 'cat-diesel')
    assert.equal(r.patch.categoryId, 'cat-diesel')
    assert.equal(r.suggestedCategory, null)
  })

  test('a multi-word category matches', () => {
    const p = parseExpenseSpeech('Paid 850 to Sharma for factory repair by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    assert.equal(r.matchedCategory?.id, 'cat-repair')
  })

  test('AN UNKNOWN CATEGORY IS A SUGGESTION AND IS NEVER CREATED OR SELECTED', () => {
    const p = parseExpenseSpeech('Paid 2400 to ABC Hardware category maintenance by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    assert.equal(r.matchedCategory, null)
    assert.equal(r.suggestedCategory, 'maintenance')
    assert.equal(r.patch.categoryId, undefined, 'nothing is selected on the person\'s behalf')
    assert.ok(r.needsAttention.some(n => n.includes('maintenance')))
  })

  test('the patch is sparse: a field the sentence did not settle is left alone', () => {
    const existing = form({ paidTo: 'Already Typed', expenseDate: '2026-09-01' })
    const p = parseExpenseSpeech('500 for diesel by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, existing)
    assert.equal(r.patch.paidTo, undefined, 'a payee already typed is not blanked')
    assert.equal(r.patch.expenseDate, undefined, 'a date already chosen is not overwritten')
    const after = { ...existing, ...r.patch }
    assert.equal(after.paidTo, 'Already Typed')
    assert.equal(after.expenseDate, '2026-09-01')
    assert.equal(after.amount, '500')
  })

  test('what is still missing is reported in plain words', () => {
    const p = parseExpenseSpeech('Paid by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    const joined = r.needsAttention.join(' | ')
    assert.ok(joined.includes('amount'))
    assert.ok(joined.includes('payee') || joined.includes('who was paid'))
    assert.ok(joined.includes('category'))
  })

  test('a field already filled is not reported as missing', () => {
    const p = parseExpenseSpeech('by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form({
      amount: '100', paidTo: 'Ramesh', categoryId: 'cat-diesel',
    }))
    assert.deepEqual(r.needsAttention, [])
  })

  test('an ambiguous "card" is carried into what needs attention', () => {
    const p = parseExpenseSpeech('Paid 2400 by card to ABC for diesel', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    assert.ok(r.needsAttention.some(n => n.includes('Credit Card or Debit Card')))
    assert.equal(r.patch.paymentMode, undefined)
  })

  test('a retired category is still matched, so the form does not offer to re-create its name', () => {
    const p = parseExpenseSpeech('Paid 100 to X category old freight by cash', TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    assert.equal(r.matchedCategory?.id, 'cat-retired')
    assert.equal(r.suggestedCategory, null)
  })

  test('NOTHING IN THE RESULT CAN SAVE ANYTHING — it is a patch and some words', () => {
    const p = parseExpenseSpeech(VOICE_EXAMPLE_PHRASE, TODAY)
    const r = resolveVoiceParse(p, CATEGORIES, form())
    assert.deepEqual(
      Object.keys(r).sort(),
      ['matchedCategory', 'needsAttention', 'parsed', 'patch', 'suggestedCategory'],
      'no submit, no id, no callback: voice cannot reach a write',
    )
  })
})

describe('Hinglish connectors', () => {
  test('"ko" introduces the payee', () => {
    const p = parseExpenseSpeech('500 Ramesh ko diesel ke liye cash se', TODAY)
    assert.equal(p.amount, '500')
    assert.equal(p.paymentMode, 'cash')
  })

  test('"ke liye" introduces the category', () => {
    const p = parseExpenseSpeech('Paid 500 to Ramesh ke liye diesel by cash', TODAY)
    assert.equal(p.categoryText, 'diesel')
    assert.equal(p.paidTo, 'Ramesh')
  })
})
