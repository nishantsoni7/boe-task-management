// ── Removing an expense, without destroying it ───────────────────────────────
//
// THE ROW IS NEVER DESTROYED. "Delete" on an expense sets a tombstone —
// deleted_at and deleted_by — and nothing else. The original date, amount,
// payee, category, remark, author and timestamps stay exactly as they were, so
// six months later somebody can still answer "what was this, and who removed
// it?". The migration adds NO DELETE POLICY to public.expenses, so a hard delete
// is refused by RLS for every non-service caller: soft deletion is not the
// polite option here, it is the only one that exists.
//
// WHAT A DELETED EXPENSE IS EXCLUDED FROM, and it is everything a person sees:
// the list, every filter, the total, category learning and reporting. It is
// present in exactly one place — the table — and there is deliberately NO
// recycle-bin screen in this phase. The retained row is for safety and a future
// recovery path, not a feature.
//
// A DELETED EXPENSE IS NOT EDITABLE. Enforced three times, because each layer
// catches a different mistake: the list draws no Edit control (this file's
// `mayEditExpense`), the form refuses to open on one, and a database trigger
// refuses any UPDATE to a tombstoned row whatever wrote it.
//
// NOTHING HERE AUTHORIZES ANYTHING. `mayDeleteExpense` decides which button is
// drawn; the two UPDATE policies in the database decide whether the write lands,
// from the same two facts (ownership, finance.manage). A disabled button is a
// courtesy.

import type { ExpenseRow } from './expenses'

// ── The tombstone ────────────────────────────────────────────────────────────

/** Is this expense removed from the normal records? */
export function isExpenseDeleted(
  row: { deleted_at?: string | null } | null | undefined,
): boolean {
  return row != null && row.deleted_at != null
}

/**
 * The rows that count — the list, the filters, the total, the matcher, reports.
 *
 * ONE FUNCTION, USED BY ALL OF THEM, so "excluded from totals" and "excluded
 * from the list" cannot drift apart. The database query also asks for
 * `deleted_at is null`; this is the second line of the same defence, and the one
 * a test can reach without a database.
 */
export function liveExpenses<T extends { deleted_at?: string | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter(row => !isExpenseDeleted(row))
}

// ── Who may delete ───────────────────────────────────────────────────────────

/**
 * May this person remove this expense?
 *
 * EXACTLY THE SET WHO MAY ALREADY CORRECT IT — its author, or a holder of the
 * protected finance.manage — because removing an expense and rewriting one are
 * the same authority over the same financial fact, and inventing a third rule
 * would mean a person who may silently change an amount to ₹1 may not withdraw
 * it. No new action key, no new permission row, no widening.
 *
 * AN ALREADY-DELETED EXPENSE CANNOT BE DELETED AGAIN. That is not a permission
 * question but it is the same answer — no button — and the database refuses the
 * write regardless.
 */
export function mayDeleteExpense(
  row: Pick<ExpenseRow, 'created_by'> & { deleted_at?: string | null },
  actor: { userId: string | null; canManageFinance: boolean },
): boolean {
  if (isExpenseDeleted(row)) return false
  if (actor.canManageFinance) return true
  return actor.userId !== null && row.created_by === actor.userId
}

/**
 * May this person correct this expense?
 *
 * The rule PR #174 shipped, with one addition: a deleted expense is not
 * editable by anybody, its author included. Restoring one is not a correction
 * and this phase has no path to it.
 */
export function mayEditExpense(
  row: Pick<ExpenseRow, 'created_by'> & { deleted_at?: string | null },
  actor: { userId: string | null; canManageFinance: boolean },
): boolean {
  if (isExpenseDeleted(row)) return false
  if (actor.canManageFinance) return true
  return actor.userId !== null && row.created_by === actor.userId
}

// ── The typed confirmation ───────────────────────────────────────────────────

/**
 * The word that has to be typed: DELETE.
 *
 * NOT THE EXPENSE'S ID, and the difference is deliberate. The payment deletion
 * dialog asks for a Payment ID because there the danger is deleting the WRONG
 * payment out of a list of near-identical ids — typing it back is the check that
 * the right row is selected. An expense has no human-facing id, and asking
 * somebody to copy a uuid teaches them to paste without reading. Here the
 * dialog states the four facts that identify the expense — date, amount, payee,
 * category — and the typed word is a deliberate pause, not an identity check.
 */
export const EXPENSE_DELETE_CONFIRMATION = 'DELETE'

/**
 * Does what has been typed match?
 *
 * SURROUNDING WHITESPACE IS FORGIVEN — a trailing space from a phone keyboard's
 * autocorrect is not a different answer. CASE IS NOT: "delete" typed in a hurry
 * against a dialog that says DELETE is exactly the half-attention this gate
 * exists to catch, and accepting it would make the gate decorative.
 */
export function expenseDeleteConfirmationMatches(typed: unknown): boolean {
  if (typeof typed !== 'string') return false
  return typed.trim() === EXPENSE_DELETE_CONFIRMATION
}

/**
 * What is wrong with what has been typed so far — or null.
 *
 * AN EMPTY BOX IS NOT A MISTAKE. Somebody who has not typed yet is reading the
 * dialog, not failing a check, so nothing is said until there is something on
 * screen that does not match.
 */
export function expenseDeleteConfirmationProblem(typed: string): string | null {
  if (typed.trim() === '') return null
  if (expenseDeleteConfirmationMatches(typed)) return null
  return `Type ${EXPENSE_DELETE_CONFIRMATION} exactly, in capitals.`
}

// ── The write ────────────────────────────────────────────────────────────────

/**
 * The patch that removes an expense.
 *
 * TWO COLUMNS, AND NOTHING ELSE. No amount is zeroed, no payee is blanked, no
 * category is cleared — a tombstoned expense that had lost its own details would
 * defeat the entire point of keeping the row. `deleted_at` is left to the
 * database's now(), so the moment recorded is the server's and not a phone's
 * clock, and `deleted_by` must be the caller because the UPDATE policy's WITH
 * CHECK requires it.
 *
 * updated_by IS SENT TOO, because the correction policies' WITH CHECK requires
 * every UPDATE by that path to name its author. Deleting is a kind of writing,
 * and the row records who did it in both places.
 */
export function expenseSoftDeletePayload(userId: string): {
  deleted_by: string
  updated_by: string
} {
  return { deleted_by: userId, updated_by: userId }
}

// ── What the dialog says ─────────────────────────────────────────────────────

/**
 * The sentence that explains what is about to happen, in the words the business
 * uses — not "soft delete", which means nothing to the person holding the phone,
 * and not "permanently deleted", which would be a lie.
 */
export const EXPENSE_DELETE_EXPLANATION =
  'This expense will be removed from the normal expense records — the list, the filters, the totals and the reports. It stops being counted anywhere.'

/** The second line: why the row is kept, said plainly rather than hidden. */
export const EXPENSE_DELETE_RETENTION_NOTE =
  'A record of it is kept in the database for safety, with your name and the time, in case it ever has to be recovered.'

export const EXPENSE_DELETE_PROMPT = `Type ${EXPENSE_DELETE_CONFIRMATION} to confirm`
