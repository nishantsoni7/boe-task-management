// ── The BOE accounts a HISTORICAL payment was recorded against ───────────────
//
// A payment used to name its account as the (payment_mode, received_in) PAIR:
// `cash` alone did not say Paytm, and `other` alone did not say PNB. Since
// 20261014000000 §1 the four accounts ARE the payment modes — hdfc, pnb, paytm,
// canara — so a new payment names one directly and this file has nothing to do
// with it.
//
// WHAT REMAINS IS THE READING HALF, and it is not optional: every row recorded
// before the change still carries a real pair naming a real account, and it is
// still read by the approval RPCs' row snapshots, by the post-approval freeze
// guard and by both Finance surfaces. A screen that could not name those
// accounts would print a blank where a financial fact belongs.
//
// WHAT WENT, AND WHERE IT WENT
// ----------------------------
// The CASH TRAIL half of this module — CollectionState, captureForMode,
// collectionErrorForMode, buildCollectionPayloadForMode, readCollectionState and
// collectionDisplayFor — is gone. It expressed a single collection and a single
// handover in five columns on the payment row, rewritten on every save. That
// shape could not hold a second hand-off, could not say WHEN a collection
// happened, and destroyed itself when a request's mode was corrected.
//
// Its replacement is an append-only event log: finance_payment_custody_events
// (20261014000000 §2) and src/lib/finance/custodyTrail.ts. The five columns are
// FROZEN AS HISTORY — nothing writes them any more, and legacyCustodyEvents
// projects them into the same event shape so one reader shows both.
//
// The names here are BOE_ACCOUNTS / BoeAccount / BoeAccountKey and not
// "PaymentDestination", which since 20261013000000 means one of the three things
// a payment can be FOR — PI Draft, Confirmed Order, Suspense Entry
// (src/lib/finance/paymentEntry.ts). One word, two meanings, is how two screens
// end up disagreeing.
//
// Nothing here touches Supabase, permissions or approval.

import { paymentModeLabel } from '@/lib/finance/paymentEntry'

export type BoeAccountKey = 'hdfc' | 'canara' | 'paytm' | 'pnb'

/** What the cash trail behind this destination needs recording. */
export type CollectionCapture =
  | 'none'        // money landed in an account; nobody carried it
  | 'collection'  // cash collected internally — who collected it
  | 'handover'    // cash collected externally — who collected it, and the handover

export type BoeAccount = {
  key: BoeAccountKey
  /** The account name, as BOE says it out loud. */
  label: string
  /** What that account MEANS operationally. Short, and never colour-coded. */
  helper: string
  capture: CollectionCapture
  /** Resolved to a component by DESTINATION_ICON in components/AccountIcons. */
  iconKey: 'landmark' | 'piggy-bank' | 'hand-coins' | 'users'
  /** The stored pair. Unchanged from what the form has always written. */
  payment_mode: string
  received_in: string
}

export const BOE_ACCOUNTS: readonly BoeAccount[] = [
  {
    key: 'hdfc',
    label: 'HDFC',
    helper: 'Company current account',
    capture: 'none',
    iconKey: 'landmark',
    payment_mode: 'bank_transfer',
    received_in: 'company_account',
  },
  {
    key: 'canara',
    label: 'Canara',
    helper: 'Savings account',
    capture: 'none',
    iconKey: 'piggy-bank',
    payment_mode: 'bank_transfer',
    received_in: 'savings_account',
  },
  {
    key: 'paytm',
    label: 'Paytm',
    helper: 'Cash collected internally',
    capture: 'collection',
    iconKey: 'hand-coins',
    payment_mode: 'cash',
    received_in: 'cash_in_hand',
  },
  {
    key: 'pnb',
    label: 'PNB',
    helper: 'Cash collected through an external source',
    capture: 'handover',
    iconKey: 'users',
    payment_mode: 'other',
    received_in: 'other',
  },
] as const

// ── Reading a stored row back ─────────────────────────────────────────────────
// The pair is only meaningful READ TOGETHER: `cash` alone does not say Paytm,
// and `other` alone does not say PNB. A pair this form cannot produce (a legacy
// row, or one written before the account options existed) resolves to null here
// rather than being forced into an account it was never recorded against.

export function destinationFromDb(payment_mode: string, received_in: string | null): BoeAccount | null {
  return BOE_ACCOUNTS.find(
    d => d.payment_mode === payment_mode && d.received_in === received_in,
  ) ?? null
}

// Naming a legacy row whose pair no account matches. The five labels are the
// shared ones (lib/finance/paymentEntry) rather than a sixth copy of them —
// this file's job is the ACCOUNT vocabulary, not the mode vocabulary.

/**
 * The account name to DISPLAY for a stored row. Falls back to the legacy mode
 * label, and finally to the raw stored value, so an unrecognised row still says
 * something true instead of being mislabelled as an account it never used.
 */
export function paymentDestinationLabel(payment_mode: string, received_in: string | null): string {
  const d = destinationFromDb(payment_mode, received_in)
  if (d) return d.label
  return paymentModeLabel(payment_mode)
}
