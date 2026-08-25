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
// FIVE VALUES, AND THE DATABASE DECIDES WHICH FIVE. This is exactly the domain
// finance_payment_requests.payment_mode has carried since 20260628000200:
//
//   check (payment_mode in ('bank_transfer','cash','upi','cheque','other'))
//
// THERE IS NO 'card'. It was proposed and is not in the constraint, so adding it
// here would produce a form that offers a value every write refuses. Adding it
// properly is a migration, and a deliberate one.
//
// This replaces five separate arrays that had drifted into five files while
// happening to agree. They agreed; nothing made them.

export const PAYMENT_MODES = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cash',          label: 'Cash' },
  { value: 'upi',           label: 'UPI' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'other',         label: 'Other' },
] as const

export type PaymentMode = typeof PAYMENT_MODES[number]['value']

export const PAYMENT_MODE_VALUES: readonly PaymentMode[] = PAYMENT_MODES.map(m => m.value)

export const PAYMENT_MODE_LABEL: Record<string, string> =
  Object.fromEntries(PAYMENT_MODES.map(m => [m.value, m.label]))

export function isPaymentMode(value: string | null | undefined): value is PaymentMode {
  return (PAYMENT_MODE_VALUES as readonly string[]).includes(value ?? '')
}

/**
 * How a stored payment mode is written down.
 *
 * An unrecognised value is returned AS IT IS STORED rather than as 'Other': a
 * row carrying something this list does not know is a fact worth seeing, and
 * relabelling it would hide the only evidence.
 */
export function paymentModeLabel(value: string | null | undefined): string {
  const key = (value ?? '').trim()
  if (!key) return '—'
  return PAYMENT_MODE_LABEL[key] ?? key
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
  if (m.includes('PAYMENT_MODE_INVALID')) {
    return 'Choose Bank Transfer, Cash, UPI, Cheque or Other.'
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
