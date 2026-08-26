// ── The shared vocabulary both payment-entry forms speak ─────────────────────
//
// Payment Request and Record Payment ask the same two questions — where is this
// money for, and how did it arrive — and used to answer them in different
// words, from different arrays, in different files. This module is the single
// source for both, plus the one formatter that decides how a payment with no
// customer is written down.
//
// NOTHING HERE AUTHORIZES OR DECIDES ANYTHING. Every rule it expresses is
// re-derived server-side by submit_payment_request and
// record_payment_with_allocations (20261013000000): the destination, the
// target's eligibility, the customer, the payment mode. A browser check is a
// convenience and never a boundary.

// ── Destination ──────────────────────────────────────────────────────────────
//
// THREE, AND THE SAME THREE ON BOTH FORMS. The values are the ones
// submit_payment_request accepts; the labels are what a person reads.
//
// 'suspense' is money recorded now and attached later. It is NOT a fake
// customer, a fake Order or a placeholder allocation — it is a payment with no
// target, which the database expresses as a null client_name and no allocation
// row at all.

export const PAYMENT_DESTINATIONS = ['pi_draft', 'confirmed_order', 'suspense'] as const
export type PaymentDestination = typeof PAYMENT_DESTINATIONS[number]

export function isPaymentDestination(value: string | null | undefined): value is PaymentDestination {
  return (PAYMENT_DESTINATIONS as readonly string[]).includes(value ?? '')
}

/** The card copy. The description names the situation, not the database effect. */
export const PAYMENT_DESTINATION_OPTIONS: {
  value: PaymentDestination
  label: string
  description: string
  /** Resolved to a component by the form. Decorative — every icon sits beside its label. */
  iconKey: 'file-text' | 'package-check' | 'wallet'
}[] = [
  {
    value: 'pi_draft',
    label: 'PI Draft',
    description: 'Allocate this payment to an approved PI Draft.',
    iconKey: 'file-text',
  },
  {
    value: 'confirmed_order',
    label: 'Confirmed Order',
    description: 'Allocate this payment to a confirmed Order.',
    iconKey: 'package-check',
  },
  {
    value: 'suspense',
    label: 'Suspense Entry',
    description: 'Record now and allocate it later.',
    iconKey: 'wallet',
  },
]

export const PAYMENT_DESTINATION_LABEL: Record<PaymentDestination, string> =
  Object.fromEntries(PAYMENT_DESTINATION_OPTIONS.map(o => [o.value, o.label])) as
    Record<PaymentDestination, string>

/** Does this destination need a PI Draft or an Order chosen? */
export function destinationNeedsTarget(destination: PaymentDestination): boolean {
  return destination !== 'suspense'
}

/** What a target search should look for, or null when there is nothing to pick. */
export function destinationTargetKind(destination: PaymentDestination): 'submission' | 'order' | null {
  switch (destination) {
    case 'pi_draft':        return 'submission'
    case 'confirmed_order': return 'order'
    default:                return null
  }
}

/** Shown under the Suspense card once it is chosen. */
export const SUSPENSE_NOTICE =
  'This payment will remain unallocated until it is assigned through Allocate Funds.'

// ── Payment Mode ─────────────────────────────────────────────────────────────
//
// FOUR VALUES FOR A NEW ENTRY, AND THE DATABASE DECIDES THE SAME FOUR. Since
// 20261014000000 §1 the domain a new payment may use is:
//
//   hdfc | pnb | paytm | canara
//
// These are the four BOE accounts money actually arrives into. What each one
// MEANS internally is recorded in the database's own column comment
// (finance_payment_requests.payment_mode, 20261014000000 §1) and is deliberately
// absent from this file, because it is absent from the product: a screen shows
// the account name and never a gloss on it.
//
// THE FIVE LEGACY VALUES ARE STILL READABLE. bank_transfer, cash, upi, cheque
// and other are what every payment recorded before the change carries. They stay
// storable (the CHECK keeps them) so no history is rewritten, and they are
// refused for a NEW entry by the four entry RPCs AND by
// finance_payment_requests_enforce_current_payment_mode — so a browser that
// offered one would produce a form every write refuses.
//
// WHY THEY WERE NOT CONVERTED. The stored (payment_mode, received_in) PAIR is
// what named an account, never the mode alone; received_in has been nullable
// since 20260919000000 and unwritten since 20261013000000, so a bare
// 'bank_transfer' is HDFC or Canara and nothing on the row says which.
// Converting would have invented a fact. See 20261014000000 §1 for the decision
// in full.
//
// ONE LIST, EVERY SURFACE. Payment Request, Edit Payment Request, Record
// Payment, the PI payment card, the filters, the tables and the detail views all
// read from here. They agreed by accident once; this is what makes them agree.

export const PAYMENT_MODES = [
  { value: 'hdfc',   label: 'HDFC' },
  { value: 'pnb',    label: 'PNB' },
  { value: 'paytm',  label: 'Paytm' },
  { value: 'canara', label: 'Canara' },
] as const

export type PaymentMode = typeof PAYMENT_MODES[number]['value']

export const PAYMENT_MODE_VALUES: readonly PaymentMode[] = PAYMENT_MODES.map(m => m.value)

/** The mode a form starts on before anybody has chosen. */
export const DEFAULT_PAYMENT_MODE: PaymentMode = 'hdfc'

/**
 * The five retired values, and how a historical row carrying one is written down.
 *
 * READ ONLY. Nothing offers these; they exist so a 2026 row prints "Bank
 * Transfer" rather than a raw column value, and so a test can name the set that
 * must never appear in a picker.
 */
export const LEGACY_PAYMENT_MODES = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cash',          label: 'Cash' },
  { value: 'upi',           label: 'UPI' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'other',         label: 'Other' },
] as const

export const LEGACY_PAYMENT_MODE_VALUES: readonly string[] =
  LEGACY_PAYMENT_MODES.map(m => m.value)

export const PAYMENT_MODE_LABEL: Record<string, string> =
  Object.fromEntries([...PAYMENT_MODES, ...LEGACY_PAYMENT_MODES].map(m => [m.value, m.label]))

/** Is this one of the four a NEW entry may use? */
export function isPaymentMode(value: string | null | undefined): value is PaymentMode {
  return (PAYMENT_MODE_VALUES as readonly string[]).includes(value ?? '')
}

/** Is this a retired value, kept readable for history and refused for new entries? */
export function isLegacyPaymentMode(value: string | null | undefined): boolean {
  return LEGACY_PAYMENT_MODE_VALUES.includes(value ?? '')
}

/**
 * How a stored payment mode is written down.
 *
 * A retired value reads as the words it always read as. An unrecognised value is
 * returned AS IT IS STORED rather than as 'Other': a row carrying something
 * neither list knows is a fact worth seeing, and relabelling it would hide the
 * only evidence.
 */
export function paymentModeLabel(value: string | null | undefined): string {
  const key = (value ?? '').trim()
  if (!key) return '—'
  return PAYMENT_MODE_LABEL[key] ?? key
}

/**
 * The options a picker should draw for a row that already carries `current`.
 *
 * The four, plus — only when the row holds a value outside them — the stored one
 * as an option of its own. Without that, opening an edit form on a historical
 * payment would silently move it onto HDFC the moment anything else was saved.
 * The extra option is never one of the four and is never offered to a new entry.
 */
export function paymentModeOptionsFor(
  current: string | null | undefined,
): { value: string; label: string; retired?: boolean }[] {
  const options: { value: string; label: string; retired?: boolean }[] =
    PAYMENT_MODES.map(m => ({ value: m.value, label: m.label }))
  const key = (current ?? '').trim()
  if (key && !isPaymentMode(key)) {
    options.unshift({ value: key, label: paymentModeLabel(key), retired: true })
  }
  return options
}

// ── Which modes are physically carried by a person ──────────────────────────
//
// PNB and Paytm. The money passes through somebody's hands between the customer
// and the company, so who held it and when is a real accountability record —
// which is what the custody trail (20261014000000 §2, and
// src/lib/finance/custodyTrail.ts) exists to hold.
//
// THE SERVER DECIDES THIS AGAIN, in payment_mode_requires_custody(), so a form
// that drew the section for a bank account has its events refused rather than
// stored. This function is why the section is drawn, never why it is allowed.

export function modeRequiresCustodyTrail(value: string | null | undefined): boolean {
  const key = (value ?? '').trim()
  return key === 'pnb' || key === 'paytm'
}

// ── The customer, which is never typed ───────────────────────────────────────
//
// client_name is nullable since 20261013000000 §1, and null means exactly one
// thing: no customer could be derived, because the payment has no target. The
// database refuses to leave it null for a targeted payment.
//
// TWO KINDS OF NULL, AND THEY READ DIFFERENTLY. A payment with no allocations
// has no customer to name. A payment whose allocations name SEVERAL customers
// has too many to name in one field — the database stores null there too,
// rather than inventing a summary string that would then be searchable as a
// customer. This formatter is where that distinction becomes words, because a
// sentence about a payment belongs at the point of display and not in a column.

export const NO_CUSTOMER_LABEL       = 'Not identified'
export const MULTIPLE_CUSTOMER_LABEL = 'Multiple customers'

export function customerDisplayName(
  clientName: string | null | undefined,
  options?: {
    /** How many DISTINCT customers this payment's active allocations name. */
    distinctAllocationCustomers?: number
  },
): string {
  const name = (clientName ?? '').trim()
  if (name) return name
  if ((options?.distinctAllocationCustomers ?? 0) > 1) return MULTIPLE_CUSTOMER_LABEL
  return NO_CUSTOMER_LABEL
}

// ── What the submit door says when it refuses ────────────────────────────────
//
// submit_payment_request raises greppable code prefixes, one per rule. Each maps
// to a sentence naming the rule that refused, so the person knows whether to
// pick a different record, fix the record itself, or ask for access — never a
// single "please try again" that hides which of them it was.
//
// AN UNRECOGNISED REFUSAL NEVER LEAKS DATABASE TEXT, and says plainly that
// nothing was written. The RPC is one transaction: there is no partial state to
// describe and nothing for a screen to compensate for.

export function paymentEntryErrorMessage(message: string | null | undefined): string {
  const m = message ?? ''

  if (m.includes('FINANCE_MODULE_CLOSED')) {
    return 'You do not have access to Finance. Ask an administrator to open the module for you.'
  }
  if (m.includes('PAYMENT_DESTINATION_INVALID')) {
    return 'Choose PI Draft, Confirmed Order or Suspense Entry.'
  }
  if (m.includes('PAYMENT_TARGET_FORBIDDEN')) {
    return 'A Suspense Entry names no PI Draft and no Order. Remove the selection, or choose a different destination.'
  }
  if (m.includes('PAYMENT_TARGET_REQUIRED')) {
    return 'Choose the PI Draft or Order this payment is for.'
  }
  if (m.includes('PAYMENT_TARGET_CONVERTED')) {
    return 'That PI has been approved and is now an Order. Choose Confirmed Order and select it instead.'
  }
  if (m.includes('PAYMENT_TARGET_NOT_ACTIVE')) {
    return 'That record can no longer receive a payment. Refresh and choose another.'
  }
  if (m.includes('PAYMENT_TARGET_NOT_FOUND')) {
    return 'That record no longer exists. Refresh and choose another.'
  }
  if (m.includes('PAYMENT_TARGET_NO_CLIENT')) {
    return 'That record has no customer on file. Correct it before recording a payment against it — the customer is read from the record, not typed here.'
  }
  if (m.includes('PAYMENT_AMOUNT_INVALID')) {
    return 'Enter a positive amount in rupees and paise.'
  }
  if (m.includes('PAYMENT_DATE_REQUIRED')) {
    return 'Enter the date the payment was received.'
  }
  if (m.includes('PAYMENT_MODE_INVALID') || m.includes('PAYMENT_MODE_RETIRED')) {
    return 'Choose HDFC, PNB, Paytm or Canara.'
  }
  // The custody trail's own refusals, each naming the rule that refused rather
  // than collapsing into one "please check the form".
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
  if (m.includes('CUSTODY_EVENT_IMMUTABLE')) {
    return 'A saved custody activity cannot be edited. Add the activity that actually happened instead.'
  }
  if (m.includes('PAYMENT_INTENT_EXCEEDS_AMOUNT')) {
    return 'This payment is already promised to another record for its full value. Refresh and check the figures.'
  }
  if (m.includes('finance_payment_requests_handover_pair')) {
    return 'A handover needs both a person and a date, or neither.'
  }
  if (m.includes('finance_payment_requests_handover_not_before_payment')) {
    return 'The handover date cannot be before the payment date.'
  }
  if (m.includes('Authentication required')) {
    return 'Your session has expired. Sign in again and resubmit.'
  }

  return 'The payment request could not be submitted. Nothing was saved — refresh and try again.'
}
