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
  test('it is later than every other migration', () => {
    const files = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.length - 1], '20270403000000_finance_reimburse_permission.sql')
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
