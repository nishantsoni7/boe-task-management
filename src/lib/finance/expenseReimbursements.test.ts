/**
 * EXPENSES PHASE 3 — who paid, reimbursement, bills: the rules, and the wiring
 * that must not drift from the database (20270205120000).
 *
 * Pure functions are tested directly; the migration and the screens are read as
 * source, the way expenseSurfaces.test.ts reads them. Nothing here talks to a
 * database — supabase/tests/run_expense_reimbursement_suite.sh proves the SQL on
 * a disposable one.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  billDisplayName,
  billExtension,
  billFileProblem,
  billStoragePath,
  friendlyReimbursementError,
  isReimbursable,
  mayAddBillAsPayer,
  maySelectWith,
  selectionPayer,
  mayRecordForOthers,
  mayRecordReimbursement,
  reimbursementSelectionProblem,
  reimbursementState,
  selectionTotal,
  validateReimbursementForm,
  EXPENSE_BILL_MAX_BYTES,
  REIMBURSEMENT_FILTER_OPTIONS,
} from './expenseReimbursements'
import {
  EMPTY_EXPENSE_FILTERS,
  emptyExpenseFormWithSource,
  expenseFiltersActive,
  expenseFormFromRowWithSource,
  expenseWritePayload,
  validateExpenseForm,
  type ExpenseRow,
} from './expenses'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const MIGRATION = read('supabase/migrations/20270205120000_expense_reimbursements_and_bills.sql')
const VIEW = read('src/app/finance/expenses/ExpensesView.tsx')
const FORM = read('src/app/finance/expenses/ExpenseForm.tsx')
const MODALS = read('src/app/finance/expenses/ExpenseReimbursementModals.tsx')
const BILLS = read('src/app/finance/expenses/ExpenseBills.tsx')

const row = (over: Partial<ExpenseRow> = {}): ExpenseRow => ({
  id: 'e1', expense_date: '2026-09-20', amount: 100, payment_mode: 'cash', paid_to: 'X',
  category_id: 'c1', remark: null, created_by: 'u1', created_at: '', updated_at: '',
  updated_by: null, deleted_at: null, deleted_by: null,
  paid_from: 'personal', paid_by: 'u1', reimbursement_id: null,
  ...over,
})

describe('the four states of an expense', () => {
  test('company, pending, reimbursed — and unknown for older expenses', () => {
    assert.equal(reimbursementState(row({ paid_from: 'company', paid_by: null })), 'company')
    assert.equal(reimbursementState(row()), 'pending')
    assert.equal(reimbursementState(row({ reimbursement_id: 'b1' })), 'reimbursed')
    assert.equal(reimbursementState(row({ paid_from: null, paid_by: null })), 'unknown')
    // A row from before the migration carries no field at all.
    const legacy = row()
    delete legacy.paid_from
    assert.equal(reimbursementState(legacy), 'unknown', 'a missing source is NOT read as either')
  })

  test('company-paid is never pending, and an unknown one is never pending either', () => {
    assert.equal(isReimbursable(row({ paid_from: 'company', paid_by: null })), false)
    assert.equal(isReimbursable(row({ paid_from: null, paid_by: null })), false)
    assert.equal(isReimbursable(row({ reimbursement_id: 'b1' })), false)
    assert.equal(isReimbursable(row({ deleted_at: '2026-09-21' })), false)
    assert.equal(isReimbursable(row()), true)
  })

  test('the filter offers all four, plus "all"', () => {
    assert.deepEqual(REIMBURSEMENT_FILTER_OPTIONS.map(o => o.value), ['', 'company', 'pending', 'reimbursed', 'unknown'])
  })
})

describe('selecting expenses to reimburse', () => {
  test('a clean selection has no problem and an exact total', () => {
    const rows = [row({ id: 'a', amount: '120.50' }), row({ id: 'b', amount: 79.5 })]
    assert.equal(reimbursementSelectionProblem(rows), null)
    assert.equal(selectionTotal(rows), '200.00')
    assert.equal(selectionTotal([row({ amount: '0.10' }), row({ amount: '0.20' })]), '0.30', 'no floating point')
  })

  test('a mixed selection is refused, in words that say what to remove', () => {
    const problem = reimbursementSelectionProblem([
      row({ id: 'a' }),
      row({ id: 'b', paid_from: 'company', paid_by: null }),
      row({ id: 'c', reimbursement_id: 'b1' }),
      row({ id: 'd', paid_from: null, paid_by: null }),
    ])
    assert.ok(problem?.includes('1 company-paid'))
    assert.ok(problem?.includes('1 already reimbursed'))
    assert.ok(problem?.includes('1 with no payment source recorded'))
  })

  test('ONE PAYER PER REIMBURSEMENT: a mixed-payer selection is refused in words', () => {
    const mixed = [row({ id: 'a', paid_by: 'u1' }), row({ id: 'b', paid_by: 'u2' })]
    assert.equal(selectionPayer(mixed), null)
    assert.ok(reimbursementSelectionProblem(mixed)?.includes('paid by different people'))
    assert.ok(friendlyReimbursementError({ message: 'EXPENSE_REIMBURSEMENT_MIXED_PAYERS: the selection was paid by 2 different people — reimburse one payer at a time, each with its own reference' })
      .startsWith('The selection was paid by 2 different people'))
  })

  test('fifteen expenses of one payer are one clean selection, with an exact total', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => row({ id: `e${i}`, paid_by: 'u7', amount: (100 + i + 1 + 0.25).toFixed(2) }))
    assert.equal(reimbursementSelectionProblem(fifteen), null)
    assert.equal(selectionPayer(fifteen), 'u7')
    assert.equal(selectionTotal(fifteen), '1623.75')
  })

  test('once one payer is ticked, only that payer\'s pending expenses may join', () => {
    const picked = [row({ id: 'a', paid_by: 'u1' })]
    assert.equal(maySelectWith(row({ id: 'b', paid_by: 'u1' }), picked), true)
    assert.equal(maySelectWith(row({ id: 'c', paid_by: 'u2' }), picked), false)
    assert.equal(maySelectWith(row({ id: 'd', paid_by: 'u2' }), []), true, 'anybody may start a selection')
    assert.equal(maySelectWith(row({ id: 'e', paid_by: 'u1', reimbursement_id: 'b1' }), picked), false)
  })

  test('nothing selected, or one expense twice, is refused', () => {
    assert.ok(reimbursementSelectionProblem([]))
    assert.ok(reimbursementSelectionProblem([row({ id: 'a' }), row({ id: 'a' })]))
  })

  test('the reimbursement form needs a date that is not in the future and a reference', () => {
    const today = '2026-09-27'
    assert.deepEqual(validateReimbursementForm({ reimbursedOn: today, reference: 'CH-1', note: '' }, today), {})
    const errors = validateReimbursementForm({ reimbursedOn: '2026-09-28', reference: '   ', note: '' }, today)
    assert.ok(errors.reimbursedOn && errors.reference)
    assert.ok(validateReimbursementForm({ reimbursedOn: today, reference: 'x'.repeat(121), note: '' }, today).reference)
  })
})

describe('who may do what — the courtesy mirrors the database', () => {
  test('recording takes finance.manage AND company-wide sight', () => {
    assert.equal(mayRecordReimbursement({ canManageFinance: true, canViewAllFinance: true }), true)
    assert.equal(mayRecordReimbursement({ canManageFinance: true, canViewAllFinance: false }), false)
    assert.equal(mayRecordReimbursement({ canManageFinance: false, canViewAllFinance: true }), false)
    assert.ok(/actor_has_module_permission\('finance', 'manage'\)\s*and public\.actor_has_module_permission\('finance', 'view_all'\)/
      .test(MIGRATION), 'can_record_expense_reimbursement() requires the same two')
  })

  test('the named payer may ADD a bill to a live personal expense, and nobody else gains that', () => {
    assert.equal(mayAddBillAsPayer(row({ paid_by: 'u2', created_by: 'fin' }), 'u2'), true)
    assert.equal(mayAddBillAsPayer(row({ paid_by: 'u2' }), 'u3'), false, 'an unrelated employee')
    assert.equal(mayAddBillAsPayer(row({ paid_from: 'company', paid_by: null }), 'u2'), false)
    assert.equal(mayAddBillAsPayer(row({ paid_by: 'u2', deleted_at: '2026-09-27' }), 'u2'), false)
    assert.ok(/create or replace function public\.can_add_expense_bill[\s\S]{0,900}e\.paid_by = u\.id/.test(MIGRATION))
    assert.ok(/for update to authenticated\s*using \(\s*public\.can_attach_expense_bill\(expense_id\)\s*or \(uploaded_by = auth\.uid\(\) and public\.can_add_expense_bill\(expense_id\)\)/.test(MIGRATION),
      'removing a bill: author / finance.manage, or the payer for a bill THEY uploaded')
    assert.ok(/if exists \(select 1 from public\.expenses e where e\.id = old\.expense_id and e\.reimbursement_id is not null\)/.test(MIGRATION),
      'and nobody once the expense is reimbursed (the guard trigger)')
    const BILLS_SRC = read('src/app/finance/expenses/ExpenseBills.tsx')
    assert.ok(BILLS_SRC.includes('(mayRemove || (mayRemoveOwn && bill.uploaded_by === userId)) && !reimbursed'),
      'the screen offers the payer Remove only on their own upload, only before reimbursement')
  })

  test('naming somebody else as the payer takes finance.manage', () => {
    assert.equal(mayRecordForOthers({ canManageFinance: false }), false)
    assert.ok(MIGRATION.includes("Only Finance can record an expense as paid by somebody else"))
  })

  test('the database refusals are put into words', () => {
    const duplicate = friendlyReimbursementError({ message: 'EXPENSE_REIMBURSEMENT_NOT_PENDING: only pending personal expenses can be reimbursed — the selection includes 1 already reimbursed' })
    assert.ok(duplicate.startsWith('Only pending personal expenses can be reimbursed — the selection includes 1 already reimbursed. '))
    assert.ok(duplicate.includes('refresh the list') && duplicate.endsWith('Nothing was recorded.'))
    assert.ok(friendlyReimbursementError({ message: 'EXPENSE_REIMBURSEMENT_STALE: the selected amounts changed since they were shown (now 5). Refresh and check again.' })
      .startsWith('The selected amounts changed'))
    assert.ok(friendlyReimbursementError({ code: '42501', message: 'EXPENSE_REIMBURSEMENT_FORBIDDEN: only Finance can record a reimbursement' })
      .includes('Only Finance users'))
  })
})

describe('the expense form carries the payment source', () => {
  const today = '2026-09-27'
  const base = { ...emptyExpenseFormWithSource(today, 'u1'), amount: '10', paidTo: 'X', categoryId: 'c1' }

  test('a new expense has NO source preselected, and the payer defaults to the person entering it', () => {
    assert.equal(base.paidFrom, '')
    assert.equal(base.paidBy, 'u1')
  })

  test('the source is required on a new expense', () => {
    assert.ok(validateExpenseForm(base, today, { requirePaidFrom: true }).paidFrom)
    assert.equal(validateExpenseForm({ ...base, paidFrom: 'company' }, today, { requirePaidFrom: true }).paidFrom, undefined)
  })

  test('an older expense can be corrected without being forced to guess', () => {
    const form = expenseFormFromRowWithSource(row({ paid_from: null, paid_by: null }), 'u1')
    assert.equal(form.paidFrom, '')
    assert.deepEqual(validateExpenseForm(form, today, { requirePaidFrom: false }), {})
    const payload = expenseWritePayload(form)
    assert.equal(payload.paid_from, null, 'it stays unknown')
    assert.equal(payload.paid_by, null)
  })

  test('the payload carries a payer exactly when paid personally', () => {
    assert.deepEqual(
      [expenseWritePayload({ ...base, paidFrom: 'personal', paidBy: 'u2' }).paid_by,
       expenseWritePayload({ ...base, paidFrom: 'company', paidBy: 'u2' }).paid_by],
      ['u2', null])
  })

  test('a caller whose form does not ask the question leaves the columns alone', () => {
    const { paidFrom: _a, paidBy: _b, ...old } = base
    assert.equal('paid_from' in expenseWritePayload(old), false)
    assert.equal('paid_by' in expenseWritePayload(old), false)
  })

  test('the three new filters count as narrowing the list', () => {
    assert.equal(expenseFiltersActive(EMPTY_EXPENSE_FILTERS), false)
    assert.equal(expenseFiltersActive({ ...EMPTY_EXPENSE_FILTERS, reimbursement: 'pending' }), true)
    assert.equal(expenseFiltersActive({ ...EMPTY_EXPENSE_FILTERS, paidBy: 'u1' }), true)
    assert.equal(expenseFiltersActive({ ...EMPTY_EXPENSE_FILTERS, missingBill: true }), true)
  })
})

describe('bills', () => {
  test('PDF and photos up to 10 MB, anything else refused in words', () => {
    assert.equal(billFileProblem({ name: 'a.pdf', type: 'application/pdf', size: 1000 }), null)
    assert.equal(billFileProblem({ name: 'a.jpg', type: 'image/jpeg', size: EXPENSE_BILL_MAX_BYTES }), null)
    assert.ok(billFileProblem({ name: 'a.exe', type: 'application/x-msdownload', size: 10 }))
    assert.ok(billFileProblem({ name: 'big.pdf', type: 'application/pdf', size: EXPENSE_BILL_MAX_BYTES + 1 }))
    assert.ok(billFileProblem({ name: 'empty.pdf', type: 'application/pdf', size: 0 }))
  })

  test('the key is {expense}/{random}.{ext} — the only shape the storage rule admits', () => {
    const e = '5509dffb-df89-47f2-944b-1eeb432319f2'
    const r = '00000000-0000-0000-0000-000000000001'
    const path = billStoragePath(e, r, 'image/png')
    assert.equal(path, `${e}/${r}.png`)
    assert.equal(billExtension('image/jpeg'), 'jpg')
    const keyRule = /storage_path ~ '([^']+)'/.exec(MIGRATION)?.[1]
    assert.ok(keyRule && new RegExp(keyRule).test(path), 'the migration\'s key pattern accepts what the screen produces')
    assert.equal(billDisplayName('  '), 'bill')
    assert.equal(billDisplayName('x'.repeat(250)).length, 200)
  })

  test('files are private and opened by short-lived signed URL, never a public URL', () => {
    assert.ok(/values \('expense-bills', 'expense-bills', false,/.test(MIGRATION), 'the bucket is created private')
    assert.ok(BILLS.includes('createSignedUrl('))
    assert.equal(/getPublicUrl/.test(BILLS + MODALS + VIEW + FORM), false)
  })

  test('a failed bill row removes its own upload (compensation), and nothing else is ever deleted', () => {
    assert.ok(/if \(rowError\) \{[\s\S]{0,200}\.remove\(\[path\]\)/.test(BILLS))
    assert.equal(/\.delete\(\)/.test(BILLS + MODALS), false, 'bills are removed by tombstone')
  })
})

describe('the list and the reimbursement surfaces', () => {
  test('pending is personal AND unlinked; company-paid can never be pending', () => {
    assert.ok(VIEW.includes(".eq('paid_from', 'personal').is('reimbursement_id', null)"))
    assert.ok(VIEW.includes("case 'unknown': query = query.is('paid_from', null)"))
  })

  test('deleted expenses still stay out of every figure, including the pending total', () => {
    assert.ok(/loadPendingSummary[\s\S]{0,400}\.is\('deleted_at', null\)/.test(VIEW))
  })

  test('THE BATCH IS NEVER EMBEDDED: each reader gets their own expense\'s receipt', () => {
    assert.equal(/from\('expense_reimbursements'\)|expense_reimbursements!/.test(VIEW), false,
      'the list must not read the batch row (total, count, note)')
    assert.ok(VIEW.includes("rpc('expense_reimbursement_receipts'"))
    assert.ok(/returns table \(\s*expense_id uuid,\s*reimbursement_id uuid,\s*reimbursed_on date,\s*reference text,\s*amount numeric,\s*recorded_by uuid,\s*recorded_at timestamptz\s*\)/.test(MIGRATION),
      'the receipt carries no total, count or note')
  })

  test('only Finance is offered the whole batch', () => {
    assert.ok(VIEW.includes('onOpenReimbursement={caps.canViewAllFinance ?'))
  })

  test('a reimbursement is written only through the RPC, with the total the person confirmed', () => {
    assert.ok(MODALS.includes("supabase.rpc('record_expense_reimbursement'"))
    assert.ok(/p_expected_total: total/.test(MODALS))
    assert.equal(/from\('expense_reimbursements'\)\s*\.(insert|update|upsert)/.test(MODALS + VIEW), false)
    assert.equal(/reimbursement_id:/.test(FORM), false, 'the expense form never sets the link')
  })

  test('the confirmation shows the count, each amount and the total before it is pressed', () => {
    assert.ok(MODALS.includes("{rows.length} {rows.length === 1 ? 'expense' : 'expenses'}"))
    assert.ok(/rows\.map\(row => \([\s\S]{0,900}formatMoney\(row\.amount\)/.test(MODALS))
    assert.ok(MODALS.includes('Confirm ${formatMoney(total)} reimbursed'))
  })

  test('a correction is a reversal with a reason, never a toggle', () => {
    assert.ok(MODALS.includes("supabase.rpc('reverse_expense_reimbursement'"))
    assert.ok(MODALS.includes('p_reason: reason.trim()'))
  })

  test('double submission is stopped by a synchronous ref', () => {
    assert.ok(/if \(inFlight\.current[^)]*\) return/.test(MODALS))
  })

  test('a reimbursed expense offers no Delete', () => {
    assert.ok(VIEW.includes('mayDeleteExpense(row, actor) && !row.reimbursement_id'))
  })
})

describe('a NEW expense must say how it was paid (20270211120000)', () => {
  const RULE = read('supabase/migrations/20270211120000_expense_payment_source_required.sql')

  test('the database refuses a new expense with no source — on INSERT only', () => {
    assert.ok(/before insert on public\.expenses/.test(RULE))
    assert.equal(/before (insert or )?update on public\.expenses/.test(RULE), false,
      'an UPDATE rule would force a guess to correct an older expense')
    assert.ok(/if new\.paid_from is null then\s*raise exception 'EXPENSE_PAYMENT_SOURCE_REQUIRED/.test(RULE))
    assert.equal(/alter table public\.expenses[\s\S]{0,80}(set not null|add constraint)/.test(RULE), false,
      'no NOT NULL or CHECK: older expenses keep NULL ("not recorded")')
  })

  test('the form says it in words if the rule is ever reached', async () => {
    const { friendlyWriteError } = await import('@/app/finance/expenses/ExpenseForm')
    assert.equal(
      friendlyWriteError({ code: '23502', message: 'EXPENSE_PAYMENT_SOURCE_REQUIRED: choose whether this expense was paid from a company account or personally' }),
      'Choose whether this was paid from a company account or personally.')
  })
})
