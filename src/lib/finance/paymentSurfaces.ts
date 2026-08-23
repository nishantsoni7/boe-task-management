// WHICH PAGE A PAYMENT BELONGS ON, and the one status list that decides it.
//
// THE CANONICAL DEFINITION IS THE DATABASE'S, NOT THIS FILE'S.
// public.finance_payment_status_is_verified(text) — 20260918000000 §5 — says a
// payment is confirmed when its status is `approved_unlinked` or
// `approved_linked`, "and nothing else", and calls itself "the single
// definition of verified". CONFIRMED_PAYMENT_STATUSES below is that function's
// list, restated for the client with a test that reads the migration and fails
// if the two ever disagree. Nothing here invents a rule.
//
// THE FULL ENUM, from the CHECK on finance_payment_requests.status
// (20260628000200):
//
//   pending_approval      submitted, nobody has verified it yet
//   needs_clarification   a verifier asked the submitter something
//   rejected              a verifier refused it
//   approved_unlinked     CONFIRMED. Money received, no direct Order linkage
//   approved_linked       CONFIRMED. Money received, linked to an Order
//
// WHY TWO PAGES AND NOT ONE LIST WITH A FILTER
// --------------------------------------------
// The two halves are different work for different people. A verifier opens
// Payments to Verify to decide something; everybody else opens Confirmed
// Payments to read money that has actually arrived. Merging them meant the
// second audience scanned past rows that were not money yet, and every count,
// every search and every page number was computed over a set that mixed the
// two — so "142 payments" answered neither question.
//
// THE SPLIT IS EXHAUSTIVE AND DISJOINT, asserted in the tests: every status in
// the enum is on exactly one page. A status invented by a later phase belongs
// to neither until somebody decides, which is a visible failure rather than a
// row that quietly stops appearing anywhere.

/** Money that has arrived. The database's own definition, restated. */
export const CONFIRMED_PAYMENT_STATUSES = [
  'approved_unlinked',
  'approved_linked',
] as const

/** Everything that is not money yet, or is not money at all. */
export const TO_VERIFY_PAYMENT_STATUSES = [
  'pending_approval',
  'needs_clarification',
  'rejected',
] as const

/** Every status the CHECK constraint admits. Used to prove the split is total. */
export const ALL_PAYMENT_STATUSES = [
  ...CONFIRMED_PAYMENT_STATUSES,
  ...TO_VERIFY_PAYMENT_STATUSES,
] as const

export type PaymentStatus = (typeof ALL_PAYMENT_STATUSES)[number]

export type PaymentSurface = 'confirmed' | 'to_verify'

export const PAYMENT_SURFACE_STATUSES: Record<PaymentSurface, readonly string[]> = {
  confirmed: CONFIRMED_PAYMENT_STATUSES,
  to_verify: TO_VERIFY_PAYMENT_STATUSES,
}

export const CONFIRMED_PAYMENTS_PATH = '/finance/received'
export const PAYMENTS_TO_VERIFY_PATH = '/finance/payments-to-verify'

export const PAYMENT_SURFACE_PATH: Record<PaymentSurface, string> = {
  confirmed: CONFIRMED_PAYMENTS_PATH,
  to_verify: PAYMENTS_TO_VERIFY_PATH,
}

export const PAYMENT_SURFACE_TITLE: Record<PaymentSurface, string> = {
  confirmed: 'Confirmed Payments',
  to_verify: 'Payments to Verify',
}

export const PAYMENT_SURFACE_SUBTITLE: Record<PaymentSurface, string> = {
  confirmed: 'Money that has been received and verified.',
  to_verify: 'Awaiting verification, needing clarification, or rejected.',
}

/**
 * Which page this payment belongs on.
 *
 * Returns null for a status the enum does not contain — a row that belongs
 * nowhere is a schema change nobody told the screens about, and answering
 * "confirmed" or "to verify" for it would be a guess about money.
 */
export function surfaceForStatus(status: string | null | undefined): PaymentSurface | null {
  if ((CONFIRMED_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')) return 'confirmed'
  if ((TO_VERIFY_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')) return 'to_verify'
  return null
}

export function isConfirmedPaymentStatus(status: string | null | undefined): boolean {
  return surfaceForStatus(status) === 'confirmed'
}

/**
 * The overlapping views — All, Orders, PI Drafts, Available to Allocate — belong
 * to Confirmed Payments alone.
 *
 * They classify money by where it has been attributed, and a payment awaiting
 * verification has been attributed nowhere: "Available to Allocate" over money
 * nobody has confirmed arrived is an invitation to spend it twice.
 */
export function surfaceHasClassificationViews(surface: PaymentSurface): boolean {
  return surface === 'confirmed'
}

// ── The Confirmed Payments table ─────────────────────────────────────────────

/**
 * NINE COLUMNS, IN THIS ORDER, AND NO OTHERS.
 *
 * The table carried eleven and was honestly wide: at 1024px it either scrolled
 * sideways inside its own box or squeezed every figure into an unreadable
 * column, and two of the eleven — the payment reference and the client name —
 * were repeated in the row a reader opens anyway. What survives is what a
 * Finance reader scans for: how much, how, when, where it went, what is left,
 * who raised it, who confirmed it, and what they can do about it.
 *
 * WHAT WAS REMOVED AND WHERE IT WENT, so nothing is silently lost:
 *
 *   Payment (reference)  → the detail panel, and search still matches it
 *   Client               → the detail panel; the card view still leads with it
 *   Status               → the page IS the status now. Every row is confirmed.
 *   Goes To              → replaced by counts beside the two money columns.
 *                          A list of Order names inline is what made the row
 *                          wrap unpredictably and the table impossible to size.
 */
export const CONFIRMED_PAYMENT_COLUMNS = [
  { key: 'amount',       label: 'Amount',        align: 'right' },
  { key: 'mode',         label: 'Mode',          align: 'left'  },
  { key: 'date',         label: 'Date',          align: 'left'  },
  { key: 'to_orders',    label: 'To Orders',     align: 'right' },
  { key: 'to_pi_draft',  label: 'To PI Draft',   align: 'right' },
  { key: 'unallocated',  label: 'Unallocated',   align: 'right' },
  { key: 'initiated_by', label: 'Initiated by',  align: 'left'  },
  { key: 'approved_by',  label: 'Approved by',   align: 'left'  },
  { key: 'actions',      label: 'Actions',       align: 'right' },
] as const

export type ConfirmedPaymentColumn = (typeof CONFIRMED_PAYMENT_COLUMNS)[number]['key']

/**
 * Below this the table becomes cards.
 *
 * NINE COMPACT COLUMNS FIT 1024px; eleven did not. The number is the practical
 * table breakpoint rather than a device: the requirement is that a 1024px
 * viewport shows the whole table with no horizontal scrolling anywhere, and
 * that anything narrower gets cards instead of a table turned sideways.
 */
export const PAYMENTS_TABLE_BREAKPOINT = 1024

/**
 * A person's name, short enough for a column.
 *
 * FIRST NAME AND AN INITIAL, never a truncation with an ellipsis: "Priyanka
 * S." is a name a colleague recognises, "Priyanka Sriniv…" is a bug report.
 * A single-word name is returned whole.
 */
export function conciseName(full: string | null | undefined): string {
  const name = (full ?? '').trim().replace(/\s+/g, ' ')
  if (name === '') return '—'
  const parts = name.split(' ')
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}
