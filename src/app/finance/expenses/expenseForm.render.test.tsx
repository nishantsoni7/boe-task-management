/**
 * THE EXPENSE FORM AND THE EXPENSE LIST, RENDERED.
 *
 * Both components are mounted through react-dom/server, the same way
 * amountEntry.render.test.tsx renders the shared AmountInput — so what is
 * asserted is the markup a browser receives, not a description of it.
 *
 * WHAT A SERVER RENDER SETTLES, AND WHAT IT DOES NOT. Effects do not run, so
 * this is the FIRST FRAME: no measurement has happened and no microphone has
 * been detected. That is exactly the frame worth pinning — the one where a
 * responsive list must not already be scrolling sideways, and where a browser
 * without speech recognition must already be usable. Behaviour that needs a real
 * DOM (pressing Save, opening the category modal) is covered by the rules tests
 * over the pure functions those handlers call, and by the manual pass.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpenseForm } from './ExpenseForm'
import {
  ExpenseList, ExpenseTable, expenseListMode,
  EXPENSE_TABLE_MIN_CONTAINER_PX, EXPENSE_TABLE_COLUMNS, EXPENSE_FLEX_COLUMN_MIN_PX,
} from './ExpensesView'
import type { ExpenseCategory, ExpenseListRow, ExpenseRow } from '@/lib/finance/expenses'
import { VOICE_UNSUPPORTED_MESSAGE } from '@/lib/finance/expenseVoice'

const CATEGORIES: ExpenseCategory[] = [
  { id: 'cat-1', name: 'Diesel', is_active: true },
  { id: 'cat-2', name: 'Transport', is_active: true },
  { id: 'cat-3', name: 'Retired Thing', is_active: false },
]

const ROW: ExpenseRow = {
  id: 'exp-1', expense_date: '2026-09-18', amount: '850.50', payment_mode: 'upi',
  paid_to: 'Sharma Ji', category_id: 'cat-1', remark: 'welding machine',
  created_by: 'user-1', created_at: '2026-09-18T10:00:00Z',
  updated_at: '2026-09-18T10:00:00Z', updated_by: null,
}

// The form never calls Supabase during a render; a stub satisfies the type.
const supabase = {} as Parameters<typeof ExpenseForm>[0]['supabase']

const renderForm = (over: Partial<Parameters<typeof ExpenseForm>[0]> = {}) =>
  renderToStaticMarkup(createElement(ExpenseForm, {
    supabase,
    userId: 'user-1',
    mode: 'add',
    categories: CATEGORIES,
    onCategoryCreated: () => {},
    onSaved: () => {},
    onCancel: () => {},
    ...over,
  }))

const listRow = (over: Partial<ExpenseListRow> = {}): ExpenseListRow =>
  ({ ...ROW, category_name: null, created_by_name: null, ...over })

const renderList = (over: Partial<Parameters<typeof ExpenseList>[0]> = {}) =>
  renderToStaticMarkup(createElement(ExpenseList, {
    rows: [listRow()],
    loading: false,
    error: null,
    narrowed: false,
    categoryName: (id: string) => CATEGORIES.find(c => c.id === id)?.name ?? '—',
    personName: () => 'Nishant',
    mayEdit: () => true,
    onEdit: () => {},
    onClearFilters: () => {},
    ...over,
  }))

// ── The form ─────────────────────────────────────────────────────────────────

describe('the Add form renders every required field, and nothing more', () => {
  const html = renderForm()

  test('the six fields the requirement names are all present', () => {
    for (const id of [
      'expense-date', 'expense-paid-to',
      'expense-category', 'expense-mode', 'expense-remark',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `${id} is missing`)
    }
    // The amount is the SHARED Finance AmountInput. It draws its own <input> and
    // takes no id, so it is found by the one attribute only it sets.
    assert.ok(html.includes('inputMode="decimal"'), 'the amount field is missing')
  })

  test('and no field beyond them', () => {
    // Phase 1 asks for exactly these. A receipt upload, a GST field, an approver
    // or a vendor picker appearing here would be scope, not a detail.
    const ids = [...html.matchAll(/id="(expense-[a-z-]+)"/g)].map(m => m[1]).sort()
    assert.deepEqual(ids, [
      'expense-category', 'expense-date',
      'expense-mode', 'expense-paid-to', 'expense-remark',
    ])
    assert.equal((html.match(/inputMode="decimal"/g) ?? []).length, 1, 'exactly one amount')
    assert.equal(/type="file"/.test(html), false, 'no receipt upload in Phase 1')
  })

  test('every field is announced — five by id, the amount by containment', () => {
    for (const id of [
      'expense-date', 'expense-paid-to',
      'expense-category', 'expense-mode', 'expense-remark',
    ]) {
      assert.ok(html.includes(`for="${id}"`), `${id} has no label`)
    }
    // THE AMOUNT'S LABEL CONTAINS ITS INPUT — an implicit association, because
    // AmountInput takes no id and a `for` pointing at a non-existent one would
    // leave the field unnamed while looking correct in the source.
    // [\s\S] rather than the dotAll flag: tsconfig targets ES2017, where /s is
    // a compile error (see the note on BigInt literals in exactMoney.ts).
    assert.ok(
      /<label[^>]*>(?:(?!<\/label>)[\s\S])*Amount \(₹\)(?:(?!<\/label>)[\s\S])*inputMode="decimal"/
        .test(html),
      'the amount input sits inside its own label')
  })

  test('THE DATE DEFAULTS TO TODAY and cannot be set in the future', () => {
    const value = /id="expense-date"[^>]*value="(\d{4}-\d{2}-\d{2})"/.exec(html)
    const max = /id="expense-date"[^>]*max="(\d{4}-\d{2}-\d{2})"/.exec(html)
    assert.ok(value, 'the date field carries a value')
    assert.ok(max, 'the date field carries a maximum')
    assert.equal(value![1], max![1], 'both are today, in the reader\'s own time zone')
  })

  test('THE AMOUNT USES A NUMERIC MOBILE KEYBOARD', () => {
    // inputMode="decimal" is what AmountInput sets; this asserts the expense
    // form actually mounts it rather than a plain text input of its own.
    assert.ok(html.includes('inputMode="decimal"'))
  })

  test('the payment mode offers the seven outgoing routes, not the BOE accounts', () => {
    for (const label of ['Cash', 'UPI', 'Bank Transfer', 'Credit Card', 'Debit Card', 'Cheque', 'Other']) {
      assert.ok(html.includes(`>${label}</option>`), `${label} is missing`)
    }
    for (const account of ['HDFC', 'PNB', 'Paytm', 'Canara']) {
      assert.equal(html.includes(`>${account}</option>`), false,
        `${account} names an account money arrives INTO and has no place on an expense`)
    }
  })

  test('the category picker offers the active categories and an Add action', () => {
    assert.ok(html.includes('>Diesel</option>'))
    assert.ok(html.includes('>Transport</option>'))
    assert.equal(html.includes('>Retired Thing</option>'), false,
      'a retired category is not offered for a NEW expense')
    assert.ok(html.includes('aria-label="Add category"'))
  })

  test('an expense already naming a retired category can still be corrected', () => {
    const edit = renderForm({
      mode: 'edit',
      expense: { ...ROW, category_id: 'cat-3' },
    })
    assert.ok(edit.includes('>Retired Thing</option>'),
      'the category it holds stays selectable, so an edit cannot silently change it')
  })

  test('the required fields are marked, and the optional one says so', () => {
    assert.equal((html.match(/aria-hidden="true">\*<\/span>/g) ?? []).length, 5,
      'date, amount, paid to, category and mode — the remark is not required')
    assert.ok(html.includes('Optional'))
  })

  test('nothing is in an error state before anybody has pressed Save', () => {
    assert.equal(html.includes('role="alert"'), false)
    assert.equal(html.includes('aria-invalid="true"'), false)
  })

  test('the primary action says what it will do', () => {
    assert.ok(html.includes('>Save expense</button>'))
    assert.ok(html.includes('>Cancel</button>'))
  })
})

describe('the Edit form is clearly a correction of an existing entry', () => {
  const html = renderForm({ mode: 'edit', expense: ROW })

  test('it opens on the stored values, exactly as stored', () => {
    assert.ok(html.includes('value="2026-09-18"'))
    assert.ok(html.includes('value="850.50"') || html.includes('value="850.5"'))
    assert.ok(html.includes('value="Sharma Ji"'))
    assert.ok(html.includes('value="welding machine"'))
  })

  test('the action word is different from Add', () => {
    assert.ok(html.includes('>Save changes</button>'))
    assert.equal(html.includes('>Save expense</button>'), false)
  })

  test('"Save & add another" belongs to Add only', () => {
    assert.equal(/Save (&amp;|&) add another/.test(html), false)
    assert.ok(/Save (&amp;|&) add another/.test(renderForm({ showSaveAndAddAnother: true })))
  })
})

describe('a browser with no speech recognition', () => {
  // The server snapshot of useVoiceSupported is false, which is precisely the
  // case this asserts: Firefox, most iOS browsers, and the first frame anywhere.
  const html = renderForm()

  test('NO MICROPHONE IS DRAWN', () => {
    assert.equal(html.includes('aria-label="Fill this form by voice"'), false)
    assert.equal(html.includes('>Speak'), false)
  })

  test('one short, helpful line says so', () => {
    assert.ok(html.includes(VOICE_UNSUPPORTED_MESSAGE))
    assert.ok(VOICE_UNSUPPORTED_MESSAGE.includes('everything still works'))
  })

  test('AND THE FORM IS COMPLETELY USABLE', () => {
    for (const id of ['expense-date', 'expense-paid-to',
                      'expense-category', 'expense-mode', 'expense-remark']) {
      assert.ok(html.includes(`id="${id}"`))
    }
    assert.ok(html.includes('inputMode="decimal"'))
    assert.ok(html.includes('>Save expense</button>'))
    assert.equal(html.includes('disabled'), false, 'nothing is disabled by the absence of voice')
  })
})

// ── The list ─────────────────────────────────────────────────────────────────

describe('table or cards, by the room actually available', () => {
  test('the rule, stated once', () => {
    assert.equal(expenseListMode(null), 'cards', 'before measurement, the layout that always fits')
    assert.equal(expenseListMode(360), 'cards')
    assert.equal(expenseListMode(390), 'cards')
    // The widths a real window leaves this list, beside the fixed 260px sidebar.
    assert.equal(expenseListMode(720), 'cards', '1024px window — cards, not a clipped table')
    assert.equal(expenseListMode(768), 'cards')
    assert.equal(expenseListMode(EXPENSE_TABLE_MIN_CONTAINER_PX - 1), 'cards')
    assert.equal(expenseListMode(EXPENSE_TABLE_MIN_CONTAINER_PX), 'table')
    assert.equal(expenseListMode(976), 'table', '1280px window — the table fits')
    assert.equal(expenseListMode(1200), 'table')
  })

  test('THE THRESHOLD IS THE ARITHMETIC OF THE COLUMNS, not a guess', () => {
    // The first version of this number was 720 — the container a 1024px window
    // leaves — which is what the LIST has, not what the TABLE needs. At 720 the
    // two flexible columns shared about 50px and the payee truncated to nothing.
    const fixed = EXPENSE_TABLE_COLUMNS
      .filter(c => 'width' in c)
      .reduce((sum, c) => sum + parseInt((c as { width: string }).width, 10), 0)
    const flexible = EXPENSE_TABLE_COLUMNS.filter(c => !('width' in c))
    assert.equal(flexible.length, 2, 'Paid to and Remark share the remainder')
    assert.ok(EXPENSE_TABLE_MIN_CONTAINER_PX - fixed >= EXPENSE_FLEX_COLUMN_MIN_PX * 2 - 10,
      'the threshold leaves both flexible columns a readable width')
    assert.equal(EXPENSE_TABLE_MIN_CONTAINER_PX, 930,
      'the same switch width as the Confirmed Payments table')
  })

  test('THE FIRST FRAME IS CARDS, so nothing can scroll sideways before measuring', () => {
    const html = renderList()
    assert.ok(html.includes('data-expense-list="cards"'))
    assert.equal(html.includes('<table'), false)
  })
})

describe('the desktop table', () => {
  const html = renderToStaticMarkup(createElement(ExpenseTable, {
    rows: [listRow()],
    loading: false,
    error: null,
    narrowed: false,
    categoryName: (id: string) => CATEGORIES.find(c => c.id === id)?.name ?? '—',
    personName: () => 'Nishant',
    mayEdit: () => true,
    onEdit: () => {},
    onClearFilters: () => {},
  }))

  test('every column the requirement names has a header, in order', () => {
    const headers = [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1])
    assert.deepEqual(headers,
      ['Date', 'Amount', 'Paid to', 'Category', 'Mode', 'Remark', 'Recorded by', 'Actions'])
    assert.deepEqual(headers, EXPENSE_TABLE_COLUMNS.map(c => c.label),
      'the header row is drawn from the column list the threshold is computed from')
  })

  test('the layout is fixed, so a long value truncates instead of widening the table', () => {
    assert.ok(/table-layout:fixed/.test(html.replace(/\s/g, '')))
    assert.ok(/text-overflow:ellipsis/.test(html.replace(/\s/g, '')))
  })

  test('a row prints every field, and the full remark is available on hover', () => {
    assert.ok(html.includes('₹850.50'))
    assert.ok(/18 Sept? 2026/.test(html))
    assert.ok(html.includes('Sharma Ji'))
    assert.ok(html.includes('Diesel'))
    assert.ok(html.includes('UPI'))
    assert.ok(html.includes('title="welding machine"'), 'the compact cell keeps the whole text')
    assert.ok(html.includes('Nishant'))
  })

  test('a row with no remark prints a dash, not an empty cell', () => {
    const empty = renderToStaticMarkup(createElement(ExpenseTable, {
      rows: [listRow({ remark: null })], loading: false, error: null, narrowed: false,
      categoryName: () => 'Diesel', personName: () => 'Nishant',
      mayEdit: () => true, onEdit: () => {}, onClearFilters: () => {},
    }))
    assert.ok(empty.includes('—'))
  })
})

describe('what a row shows', () => {
  const html = renderList()

  test('the amount is Indian currency with both paise', () => {
    assert.ok(html.includes('₹850.50'))
  })

  test('the date is Indian presentation, not ISO', () => {
    // en-IN, day-month-year, the same toLocaleDateString options the Confirmed
    // Payments list uses — so the two Finance lists print a date identically.
    assert.ok(/18 Sept? 2026/.test(html), html.slice(0, 200))
    assert.equal(html.includes('2026-09-18'), false)
  })

  test('payee, category, mode, remark and recorder are all on the card', () => {
    assert.ok(html.includes('Sharma Ji'))
    assert.ok(html.includes('Diesel'))
    assert.ok(html.includes('UPI'))
    assert.ok(html.includes('welding machine'))
    assert.ok(html.includes('Nishant'))
  })

  test('Edit is offered, and named for a screen reader', () => {
    assert.ok(html.includes('>Edit</button>'))
    assert.ok(html.includes('aria-label="Correct the expense of ₹850.50 paid to Sharma Ji"'))
  })

  test('Edit is absent on a row this person may not correct', () => {
    const html2 = renderList({ mayEdit: () => false })
    assert.equal(html2.includes('>Edit</button>'), false)
  })

  test('NOTHING OFFERS DELETION', () => {
    assert.equal(/>Delete</.test(html), false)
    assert.equal(/>Remove</.test(html), false)
  })

  test('a row with no remark prints nothing rather than an empty line', () => {
    const html2 = renderList({ rows: [listRow({ remark: null })] })
    assert.equal(html2.includes('welding machine'), false)
    assert.ok(html2.includes('Sharma Ji'))
  })
})

describe('the four list states are distinguishable', () => {
  test('loading', () => {
    assert.ok(renderList({ loading: true, rows: [] }).includes('Loading expenses…'))
  })

  test('A FAILED READ IS NOT AN EMPTY LIST', () => {
    const html = renderList({ error: 'The expenses could not be loaded. Use Refresh to try again.', rows: [] })
    assert.ok(html.includes('could not be loaded'))
    assert.equal(html.includes('No expenses recorded yet.'), false,
      '"nothing here" and "we could not read it" must never be the same sentence')
  })

  test('genuinely empty', () => {
    const html = renderList({ rows: [] })
    assert.ok(html.includes('No expenses recorded yet.'))
    assert.ok(html.includes('Use Add Expense to record the first one.'))
  })

  test('empty because of the filters, with the way out', () => {
    const html = renderList({ rows: [], narrowed: true })
    assert.ok(html.includes('No expenses match these filters.'))
    assert.ok(html.includes('>Clear filters</button>'))
  })
})

describe('tap targets on a phone', () => {
  test('every control in the form clears 44px', () => {
    const html = renderForm()
    // Each button carries an explicit min-height; the shared .boe-btn rule sets
    // 44px below 768px anyway, and these do not fight it.
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(m => m[0])
    assert.ok(buttons.length >= 3)
    for (const button of buttons) {
      assert.ok(/min-height:4[04]px/.test(button.replace(/\s/g, '')),
        `a control without an explicit tap height: ${button.slice(0, 90)}`)
    }
  })
})
