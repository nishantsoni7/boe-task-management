// ── Expense reimbursements: what goes into the Excel files ───────────────────
//
// Pure, like expenseReimbursements.ts: it turns rows the page already holds
// (each read under the reader's own row-level security) into sheets, and names
// the files. It reads nothing and authorizes nothing — a person who could not
// read a row on screen cannot export it either, because the rows come from the
// same reads.
//
// Amounts are written as numbers so Excel can add them; they come from
// numeric(14,2) columns, so two decimals survive exactly. Dates stay ISO text
// (2026-10-22), which sorts and filters correctly.

import { exactToString, sumExact } from './exactMoney'
import { REIMBURSEMENT_STATE_LABEL, reimbursementState } from './expenseReimbursements'
import { expensePaymentModeLabel, type ExpenseRow } from './expenses'

export type SheetCell = string | number | null
export type Sheet = { name: string; rows: SheetCell[][] }

type NameOf = (id: string | null | undefined) => string

/** A numeric(14,2) value as a number, or null when it is not one. */
export function amountCell(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

// ── The expense list (pending, reimbursed, or whatever the filters show) ─────

export type ExportExpense = Pick<
  ExpenseRow,
  'id' | 'expense_date' | 'amount' | 'payment_mode' | 'paid_to' | 'category_id' | 'remark' | 'created_by' | 'paid_from' | 'paid_by' | 'reimbursement_id'
> & {
  reimbursement?: { reimbursed_on: string; reference: string; amount: string | number } | null
}

export const EXPENSE_SHEET_HEADER: SheetCell[] = [
  'Date', 'Paid to', 'Category', 'Amount (₹)', 'Payment mode', 'Remark',
  'Paid from', 'Paid by', 'Recorded by', 'Reimbursement status', 'Challan ID', 'Reimbursed on',
]

export function expenseSheet(
  rows: readonly ExportExpense[],
  ctx: { categoryName: (id: string | null) => string; personName: NameOf },
  name = 'Expenses',
): Sheet {
  const body: SheetCell[][] = rows.map(row => {
    const state = reimbursementState(row)
    return [
      row.expense_date,
      row.paid_to,
      ctx.categoryName(row.category_id),
      amountCell(row.amount),
      expensePaymentModeLabel(row.payment_mode),
      row.remark ?? '',
      row.paid_from === 'company' ? 'Company account' : row.paid_from === 'personal' ? 'Personally' : 'Not recorded',
      row.paid_from === 'personal' ? ctx.personName(row.paid_by) : '',
      ctx.personName(row.created_by),
      REIMBURSEMENT_STATE_LABEL[state],
      state === 'reimbursed' ? row.reimbursement?.reference ?? '' : '',
      state === 'reimbursed' ? row.reimbursement?.reimbursed_on ?? '' : '',
    ]
  })
  const total = exactToString(sumExact(rows.map(r => r.amount)))
  return {
    name,
    rows: [EXPENSE_SHEET_HEADER, ...body, ['Total', '', '', amountCell(total), '', '', '', '', '', '', '', '']],
  }
}

// ── Reimbursement batches (the history, or one just recorded) ────────────────

export type ExportBatch = {
  id: string
  reimbursed_on: string
  reference: string
  payer_id: string
  expense_count: number
  total_amount: string | number
  status: 'recorded' | 'reversed'
  note: string | null
  recorded_by: string
  recorded_at: string
  reversed_at: string | null
  reversal_reason: string | null
}

export type ExportBatchItem = {
  reimbursement_id: string
  amount: string | number
  paid_by: string
  expense: { expense_date: string; paid_to: string; remark: string | null } | null
}

export const BATCH_SHEET_HEADER: SheetCell[] = [
  'Challan ID', 'Reimbursed on', 'Paid to', 'Expenses', 'Total (₹)', 'Status',
  'Recorded by', 'Recorded on', 'Note', 'Reversal reason',
]

export const BATCH_ITEM_SHEET_HEADER: SheetCell[] = [
  'Challan ID', 'Reimbursed on', 'Paid to', 'Expense date', 'Expense paid to', 'Remark', 'Amount (₹)', 'Status',
]

export function batchSummarySheet(batches: readonly ExportBatch[], nameOf: NameOf, name = 'Reimbursements'): Sheet {
  const body: SheetCell[][] = batches.map(b => [
    b.reference,
    b.reimbursed_on,
    nameOf(b.payer_id),
    b.expense_count,
    amountCell(b.total_amount),
    b.status === 'reversed' ? 'Reversed' : 'Reimbursed',
    nameOf(b.recorded_by),
    b.recorded_at.slice(0, 10),
    b.note ?? '',
    b.reversal_reason ?? '',
  ])
  // A reversed batch paid nothing, so it is not in the total.
  const live = batches.filter(b => b.status === 'recorded')
  const total = exactToString(sumExact(live.map(b => b.total_amount)))
  return {
    name,
    rows: [BATCH_SHEET_HEADER, ...body, ['Total (excluding reversed)', '', '', live.reduce((n, b) => n + b.expense_count, 0), amountCell(total), '', '', '', '', '']],
  }
}

export function batchItemsSheet(
  batches: readonly ExportBatch[],
  items: readonly ExportBatchItem[],
  nameOf: NameOf,
  name = 'Expenses paid back',
): Sheet {
  const byId = new Map(batches.map(b => [b.id, b]))
  const body: SheetCell[][] = []
  for (const item of items) {
    const batch = byId.get(item.reimbursement_id)
    if (!batch) continue
    body.push([
      batch.reference,
      batch.reimbursed_on,
      nameOf(batch.payer_id),
      item.expense?.expense_date ?? '',
      item.expense?.paid_to ?? '',
      item.expense?.remark ?? '',
      amountCell(item.amount),
      batch.status === 'reversed' ? 'Reversed' : 'Reimbursed',
    ])
  }
  return { name, rows: [BATCH_ITEM_SHEET_HEADER, ...body] }
}

/** The workbook for any set of batches: a summary sheet and a line-items sheet. */
export function reimbursementWorkbook(
  batches: readonly ExportBatch[],
  items: readonly ExportBatchItem[],
  nameOf: NameOf,
): Sheet[] {
  return [batchSummarySheet(batches, nameOf), batchItemsSheet(batches, items, nameOf)]
}

// ── File names ───────────────────────────────────────────────────────────────

function safeFilePart(text: string): string {
  const clean = text.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return clean === '' ? 'x' : clean.slice(0, 40)
}

export function expenseExportFileName(label: string, todayIso: string): string {
  return `expenses-${safeFilePart(label)}-${todayIso}.xlsx`
}

export function reimbursementExportFileName(scope: 'all' | { challan: string }, todayIso: string): string {
  return scope === 'all'
    ? `reimbursements-${todayIso}.xlsx`
    : `reimbursement-${safeFilePart(scope.challan)}-${todayIso}.xlsx`
}

// ── Writing the file (browser only) ──────────────────────────────────────────

/** Excel limits a sheet name to 31 characters and forbids : \ / ? * [ ]. */
export function sheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet'
}

/**
 * Builds the workbook and starts the download. `xlsx` is loaded only when a
 * person presses Download, so it is not part of the page's first load.
 */
export async function downloadWorkbook(fileName: string, sheets: readonly Sheet[]): Promise<void> {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows as unknown[][])
    const widest: number[] = []
    for (const row of sheet.rows) {
      row.forEach((cell, i) => { widest[i] = Math.max(widest[i] ?? 8, Math.min(String(cell ?? '').length + 2, 48)) })
    }
    ws['!cols'] = widest.map(wch => ({ wch }))
    XLSX.utils.book_append_sheet(book, ws, sheetName(sheet.name))
  }
  XLSX.writeFile(book, fileName)
}
