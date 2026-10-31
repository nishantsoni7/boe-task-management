/**
 * REIMBURSEMENT WITHOUT EDITING: finance.reimburse, the Excel files and the
 * "all reimbursements" page (20270403000000).
 *
 * The owner's rule: the person who pays staff back (a) sees every expense,
 * (b) cannot edit or delete anybody's expense, (c) records a reimbursement with
 * a challan ID and date, (d) downloads the lists in Excel, and (e) sees every
 * reimbursement ever done. Only that person and the owner see it.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  BATCH_ITEM_SHEET_HEADER,
  BATCH_SHEET_HEADER,
  EXPENSE_SHEET_HEADER,
  amountCell,
  batchItemsSheet,
  batchSummarySheet,
  expenseExportFileName,
  expenseSheet,
  reimbursementExportFileName,
  reimbursementWorkbook,
  sheetName,
  type ExportBatch,
  type ExportBatchItem,
  type ExportExpense,
} from './expenseReimbursementExport'
import { mayDeleteExpense, mayEditExpense } from './expenseDeletion'
import { mayRecordReimbursement } from './expenseReimbursements'
import { deriveFinanceCapabilities } from '../permissions/finance'
import { ACTION_DEPENDENCIES, PROTECTED_ACTIONS } from '../permissions/levels'
import { activeFinanceNav, pendingModuleTitle } from '../navigation/moduleNav'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const MIGRATION = read('supabase/migrations/20270403000000_finance_reimburse_permission.sql')

const names: Record<string, string> = { u1: 'Nishant', u2: 'Asha', fin: 'Nitish' }
const personName = (id: string | null | undefined) => (id ? names[id] ?? '—' : '—')

const expense = (over: Partial<ExportExpense> = {}): ExportExpense => ({
  id: 'e1', expense_date: '2026-10-01', amount: 150.5, payment_mode: 'upi', paid_to: 'Stationery',
  category_id: 'c1', remark: null, created_by: 'u1', paid_from: 'personal', paid_by: 'u1', reimbursement_id: null,
  ...over,
})

const batch = (over: Partial<ExportBatch> = {}): ExportBatch => ({
  id: 'b1', reimbursed_on: '2026-10-20', reference: 'CH-101', payer_id: 'u1', expense_count: 2, total_amount: 300.5,
  status: 'recorded', note: null, recorded_by: 'fin', recorded_at: '2026-10-20T10:00:00Z', reversed_at: null, reversal_reason: null,
  ...over,
})

describe('the expense list in Excel', () => {
  const ctx = { categoryName: (id: string | null) => (id === 'c1' ? 'Office' : '—'), personName }

  test('a pending personal expense: no challan yet, and the total adds up exactly', () => {
    const sheet = expenseSheet([expense(), expense({ id: 'e2', amount: 0.1 }), expense({ id: 'e3', amount: 0.2 })], ctx)
    assert.deepEqual(sheet.rows[0], EXPENSE_SHEET_HEADER)
    assert.deepEqual(sheet.rows[1].slice(0, 4), ['2026-10-01', 'Stationery', 'Office', 150.5])
    assert.equal(sheet.rows[1][9], 'Pending reimbursement')
    assert.equal(sheet.rows[1][10], '', 'no challan before it is reimbursed')
    const total = sheet.rows[sheet.rows.length - 1]
    assert.equal(total[0], 'Total')
    assert.equal(total[3], 150.8, '150.5 + 0.1 + 0.2 is summed exactly, not 150.79999…')
  })

  test('a reimbursed expense carries its challan ID and date', () => {
    const sheet = expenseSheet([
      expense({ reimbursement_id: 'b1', reimbursement: { reimbursed_on: '2026-10-20', reference: 'CH-101', amount: 150.5 } }),
    ], ctx)
    assert.equal(sheet.rows[1][9], 'Reimbursed')
    assert.equal(sheet.rows[1][10], 'CH-101')
    assert.equal(sheet.rows[1][11], '2026-10-20')
  })

  test('a company-paid expense names no payer and no reimbursement', () => {
    const row = expenseSheet([expense({ paid_from: 'company', paid_by: null })], ctx).rows[1]
    assert.equal(row[6], 'Company account')
    assert.equal(row[7], '')
    assert.equal(row[9], 'Company-paid')
  })
})

describe('the reimbursement history in Excel', () => {
  const items: ExportBatchItem[] = [
    { reimbursement_id: 'b1', amount: 100, paid_by: 'u1', expense: { expense_date: '2026-10-01', paid_to: 'A', remark: 'r' } },
    { reimbursement_id: 'b1', amount: 200.5, paid_by: 'u1', expense: { expense_date: '2026-10-02', paid_to: 'B', remark: null } },
    { reimbursement_id: 'b2', amount: 50, paid_by: 'u2', expense: null },
  ]
  const batches = [batch(), batch({ id: 'b2', reference: 'CH-102', payer_id: 'u2', expense_count: 1, total_amount: 50, status: 'reversed', reversal_reason: 'wrong challan' })]

  test('the summary sheet has one row per challan and leaves reversed ones out of the total', () => {
    const sheet = batchSummarySheet(batches, personName)
    assert.deepEqual(sheet.rows[0], BATCH_SHEET_HEADER)
    assert.equal(sheet.rows.length, 4, 'header + two batches + total')
    assert.deepEqual(sheet.rows[1].slice(0, 6), ['CH-101', '2026-10-20', 'Nishant', 2, 300.5, 'Reimbursed'])
    assert.equal(sheet.rows[2][5], 'Reversed')
    assert.equal(sheet.rows[2][9], 'wrong challan')
    const total = sheet.rows[3]
    assert.equal(total[4], 300.5)
    assert.equal(total[3], 2)
  })

  test('the lines sheet has one row per expense, each with its challan and date', () => {
    const sheet = batchItemsSheet(batches, items, personName)
    assert.deepEqual(sheet.rows[0], BATCH_ITEM_SHEET_HEADER)
    assert.equal(sheet.rows.length, 4)
    assert.deepEqual(sheet.rows[2].slice(0, 7), ['CH-101', '2026-10-20', 'Nishant', '2026-10-02', 'B', '', 200.5])
    assert.equal(sheet.rows[3][7], 'Reversed')
  })

  test('the workbook is those two sheets, named within Excel’s rules', () => {
    const sheets = reimbursementWorkbook(batches, items, personName)
    assert.equal(sheets.length, 2)
    for (const s of sheets) assert.ok(sheetName(s.name).length <= 31)
    assert.equal(sheetName('a/b:c?d*e[f]g'.padEnd(40, 'x')).length, 31)
    assert.ok(!/[:\\/?*[\]]/.test(sheetName('a/b:c?d*e[f]g')))
  })

  test('a line whose batch is not in the export is not invented', () => {
    assert.equal(batchItemsSheet([batch()], items.slice(2), personName).rows.length, 1)
  })
})

describe('numbers and file names', () => {
  test('amounts are numbers; junk is null', () => {
    assert.equal(amountCell('12.50'), 12.5)
    assert.equal(amountCell(7), 7)
    assert.equal(amountCell(null), null)
    assert.equal(amountCell('abc'), null)
  })
  test('file names are safe and dated', () => {
    assert.equal(reimbursementExportFileName('all', '2026-10-22'), 'reimbursements-2026-10-22.xlsx')
    assert.equal(reimbursementExportFileName({ challan: 'CH/101 ?' }, '2026-10-22'), 'reimbursement-CH-101-2026-10-22.xlsx')
    assert.equal(expenseExportFileName('Pending reimbursement', '2026-10-22'), 'expenses-Pending-reimbursement-2026-10-22.xlsx')
    assert.equal(reimbursementExportFileName({ challan: '///' }, '2026-10-22'), 'reimbursement-x-2026-10-22.xlsx')
  })
})

describe('finance.reimburse sees and pays, but never edits or deletes', () => {
  const grant = (...actions: string[]) => ['view', ...actions].map(actionKey => ({ actionKey, allowed: true })) as never

  test('reimburse + view_all can reimburse, and gain no authority over other people’s expenses', () => {
    const caps = deriveFinanceCapabilities('employee', grant('view_all', 'reimburse'))
    assert.equal(caps.canReimburseExpenses, true)
    assert.equal(mayRecordReimbursement(caps), true)
    assert.equal(caps.canManageFinance, false)
    const actor = { userId: 'fin', canManageFinance: caps.canManageFinance }
    const owners = { created_by: 'u1', deleted_at: null }
    assert.equal(mayEditExpense(owners, actor), false, 'cannot edit the owner’s expense')
    assert.equal(mayDeleteExpense(owners, actor), false, 'cannot delete the owner’s expense')
  })

  test('manage alone no longer reimburses, and reimburse without view_all does not', () => {
    assert.equal(deriveFinanceCapabilities('employee', grant('manage', 'view_all')).canReimburseExpenses, false)
    assert.equal(deriveFinanceCapabilities('employee', grant('reimburse')).canReimburseExpenses, false)
    assert.equal(deriveFinanceCapabilities('employee', []).canReimburseExpenses, false)
  })

  test('an administrator holds it through the admin branch', () => {
    assert.equal(deriveFinanceCapabilities('admin', []).canReimburseExpenses, true)
  })

  test('it is protected (no access level grants it) and depends on view_all', () => {
    assert.ok(PROTECTED_ACTIONS.has('reimburse'))
    assert.equal(ACTION_DEPENDENCIES.reimburse, 'view_all')
  })
})

describe('the migration', () => {
  test('registers the action deny-by-default and moves the door from manage to reimburse', () => {
    assert.ok(/insert into public\.permission_actions[\s\S]*'reimburse'/.test(MIGRATION))
    assert.ok(/default_allowed[\s\S]*false/.test(MIGRATION) && /select pm\.id, pa\.id, false/.test(MIGRATION))
    assert.ok(/actor_has_module_permission\('finance', 'reimburse'\)\s*and public\.actor_has_module_permission\('finance', 'view_all'\)/.test(MIGRATION))
    assert.ok(/revoke all on function public\.can_record_expense_reimbursement\(\) from public, anon/.test(MIGRATION))
  })
  test('it does not touch the expenses policies, the RPCs or any table', () => {
    assert.ok(!/create policy|drop policy|alter table|create table|record_expense_reimbursement\(\s*p_/i.test(MIGRATION))
    assert.ok(!/create or replace function public\.(record|reverse)_expense_reimbursement/.test(MIGRATION))
  })
  test('its version is used by no other migration', () => {
    const files = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(f => f.startsWith('20270403000000'))
    assert.deepEqual(files, ['20270403000000_finance_reimburse_permission.sql'])
  })
})

describe('the screens', () => {
  const VIEW = read('src/app/finance/reimbursements/ReimbursementsView.tsx')
  const DATA = read('src/app/finance/reimbursements/reimbursementData.ts')
  const EXPENSES = read('src/app/finance/expenses/ExpensesView.tsx')
  const LAYOUT = read('src/components/layout/FinanceLayout.tsx')

  test('the history page refuses everyone without the permission before drawing a row', () => {
    assert.ok(VIEW.includes('if (!mayUse)'))
    assert.ok(VIEW.indexOf('if (!mayUse)') < VIEW.indexOf('reimbursements-table'))
    assert.ok(VIEW.includes('mayRecordReimbursement(caps)'))
  })

  test('the history page and its loaders never write an expense', () => {
    for (const src of [VIEW, DATA]) {
      assert.ok(!/\.(insert|update|upsert|delete)\(/.test(src), 'no direct write')
      assert.ok(!/\.from\('expenses'\)/.test(src), 'it does not even read the expenses table')
    }
    assert.deepEqual([...VIEW.matchAll(/\.rpc\('([a-z_]+)'/g)].map(m => m[1]), [], 'the only write is the reversal inside the shared window')
  })

  test('the Expenses page offers Excel and the post-reimbursement download only to people who may reimburse', () => {
    assert.ok(/\{mayRecord && \(\s*<button[\s\S]{0,200}download-expense-list/.test(EXPENSES))
    assert.ok(EXPENSES.includes('{mayRecord && justRecorded && ('))
    assert.ok(EXPENSES.includes("router.push('/finance/reimbursements')"))
    assert.ok(EXPENSES.includes('mayRecordReimbursement(caps)'))
  })

  test('the sidebar entry is drawn only with the permission, and the route is lit', () => {
    assert.ok(/canReimburseExpenses\s*\? \[\{ label: 'Reimbursements'/.test(LAYOUT))
    assert.equal(activeFinanceNav('/finance/reimbursements'), 'reimbursements')
    assert.equal(pendingModuleTitle('/finance/reimbursements'), 'Reimbursements')
  })

  test('the recording form asks for the Challan ID and the date', () => {
    const modals = read('src/app/finance/expenses/ExpenseReimbursementModals.tsx')
    assert.ok(modals.includes('Challan ID<span'))
    assert.ok(modals.includes('Reimbursement date<span'))
  })
})

describe('the Expenses page top: one line, and View for everybody', () => {
  const EXPENSES = read('src/app/finance/expenses/ExpensesView.tsx')

  test('everything rarely used lives behind ONE Filters button, not on the page', () => {
    const toolbar = EXPENSES.slice(EXPENSES.indexOf('aria-label="Filter expenses"'))
    const button = toolbar.indexOf('data-testid="expense-filters-button"')
    assert.ok(button > 0)
    for (const label of [
      'aria-label="Expenses on or after"', 'aria-label="Expenses on or before"',
      'aria-label="Filter by category"', 'aria-label="Filter by payment mode"',
      'aria-label="Filter by reimbursement"', 'aria-label="Filter by who paid"',
    ]) {
      assert.ok(toolbar.indexOf(label) > button, label + ' is inside the panel, after the button')
    }
    assert.ok(EXPENSES.includes('role="dialog"') && EXPENSES.includes("e.key === 'Escape'"))
  })

  test('the date range is one row with two inputs', () => {
    assert.equal((EXPENSES.match(/aria-label="Expenses on or after"/g) ?? []).length, 1)
    assert.ok(/role="group"\s*aria-label="Expense date"/.test(EXPENSES))
  })

  test('A DATE RANGE IN THE PANEL IS STILL COUNTED, so nothing narrows the list invisibly', () => {
    assert.ok(/const panelFilterCount = \[\s*filters\.dateFrom \|\| filters\.dateTo,/.test(EXPENSES))
    assert.ok(/\{panelFilterCount > 0 && !filtersOpen && \(/.test(EXPENSES), 'the way out stays in sight')
  })

  test('tabs, switch, total and what is owed share the line, ahead of the tools', () => {
    const line = EXPENSES.indexOf('className="expense-controls"')
    const tabs = EXPENSES.indexOf('data-testid="expense-tabs"')
    const source = EXPENSES.indexOf('data-testid="expense-source-switch"')
    const total = EXPENSES.indexOf("`${total} ${total === 1 ? 'expense' : 'expenses'}")
    const pending = EXPENSES.indexOf('data-testid="pending-reimbursement-summary"')
    const toolbar = EXPENSES.indexOf('aria-label="Filter expenses"')
    assert.ok(line > 0 && line < tabs && tabs < source && source < total && total < pending && pending < toolbar)
  })

  test('the switch reads and writes the one filter, and says which position is on', () => {
    assert.ok(EXPENSES.includes('aria-pressed={source === option.value}'))
    assert.ok(EXPENSES.includes('const source = paidFromView(filters.reimbursement)'))
    assert.ok(EXPENSES.includes('setFilters(prev => withPaidFromView(prev, option.value))'))
  })

  test('search is a magnifier until used, and stays open while it holds a word', () => {
    const css = read('src/app/globals.css')
    assert.ok(EXPENSES.includes("className={`boe-list-search expense-search${searchTerm ? ' is-filled' : ''}`}"))
    assert.ok(/\.boe-list-search\.expense-search \{[^}]*width: 36px;/.test(css))
    assert.ok(/\.boe-list-search\.expense-search:focus-within,\n\.boe-list-search\.expense-search\.is-filled \{ width: 250px;/.test(css))
  })

  test('there is no Remark column, and every row offers View', () => {
    assert.equal(EXPENSES.includes("label: 'Remark'"), false)
    assert.equal((EXPENSES.match(/data-testid="expense-view"/g) ?? []).length, 2, 'table and cards')
    assert.ok(/\{onOpen \|\| mayEdit\(row\) \|\| mayDelete\(row\) \?/.test(EXPENSES))
  })
})

describe('the Expenses list text is never cut, and the Filters panel has no dead space', () => {
  const EXPENSES = read('src/app/finance/expenses/ExpensesView.tsx')
  test('payee, category, mode and recorder cells wrap instead of ending in an ellipsis', () => {
    assert.ok(EXPENSES.includes("whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip'"))
    assert.equal((EXPENSES.match(/\.\.\.TD_TEXT/g) ?? []).length, 4)
  })
  test('every select in the Filters panel opts out of the class flex-basis that made it 160px tall', () => {
    const panel = EXPENSES.slice(EXPENSES.indexOf('aria-label="More filters"'))
    assert.equal((panel.match(/style=\{\{ flex: 'none', width: '100%', height: '36px'/g) ?? []).length, 4)
  })
})
