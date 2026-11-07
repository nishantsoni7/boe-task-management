// ── The words the payment popup uses, in one place ───────────────────────────
//
// The Payment Requests popup used to print what a payment is for in three places
// (Payment Against, Order Number, "What this payment is for"). It prints it once
// now, as "Paid for", and these functions are where the wording comes from:
// the kind and the record come from paymentAgainstDisplay (which every list
// already uses), the caption and the tag say what the record is and whether the
// money is attached yet.
//
// PURE. Nothing here reads the database or the screen, so each sentence has a
// test (paymentPopupWords.test.ts) and a screen can never print one that
// contradicts the destination it just read.

import {
  DESTINATION_NOT_VISIBLE,
  destinationReferenceLabel,
  paymentAgainstDisplay,
  type PaymentDestination,
} from './paymentDestination'

export type DecisionKey = 'approve' | 'needs_clarification' | 'reject'

/** Who a sentence is about when the sender's name is not known. */
export const UNKNOWN_SENDER = 'the sender'

/** "Mohit Sharma" → "Mohit". A blank name never reaches a sentence. */
export function firstName(full: string | null | undefined): string {
  const first = (full ?? '').trim().split(/\s+/)[0]
  return first || UNKNOWN_SENDER
}

/**
 * What the destination is, under its name: an old order is not in BOE One, a PI
 * Draft has no Order yet, a split payment is split. Null when the name says it all.
 */
export function destinationCaption(destination: PaymentDestination | null | undefined): string | null {
  if (destination === undefined) return null
  if (destination === null) return 'Nothing was chosen on the request'
  switch (destination.kind) {
    case 'old_order': return 'Not in BOE One'
    case 'pi_draft':  return 'No Order yet'
    case 'mixed':     return 'Split payment'
    case 'suspense':  return 'Nothing was chosen on the request'
    default:          return null
  }
}

export type DestinationTag = { tone: 'intent' | 'allocated'; label: string }

/**
 * A promise or a fact. The pending intent is what the sender chose, attached only
 * when Finance verifies; an allocation is the money already attached. A cancelled
 * link (history of a rejected request) and Suspense carry neither.
 */
export function destinationTag(destination: PaymentDestination | null | undefined): DestinationTag | null {
  if (!destination || destination.cancelled) return null
  if (destination.source === 'intent')     return { tone: 'intent',    label: 'Attaches when verified' }
  if (destination.source === 'allocation') return { tone: 'allocated', label: 'Allocated' }
  return null
}

/** "attached to Old order 478", or why it is attached to nothing. */
export function attachPhrase(destination: PaymentDestination | null | undefined): string {
  if (destination === null || destination?.kind === 'suspense') {
    return 'held unallocated until Finance allocates it'
  }
  if (destination === undefined || destinationReferenceLabel(destination) === DESTINATION_NOT_VISIBLE) {
    return 'attached to the record chosen on the request'
  }
  return `attached to ${paymentAgainstDisplay(destination)}`
}

/** The label above the note box. Required ones say so, in the label itself. */
export function decisionFieldLabel(key: DecisionKey, sender: string): string {
  if (key === 'approve')             return `Note for ${sender} (optional)`
  if (key === 'needs_clarification') return `Your question for ${sender} (required)`
  return 'Why you are rejecting it (required)'
}

/** What pressing the button does, in the button. */
export function decisionButtonLabel(key: DecisionKey, sender: string, busy: boolean): string {
  if (key === 'approve')             return busy ? 'Verifying…' : 'Verify payment'
  if (key === 'needs_clarification') return busy ? 'Saving…' : `Send to ${sender}`
  return busy ? 'Saving…' : 'Reject payment'
}

/** The one-line consequence shown once a decision is chosen. */
export function decisionConsequence(
  key: DecisionKey,
  destination: PaymentDestination | null | undefined,
  sender: string,
): string {
  if (key === 'approve') {
    return `It will be verified as received and ${attachPhrase(destination)}. ${sender} is notified. This can't be undone from this page.`
  }
  if (key === 'needs_clarification') return `${sender} is notified and sees your question.`
  return `${sender} is notified and sees your reason.`
}

/** Said under the note box while a required note is still empty. */
export const DECISION_NOTE_NEEDED = 'Required before you can send.'

/** Said instead of a missing Decision card, to somebody who recorded the payment. */
export const OWN_PAYMENT_NOTE = 'You recorded this payment, so another verifier decides it.'
