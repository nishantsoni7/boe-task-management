// ── Payment DESTINATION, and the cash trail behind it ─────────────────────────
// Two facts that were previously tangled into one pair of columns, and are kept
// apart here on purpose:
//
//   1. WHERE THE MONEY WENT — one of four BOE accounts. HDFC, Canara, Paytm,
//      PNB. This is a single choice, and the form asks it once.
//   2. WHO PHYSICALLY HANDLED IT — for the two cash destinations, who collected
//      the cash, from whom, and who it was later handed over to.
//
// (1) is stored the way it always has been: as the (payment_mode, received_in)
// PAIR that finance_payment_requests has carried since 20260628000200. Neither
// column is renamed, re-valued or dropped, because both are read by the approval
// RPCs' row snapshots, by the post-approval freeze guard, by Received Payments,
// and by the Orders module's own reader (paymentAccountLabel in
// orders/requests/components/shared.ts, which resolves the same four pairs).
// What changes is that the USER now picks one destination instead of picking a
// "mode" and a "received in" that mostly repeated each other — the pair is
// derived from that single choice, exactly as payment_against is derived from
// the target in paymentTargets.ts.
//
// (2) has no home in the existing schema at all. It was being written into
// sales_note as free prose ("Payment mode: PNB", "who collected cash or handover
// detail"), which cannot be queried, cannot be corrected without rewriting a
// sentence, and loses the handover the moment someone edits the note. 20260716
// adds five nullable columns for it; this module maps the form state onto them.
//
// Nothing here touches Supabase, permissions or approval. Every rule it appears
// to enforce is enforced again server-side: the destination pair by the table's
// two CHECK constraints, the handover pair by
// finance_payment_requests_handover_pair (20260716 §2), and the whole set by
// finance_payment_requests_guard_approved once the payment is approved.

// ── The four destinations ─────────────────────────────────────────────────────
// Order is the order they are offered in: the two bank accounts first, then the
// two cash routes, so the list reads as "money that arrived in an account" then
// "money someone carried". `capture` is what makes the form conditional — it
// names what operational detail this destination needs, not which fields to
// draw, so a fifth destination added later declares its own requirement rather
// than being pattern-matched by name at three call sites.

export type PaymentDestinationKey = 'hdfc' | 'canara' | 'paytm' | 'pnb'

/** What the cash trail behind this destination needs recording. */
export type CollectionCapture =
  | 'none'        // money landed in an account; nobody carried it
  | 'collection'  // cash collected internally — who collected it
  | 'handover'    // cash collected externally — who collected it, and the handover

export type PaymentDestination = {
  key: PaymentDestinationKey
  /** The account name, as BOE says it out loud. */
  label: string
  /** What that account MEANS operationally. Short, and never colour-coded. */
  helper: string
  capture: CollectionCapture
  /** Resolved to a component by DESTINATION_ICON in PaymentDestinationFields. */
  iconKey: 'landmark' | 'piggy-bank' | 'hand-coins' | 'users'
  /** The stored pair. Unchanged from what the form has always written. */
  payment_mode: string
  received_in: string
}

export const PAYMENT_DESTINATIONS: readonly PaymentDestination[] = [
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

/** The destination a fresh form starts on. HDFC, exactly as before. */
export const DEFAULT_DESTINATION_KEY: PaymentDestinationKey = PAYMENT_DESTINATIONS[0].key

export function isPaymentDestinationKey(value: string): value is PaymentDestinationKey {
  return PAYMENT_DESTINATIONS.some(d => d.key === value)
}

function byKey(key: string): PaymentDestination | null {
  return PAYMENT_DESTINATIONS.find(d => d.key === key) ?? null
}

/** The stored pair for a chosen destination. Both keys always present. */
export function destinationDbPair(key: PaymentDestinationKey): { payment_mode: string; received_in: string } {
  const d = byKey(key) ?? PAYMENT_DESTINATIONS[0]
  return { payment_mode: d.payment_mode, received_in: d.received_in }
}

/**
 * `key` accepts null — an unstated destination — and resolves to 'none', which
 * is correct: there is no account for a cash trail to belong to.
 */
export function captureFor(key: string | null): CollectionCapture {
  return key === null ? 'none' : (byKey(key)?.capture ?? 'none')
}

// ── Reading a stored row back ─────────────────────────────────────────────────
// The pair is only meaningful READ TOGETHER: `cash` alone does not say Paytm,
// and `other` alone does not say PNB. A pair this form cannot produce (a legacy
// row, or one written before the account options existed) resolves to null here
// rather than being forced into an account it was never recorded against.

export function destinationFromDb(payment_mode: string, received_in: string): PaymentDestination | null {
  return PAYMENT_DESTINATIONS.find(
    d => d.payment_mode === payment_mode && d.received_in === received_in,
  ) ?? null
}

// The pre-destination payment_mode vocabulary, kept for exactly one purpose:
// naming a legacy row whose pair no account matches. Never offered as a choice.
const LEGACY_PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
}

/**
 * The account name to DISPLAY for a stored row. Falls back to the legacy mode
 * label, and finally to the raw stored value, so an unrecognised row still says
 * something true instead of being mislabelled as an account it never used.
 */
export function paymentDestinationLabel(payment_mode: string, received_in: string): string {
  const d = destinationFromDb(payment_mode, received_in)
  if (d) return d.label
  return LEGACY_PAYMENT_MODE_LABEL[payment_mode] ?? payment_mode
}

/**
 * The destination a stored row should open the EDIT form on. Unlike the display
 * helper this must return a real, selectable choice — a legacy row has to land
 * on something the user can see and correct — so it falls back to the default.
 */
export function readDestinationKey(row: { payment_mode: string; received_in: string }): PaymentDestinationKey {
  return destinationFromDb(row.payment_mode, row.received_in)?.key ?? DEFAULT_DESTINATION_KEY
}

/**
 * The same read, but HONEST ABOUT NOT KNOWING: null when the stored pair matches
 * no account.
 *
 * WHY BOTH EXIST. readDestinationKey falls back to the default so a legacy row
 * lands on something a user can see and correct. That was safe while every row
 * carried a received_in; since 20260919000000 a payment recorded against a PI
 * carries NONE — the account was genuinely not stated — and defaulting it would
 * make an edit form display an account the money never went to, and write it
 * back on save along with a payment_mode the customer never used.
 *
 * An edit form must therefore use THIS one and leave the pair alone until
 * somebody chooses a real destination.
 */
export function readDestinationKeyOrNull(
  row: { payment_mode: string; received_in: string | null },
): PaymentDestinationKey | null {
  if (row.received_in === null) return null
  return destinationFromDb(row.payment_mode, row.received_in)?.key ?? null
}

/**
 * The (payment_mode, received_in) pair to WRITE for a chosen destination, or
 * null when there is no chosen destination.
 *
 * Null means "do not touch either column" — spread as `...(pair ?? {})` — so a
 * correction to some other field cannot silently restate where the money went.
 */
export function destinationWritePair(
  key: PaymentDestinationKey | null,
): { payment_mode: string; received_in: string } | null {
  return key === null ? null : destinationDbPair(key)
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

/**
 * The cash-trail half of an insert/update payload. EVERY key is always present,
 * which is what makes this safe to spread over an UPDATE: switching from PNB to
 * HDFC has to clear the columns PNB used, and an omitted key would leave a
 * handover recorded against a bank transfer.
 *
 * Fields the chosen destination does not capture are nulled rather than carried:
 * a Paytm payment records who collected the cash internally and nothing about a
 * handover, because internally-collected cash has not been handed anywhere.
 */
export function buildCollectionPayload(key: string, state: CollectionState): CollectionPayload {
  const capture = captureFor(key)
  if (capture === 'none') return { ...EMPTY_COLLECTION_PAYLOAD }

  const base: CollectionPayload = {
    ...EMPTY_COLLECTION_PAYLOAD,
    collected_by_user_id:     textOrNull(state.collectedBy),
    collection_handover_note: textOrNull(state.note),
  }
  if (capture === 'collection') return base

  return {
    ...base,
    collected_from_text:    textOrNull(state.collectedFrom),
    handed_over_to_user_id: textOrNull(state.handedOverTo),
    handed_over_at:         textOrNull(state.handoverDate),
  }
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

export function collectionErrorFor(
  key: string | null,
  state: CollectionState,
  paymentDate: string,
): string | null {
  const capture = captureFor(key)
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
  received_in: string
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
  const capture = destinationFromDb(row.payment_mode, row.received_in)?.capture ?? 'none'
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
