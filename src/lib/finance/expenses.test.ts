/**
 * THE EXPENSE RULES, and the two places they must agree with the database.
 *
 * Every validation here has a CHECK constraint behind it in
 * 20261220000000_finance_expenses.sql. The last suite reads that migration and
 * asserts the pair still say the same thing — a browser rule that has drifted
 * from its constraint produces a form that saves and then fails.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATEGORY_NAME_MAX,
  DEFAULT_EXPENSE_PAYMENT_MODE,
  EMPTY_EXPENSE_FILTERS,
  EXPENSE_PAYMENT_MODES,
  EXPENSE_PAYMENT_MODE_VALUES,
  PAID_TO_MAX,
  REMARK_MAX,
  categoryKey,
  categoryNameProblem,
  emptyExpenseForm,
  expenseFiltersActive,
  expenseFormFromRow,
  expensePaymentModeLabel,
  expenseSearchClause,
  expenseTotal,
  expenseWritePayload,
  findCategoryByName,
  isExpenseFormValid,
  isExpensePaymentMode,
  normalizeCategoryName,
  orderedDateRange,
  selectableCategories,
  validateExpenseForm,
  type ExpenseCategory,
  type ExpenseFormState,
  type ExpenseRow,
} from './expenses'

const TODAY = '2026-09-20'
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = read('supabase/migrations/20261220000000_finance_expenses.sql')

const form = (over: Partial<ExpenseFormState> = {}): ExpenseFormState => ({
  ...emptyExpenseForm(TODAY),
  amount: '500',
  paidTo: 'Ramesh',
  categoryId: 'cat-1',
  ...over,
})

const CATEGORIES: ExpenseCategory[] = [
  { id: 'cat-1', name: 'Diesel',   is_active: true },
  { id: 'cat-2', name: 'Transport', is_active: true },
  { id: 'cat-3', name: 'Retired',   is_active: false },
]

// ── Payment modes ────────────────────────────────────────────────────────────

describe('the expense payment modes are the expense\'s own, not Finance\'s', () => {
  test('the seven outgoing routes, and no BOE receiving account among them', () => {
    assert.deepEqual([...EXPENSE_PAYMENT_MODE_VALUES],
      ['cash', 'upi', 'bank_transfer', 'credit_card', 'debit_card', 'cheque', 'other'])
    // hdfc / pnb / paytm / canara name the accounts money ARRIVES INTO. An
    // expense is money going out; offering one would be meaningless.
    for (const account of ['hdfc', 'pnb', 'paytm', 'canara']) {
      assert.equal(isExpensePaymentMode(account), false, `${account} is an incoming account`)
    }
  })

  test('the default is a real mode', () => {
    assert.ok(isExpensePaymentMode(DEFAULT_EXPENSE_PAYMENT_MODE))
  })

  test('every value has a label, and an unknown one is shown as stored', () => {
    for (const m of EXPENSE_PAYMENT_MODES) {
      assert.equal(expensePaymentModeLabel(m.value), m.label)
    }
    assert.equal(expensePaymentModeLabel('something_else'), 'something_else',
      'a value neither list knows is evidence, and relabelling it would hide it')
    assert.equal(expensePaymentModeLabel(null), '—')
    assert.equal(expensePaymentModeLabel(''), '—')
  })

  test('THE DATABASE ENFORCES THE SAME SEVEN', () => {
    for (const m of EXPENSE_PAYMENT_MODE_VALUES) {
      assert.ok(MIGRATION.includes(`'${m}'`), `${m} is missing from the CHECK constraint`)
    }
    assert.ok(/expenses_payment_mode_known check \(\s*payment_mode in \(/.test(MIGRATION))
  })
})

// ── Amount ───────────────────────────────────────────────────────────────────

describe('the amount, with the same rules as every other Finance amount', () => {
  test('zero and negative are refused', () => {
    assert.equal(validateExpenseForm(form({ amount: '0' }), TODAY).amount,
      'Enter an amount greater than zero.')
    assert.equal(validateExpenseForm(form({ amount: '0.00' }), TODAY).amount,
      'Enter an amount greater than zero.')
    assert.ok(validateExpenseForm(form({ amount: '-5' }), TODAY).amount)
  })

  test('an empty amount is refused, and says so as "missing" not as "invalid"', () => {
    assert.equal(validateExpenseForm(form({ amount: '' }), TODAY).amount, 'Enter the amount paid.')
  })

  test('a third decimal place is REFUSED, never rounded', () => {
    const errors = validateExpenseForm(form({ amount: '1000.005' }), TODAY)
    assert.ok(errors.amount?.includes('two decimal places'))
    assert.ok(errors.amount?.includes('Nothing has been rounded'),
      'the shared Finance wording, so the rule reads the same everywhere')
  })

  test('two decimal places are accepted', () => {
    assert.equal(validateExpenseForm(form({ amount: '850.50' }), TODAY).amount, undefined)
    assert.equal(validateExpenseForm(form({ amount: '1' }), TODAY).amount, undefined)
    assert.equal(validateExpenseForm(form({ amount: '0.01' }), TODAY).amount, undefined)
  })

  test('letters, signs and exponents are refused', () => {
    for (const bad of ['12abc', '1e5', '+5', '1.2.3']) {
      assert.ok(validateExpenseForm(form({ amount: bad }), TODAY).amount, bad)
    }
  })

  test('the amount is written as the STRING that was typed, never through a double', () => {
    const payload = expenseWritePayload(form({ amount: '1234567890.45' }))
    assert.equal(payload.amount, '1234567890.45')
    assert.equal(typeof payload.amount, 'string')
  })

  test('THE DATABASE REFUSES THE SAME AMOUNTS', () => {
    assert.ok(MIGRATION.includes('amount numeric(14,2) not null'), 'fixed precision, never float')
    assert.ok(MIGRATION.includes("amount <> 'NaN'::numeric"))
    assert.ok(MIGRATION.includes('and amount > 0'))
    assert.ok(MIGRATION.includes('and amount = round(amount, 2)'))
    assert.ok(!/amount\s+(real|double precision|float)/.test(MIGRATION),
      'no floating-point money anywhere in the schema')
  })
})

// ── The other required fields ────────────────────────────────────────────────

describe('required fields', () => {
  test('a complete form is valid', () => {
    assert.deepEqual(validateExpenseForm(form(), TODAY), {})
    assert.equal(isExpenseFormValid(form(), TODAY), true)
  })

  test('every required field is reported at once, not one save at a time', () => {
    const errors = validateExpenseForm(
      form({ amount: '', paidTo: '', categoryId: '', expenseDate: '' }), TODAY)
    assert.deepEqual(Object.keys(errors).sort(), ['amount', 'categoryId', 'expenseDate', 'paidTo'])
  })

  test('a payee of only spaces is not a payee', () => {
    assert.equal(validateExpenseForm(form({ paidTo: '   ' }), TODAY).paidTo, 'Enter who was paid.')
  })

  test('the category is required', () => {
    assert.equal(validateExpenseForm(form({ categoryId: '' }), TODAY).categoryId, 'Choose a category.')
  })

  test('the payment mode must be one of the seven', () => {
    assert.ok(validateExpenseForm(form({ paymentMode: 'hdfc' }), TODAY).paymentMode)
    assert.ok(validateExpenseForm(form({ paymentMode: '' }), TODAY).paymentMode)
  })

  test('the remark is optional, and an empty one is written as NULL', () => {
    assert.equal(validateExpenseForm(form({ remark: '' }), TODAY).remark, undefined)
    assert.equal(expenseWritePayload(form({ remark: '' })).remark, null)
    assert.equal(expenseWritePayload(form({ remark: '   ' })).remark, null,
      'blank and absent are one fact, and the database CHECK refuses the other reading')
    assert.equal(expenseWritePayload(form({ remark: ' site visit ' })).remark, 'site visit')
  })

  test('the payee is trimmed before it is written, because the CHECK refuses otherwise', () => {
    assert.equal(expenseWritePayload(form({ paidTo: '  Sharma Ji  ' })).paid_to, 'Sharma Ji')
    assert.ok(MIGRATION.includes('paid_to = btrim(paid_to) and btrim(paid_to) <>'))
  })

  test('length limits match the database', () => {
    assert.ok(validateExpenseForm(form({ paidTo: 'x'.repeat(PAID_TO_MAX + 1) }), TODAY).paidTo)
    assert.ok(validateExpenseForm(form({ remark: 'x'.repeat(REMARK_MAX + 1) }), TODAY).remark)
    assert.ok(MIGRATION.includes(`char_length(paid_to) <= ${PAID_TO_MAX}`))
    assert.ok(MIGRATION.includes(`char_length(remark) <= ${REMARK_MAX}`))
    assert.ok(MIGRATION.includes(`char_length(name) <= ${CATEGORY_NAME_MAX}`))
  })
})

describe('the expense date', () => {
  test('a fresh form starts on today', () => {
    assert.equal(emptyExpenseForm(TODAY).expenseDate, TODAY)
  })

  test('an older payment is allowed — that is the point of the field', () => {
    assert.equal(validateExpenseForm(form({ expenseDate: '2020-01-01' }), TODAY).expenseDate, undefined)
  })

  test('a future date is a typo and is refused', () => {
    assert.ok(validateExpenseForm(form({ expenseDate: '2026-09-21' }), TODAY).expenseDate)
  })

  test('today itself is fine', () => {
    assert.equal(validateExpenseForm(form({ expenseDate: TODAY }), TODAY).expenseDate, undefined)
  })

  test('a missing or malformed date is refused', () => {
    assert.ok(validateExpenseForm(form({ expenseDate: '' }), TODAY).expenseDate)
    assert.ok(validateExpenseForm(form({ expenseDate: '20/09/2026' }), TODAY).expenseDate)
  })
})

// ── Categories ───────────────────────────────────────────────────────────────

describe('category names', () => {
  test('the stored name is trimmed and inner whitespace collapsed', () => {
    assert.equal(normalizeCategoryName('  Factory   Repair '), 'Factory Repair')
  })

  test('the comparison key is case-insensitive, matching lower(name) in the database', () => {
    assert.equal(categoryKey('DIESEL'), 'diesel')
    assert.equal(categoryKey(' Diesel '), 'diesel')
    assert.equal(categoryKey('diesel'), categoryKey('DiEsEl'))
    assert.ok(MIGRATION.includes('create unique index if not exists expense_categories_name_lower_key'))
    assert.ok(MIGRATION.includes('on public.expense_categories (lower(name))'))
  })

  test('A DUPLICATE IS FOUND BEFORE IT IS WRITTEN, whatever its case', () => {
    assert.equal(findCategoryByName(CATEGORIES, 'diesel')?.id, 'cat-1')
    assert.equal(findCategoryByName(CATEGORIES, 'DIESEL')?.id, 'cat-1')
    assert.equal(findCategoryByName(CATEGORIES, '  Diesel  ')?.id, 'cat-1')
    assert.equal(findCategoryByName(CATEGORIES, 'Fuel'), null)
  })

  test('a RETIRED category still holds its name, so it is found rather than re-created', () => {
    // The unique index covers every row. Finding it here is what lets the form
    // say so, instead of the write failing with a constraint violation.
    assert.equal(findCategoryByName(CATEGORIES, 'retired')?.id, 'cat-3')
  })

  test('an empty name is never a match', () => {
    assert.equal(findCategoryByName(CATEGORIES, ''), null)
    assert.equal(findCategoryByName(CATEGORIES, '   '), null)
  })

  test('a blank or over-long name is refused with words', () => {
    assert.equal(categoryNameProblem(''), 'Enter a category name.')
    assert.equal(categoryNameProblem('   '), 'Enter a category name.')
    assert.ok(categoryNameProblem('x'.repeat(CATEGORY_NAME_MAX + 1)))
    assert.equal(categoryNameProblem('Diesel'), null)
  })

  test('the picker offers active categories by name, and keeps the one being edited', () => {
    assert.deepEqual(selectableCategories(CATEGORIES).map(c => c.id), ['cat-1', 'cat-2'])
    assert.deepEqual(selectableCategories(CATEGORIES, 'cat-3').map(c => c.id),
      ['cat-1', 'cat-3', 'cat-2'].sort((a, b) => {
        const name = (id: string) => CATEGORIES.find(c => c.id === id)!.name
        return name(a).localeCompare(name(b), 'en-IN', { sensitivity: 'base' })
      }),
      'an expense already naming a retired category can still be corrected')
  })

  test('A CATEGORY AN EXPENSE REFERENCES CANNOT BE DELETED — the FK says so', () => {
    assert.ok(MIGRATION.includes('references public.expense_categories(id)'))
    assert.ok(!/on delete cascade/i.test(MIGRATION), 'no cascade anywhere: history is not collateral')
    assert.ok(!/on delete set null/i.test(MIGRATION))
    assert.ok(MIGRATION.includes('is_active boolean not null default true'),
      'retirement is the removal path for a category')
  })
})

// ── Editing ──────────────────────────────────────────────────────────────────

describe('correcting an expense', () => {
  const row: ExpenseRow = {
    id: 'exp-1', expense_date: '2026-09-18', amount: '850.50', payment_mode: 'upi',
    paid_to: 'Sharma Ji', category_id: 'cat-1', remark: 'welding machine',
    created_by: 'user-1', created_at: '2026-09-18T10:00:00Z',
    updated_at: '2026-09-18T10:00:00Z', updated_by: null,
  }

  test('the same form opens on the stored values, exactly', () => {
    assert.deepEqual(expenseFormFromRow(row), {
      expenseDate: '2026-09-18', amount: '850.50', paymentMode: 'upi',
      paidTo: 'Sharma Ji', categoryId: 'cat-1', remark: 'welding machine',
    })
  })

  test('a null remark opens as an empty field, and saves back as null', () => {
    const f = expenseFormFromRow({ ...row, remark: null })
    assert.equal(f.remark, '')
    assert.equal(expenseWritePayload(f).remark, null)
  })

  test('the amount is not reformatted on the way in, so a save with no edit is a no-op', () => {
    assert.equal(expenseFormFromRow({ ...row, amount: '1000.00' }).amount, '1000.00')
  })

  test('EVERY CORRECTION NAMES ITS AUTHOR — the database will not accept one that does not', () => {
    assert.ok(MIGRATION.includes('with check (created_by = auth.uid() and updated_by = auth.uid())'))
    assert.ok(MIGRATION.includes('and updated_by = auth.uid()'))
  })

  test('WHO RECORDED AN EXPENSE IS NEVER A CORRECTION', () => {
    assert.ok(MIGRATION.includes('expenses_freeze_created_by'))
    assert.ok(MIGRATION.includes('An expense cannot change who recorded it'))
  })
})

// ── Filters and the total ────────────────────────────────────────────────────

describe('filters', () => {
  test('nothing is active on a fresh toolbar', () => {
    assert.equal(expenseFiltersActive(EMPTY_EXPENSE_FILTERS), false)
  })

  test('each filter on its own counts as narrowing', () => {
    for (const key of ['dateFrom', 'dateTo', 'categoryId', 'paymentMode', 'search'] as const) {
      assert.equal(
        expenseFiltersActive({ ...EMPTY_EXPENSE_FILTERS, [key]: 'x' }), true, key)
    }
  })

  test('a search of only spaces is not a filter', () => {
    assert.equal(expenseFiltersActive({ ...EMPTY_EXPENSE_FILTERS, search: '   ' }), false)
  })

  test('a date range typed backwards is read as the range between the two bounds', () => {
    assert.deepEqual(
      orderedDateRange({ ...EMPTY_EXPENSE_FILTERS, dateFrom: '2026-09-20', dateTo: '2026-09-01' }),
      { from: '2026-09-01', to: '2026-09-20' })
  })

  test('either bound alone is a valid open-ended range', () => {
    assert.deepEqual(orderedDateRange({ ...EMPTY_EXPENSE_FILTERS, dateFrom: '2026-09-01' }),
      { from: '2026-09-01', to: '' })
    assert.deepEqual(orderedDateRange({ ...EMPTY_EXPENSE_FILTERS, dateTo: '2026-09-01' }),
      { from: '', to: '2026-09-01' })
  })

  test('the search covers the payee and the remark', () => {
    assert.equal(expenseSearchClause('ramesh'), 'paid_to.ilike.%ramesh%,remark.ilike.%ramesh%')
  })

  test('PUNCTUATION A PERSON TYPES CANNOT BECOME A PREDICATE', () => {
    // Commas and parentheses separate terms in PostgREST's `or` syntax.
    const clause = expenseSearchClause('a,b)c(d')
    assert.ok(clause)
    assert.equal(clause.split(',').length, 2, 'still exactly two ilike terms')
    assert.ok(!clause.includes('(') && !clause.includes(')'))
  })

  test('an empty search is no clause at all, not an empty match', () => {
    assert.equal(expenseSearchClause(''), null)
    assert.equal(expenseSearchClause('   '), null)
    assert.equal(expenseSearchClause(' , ( ) '), null)
  })
})

describe('the total under the list', () => {
  test('it is exact, not floating point', () => {
    assert.equal(expenseTotal([{ amount: '0.10' }, { amount: '0.20' }]), '0.30')
    assert.equal(Number('0.1') + Number('0.2') === 0.3, false, 'which is why this is not Number()')
  })

  test('a large total keeps every digit', () => {
    assert.equal(expenseTotal([{ amount: '1234567890123.45' }, { amount: '0.55' }]),
      '1234567890124.00')
  })

  test('an empty list totals zero', () => {
    assert.equal(expenseTotal([]), '0')
  })

  test('an unreadable amount contributes nothing rather than poisoning the sum', () => {
    assert.equal(expenseTotal([{ amount: '100.00' }, { amount: null }, { amount: 'oops' }]), '100.00')
  })
})

// ── The migration is additive and touches nothing that already exists ────────

describe('the migration is additive, and only additive', () => {
  test('it creates exactly the two expense tables and alters none', () => {
    const creates = [...MIGRATION.matchAll(/create table (?:if not exists )?public\.(\w+)/g)]
      .map(m => m[1]).sort()
    assert.deepEqual(creates, ['expense_categories', 'expenses'])
    assert.equal(/^\s*alter table (?!public\.expenses\b|public\.expense_categories\b)/mi.test(MIGRATION), false,
      'no existing table is altered')
  })

  test('NO DML AGAINST ANY BUSINESS TABLE — the file writes no rows at all', () => {
    // The assertion block reads counts; nothing inserts, updates or deletes.
    assert.equal(/^\s*insert\s+into/mi.test(MIGRATION), false)
    assert.equal(/^\s*update\s+public\./mi.test(MIGRATION), false)
    assert.equal(/^\s*delete\s+from/mi.test(MIGRATION), false)
    assert.equal(/\btruncate\b/i.test(MIGRATION), false)
  })

  test('it names no existing business table in any statement', () => {
    // Comments and string literals are stripped: the COMMENT ON bodies name the
    // payment tables on purpose, to say that expenses are separate from them.
    // What must not appear is an executable reference to one.
    const statements = MIGRATION
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')
      .replace(/'(?:[^']|'')*'/g, "''")
    for (const table of [
      'finance_payment_requests', 'finance_payment_allocations', 'payment_proof_attachments',
      'orders', 'order_submissions', 'order_requests',
    ]) {
      assert.equal(statements.includes(table), false,
        `${table} must not appear in an executable statement`)
    }
  })

  test('nothing that existed before is dropped', () => {
    // The only DROPs are of this migration's own policies and triggers, each
    // immediately recreated, so the file is re-runnable.
    for (const dropped of [...MIGRATION.matchAll(/drop (policy|trigger) if exists (\S+)/gi)]) {
      assert.ok(/^expenses?_|^expense_categories_/.test(dropped[2]),
        `${dropped[2]} is not one of this migration's own objects`)
    }
    assert.equal(/drop (table|column|function|index|constraint)/i.test(MIGRATION), false)
  })

  test('the users foreign keys are the ones the rest of Finance uses', () => {
    assert.ok(MIGRATION.includes('created_by uuid not null references public.users(id)'))
    assert.ok(MIGRATION.includes('updated_by uuid references public.users(id)'))
  })
})

// ── Access control, as the database expresses it ─────────────────────────────

describe('access control reuses the Finance model exactly', () => {
  test('both tables carry the RESTRICTIVE finance module gate', () => {
    for (const table of ['expenses', 'expense_categories']) {
      assert.ok(MIGRATION.includes(`create policy ${table}_module_entry_gate`))
      assert.ok(new RegExp(
        `create policy ${table}_module_entry_gate\\s+on public\\.${table}\\s+as restrictive for all to authenticated\\s+using \\(public\\.module_entry_open\\('finance'\\)\\)`,
      ).test(MIGRATION), `${table} is gated on finance entry for all four commands`)
    }
  })

  test('RLS is enabled on both', () => {
    assert.ok(MIGRATION.includes('alter table public.expenses enable row level security'))
    assert.ok(MIGRATION.includes('alter table public.expense_categories enable row level security'))
  })

  test('EXPENSES ARE NOT READABLE BY EVERY AUTHENTICATED EMPLOYEE', () => {
    // Three SELECT policies on public.expenses, each carrying a real condition:
    // admin, finance.view_all, and own rows. None of them is `using (true)`.
    const expensesBlock = MIGRATION.slice(MIGRATION.indexOf('-- ─── 5. RLS: expenses'))
    const selectPolicies = [...expensesBlock.matchAll(/create policy (expenses_\w+)\s+on public\.expenses\s+for select/g)]
      .map(m => m[1]).sort()
    assert.deepEqual(selectPolicies,
      ['expenses_admin_select', 'expenses_own_select', 'expenses_view_all_select'])
    assert.equal(/on public\.expenses\s+for select to authenticated\s+using \(true\)/.test(MIGRATION), false,
      'no unconditional read of the expense ledger')
  })

  test('writing takes finance.create, and correcting somebody else\'s takes the protected finance.manage', () => {
    assert.ok(MIGRATION.includes("public.actor_has_module_permission('finance', 'create')"))
    assert.ok(MIGRATION.includes("public.actor_has_module_permission('finance', 'manage')"))
    assert.ok(MIGRATION.includes("public.actor_has_permission('finance', 'view_all')"))
  })

  test('NO NEW MODULE, ACTION OR PERMISSION ROW is introduced', () => {
    for (const forbidden of [
      'permission_modules', 'permission_actions', 'role_permissions',
      'department_permissions', 'user_permission_overrides', 'app_modules',
    ]) {
      assert.equal(MIGRATION.includes(forbidden), false,
        `${forbidden} is untouched: Finance permissions are reused, never widened`)
    }
    assert.equal(/'expenses'\s*,\s*'view'/.test(MIGRATION), false, 'no expenses module key')
  })

  test('PHASE 1 GRANTS NO DELETION ON EITHER TABLE', () => {
    // Finance has no soft-delete pattern to reuse, so removal is omitted rather
    // than built unsafely. RLS default-denies what no policy permits.
    assert.equal(/create policy \w+\s+on public\.expenses?\w*\s+for delete/.test(MIGRATION), false)
    const forAll = [...MIGRATION.matchAll(
      /create policy (\w+)\s+on public\.\w+\s+(as restrictive )?for all/g)]
    assert.deepEqual(forAll.map(m => m[1]).sort(),
      ['expense_categories_module_entry_gate', 'expenses_module_entry_gate'],
      'the only FOR ALL policies are the two gates')
    for (const match of forAll) {
      assert.equal(match[2], 'as restrictive ',
        `${match[1]} is FOR ALL and must be RESTRICTIVE — a permissive one would grant DELETE`)
    }
  })
})

// ── Indexes ──────────────────────────────────────────────────────────────────

describe('the indexes back reads the list actually performs', () => {
  test('date ordering, category filtering and the own-rows scope', () => {
    assert.ok(MIGRATION.includes('expenses_expense_date_idx'))
    assert.ok(MIGRATION.includes('on public.expenses (expense_date desc, id desc)'),
      'id breaks the tie, so two expenses on one day have a stable order')
    assert.ok(MIGRATION.includes('expenses_category_id_idx'))
    assert.ok(MIGRATION.includes('expenses_created_by_date_idx'))
  })
})
