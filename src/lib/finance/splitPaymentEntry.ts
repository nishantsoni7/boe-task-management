// ── Dividing one payment as it is recorded ────────────────────────────────────
//
// A real payment arrives once and pays for several things. The allocation model
// has expressed that since 20260918000000 — many allocations, one payment, each
// naming a PI Draft or a Confirmed Order — but until 20261009000000 nothing
// could CREATE such a payment in one act: the money went in attached to one
// destination (or none), and the rest was allocated afterwards, through a
// control the person entering it may not even hold.
//
// This file is the arithmetic and the refusals of the form that does it in one
// go. It holds no React and reaches no network, so every rule below is a
// function somebody can read and a test can pin.
//
// TWO RULES THIS FILE HOLDS ITSELF TO
// -----------------------------------
//
// 1. THE MONEY IS COUNTED IN EXACT DECIMAL, NEVER IN FLOAT. `0.1 + 0.2` is the
//    reason: a form that adds allocations in JS numbers can show a remainder of
//    -0.00000000004 on a payment that is exactly spent, and refuse to save it.
//    Every total here goes through exactMoney, which is the same arithmetic the
//    Order and Finance totals already use.
//
// 2. NOTHING HERE AUTHORIZES ANYTHING. record_payment_with_allocations()
//    re-derives the actor, requires Finance module entry AND finance.allocate,
//    locks the payment, re-checks capacity under that lock, and re-validates
//    every target's existence, eligibility and visibility. The refusals below
//    exist so the person is told BEFORE a round trip — never so the server can
//    trust the browser.

import {
  ZERO,
  addExact,
  exactToString,
  isNegative,
  isZero,
  parseExact,
  subtractExact,
  type ExactDecimal,
} from './exactMoney'
import { amountInputProblem, isValidAmount } from '@/lib/currency'
import { SUBMISSION_KEY_REUSED_MESSAGE } from './submissionAttempt'
import { destinationTargetKind, type PaymentDestination } from './paymentEntry'

/** The two kinds of destination the business has. There is no third. */
export type SplitTargetKind = 'order' | 'submission'

/**
 * destinationTargetKind READ THE OTHER WAY, for a caller that starts from a
 * target it already holds rather than from a destination somebody picked — the
 * Confirmed Order screen, opening this form over the Order it is showing.
 *
 * It lives here, beside the import of its counterpart, because paymentEntry.ts
 * is a module this area holds still; the two mappings are still read together
 * and a change to either is visible from this line.
 *
 * TOTAL, and there is no destination for "both kinds": a payment covering a PI
 * Draft and an Order is a Suspense Entry, divided afterwards through Allocate
 * Funds.
 */
export function targetKindDestination(kind: SplitTargetKind): PaymentDestination {
  return kind === 'order' ? 'confirmed_order' : 'pi_draft'
}

/**
 * One row of the allocation list, as the form holds it.
 *
 * `amount` is the RAW STRING the person typed. Keeping it as typed is what lets
 * the form distinguish "not filled in yet" from "zero", and it is what stops a
 * half-typed "12." from being read as 12 and then silently re-rendered.
 */
export type SplitAllocationRow = {
  /** Stable across re-orders and removals, so React keys never collide. */
  key: string
  kind: SplitTargetKind | null
  targetId: string | null
  /** What the picker showed: an Order number, a PI reference, a client name. */
  targetLabel: string | null
  /**
   * The chosen record's customer, as the picker read it. Display only — it
   * feeds the mixed-customer warning and is never sent to the server, which
   * derives the payment's customer for itself.
   */
  clientName?: string | null
  /** The chosen record's own number or PI reference, for the same warning. */
  reference?: string | null
  amount: string
}

export const EMPTY_ALLOCATION_ROW = (key: string): SplitAllocationRow => ({
  key, kind: null, targetId: null, targetLabel: null, amount: '',
})

/**
 * Where a row points, as one comparable value.
 *
 * A payment may hold at most ONE ACTIVE ALLOCATION PER TARGET — the model's
 * rule, guaranteed by its partial unique indexes and refused by name
 * (ALLOCATION_DUPLICATE) in the RPC. So the same Order twice in one entry is a
 * duplicate even though the two rows are different rows, and the kind is part
 * of the key because an Order and a PI Draft can never share an id but the
 * comparison should not depend on that.
 */
export function targetKey(row: SplitAllocationRow): string | null {
  return row.kind && row.targetId ? `${row.kind}:${row.targetId}` : null
}

/** Every target named more than once in the list. Empty for the ordinary case. */
export function duplicateTargetKeys(rows: readonly SplitAllocationRow[]): Set<string> {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const row of rows) {
    const key = targetKey(row)
    if (!key) continue
    if (seen.has(key)) twice.add(key)
    seen.add(key)
  }
  return twice
}

// ── Is there anything here worth a question? ─────────────────────────────────
//
// WHAT "DIRTY" HAS TO MEAN. The discard guard exists so nobody loses a payment
// they typed. It must therefore fire on anything a person ENTERED — and it must
// NOT fire on the state the form was handed to them in, because a modal that
// argues about being closed the instant it opens teaches people to dismiss the
// warning without reading it, which is exactly when it stops protecting them.
//
// THE BASELINE IS NOT ALWAYS EMPTY. A form opened from a Confirmed Order starts
// with that Order already in row one and its destination already chosen. Both
// were the caller's doing, not the reader's. Comparing against the EMPTY form
// counted them as edits, so Add payment → Cancel asked a question about work
// nobody had done. The comparison is against the form AS IT OPENED.
//
// IT DECIDES NOTHING ELSE. Not whether the entry may be submitted (that is
// splitPaymentBlockedReason), not what is sent (toRpcAllocations), not who may
// record it (the RPC). Only whether closing should ask first.

/** What the form was handed, before anybody touched it. */
export type SplitPaymentBaseline = {
  /**
   * The row-one target the form opened with, or null for the ordinary empty
   * form the Finance page opens.
   */
  initialTarget: { kind: SplitTargetKind; id: string } | null
}

/**
 * The destination the form OPENS on: the seeded target's own, or the empty
 * form's. A person who never touched the destination card has not edited it,
 * whichever of the two it started as.
 */
export function splitPaymentPristineDestination(
  baseline: SplitPaymentBaseline,
  emptyDestination: PaymentDestination,
): PaymentDestination {
  return baseline.initialTarget
    ? targetKindDestination(baseline.initialTarget.kind)
    : emptyDestination
}

/**
 * Whether the ALLOCATION LIST has moved off its baseline.
 *
 * Unseeded: any row that names a target or carries an amount is an edit — the
 * empty form opens with one blank row and nothing else.
 *
 * Seeded: the baseline is exactly ONE row, naming the seeded target, with no
 * amount. So adding a row, removing the seeded one (which leaves a blank row
 * behind), pointing it somewhere else, or typing an amount into it are each an
 * edit; and re-picking the same target returns the form to pristine, which is
 * correct — nothing has been lost at that point.
 */
export function splitPaymentRowsChanged(
  rows: readonly SplitAllocationRow[],
  baseline: SplitPaymentBaseline,
): boolean {
  const seed = baseline.initialTarget
  if (!seed) return rows.some(r => Boolean(r.kind) || Boolean(r.targetId) || r.amount.trim() !== '')
  if (rows.length !== 1) return true
  const row = rows[0]
  return row.kind !== seed.kind
    || row.targetId !== seed.id
    || row.amount.trim() !== ''
}

/**
 * Everything a person can enter, against the form as it opened.
 *
 * The payment mode starts at a value nobody chose, so it counts only once it
 * has been changed — the rule this form already had, unchanged.
 */
export function splitPaymentIsDirty(input: {
  destination: PaymentDestination
  /** The destination an UNSEEDED form opens on — EMPTY_PAYMENT_ENTRY's. */
  emptyDestination: PaymentDestination
  amount: string
  paymentDate: string
  paymentMode: string
  /** The mode the form opens on, which nobody chose. */
  defaultPaymentMode: string
  reference: string
  remarks: string
  /** How many custody events have been added. */
  custodyCount: number
  hasAttachment: boolean
  rows: readonly SplitAllocationRow[]
  baseline: SplitPaymentBaseline
}): boolean {
  return input.amount.trim() !== ''
    || input.paymentDate !== ''
    || input.paymentMode !== input.defaultPaymentMode
    || input.reference.trim() !== ''
    || input.remarks.trim() !== ''
    || input.destination !== splitPaymentPristineDestination(input.baseline, input.emptyDestination)
    || input.custodyCount > 0
    || input.hasAttachment
    || splitPaymentRowsChanged(input.rows, input.baseline)
}

/** The three figures the form shows continuously, all exact. */
export type SplitPaymentTotals = {
  /** The payment itself, as typed. Null when it is not yet a valid figure. */
  payment: string | null
  /** The sum of every row that carries a valid amount. */
  allocated: string
  /**
   * payment - allocated. NEGATIVE when the rows total more than the payment,
   * and deliberately not floored: a form that clamped this at zero would hide
   * the one condition the person needs to see.
   */
  remaining: string | null
  overAllocated: boolean
  /** True when the rows spend the payment exactly. */
  fullyAllocated: boolean
}

export function splitPaymentTotals(input: {
  amount: string
  rows: readonly SplitAllocationRow[]
}): SplitPaymentTotals {
  const payment = isValidAmount(input.amount) ? parseExact(input.amount) : null

  let allocated: ExactDecimal = ZERO
  for (const row of input.rows) {
    if (!isValidAmount(row.amount)) continue
    const parsed = parseExact(row.amount)
    if (parsed) allocated = addExact(allocated, parsed)
  }

  const remaining = payment ? subtractExact(payment, allocated) : null

  return {
    payment: payment ? exactToString(payment) : null,
    allocated: exactToString(allocated),
    remaining: remaining ? exactToString(remaining) : null,
    overAllocated: remaining ? isNegative(remaining) : false,
    fullyAllocated: Boolean(payment && remaining && isZero(remaining) && !isZero(allocated)),
  }
}

/**
 * Why the form cannot be saved, in one sentence, or null when it can.
 *
 * ORDERED THE WAY A PERSON FILLS THE FORM IN — payment-level facts first, then
 * the rows — so somebody who has typed nothing is told to enter an amount
 * rather than to fix row 3. Stated as a function so the reason is testable and
 * so the button is never disabled with no explanation beside it, which is the
 * failure mode that has people clicking repeatedly.
 *
 * A POSITIVE REMAINDER IS NOT A REASON. Recording ₹5,00,000 and allocating
 * ₹2,00,000 of it is an ordinary, correct entry: the rest is an unallocated
 * balance Finance's own Allocate control spends later.
 *
 * AN EMPTY LIST IS A DESTINATION, NOT AN OVERSIGHT. It is exactly what Suspense
 * Entry means, and it is refused under the other two: somebody who chose
 * "Confirmed Order" and named none has not finished, and the server would
 * refuse the same entry by name.
 */
export function splitPaymentBlockedReason(input: {
  /** Which of the three the person chose. Decides whether rows are required. */
  destination: PaymentDestination
  amount: string
  paymentDate: string
  paymentMode: string
  rows: readonly SplitAllocationRow[]
}): string | null {
  // NO CUSTOMER CHECK. The customer is not typed any more: the server derives it
  // from the targets, or the payment has none because it has no targets
  // (20261013000000). A form that refused to submit without one would be
  // demanding something it can no longer ask for.
  if (!isValidAmount(input.amount)) {
    return amountInputProblem(input.amount) ?? 'Enter the amount received, in rupees and paise.'
  }
  if (!input.paymentDate) return 'Choose the date the payment was received.'
  if (!input.paymentMode) return 'Choose how the payment was made.'

  const rows = input.rows
  const filled = rows.filter(r => r.kind || r.targetId || r.amount.trim())

  const wantedKind = destinationTargetKind(input.destination)

  // SUSPENSE CARRIES NO TARGET. Not "may carry none" — carries none. If a row
  // survived a destination change it would allocate money the person told the
  // form not to allocate, so this is a refusal and not a quiet trim.
  if (!wantedKind) {
    if (filled.length > 0) {
      return 'A Suspense Entry holds no allocations. Choose PI Draft or Confirmed Order, or remove the rows.'
    }
    return null
  }

  if (filled.length === 0) {
    return input.destination === 'pi_draft'
      ? 'Choose the PI Draft this payment is for.'
      : 'Choose the Order this payment is for.'
  }

  // AND A TARGET OF THE WRONG KIND IS NOT A TARGET. The picker only offers one
  // kind, so this can only be reached by a row left behind — which is the case
  // worth refusing rather than sending.
  for (const row of filled) {
    if (row.kind && row.kind !== wantedKind) {
      return input.destination === 'pi_draft'
        ? 'One row names an Order. A PI Draft entry allocates to PI Drafts only.'
        : 'One row names a PI Draft. A Confirmed Order entry allocates to Orders only.'
    }
  }

  for (let i = 0; i < filled.length; i++) {
    const row = filled[i]
    if (!row.kind || !row.targetId) {
      const noun = input.destination === 'pi_draft' ? 'PI Draft' : 'Order'
      return `Choose ${noun === 'Order' ? 'an' : 'a'} ${noun} for allocation ${i + 1}, or remove it.`
    }
    if (!isValidAmount(row.amount)) {
      const problem = amountInputProblem(row.amount)
      return problem ? `Allocation ${i + 1}: ${problem}` : `Enter an amount for allocation ${i + 1}, in rupees and paise.`
    }
    const parsed = parseExact(row.amount)
    if (!parsed || isZero(parsed) || isNegative(parsed)) {
      return `Allocation ${i + 1} must be a positive amount.`
    }
  }

  const duplicates = duplicateTargetKeys(filled)
  if (duplicates.size > 0) {
    return 'The same Order or PI Draft is listed twice. One payment can hold only one allocation per record — combine the two rows.'
  }

  const totals = splitPaymentTotals({ amount: input.amount, rows: filled })
  if (totals.overAllocated && totals.payment) {
    return `The allocations total more than the ${totals.payment} received. Reduce a row, or raise the amount received.`
  }

  return null
}

/** The rows the RPC is given: complete ones only, in the order they were added. */
export function toRpcAllocations(rows: readonly SplitAllocationRow[]): {
  kind: SplitTargetKind
  id: string
  amount: number
}[] {
  return rows
    .filter(r => r.kind && r.targetId && isValidAmount(r.amount))
    .map(r => ({ kind: r.kind as SplitTargetKind, id: r.targetId as string, amount: Number(r.amount) }))
}

/**
 * Server refusals, mapped to a sentence naming the rule that refused.
 *
 * Every one of these is a message the RPC raises by name. A refusal the form has
 * no sentence for falls through to the generic line rather than to the raw
 * database text, which names columns nobody reading a payment form should see.
 */
export function splitPaymentErrorMessage(raw: string | null | undefined): string {
  const m = raw ?? ''

  if (m.includes('PAYMENT_ENTRY_NOT_PERMITTED')) {
    return 'You do not have access to Finance, so a payment cannot be recorded here.'
  }
  if (m.includes('PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED')) {
    return 'You do not have permission to allocate payments. Somebody in Finance can record this and divide it.'
  }
  if (m.includes('PAYMENT_ALLOCATIONS_EXCEED_AMOUNT')) {
    return 'The allocations total more than the amount received. Refresh and check the figures.'
  }
  if (m.includes('PAYMENT_ALLOCATIONS_TOO_MANY')) {
    return 'A payment can be divided at most 20 ways in one entry. Record the rest separately.'
  }
  if (m.includes('PAYMENT_ALLOCATION_KIND_INVALID')) {
    return 'One row does not name a Confirmed Order or a PI Draft.'
  }
  if (m.includes('PAYMENT_ALLOCATION_AMOUNT_INVALID')) {
    return 'Every allocation must be a positive amount in rupees and paise.'
  }
  if (m.includes('PAYMENT_ALLOCATION_TARGET_INVALID') || m.includes('PAYMENT_ALLOCATION_ROW_INVALID')) {
    return 'One allocation row is incomplete. Remove it and add it again.'
  }
  if (m.includes('PAYMENT_ALLOCATIONS_INVALID')) {
    return 'The allocation list could not be read. Refresh and try again.'
  }
  // The form no longer has a customer field to send, so this refusal can only
  // mean the page is older than the database it is talking to (or newer than
  // it: 20261013000000 not applied). Telling somebody to name a client they
  // cannot see would be worse than useless.
  if (m.includes('PAYMENT_CLIENT_REQUIRED')) {
    return 'This page is out of step with the server. Reload it and try again. Nothing was saved.'
  }
  if (m.includes('PAYMENT_AMOUNT_INVALID'))  return 'Enter a positive amount in rupees and paise.'
  if (m.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED')) return SUBMISSION_KEY_REUSED_MESSAGE
  if (m.includes('PAYMENT_DATE_FUTURE'))     return 'A payment date cannot be in the future.'
  if (m.includes('PAYMENT_DATE_REQUIRED'))   return 'A payment date is required.'
  if (m.includes('PAYMENT_MODE_INVALID') || m.includes('PAYMENT_MODE_RETIRED')) {
    return 'Choose HDFC, PNB, Paytm or Canara.'
  }

  // ── The custody trail's own refusals ──
  // Each names the rule that refused, so somebody knows whether to fix an
  // activity, change the mode, or ask for access — never a single "try again"
  // that hides which of them it was.
  if (m.includes('CUSTODY_MODE_NOT_APPLICABLE')) {
    return 'A collection and handover trail is recorded only for PNB and Paytm payments. Change the mode, or remove the activities.'
  }
  if (m.includes('CUSTODY_EVENT_HANDOVER_INCOMPLETE')) {
    return 'A handover needs both the person who handed the money over and the person who received it.'
  }
  if (m.includes('CUSTODY_EVENT_COLLECTOR_REQUIRED')) {
    return 'Say who collected the money.'
  }
  if (m.includes('CUSTODY_EVENT_TIME_FUTURE')) {
    return 'A collection or handover cannot have happened in the future.'
  }
  if (m.includes('CUSTODY_EVENT_TIME_REQUIRED')) {
    return 'Enter the date and time each collection or handover happened.'
  }
  if (m.includes('CUSTODY_EVENT_PERSON_UNKNOWN') || m.includes('CUSTODY_EVENT_PERSON_INVALID')) {
    return 'One of the people named on the custody trail is not a BOE user. Choose again.'
  }
  if (m.includes('CUSTODY_APPEND_NOT_PERMITTED')) {
    return 'You do not have permission to add a collection or handover to this payment.'
  }
  if (m.includes('PAYMENT_DESTINATION_INVALID')) return 'Choose which account the money landed in, or leave it unstated.'

  // The allocator's own refusals, reached through this door. Worded for somebody
  // looking at a list of rows rather than at one allocation.
  if (m.includes('ALLOCATION_DUPLICATE')) {
    return 'The same record is listed twice. One payment can hold only one allocation per record — combine the two rows.'
  }
  if (m.includes('ALLOCATION_TARGET_CONVERTED')) {
    return 'One of the PI Drafts has been approved and is now an Order. Choose the Order instead.'
  }
  if (m.includes('ALLOCATION_TARGET_CLAIMED')) {
    return 'One of the PI Drafts is reserved for deletion and cannot receive money.'
  }
  if (m.includes('ALLOCATION_TARGET_NOT_ACTIVE')) {
    return 'One of the records can no longer receive money. Refresh and choose another.'
  }
  if (m.includes('ALLOCATION_TARGET_NOT_AVAILABLE')) {
    return 'One of the records is not available to you. Refresh and choose another.'
  }
  if (m.includes('ALLOCATION_EXCEEDS_PAYMENT')) {
    return 'The allocations do not fit within the amount received. Refresh and check the figures.'
  }

  return 'The payment could not be recorded. Nothing was saved — check the figures and try again.'
}
