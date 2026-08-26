// ── What a payment is FOR, on a screen ───────────────────────────────────────
//
// THE DEFECT THIS MODULE EXISTS TO END
// ------------------------------------
// A Payment Request naming a Confirmed Order, approved by Finance, produced
// exactly one active allocation crediting the Order in full — and displayed:
//
//     status  approved_unlinked
//     badge   "Order No. Pending"
//     Order Number   (blank)
//     Payment Against  "New Order — no order created yet"
//
// The money was right and every word beside it was wrong, because each of those
// readers asked a column that stopped being the answer at 20261012000000:
//
//   * submit_payment_request deliberately leaves order_id NULL — those columns
//     are provenance, and the destination lives in the allocation intent;
//   * finance_payment_requests_derive_target therefore derives
//     payment_target_type='unallocated' and payment_against='new_order';
//   * approve_finance_payment_request branches on payment_target_type, so it
//     writes approved_unlinked with a null order_number;
//   * the badge, the Order Number cell and the Payment Against cell each read
//     one of those three.
//
// THE ANSWER IS DERIVED, NEVER STORED. finance_payment_destinations
// (20261014000000 §8) re-derives it on every read: from ACTIVE
// finance_payment_allocations first, from PENDING
// finance_payment_allocation_intents second, and from nothing else. This module
// is the one place that projection becomes words, so the Payment Requests table,
// the detail modal, the review modal and Received Payments cannot disagree about
// what a payment is for.
//
// IT DECIDES NO MONEY. Not one figure here. Whether a payment is fully or partly
// allocated is answered by finance_received_payments.allocation_state, from the
// ledger, and read from there — see ./paymentClassification.ts. This module says
// WHICH RECORD; that one says HOW MUCH.

import type { createClient } from '@/lib/supabase/client'

// ── The projection ───────────────────────────────────────────────────────────

export type PaymentDestinationKind =
  | 'confirmed_order'
  | 'pi_draft'
  /** More than one record, or two kinds at once. Never rendered as one Order. */
  | 'mixed'
  /** No active allocation and no pending intent. */
  | 'suspense'

export type PaymentDestinationSource = 'allocation' | 'intent' | 'none'

/** The view name. Named once so the two Finance surfaces read the same thing. */
export const PAYMENT_DESTINATIONS_SOURCE = 'finance_payment_destinations'

/** The columns a destination display needs. Named once, selected as one string. */
export const PAYMENT_DESTINATION_COLUMNS = [
  'payment_request_id',
  'destination_source',
  'destination_kind',
  'destination_order_count',
  'destination_submission_count',
  'destination_customer_count',
  'destination_order_id',
  'destination_order_number',
  'destination_submission_id',
  'destination_reference',
] as const

export const PAYMENT_DESTINATION_SELECT = PAYMENT_DESTINATION_COLUMNS.join(', ')

export type PaymentDestinationRow = {
  payment_request_id: string
  destination_source: string | null
  destination_kind: string | null
  destination_order_count: number | null
  destination_submission_count: number | null
  destination_customer_count: number | null
  destination_order_id: string | null
  destination_order_number: string | null
  destination_submission_id: string | null
  destination_reference: string | null
}

export type PaymentDestination = {
  paymentId: string
  source: PaymentDestinationSource
  kind: PaymentDestinationKind
  orderCount: number
  submissionCount: number
  /** How many distinct customers the destination records name. */
  customerCount: number
  /** Set only for a single-Order destination. Never for a mixed one. */
  orderId: string | null
  orderNumber: string | null
  /** Set only for a single-PI destination. */
  submissionId: string | null
  /**
   * How the chosen record identifies itself, or null.
   *
   * NULL MEANS TWO DIFFERENT THINGS and the label functions keep them apart: a
   * mixed or suspense destination has no single reference to give, and a single
   * destination whose record the reader may not open has one that could not be
   * read. The second is said out loud rather than left blank.
   */
  reference: string | null
}

const KINDS: readonly string[] = ['confirmed_order', 'pi_draft', 'mixed', 'suspense']
const SOURCES: readonly string[] = ['allocation', 'intent', 'none']

/**
 * One projection row, normalised.
 *
 * A row that could not be read at all — the projection returned nothing for this
 * payment — is NOT the same as a Suspense entry, and readPaymentDestination is
 * never called for one: the caller passes `null` to the label functions and they
 * say so. Collapsing "not loaded yet" into "no destination" is how every
 * targeted payment flashes as Suspense while a modal opens.
 */
export function readPaymentDestination(row: PaymentDestinationRow): PaymentDestination {
  const kind = KINDS.includes(row.destination_kind ?? '')
    ? (row.destination_kind as PaymentDestinationKind)
    : 'suspense'
  const source = SOURCES.includes(row.destination_source ?? '')
    ? (row.destination_source as PaymentDestinationSource)
    : 'none'
  return {
    paymentId: row.payment_request_id,
    source,
    kind,
    orderCount: Math.max(0, row.destination_order_count ?? 0),
    submissionCount: Math.max(0, row.destination_submission_count ?? 0),
    customerCount: Math.max(0, row.destination_customer_count ?? 0),
    orderId: row.destination_order_id,
    orderNumber: row.destination_order_number,
    submissionId: row.destination_submission_id,
    reference: row.destination_reference,
  }
}

// ── The words ────────────────────────────────────────────────────────────────

export const DESTINATION_KIND_LABEL: Record<PaymentDestinationKind, string> = {
  confirmed_order: 'Confirmed Order',
  pi_draft:        'PI Draft',
  mixed:           'Multiple destinations',
  suspense:        'Suspense / Unallocated',
}

/** What a reader is told when the record exists but they may not open it. */
export const DESTINATION_NOT_VISIBLE = 'Not visible to you'

/** Shown while the projection has not been read back yet. */
export const DESTINATION_LOADING = 'Reading…'

/**
 * The kind, in one phrase.
 *
 * `undefined` means the projection has not arrived; `null` means it arrived and
 * this payment has no row in it, which for a security_invoker view means the
 * payment itself is not readable — so nothing is claimed about it either way.
 */
export function destinationLabel(destination: PaymentDestination | null | undefined): string {
  if (destination === undefined) return DESTINATION_LOADING
  if (destination === null) return DESTINATION_KIND_LABEL.suspense
  return DESTINATION_KIND_LABEL[destination.kind]
}

/**
 * How the destination records identify themselves, or null when there is
 * nothing to name.
 *
 * A MIXED DESTINATION IS SUMMARISED, NEVER SAMPLED. "2 Orders · 1 PI Draft" is
 * true of the whole payment; printing whichever Order happened to sort first
 * would be a statement about one part of it presented as the whole — the exact
 * misleading-single-Order-Number failure the projection withholds identifiers to
 * prevent.
 */
export function destinationReferenceLabel(
  destination: PaymentDestination | null | undefined,
): string | null {
  if (!destination) return null
  if (destination.kind === 'suspense') return null
  if (destination.kind === 'mixed') {
    const parts: string[] = []
    if (destination.orderCount > 0) {
      parts.push(`${destination.orderCount} ${destination.orderCount === 1 ? 'Order' : 'Orders'}`)
    }
    if (destination.submissionCount > 0) {
      parts.push(`${destination.submissionCount} PI ${destination.submissionCount === 1 ? 'Draft' : 'Drafts'}`)
    }
    return parts.join(' · ') || null
  }
  return destination.reference ?? DESTINATION_NOT_VISIBLE
}

/**
 * The "Payment Against" cell: the kind and the record, in one line.
 *
 * THIS IS WHAT REPLACES "New Order — no order created yet". That sentence came
 * from payment_against, which reads 'new_order' for every request the current
 * form writes — true of the row, and false about the money.
 */
export function paymentAgainstDisplay(
  destination: PaymentDestination | null | undefined,
): string {
  if (destination === undefined) return DESTINATION_LOADING
  const kind = destinationLabel(destination)
  const reference = destinationReferenceLabel(destination)
  return reference ? `${kind} · ${reference}` : kind
}

/**
 * The "Order Number" cell.
 *
 * A number ONLY when exactly one Confirmed Order is the whole destination. A
 * mixed payment says how many rather than naming one; anything else says there
 * is no Order, which is a fact and not a blank.
 */
export function orderNumberDisplay(
  destination: PaymentDestination | null | undefined,
): { value: string; muted: boolean } {
  if (destination === undefined) return { value: DESTINATION_LOADING, muted: true }
  if (destination && destination.kind === 'confirmed_order') {
    return destination.orderNumber
      ? { value: destination.orderNumber, muted: false }
      : { value: DESTINATION_NOT_VISIBLE, muted: true }
  }
  if (destination && destination.kind === 'mixed' && destination.orderCount > 0) {
    return {
      value: destination.orderCount === 1
        ? '1 Order (split payment)'
        : `${destination.orderCount} Orders`,
      muted: true,
    }
  }
  if (destination && destination.kind === 'pi_draft') {
    return { value: 'No Order yet — PI Draft', muted: true }
  }
  return { value: 'Not allocated', muted: true }
}

// ── The badge: verification AND destination, decided in one place ────────────
//
// THE TWO AXES ARE STILL SEPARATE FACTS. Whether the money ARRIVED is Finance's
// decision; WHICH RECORD it is for is the ledger's. What changed is that the
// badge used to read the second one off the payment row's frozen status column,
// so a verified payment with a complete allocation wore "Order No. Pending"
// forever. It now reads the destination live, which means a reversal takes the
// badge with it and no stale linked state can survive.

export type PaymentDisplayState =
  | 'pending'
  | 'needs_clarification'
  | 'rejected'
  | 'received'
  | 'received_unallocated'

export const PAYMENT_DISPLAY_STATE_META: Record<
  PaymentDisplayState,
  { label: string; bg: string; color: string; border: string }
> = {
  pending:             { label: 'Pending',               bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  needs_clarification: { label: 'Needs Clarification',   bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',              bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  received:            { label: 'Received Payment',      bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  // NOT "Order No. Pending". The money arrived and is verified; what it has not
  // got is a home. That is what the words say, and Allocate Funds is what fixes
  // it — an Order number is one of several answers, not the only one.
  received_unallocated:{ label: 'Received — Unallocated', bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
}

/**
 * The state a payment displays as.
 *
 * `destination` undefined means the projection has not arrived; the payment is
 * still classified, because verification alone decides three of the five states
 * and the two verified ones default to the conservative "unallocated" rather
 * than claiming a link nothing has confirmed yet.
 */
export function paymentDisplayState(
  status: string | null | undefined,
  destination: PaymentDestination | null | undefined,
): PaymentDisplayState {
  if (status === 'rejected') return 'rejected'
  if (status === 'needs_clarification') return 'needs_clarification'
  if (status !== 'approved_linked' && status !== 'approved_unlinked') return 'pending'
  // VERIFIED. The destination decides which of the two, and it decides it from
  // the allocation ledger — never from the status column, which is exactly the
  // reader that produced the defect.
  const attached = destination
    ? destination.source === 'allocation' && destination.kind !== 'suspense'
    : false
  return attached ? 'received' : 'received_unallocated'
}

export function paymentDisplayStateMeta(
  status: string | null | undefined,
  destination: PaymentDestination | null | undefined,
) {
  return PAYMENT_DISPLAY_STATE_META[paymentDisplayState(status, destination)]
}

// ── Reading the projection ───────────────────────────────────────────────────

/**
 * The destinations for one page of payments, in ONE bounded request.
 *
 * BY ID, AND NEVER PER ROW. The pattern Received Payments already uses for its
 * target labels: the list query returns its page, and this fills in the one
 * thing the base table cannot answer. A per-row read would be fifty round trips
 * for one screen.
 *
 * An empty id list asks nothing. A failed read returns an empty map rather than
 * throwing: the list still renders, and every destination reads as not-yet-known
 * instead of the screen going blank.
 */
export async function loadPaymentDestinations(
  supabase: ReturnType<typeof createClient>,
  paymentIds: string[],
): Promise<Map<string, PaymentDestination>> {
  const map = new Map<string, PaymentDestination>()
  const ids = [...new Set(paymentIds.filter(Boolean))]
  if (ids.length === 0) return map

  const { data, error } = await supabase
    .from(PAYMENT_DESTINATIONS_SOURCE)
    .select(PAYMENT_DESTINATION_SELECT)
    .in('payment_request_id', ids)

  if (error || !data) return map
  for (const row of data as unknown as PaymentDestinationRow[]) {
    map.set(row.payment_request_id, readPaymentDestination(row))
  }
  return map
}

/** The destination for one payment, for a modal that opens on a single row. */
export async function loadPaymentDestination(
  supabase: ReturnType<typeof createClient>,
  paymentId: string,
): Promise<PaymentDestination | null> {
  const map = await loadPaymentDestinations(supabase, [paymentId])
  return map.get(paymentId) ?? null
}
