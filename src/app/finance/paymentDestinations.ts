// ── The BOE accounts a payment was recorded against, and the cash trail ───────
//
// TWO FACTS, KEPT APART ON PURPOSE:
//
//   1. WHERE THE MONEY WENT — one of four BOE accounts. HDFC, Canara, Paytm,
//      PNB, stored as the (payment_mode, received_in) PAIR that
//      finance_payment_requests has carried since 20260628000200.
//   2. WHO PHYSICALLY HANDLED IT — for cash, who collected it, from whom, and
//      who it was later handed over to. Five nullable columns since 20260716000000.
//
// NO FORM ASKS (1) ANY MORE, AND THIS FILE NO LONGER OFFERS IT. Since
// 20261013000000 both payment-entry forms ask for the canonical five-value
// Payment Mode instead — the account picker answered payment_mode and
// received_in in one click, and its second half is now neither asked for nor
// invented. So the CHOOSING half of this module (the default key, the pair
// builder, the account-keyed capture rule, the edit-form readers and the write
// pair) is deleted rather than left behind for something to call.
//
// WHAT REMAINS IS THE READING HALF, and it is not optional: every row recorded
// before the change still carries a real pair naming a real account, and it is
// still read by the approval RPCs' row snapshots, by the post-approval freeze
// guard, by Received Payments, and by the Orders module's own reader
// (paymentAccountLabel in orders/requests/components/shared.ts, which resolves
// the same four pairs). A screen that could not name those accounts would print
// a blank where a financial fact belongs.
//
// (2) REMAINS A LIVE PROCESS, decided by the payment mode: cash, and only cash.
// See captureForMode below and components/CashTrailFields.tsx.
//
// The names here are BOE_ACCOUNTS / BoeAccount / BoeAccountKey and not
// "PaymentDestination", which since 20261013000000 means one of the three things
// a payment can be FOR — PI Draft, Confirmed Order, Suspense Entry
// (src/lib/finance/paymentEntry.ts). One word, two meanings, is how two screens
// end up disagreeing.
//
// Nothing here touches Supabase, permissions or approval. Every rule it appears
// to enforce is enforced again server-side: the payment-mode domain by the
// table's CHECK, the handover pair by finance_payment_requests_handover_pair
// (20260716 §2), the cash trail by submit_payment_request, and the whole set by
// finance_payment_requests_guard_approved once the payment is approved.

// ── The four accounts ─────────────────────────────────────────────────────────
// Listed as they always were: the two bank accounts first, then the two cash
// routes. `capture` names what operational detail a row recorded against this
// account carries, which is what lets a historical row keep describing itself
// exactly as it always has.

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

// ── The cash trail ────────────────────────────────────────────────────────────
// Form state for the conditional section. Ids are held as strings ('' = not
// chosen) so the state maps straight onto <select> values; buildCollectionPayload
// is the single place they become nulls.

export type CollectionState = {
  /** users.id of the person who physically collected the cash. */
  collectedBy: string
  /** Free text — an outside party has no BOE user record. */
  collectedFrom: string
  /** users.id. Empty until the handover actually happens. */
  handedOverTo: string
  /** yyyy-mm-dd. Empty until the handover actually happens. */
  handoverDate: string
  note: string
}

export const EMPTY_COLLECTION_STATE: CollectionState = {
  collectedBy:   '',
  collectedFrom: '',
  handedOverTo:  '',
  handoverDate:  '',
  note:          '',
}

export type CollectionPayload = {
  collected_by_user_id:     string | null
  collected_from_text:      string | null
  handed_over_to_user_id:   string | null
  handed_over_at:           string | null
  collection_handover_note: string | null
}

const EMPTY_COLLECTION_PAYLOAD: CollectionPayload = {
  collected_by_user_id:     null,
  collected_from_text:      null,
  handed_over_to_user_id:   null,
  handed_over_at:           null,
  collection_handover_note: null,
}

function textOrNull(v: string): string | null {
  const t = v.trim()
  return t === '' ? null : t
}

/** Seeds the form from a stored row. Nulls become '' so inputs stay controlled. */
export function readCollectionState(row: {
  collected_by_user_id:     string | null
  collected_from_text:      string | null
  handed_over_to_user_id:   string | null
  handed_over_at:           string | null
  collection_handover_note: string | null
}): CollectionState {
  return {
    collectedBy:   row.collected_by_user_id     ?? '',
    collectedFrom: row.collected_from_text      ?? '',
    handedOverTo:  row.handed_over_to_user_id   ?? '',
    // A date column arrives as yyyy-mm-dd, which is what <input type="date">
    // wants; a timestamptz would not be, so the column is deliberately a date.
    handoverDate:  row.handed_over_at           ?? '',
    note:          row.collection_handover_note ?? '',
  }
}

// ── Validation ────────────────────────────────────────────────────────────────
// Deliberately short. The handover is the ONE thing this workflow exists to make
// possible later: a salesperson collects cash today because nobody authorised is
// around, submits the request, and hands the money over tomorrow. So neither
// handover field is required to submit — only required to be CONSISTENT with
// each other, because "handed over to Nishant" with no date, or a date with
// nobody named, is a record that cannot be acted on.
//
// Returns null when the section is valid, or ONE sentence naming what is wrong.

/**
 * The rules, asked of a CAPTURE.
 *
 * The four-account picker is gone from both payment-entry forms
 * (20261013000000): what a payment mode captures is now decided by the mode
 * itself, so the rules are reachable without naming an account.
 * collectionErrorForMode below is the one way in.
 */
export function collectionErrorForCapture(
  capture: CollectionCapture,
  state: CollectionState,
  paymentDate: string,
): string | null {
  if (capture === 'none') return null

  if (!state.collectedBy.trim()) {
    return 'Select who collected the cash.'
  }
  if (capture !== 'handover') return null

  const to   = state.handedOverTo.trim()
  const date = state.handoverDate.trim()

  // The pair moves together or not at all — the same rule
  // finance_payment_requests_handover_pair states in the database.
  if (to && !date)  return 'Enter the date the cash was handed over.'
  if (date && !to)  return 'Select who the cash was handed over to.'

  // Cash cannot be handed over before it was collected. Compared as ISO strings,
  // which sort chronologically for yyyy-mm-dd. Skipped when either date is
  // missing rather than guessed.
  if (to && date && paymentDate && date < paymentDate) {
    return 'The handover date cannot be before the payment date.'
  }
  return null
}

// ── The cash trail, decided by the PAYMENT MODE ───────────────────────────────
//
// WHY THIS EXISTS. The four accounts (HDFC, Canara, Paytm, PNB) each declared
// what cash trail they needed. Both payment-entry forms now ask for a canonical
// PAYMENT MODE instead — five values, no account — so the question "does this
// payment need a collection record" has to be answerable from the mode alone.
//
// CASH, AND ONLY CASH. Somebody physically carried it, so who collected it,
// from whom, and who it was handed to are real facts with real columns
// (20260716000000). A bank transfer, a UPI payment, a cheque and 'other' carried
// no cash and record none — and submit_payment_request decides the same thing
// again server-side, so a stale form field cannot smuggle one in.
//
// The full HANDOVER shape, not the shorter collection one: without an account to
// distinguish internally-collected cash from externally-collected cash, the
// honest default is to OFFER the handover fields and leave them blank, rather
// than to decide on the person's behalf that no handover can have happened.

export function captureForMode(payment_mode: string): CollectionCapture {
  return payment_mode === 'cash' ? 'handover' : 'none'
}

/** Does this payment mode ask for a cash trail at all? */
export function modeCapturesCash(payment_mode: string): boolean {
  return captureForMode(payment_mode) !== 'none'
}

export function collectionErrorForMode(
  payment_mode: string,
  state: CollectionState,
  paymentDate: string,
): string | null {
  return collectionErrorForCapture(captureForMode(payment_mode), state, paymentDate)
}

/**
 * The cash-trail half of an insert/update payload, chosen by MODE.
 *
 * Every key is always present, for the same reason buildCollectionPayload's are:
 * switching a payment off Cash has to CLEAR the trail it recorded, and an
 * omitted key would leave a handover attached to a bank transfer.
 */
export function buildCollectionPayloadForMode(
  payment_mode: string,
  state: CollectionState,
): CollectionPayload {
  const capture = captureForMode(payment_mode)
  if (capture === 'none') return { ...EMPTY_COLLECTION_PAYLOAD }
  return {
    ...EMPTY_COLLECTION_PAYLOAD,
    collected_by_user_id:     textOrNull(state.collectedBy),
    collected_from_text:      textOrNull(state.collectedFrom),
    handed_over_to_user_id:   textOrNull(state.handedOverTo),
    handed_over_at:           textOrNull(state.handoverDate),
    collection_handover_note: textOrNull(state.note),
  }
}

// ── Reading the cash trail back OUT, for display ──────────────────────────────
// One helper, so every read-only surface — the requester's details popup, and
// the admin review popup after it — describes a collection the same way. The
// alternative is each modal deciding independently what "not handed over yet"
// looks like, which is exactly how two screens end up disagreeing about whether
// money has moved.
//
// It returns ROWS rather than JSX so it stays pure and testable; the host
// decides the chrome. Date formatting is injected for the same reason.

export type StoredCollection = {
  payment_mode: string
  /**
   * NULL since 20260919000000 for a payment recorded against a PI, and null for
   * EVERY payment written through the two redesigned entry forms
   * (20261013000000): the account picker is gone and nothing is invented in its
   * place. A null pair falls through to the mode below.
   */
  received_in: string | null
  collected_by_user_id:     string | null
  collected_from_text:      string | null
  handed_over_to_user_id:   string | null
  handed_over_at:           string | null
  collection_handover_note: string | null
}

export type CollectionDisplayRow = { label: string; value: string; muted?: boolean }

export type CollectionDisplay = {
  title: string
  rows: CollectionDisplayRow[]
  /** True when this is a handover destination whose handover has not happened. */
  handoverPending: boolean
}

/** A handover is recorded only when BOTH halves are — the DB constraint's rule. */
function isHandoverRecorded(row: Pick<StoredCollection, 'handed_over_to_user_id' | 'handed_over_at'>): boolean {
  return !!(row.handed_over_to_user_id && row.handed_over_at)
}

function hasAnyCollectionData(row: StoredCollection): boolean {
  return !!(
    row.collected_by_user_id ||
    row.collected_from_text ||
    row.handed_over_to_user_id ||
    row.handed_over_at ||
    row.collection_handover_note
  )
}

/**
 * The cash-collection section for a stored payment, or null when there is
 * nothing to show.
 *
 * Null for HDFC and Canara — money that arrived in an account was not carried by
 * anyone, so an empty "collection" panel would be noise. The ONE exception is a
 * bank row that nonetheless carries stored data (a destination corrected after
 * the fact, or a legacy pair): real recorded data is never hidden just because
 * the current destination does not ask for it.
 *
 * `names` supplies the display names for the two user columns, resolved by the
 * caller's existing query. A raw uuid is never rendered.
 */
export function collectionDisplayFor(
  row: StoredCollection,
  names: { collectedBy?: string | null; handedOverTo?: string | null },
  formatDate: (iso: string) => string,
): CollectionDisplay | null {
  // THE STORED PAIR FIRST, THE MODE SECOND. A historical row whose pair names a
  // real account keeps describing itself exactly as it always has — the account
  // knew whether cash was collected internally or handed over, and that
  // distinction is not re-decided years later. A row with no account (every new
  // one) is described by its mode instead.
  const capture = row.received_in === null
    ? captureForMode(row.payment_mode)
    : destinationFromDb(row.payment_mode, row.received_in)?.capture ?? 'none'
  const hasData = hasAnyCollectionData(row)
  if (capture === 'none' && !hasData) return null

  // A bank destination carrying leftover data is titled by what it actually
  // holds, not by what its destination would have asked for.
  const showsHandover = capture === 'handover'
    || (capture === 'none' && !!(row.handed_over_to_user_id || row.handed_over_at))

  const rows: CollectionDisplayRow[] = [
    row.collected_by_user_id
      ? { label: 'Collected by', value: names.collectedBy || 'Unknown user' }
      : { label: 'Collected by', value: 'Not recorded', muted: true },
  ]

  if (showsHandover) {
    if (row.collected_from_text) {
      rows.push({ label: 'Collected from', value: row.collected_from_text })
    }
    // ONE pending state, not two "Not provided" rows for a recipient and a date
    // that are both absent for the same single reason.
    if (isHandoverRecorded(row)) {
      rows.push({ label: 'Handover status', value: 'Handed over' })
      rows.push({ label: 'Handed over to',  value: names.handedOverTo || 'Unknown user' })
      rows.push({ label: 'Handover date',   value: formatDate(row.handed_over_at as string) })
    } else {
      rows.push({ label: 'Handover status', value: 'Pending handover', muted: true })
    }
  }

  if (row.collection_handover_note) {
    rows.push({
      label: showsHandover ? 'Collection / handover note' : 'Collection details',
      value: row.collection_handover_note,
    })
  }

  return {
    title: showsHandover ? 'Cash collection and handover' : 'Cash collection',
    rows,
    handoverPending: showsHandover && !isHandoverRecorded(row),
  }
}
