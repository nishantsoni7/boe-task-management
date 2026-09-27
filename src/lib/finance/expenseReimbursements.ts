// ── Expenses: who paid, reimbursement, and bills — the rules ─────────────────
//
// Pure, like expenses.ts: the vocabulary, the states, the selection rules and
// the error wording. The screens hold no rule of their own.
//
// NOTHING HERE AUTHORIZES ANYTHING. The database decides (20270205120000):
// record_expense_reimbursement() refuses a mixed selection, a stale total and a
// caller without finance.manage + company-wide Finance sight; triggers freeze a
// reimbursed expense; the storage rule opens a bill only for somebody who may
// read its expense. These functions tell a person what is wrong BEFORE the round
// trip, and put the database's refusal into words after it.

import { sumExact, exactToString } from './exactMoney'
import type { ExpenseRow } from './expenses'

// ── Payment source ───────────────────────────────────────────────────────────

export type ExpensePaidFrom = 'company' | 'personal'

export const EXPENSE_PAID_FROM_OPTIONS: readonly { value: ExpensePaidFrom; label: string; hint: string }[] = [
  { value: 'company',  label: 'Paid from company account',            hint: 'No reimbursement' },
  { value: 'personal', label: 'Paid personally, reimbursement needed', hint: 'Finance pays it back' },
]

// ── Reimbursement state ──────────────────────────────────────────────────────
//
// FOUR STATES, NOT THREE. `unknown` is every expense entered before the payment
// source was recorded. It is never shown as company-paid and never counted as
// pending: nobody said which it was.

export type ReimbursementState = 'company' | 'pending' | 'reimbursed' | 'unknown'

type SourceFields = Pick<ExpenseRow, 'paid_from' | 'reimbursement_id'>

export function reimbursementState(row: SourceFields): ReimbursementState {
  if (row.paid_from === 'company') return 'company'
  if (row.paid_from === 'personal') return row.reimbursement_id ? 'reimbursed' : 'pending'
  return 'unknown'
}

export const REIMBURSEMENT_STATE_LABEL: Record<ReimbursementState, string> = {
  company: 'Company-paid',
  pending: 'Pending reimbursement',
  reimbursed: 'Reimbursed',
  unknown: 'Source not recorded',
}

/** The compact word the list uses. */
export const REIMBURSEMENT_STATE_SHORT: Record<ReimbursementState, string> = {
  company: 'Company',
  pending: 'Pending',
  reimbursed: 'Reimbursed',
  unknown: '',
}

// ── Filters ──────────────────────────────────────────────────────────────────

export type ReimbursementFilter = '' | ReimbursementState

export const REIMBURSEMENT_FILTER_OPTIONS: readonly { value: ReimbursementFilter; label: string }[] = [
  { value: '', label: 'All payment sources' },
  { value: 'company', label: 'Company-paid' },
  { value: 'pending', label: 'Pending reimbursement' },
  { value: 'reimbursed', label: 'Reimbursed' },
  { value: 'unknown', label: 'Source not recorded' },
]

// ── Selecting expenses to reimburse ──────────────────────────────────────────

export type ReimbursableRow = SourceFields & Pick<ExpenseRow, 'id' | 'amount' | 'deleted_at' | 'paid_by'>

/**
 * ONE PAYER PER REIMBURSEMENT. A challan / payment reference names one transfer
 * to one person, so a batch never mixes payers — record_expense_reimbursement()
 * refuses it too. The payer of a selection, or null when it has none or several.
 */
export function selectionPayer(rows: readonly Pick<ExpenseRow, 'paid_by'>[]): string | null {
  const payers = new Set(rows.map(r => r.paid_by ?? null))
  if (payers.size !== 1) return null
  return [...payers][0] ?? null
}

/** May this row join the current selection? Only a pending one of the same payer. */
export function maySelectWith(row: ReimbursableRow, selected: readonly ReimbursableRow[]): boolean {
  if (!isReimbursable(row)) return false
  if (selected.length === 0) return true
  return selectionPayer(selected) === (row.paid_by ?? null)
}

/** Only a live, personally-paid, not-yet-reimbursed expense can be selected. */
export function isReimbursable(row: ReimbursableRow): boolean {
  return row.deleted_at == null && reimbursementState(row) === 'pending'
}

/**
 * Why this selection cannot be reimbursed, in words — or null.
 *
 * The database refuses the same selection for the same reasons; this says so
 * before anybody presses Confirm.
 */
export function reimbursementSelectionProblem(rows: readonly ReimbursableRow[]): string | null {
  if (rows.length === 0) return 'Select at least one pending expense.'
  const ids = new Set(rows.map(r => r.id))
  if (ids.size !== rows.length) return 'An expense was selected twice.'
  const counts: Record<ReimbursementState | 'deleted', number> = {
    company: 0, pending: 0, reimbursed: 0, unknown: 0, deleted: 0,
  }
  for (const row of rows) {
    if (row.deleted_at != null) counts.deleted++
    else counts[reimbursementState(row)]++
  }
  const problems: string[] = []
  if (counts.company) problems.push(`${counts.company} company-paid`)
  if (counts.reimbursed) problems.push(`${counts.reimbursed} already reimbursed`)
  if (counts.unknown) problems.push(`${counts.unknown} with no payment source recorded`)
  if (counts.deleted) problems.push(`${counts.deleted} deleted`)
  if (problems.length > 0) return `Only pending personal expenses can be reimbursed. Remove ${problems.join(', ')}.`
  if (selectionPayer(rows) === null) {
    return 'These expenses were paid by different people. Reimburse one payer at a time — each payment gets its own date and reference.'
  }
  return null
}

/** The exact total of a selection, as a decimal string. */
export function selectionTotal(rows: readonly { amount: string | number | null }[]): string {
  return exactToString(sumExact(rows.map(r => r.amount)))
}

export const REIMBURSEMENT_BATCH_MAX = 200
export const REIMBURSEMENT_REFERENCE_MAX = 120
export const REIMBURSEMENT_NOTE_MAX = 500

export type ReimbursementFormState = {
  reimbursedOn: string
  reference: string
  note: string
}

export type ReimbursementFormErrors = Partial<Record<keyof ReimbursementFormState, string>>

export function validateReimbursementForm(form: ReimbursementFormState, todayIso: string): ReimbursementFormErrors {
  const errors: ReimbursementFormErrors = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.reimbursedOn)) errors.reimbursedOn = 'Choose the reimbursement date.'
  else if (form.reimbursedOn > todayIso) errors.reimbursedOn = 'A reimbursement cannot be dated in the future.'
  const reference = form.reference.trim()
  if (reference === '') errors.reference = 'Enter the challan / payment reference.'
  else if (reference.length > REIMBURSEMENT_REFERENCE_MAX) {
    errors.reference = `Keep the reference to ${REIMBURSEMENT_REFERENCE_MAX} characters or fewer.`
  }
  if (form.note.trim().length > REIMBURSEMENT_NOTE_MAX) {
    errors.note = `Keep the note to ${REIMBURSEMENT_NOTE_MAX} characters or fewer.`
  }
  return errors
}

// ── Who may do what (a courtesy; the database decides) ───────────────────────

/**
 * Record or reverse a reimbursement: finance.manage AND company-wide Finance
 * sight — exactly can_record_expense_reimbursement() in the database. An admin
 * holds both through the admin branch.
 */
export function mayRecordReimbursement(caps: { canManageFinance: boolean; canViewAllFinance: boolean }): boolean {
  return caps.canManageFinance && caps.canViewAllFinance
}

/**
 * The named payer of a live personal expense may ADD a bill to it, and remove
 * only a bill they uploaded, before it is reimbursed — can_add_expense_bill()
 * and expense_bill_attachments_remove in the database. Everything else about
 * the expense stays read only for them.
 */
export function mayAddBillAsPayer(
  row: Pick<ExpenseRow, 'paid_from' | 'paid_by' | 'deleted_at'>,
  userId: string | null,
): boolean {
  return userId !== null && row.deleted_at == null && row.paid_from === 'personal' && row.paid_by === userId
}

/** Name somebody else as the payer: finance.manage, as the database's guard. */
export function mayRecordForOthers(caps: { canManageFinance: boolean }): boolean {
  return caps.canManageFinance
}

// ── The database's refusals, in words ────────────────────────────────────────

type RpcError = { code?: string; message?: string } | null | undefined

export function friendlyReimbursementError(error: RpcError): string {
  const message = error?.message ?? ''
  // The database's sentence after its code, as a sentence: capitalised, one full stop.
  const tail = (prefix: string) => {
    const text = message.slice(message.indexOf(prefix) + prefix.length).replace(/^:\s*/, '').trim()
    const sentence = text.charAt(0).toUpperCase() + text.slice(1)
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
  }
  if (message.includes('EXPENSE_REIMBURSEMENT_NOT_PENDING')) {
    return `${tail('EXPENSE_REIMBURSEMENT_NOT_PENDING')} Another person may have just reimbursed some of them — refresh the list. Nothing was recorded.`
  }
  if (message.includes('EXPENSE_REIMBURSEMENT_MIXED_PAYERS')) return `${tail('EXPENSE_REIMBURSEMENT_MIXED_PAYERS')} Nothing was recorded.`
  if (message.includes('EXPENSE_REIMBURSEMENT_STALE')) return `${tail('EXPENSE_REIMBURSEMENT_STALE')} Nothing was recorded.`
  if (message.includes('EXPENSE_REIMBURSEMENT_ALREADY_REVERSED')) return 'This reimbursement was already reversed.'
  if (message.includes('EXPENSE_REIMBURSEMENT_INVALID')) return tail('EXPENSE_REIMBURSEMENT_INVALID')
  if (message.includes('EXPENSE_REIMBURSEMENT_NOT_FOUND')) return 'That reimbursement no longer exists.'
  if (message.includes('EXPENSE_REIMBURSEMENT_FORBIDDEN') || error?.code === '42501') {
    return 'Only Finance users who manage expenses can record or reverse a reimbursement.'
  }
  return message || 'The reimbursement could not be saved. Nothing was recorded — try again.'
}

// ── Bills ────────────────────────────────────────────────────────────────────

export const EXPENSE_BILL_BUCKET = 'expense-bills'
export const EXPENSE_BILL_MAX_BYTES = 10 * 1024 * 1024
export const EXPENSE_BILL_URL_TTL_SECONDS = 120
export const EXPENSE_BILL_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp'

const BILL_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function billExtension(mimeType: string): string | null {
  return BILL_EXTENSION[mimeType] ?? null
}

/** Why this file cannot be attached, in words — or null. */
export function billFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (!billExtension(file.type)) return `${file.name}: attach a PDF, JPG, PNG or WebP file.`
  if (file.size <= 0) return `${file.name} is empty.`
  if (file.size > EXPENSE_BILL_MAX_BYTES) return `${file.name} is larger than 10 MB.`
  return null
}

/** {expense}/{random}.{ext} — the only key shape the storage rule admits. */
export function billStoragePath(expenseId: string, randomId: string, mimeType: string): string {
  const ext = billExtension(mimeType)
  if (!ext) throw new Error('Unsupported bill type')
  return `${expenseId}/${randomId}.${ext}`
}

/** A display name the database will accept (1–200 characters). */
export function billDisplayName(name: string): string {
  const clean = name.trim() || 'bill'
  return clean.length > 200 ? clean.slice(0, 200) : clean
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export type ExpenseBillRow = {
  id: string
  expense_id: string
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  uploaded_by: string
  created_at: string
  removed_at: string | null
}

/**
 * ONE EXPENSE'S reimbursement, as expense_reimbursement_receipts() returns it
 * to anybody who may read that expense: its own amount, never the batch total.
 */
export type ExpenseReimbursementReceipt = {
  expense_id: string
  reimbursement_id: string
  reimbursed_on: string
  reference: string
  amount: string | number
  recorded_by: string
  recorded_at: string
}

/** The whole batch — readable by company-wide Finance sight only. */
export type ExpenseReimbursementRow = {
  id: string
  payer_id: string
  reimbursed_on: string
  reference: string
  note: string | null
  expense_count: number
  total_amount: string | number
  status: 'recorded' | 'reversed'
  recorded_by: string
  recorded_at: string
  reversed_by: string | null
  reversed_at: string | null
  reversal_reason: string | null
}
