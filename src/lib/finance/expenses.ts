// ── Expenses: the rules, away from the screens ───────────────────────────────
//
// Money BOE PAYS OUT, recorded by the person who paid it. Everything in this
// file is pure: the payment-mode vocabulary, the form's validation, the
// category-name rules and the filtered total. The React components hold no rule
// of their own, so each one can be read — and tested — without a browser.
//
// NOTHING HERE AUTHORIZES ANYTHING. Every rule below is re-derived by the
// database: the CHECK constraints on public.expenses refuse a bad amount, an
// unknown mode, an untrimmed payee and a blank remark, and the RLS policies
// decide who may write at all (20261220000000). A browser check is a courtesy
// that tells somebody what is wrong before the round trip, never a boundary.
//
// WHY THIS IS NOT paymentEntry.ts. An expense is an OUTGOING payment and shares
// no vocabulary with the incoming-payment forms — no destination, no PI, no
// Order, no customer, no proof, no verification. The one thing it looked like it
// could share, payment_mode, it deliberately does not; see EXPENSE_PAYMENT_MODES
// below.

import { isValidAmount, amountInputProblem } from '@/lib/currency'
import { sumExact, exactToString } from './exactMoney'

// ── Payment mode ─────────────────────────────────────────────────────────────
//
// THE EXPENSE'S OWN LIST, AND DELIBERATELY NOT FINANCE'S.
//
// finance_payment_requests.payment_mode offers four values — hdfc, pnb, paytm,
// canara — and they are the BOE ACCOUNTS MONEY ARRIVES INTO (paymentEntry.ts,
// and the database's own column comment). "Which BOE account received this" is
// not a question about money somebody paid out of their own pocket for diesel.
//
// The five generic values that WOULD have fitted — bank_transfer, cash, upi,
// cheque, other — are RETIRED on that table: kept storable so history reads, and
// refused for any new entry by the four entry RPCs and by
// finance_payment_requests_enforce_current_payment_mode. Reusing a domain the
// database is actively rejecting would have been the worst of both.
//
// So: one small outgoing list, matching how these payments are actually made.
// The two columns are independent and neither constrains the other. The same
// seven values are a CHECK constraint on public.expenses.payment_mode.

export const EXPENSE_PAYMENT_MODES = [
  { value: 'cash',          label: 'Cash' },
  { value: 'upi',           label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'credit_card',   label: 'Credit Card' },
  { value: 'debit_card',    label: 'Debit Card' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'other',         label: 'Other' },
] as const

export type ExpensePaymentMode = typeof EXPENSE_PAYMENT_MODES[number]['value']

export const EXPENSE_PAYMENT_MODE_VALUES: readonly ExpensePaymentMode[] =
  EXPENSE_PAYMENT_MODES.map(m => m.value)

/** The mode a fresh form starts on. Cash is what most of these actually are. */
export const DEFAULT_EXPENSE_PAYMENT_MODE: ExpensePaymentMode = 'cash'

export function isExpensePaymentMode(value: string | null | undefined): value is ExpensePaymentMode {
  return (EXPENSE_PAYMENT_MODE_VALUES as readonly string[]).includes(value ?? '')
}

const EXPENSE_PAYMENT_MODE_LABEL: Record<string, string> =
  Object.fromEntries(EXPENSE_PAYMENT_MODES.map(m => [m.value, m.label]))

/**
 * How a stored mode is written down.
 *
 * An unrecognised value is returned AS STORED rather than as "Other" — the same
 * choice paymentModeLabel makes. A row carrying something this list does not
 * know is a fact worth seeing, and relabelling it would hide the only evidence.
 */
export function expensePaymentModeLabel(value: string | null | undefined): string {
  const key = (value ?? '').trim()
  if (!key) return '—'
  return EXPENSE_PAYMENT_MODE_LABEL[key] ?? key
}

// ── Rows, as the database returns them ───────────────────────────────────────

export type ExpenseCategory = {
  id: string
  name: string
  is_active: boolean
}

export type ExpenseRow = {
  id: string
  expense_date: string
  /** `numeric` crosses the wire as a STRING. Kept as one; see exactMoney.ts. */
  amount: string
  payment_mode: string
  paid_to: string
  category_id: string
  remark: string | null
  created_by: string
  created_at: string
  updated_at: string
  updated_by: string | null
  /**
   * THE TOMBSTONE. Null on every expense that counts; set on one that has been
   * removed from the normal records — the list, the filters, the total,
   * category learning and reporting alike.
   *
   * THE ROW ITSELF IS NEVER DESTROYED. Migration 20261222000000 adds these two
   * columns and still adds no DELETE policy, so a hard delete remains refused
   * by RLS for every non-service caller. See expenseDeletion.ts for the rules
   * and ExpensesView for where the exclusion is applied.
   */
  deleted_at: string | null
  deleted_by: string | null
}

/** A row joined to the two names a list row prints. */
export type ExpenseListRow = ExpenseRow & {
  category_name: string | null
  created_by_name: string | null
}

// ── Category names ───────────────────────────────────────────────────────────
//
// ONE COMPARISON KEY, used everywhere a duplicate must be detected: the browser
// before it writes, and the unique index on lower(name) after. If the two
// disagreed, the form would offer to create a category the database then
// refuses with a constraint error nobody can read.

/** What is actually stored: the trimmed name, with inner runs of whitespace collapsed. */
export function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** The case-insensitive comparison key. Mirrors the database's lower(name). */
export function categoryKey(raw: string): string {
  return normalizeCategoryName(raw).toLowerCase()
}

export const CATEGORY_NAME_MAX = 60

/** Why a typed category name cannot be saved, in words — or null when it is fine. */
export function categoryNameProblem(raw: string): string | null {
  const name = normalizeCategoryName(raw)
  if (name === '') return 'Enter a category name.'
  if (name.length > CATEGORY_NAME_MAX) return `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer.`
  return null
}

/**
 * The existing category with this name, case-insensitively — or null.
 *
 * RETIRED CATEGORIES ARE SEARCHED TOO, deliberately. The unique index covers
 * every row, so "Diesel" cannot be created again while a retired "diesel"
 * holds the name. Finding it here means the form can say so, instead of the
 * write failing with a constraint violation.
 */
export function findCategoryByName(
  categories: readonly ExpenseCategory[],
  raw: string,
): ExpenseCategory | null {
  const key = categoryKey(raw)
  if (key === '') return null
  return categories.find(c => categoryKey(c.name) === key) ?? null
}

/** What the picker offers: active categories, by name, case-insensitively. */
export function selectableCategories(
  categories: readonly ExpenseCategory[],
  /** Keep this one even if retired — the category an expense being edited names. */
  keepId?: string | null,
): ExpenseCategory[] {
  return categories
    .filter(c => c.is_active || (keepId != null && c.id === keepId))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' }))
}

// ── The form ─────────────────────────────────────────────────────────────────

export type ExpenseFormState = {
  expenseDate: string
  /** The raw text of the amount field. Never a number; see AmountInput. */
  amount: string
  paymentMode: string
  paidTo: string
  categoryId: string
  remark: string
}

export type ExpenseFormField = keyof ExpenseFormState

export type ExpenseFormErrors = Partial<Record<ExpenseFormField, string>>

export const PAID_TO_MAX = 120
export const REMARK_MAX = 500

export function emptyExpenseForm(todayIso: string): ExpenseFormState {
  return {
    expenseDate: todayIso,
    amount: '',
    paymentMode: DEFAULT_EXPENSE_PAYMENT_MODE,
    paidTo: '',
    categoryId: '',
    remark: '',
  }
}

/** An existing expense, as the shared form edits it. */
export function expenseFormFromRow(row: ExpenseRow): ExpenseFormState {
  return {
    expenseDate: row.expense_date,
    amount: row.amount,
    paymentMode: row.payment_mode,
    paidTo: row.paid_to,
    categoryId: row.category_id,
    remark: row.remark ?? '',
  }
}

/**
 * Everything wrong with the form, field by field.
 *
 * ONE PASS, EVERY FIELD. Not "the first problem": somebody filling this in on a
 * phone should see all of what is missing at once rather than discovering it one
 * save at a time.
 *
 * `todayIso` is injected rather than read from the clock, so the future-date
 * rule is testable and so it is the READER'S local date — localTodayIso, not
 * toISOString, for the reason recorded against the PI payment form.
 */
export function validateExpenseForm(
  form: ExpenseFormState,
  todayIso: string,
): ExpenseFormErrors {
  const errors: ExpenseFormErrors = {}

  if (!form.expenseDate) {
    errors.expenseDate = 'Choose the date the money was paid.'
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(form.expenseDate)) {
    errors.expenseDate = 'Choose a valid date.'
  } else if (form.expenseDate > todayIso) {
    // An older payment is the point of the field; a future one is a typo.
    errors.expenseDate = 'An expense cannot be dated in the future.'
  }

  const amount = form.amount.trim()
  if (amount === '') {
    errors.amount = 'Enter the amount paid.'
  } else {
    // The SHARED amount rules, so an expense is refused for exactly the reasons
    // every other Finance amount is, in exactly the same words. Nothing is
    // rounded or trimmed on the person's behalf.
    const problem = amountInputProblem(amount)
    if (problem) errors.amount = problem
    else if (!isValidAmount(amount)) errors.amount = 'Enter an amount greater than zero.'
  }

  if (!isExpensePaymentMode(form.paymentMode)) {
    errors.paymentMode = 'Choose how it was paid.'
  }

  const paidTo = form.paidTo.trim()
  if (paidTo === '') errors.paidTo = 'Enter who was paid.'
  else if (paidTo.length > PAID_TO_MAX) errors.paidTo = `Keep this to ${PAID_TO_MAX} characters or fewer.`

  if (!form.categoryId) errors.categoryId = 'Choose a category.'

  if (form.remark.trim().length > REMARK_MAX) {
    errors.remark = `Keep the remark to ${REMARK_MAX} characters or fewer.`
  }

  return errors
}

export function isExpenseFormValid(form: ExpenseFormState, todayIso: string): boolean {
  return Object.keys(validateExpenseForm(form, todayIso)).length === 0
}

/**
 * The row to write, from a valid form.
 *
 * TRIMMED HERE, ONCE. The database's CHECK constraints refuse an untrimmed payee
 * and a blank-but-not-null remark, so the shape the form produces has to be the
 * shape the table accepts — not nearly it.
 *
 * The amount is passed through AS THE STRING THAT WAS TYPED. Number() would put
 * a double between the person and the ledger for no reason; `numeric` accepts
 * the decimal string exactly.
 */
export function expenseWritePayload(form: ExpenseFormState): {
  expense_date: string
  amount: string
  payment_mode: string
  paid_to: string
  category_id: string
  remark: string | null
} {
  const remark = form.remark.trim()
  return {
    expense_date: form.expenseDate,
    amount: form.amount.trim(),
    payment_mode: form.paymentMode,
    paid_to: form.paidTo.trim(),
    category_id: form.categoryId,
    remark: remark === '' ? null : remark,
  }
}

// ── Filters ──────────────────────────────────────────────────────────────────

export type ExpenseFilters = {
  dateFrom: string
  dateTo: string
  categoryId: string
  paymentMode: string
  search: string
}

export const EMPTY_EXPENSE_FILTERS: ExpenseFilters = {
  dateFrom: '', dateTo: '', categoryId: '', paymentMode: '', search: '',
}

/** Is anything narrowing the list? Decides whether "Clear filters" is offered. */
export function expenseFiltersActive(filters: ExpenseFilters): boolean {
  return filters.dateFrom !== '' || filters.dateTo !== ''
    || filters.categoryId !== '' || filters.paymentMode !== ''
    || filters.search.trim() !== ''
}

/**
 * A date range typed the wrong way round is read as the range BETWEEN the two
 * bounds, not answered with an empty list — the same courtesy the Confirmed
 * Payments toolbar extends.
 */
export function orderedDateRange(filters: ExpenseFilters): { from: string; to: string } {
  const { dateFrom, dateTo } = filters
  if (dateFrom && dateTo && dateFrom > dateTo) return { from: dateTo, to: dateFrom }
  return { from: dateFrom, to: dateTo }
}

/**
 * The PostgREST `or` clause for the free-text search: paid-to or remark.
 *
 * Commas and parentheses are what separate the terms in that syntax, so a
 * search containing one would otherwise be read as a second filter. They are
 * dropped from the pattern rather than escaped — a payee name is matched on its
 * words, and no punctuation a person types can turn into a predicate.
 */
export function expenseSearchClause(search: string): string | null {
  const term = search.trim().replace(/[,()*\\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (term === '') return null
  return `paid_to.ilike.%${term}%,remark.ilike.%${term}%`
}

// ── The total ────────────────────────────────────────────────────────────────

/**
 * The exact sum of what is on screen, as a decimal STRING.
 *
 * Exact, through exactMoney: `0.1 + 0.2 !== 0.3` in binary floating point, and a
 * total under a list of expenses is a figure somebody will reconcile against a
 * bank statement. A row whose amount could not be parsed contributes nothing
 * rather than poisoning the sum — sumExact's rule, carried through.
 *
 * THIS IS THE TOTAL OF THE ROWS PASSED IN. The list loads its whole filtered
 * result (it is not paged in Phase 1), so that is the filtered total; if paging
 * is ever added, this must be replaced by a database-side sum rather than left
 * to describe one page.
 *
 * A SOFT-DELETED EXPENSE CONTRIBUTES NOTHING, and that is enforced HERE as well
 * as in the query. The list already asks the database for `deleted_at is null`,
 * so in practice no tombstoned row reaches this function — but "a deleted
 * expense is not in the total" is the promise the delete dialog makes, and a
 * promise about money is worth holding in the one place that computes it, where
 * a test can reach it without a database. A row with no `deleted_at` field at
 * all — a plain `{ amount }`, which several callers pass — is live.
 */
export function expenseTotal(
  rows: readonly { amount: string | number | null; deleted_at?: string | null }[],
): string {
  return exactToString(sumExact(
    rows.filter(r => r.deleted_at == null).map(r => r.amount)))
}
