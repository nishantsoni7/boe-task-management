// ── Quick Capture and Needs Details: the rules ───────────────────────────────
//
// "500 cash to Ramesh for diesel." — said into a phone while walking back to the
// car, saved in one tap, completed at a desk that evening.
//
// ── WHY A SEPARATE TABLE, AND NOT A "DRAFT" FLAG ON public.expenses ─────────
//
// A finalized expense has a date, an amount, a payment mode, a payee and a
// category, and every one of those is NOT NULL with a CHECK behind it. That is
// the whole value of the table: nothing in it is half-entered, and any total
// over it is a real total.
//
// A capture is the opposite by design — it is whatever somebody managed to say.
// Putting it in public.expenses would mean making those columns nullable, and
// every constraint that protects a finalized expense would have to be weakened
// to a conditional one for every row that already exists. So: a separate table,
// public.expense_drafts, whose columns are nullable BECAUSE THEY ARE MEANT TO
// BE, beside an expenses table whose constraints are untouched.
//
// A DRAFT IS NOT AN EXPENSE, and the separation is what makes that true rather
// than a convention. A draft cannot appear in the expense list, cannot reach a
// total, cannot reach a category total, cannot teach the Smart suggestion
// matcher and cannot appear in reporting — not because each of those filters it
// out, but because none of them reads that table at all.
//
// ── "NEEDS DETAILS", NOT "PENDING APPROVAL" ─────────────────────────────────
//
// Nobody else has to look at these. A draft is waiting for its own author to
// finish it, and calling that queue "approval" would invent a second person and
// a permission that does not exist. Every word on the screen says Needs Details.
//
// ── NOTHING IS EVER INVENTED ────────────────────────────────────────────────
//
// A field the sentence did not contain is saved as NULL and shown as missing.
// The one exception is the DATE, which defaults to today and says so: a capture
// is made minutes after the payment, an expense must have a date, and "today"
// is a statement the person can see and change rather than a guess hidden in a
// column.
//
// ── NOTHING SAVES ITSELF ────────────────────────────────────────────────────
//
// Speech recognition fills the text box and stops. The person reads what was
// heard and taps Save for later. There is no code path from a recognition
// result to a write, here or in the components.

import { localTodayIso } from './piPaymentView'
import {
  emptyExpenseForm,
  isExpensePaymentMode,
  type ExpenseFormState,
} from './expenses'
import { parseExpenseSpeech, type ExpenseVoiceParse } from './expenseVoice'

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * THREE STATES, AND TWO OF THEM ARE TERMINAL.
 *
 *   pending    in the Needs Details inbox, waiting for its author.
 *   finalized  it became exactly one expense. The row stays, linked to it, for
 *              audit — and leaves the inbox.
 *   discarded  it was not wanted. The row stays, with who discarded it and when.
 *
 * THERE IS NO DELETION. The migration adds no DELETE policy to the table, so a
 * hard delete is refused by RLS for every non-service caller, exactly as on
 * public.expenses. Discarding is a status, not a removal.
 */
export const EXPENSE_DRAFT_STATUSES = ['pending', 'finalized', 'discarded'] as const
export type ExpenseDraftStatus = typeof EXPENSE_DRAFT_STATUSES[number]

export function isExpenseDraftStatus(value: unknown): value is ExpenseDraftStatus {
  return typeof value === 'string' && (EXPENSE_DRAFT_STATUSES as readonly string[]).includes(value)
}

// ── The row ──────────────────────────────────────────────────────────────────

export type ExpenseDraftRow = {
  id: string
  /** What was typed or spoken, verbatim. The one field that is never null. */
  raw_text: string
  /** Always set. Today when the sentence named no date — and the UI says so. */
  parsed_date: string
  /** `numeric` crosses the wire as a STRING, or null when none was heard. */
  parsed_amount: string | null
  parsed_paid_to: string | null
  parsed_payment_mode: string | null
  parsed_remark: string | null
  /** A category only if one was chosen or matched. Never invented. */
  category_id: string | null
  status: ExpenseDraftStatus
  /** The one expense this became. Null until it is finalized. */
  expense_id: string | null
  finalized_at: string | null
  discarded_by: string | null
  discarded_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export const DRAFT_RAW_TEXT_MAX = 500

// ── Saving a capture ─────────────────────────────────────────────────────────

/**
 * Why this capture cannot be saved — or null.
 *
 * THE ONLY REQUIREMENT IS THAT SOMETHING WAS SAID. Not an amount, not a payee,
 * not a category: the entire purpose of Quick Capture is that it accepts what
 * somebody had time to give. An empty box is refused because a draft with no
 * text is not a record of anything — there would be nothing to complete it
 * from, and it would sit in the inbox forever as a row nobody can act on.
 */
export function draftTextProblem(raw: string): string | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return 'Type or say what was paid, then save it.'
  if (text.length > DRAFT_RAW_TEXT_MAX) {
    return `Keep this to ${DRAFT_RAW_TEXT_MAX} characters or fewer.`
  }
  return null
}

export type ExpenseDraftWritePayload = {
  raw_text: string
  parsed_date: string
  parsed_amount: string | null
  parsed_paid_to: string | null
  parsed_payment_mode: string | null
  parsed_remark: string | null
  category_id: string | null
}

/**
 * The row to write, from one line of text.
 *
 * THE SAME PARSER THE VOICE FORM USES, on the same sentences, so a typed
 * capture and a spoken one are read identically — the microphone produces a
 * string and this function does not know or care which one it got.
 *
 * NOTHING IS GUESSED. Every field the parser did not settle is null. The date is
 * the deliberate exception recorded in the header.
 *
 * THE PURPOSE FALLS BACK TO THE CATEGORY WORDS. "750 for factory work" names no
 * category that exists, but "factory work" is plainly the purpose — it is kept
 * as the remark so the Smart suggestion has something to work with at completion
 * time, instead of being thrown away because it matched no category row.
 */
export function draftWritePayload(
  rawText: string,
  todayIso: string,
  /** Injected only by the test; the default is the real parser. */
  parse: (text: string, today: string) => ExpenseVoiceParse = parseExpenseSpeech,
): ExpenseDraftWritePayload {
  const text = rawText.trim()
  const parsed = parse(text, todayIso)

  const remark = parsed.remark ?? parsed.categoryText ?? null
  const trimmedRemark = remark === null ? null : remark.trim()

  return {
    raw_text: text,
    parsed_date: parsed.date ?? todayIso,
    parsed_amount: parsed.amount,
    parsed_paid_to: parsed.paidTo === null ? null : parsed.paidTo.trim() || null,
    parsed_payment_mode: parsed.paymentMode,
    parsed_remark: trimmedRemark === '' ? null : trimmedRemark,
    // A capture never picks a category. Matching happens when the draft is
    // completed, against the categories that exist THEN — which may not be the
    // ones that existed when it was spoken.
    category_id: null,
  }
}

/** Was the date in the payload assumed rather than said? Drives the UI note. */
export function draftDateWasAssumed(
  rawText: string,
  todayIso: string,
  parse: (text: string, today: string) => ExpenseVoiceParse = parseExpenseSpeech,
): boolean {
  return parse(rawText.trim(), todayIso).date === null
}

// ── What is missing ──────────────────────────────────────────────────────────

/**
 * The fields a finalized expense requires that this draft does not have, in the
 * words the form uses for them.
 *
 * SAID PLAINLY AND IN FULL. A person opening the inbox a week later has to know
 * what completing this will ask of them BEFORE they tap it — the amount is the
 * one they may no longer remember, and finding that out after opening the form
 * is the difference between a two-second decision and a wasted trip.
 *
 * THE DATE IS NEVER MISSING. It always has a value; whether that value was heard
 * or assumed is a different fact, carried by `date_was_assumed` in the UI.
 * THE REMARK IS NEVER MISSING EITHER — it is optional on a finalized expense.
 */
export function draftMissingFields(row: {
  parsed_amount: string | null
  parsed_paid_to: string | null
  parsed_payment_mode: string | null
  category_id: string | null
}): string[] {
  const missing: string[] = []
  if (row.parsed_amount === null || row.parsed_amount.trim() === '') missing.push('Amount')
  if (row.parsed_paid_to === null || row.parsed_paid_to.trim() === '') missing.push('Paid to')
  if (!isExpensePaymentMode(row.parsed_payment_mode)) missing.push('Payment mode')
  if (row.category_id === null || row.category_id === '') missing.push('Category')
  return missing
}

/**
 * The one-line summary under a draft in the inbox.
 *
 * "Nothing missing" is a real and common answer — a complete sentence produces a
 * draft that only needs somebody to look at it and press Save.
 */
export function draftMissingSummary(missing: readonly string[]): string {
  if (missing.length === 0) return 'Nothing missing — review and save it.'
  if (missing.length === 1) return `Missing: ${missing[0]}`
  return `Missing: ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
}

/** Is this draft still waiting in the inbox? */
export function isDraftPending(row: { status: string }): boolean {
  return row.status === 'pending'
}

/**
 * The inbox's badge.
 *
 * COUNTS ONLY PENDING ROWS — a finalized draft became an expense and a
 * discarded one was not wanted, and a badge that counted either would send
 * somebody to an inbox with nothing in it.
 */
export function pendingDraftCount(rows: readonly { status: string }[]): number {
  return rows.reduce((n, row) => n + (isDraftPending(row) ? 1 : 0), 0)
}

// ── Completing one ───────────────────────────────────────────────────────────

/**
 * The expense form, prefilled from a draft.
 *
 * EVERY RECOGNISED FIELD IS PREFILLED AND EVERY ONE REMAINS EDITABLE. Nothing is
 * locked: the parse is a convenience, and a parse that got the payee wrong must
 * be as easy to fix as an empty field is to fill.
 *
 * AN UNRECOGNISED PAYMENT MODE FALLS BACK TO THE FORM'S DEFAULT rather than
 * being forced — the draft stored what was heard, and if that is not one of the
 * seven the form offers, the form starts where a fresh one starts and the person
 * chooses. The draft row keeps what was actually said, untouched.
 */
export function expenseFormFromDraft(
  row: Pick<ExpenseDraftRow,
    'parsed_date' | 'parsed_amount' | 'parsed_paid_to' | 'parsed_payment_mode' | 'parsed_remark' | 'category_id'>,
  todayIso: string = localTodayIso(),
): ExpenseFormState {
  const base = emptyExpenseForm(todayIso)
  return {
    expenseDate: row.parsed_date || base.expenseDate,
    amount: row.parsed_amount ?? '',
    paymentMode: isExpensePaymentMode(row.parsed_payment_mode)
      ? row.parsed_payment_mode
      : base.paymentMode,
    paidTo: row.parsed_paid_to ?? '',
    categoryId: row.category_id ?? '',
    remark: row.parsed_remark ?? '',
  }
}

/**
 * Can this draft be finalized at all?
 *
 * ONLY A PENDING ONE, and this is the browser's half of the rule. The other
 * half — the half that actually decides — is finalize_expense_draft(), which
 * takes a row lock and re-reads the status inside the transaction. A second tap,
 * a retried request and two devices at once all reach that lock, and exactly one
 * of them creates an expense; the others are handed the SAME expense id back.
 * Nothing in the browser can make a draft into two expenses, because the browser
 * is not what decides.
 */
export function mayFinalizeDraft(row: { status: string }): boolean {
  return isDraftPending(row)
}

/** Only a pending draft can be discarded, for the same reason and by the same lock. */
export function mayDiscardDraft(row: { status: string }): boolean {
  return isDraftPending(row)
}

/**
 * Only its own author, or a holder of the protected finance.manage, may act on
 * a draft.
 *
 * THE SAME TWO FACTS THE EXPENSE RULES USE, so nobody has to learn a second
 * model, and the same two the RLS policies re-derive in the database.
 */
export function mayActOnDraft(
  row: { created_by: string },
  actor: { userId: string | null; canManageFinance: boolean },
): boolean {
  if (actor.canManageFinance) return true
  return actor.userId !== null && row.created_by === actor.userId
}

// ── Words the screens share ──────────────────────────────────────────────────

export const NEEDS_DETAILS_LABEL = 'Needs Details'
export const NEEDS_DETAILS_BLURB =
  'Captures waiting for the rest of their details. Nothing here counts towards any total until you complete it.'
export const QUICK_CAPTURE_LABEL = 'Quick Capture'
export const QUICK_CAPTURE_SAVE_LABEL = 'Save for later'
export const QUICK_CAPTURE_SAVED_MESSAGE = 'Saved in Needs Details'
export const QUICK_CAPTURE_PLACEHOLDER = 'Paid 1000 rupees to Vikram for machine repair'
export const QUICK_CAPTURE_HINT =
  'One line is enough. Anything missing can be filled in later.'
export const DISCARD_DRAFT_EXPLANATION =
  'This capture will be removed from Needs Details. A record of it is kept with your name and the time.'
