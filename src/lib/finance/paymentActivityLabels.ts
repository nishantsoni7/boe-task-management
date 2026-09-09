/**
 * HOW ONE FINANCE ACTIVITY ROW IS WRITTEN DOWN FOR A HUMAN.
 *
 * The activity trail is an audit record and its `event_type` values are chosen
 * for the database: `allocation_moved`, `allocation_created`, `status_changed`.
 * Those are correct names and they are the wrong words to show a manager, who
 * is reading the payment's history and not its schema.
 *
 * THIS MODULE ONLY RENAMES. It reads a row and returns a sentence. It never
 * decides which rows exist, never reorders them, never drops one, and has no
 * opinion about money — every figure in the modal is computed elsewhere from
 * the allocation ledger. Deleting a case here would make an event read as its
 * raw name; it could not make an event disappear.
 *
 * A NAME IS RESOLVED, NEVER INVENTED. The allocation events carry target UUIDs
 * and no display number (see log_finance_payment_allocation_activity in
 * 20260921000000), so the caller passes a resolver built from the records it
 * has already loaded. When the resolver cannot name a target — a REVERSED
 * allocation is not in the live summary, and a reader may not be allowed to see
 * the record at all — the sentence says "a Confirmed Order" rather than
 * printing a uuid or guessing a number.
 */

import {
  ALLOCATION_TARGET_WORD,
  type AllocationTarget,
} from './paymentAllocations'

/** The one row this module describes. Deliberately narrower than the query. */
export type PaymentActivityRow = {
  event_type: string
  payload: Record<string, unknown> | null
}

/** What an allocation points at — the allocation ledger's own two kinds. */
export type ActivityTargetKind = AllocationTarget['kind']

/**
 * Names a target the caller has already loaded, or returns null.
 *
 * NULL IS A NORMAL ANSWER, not an error: it means "this reader cannot name that
 * record", which is exactly what a restricted viewer and a reversed allocation
 * both produce.
 */
export type ActivityTargetResolver =
  (kind: ActivityTargetKind, id: string) => string | null

const NEVER_RESOLVES: ActivityTargetResolver = () => null

/** How a target that could NOT be named is described instead. */
const KIND_INDEFINITE: Record<ActivityTargetKind, string> = {
  order:      'a Confirmed Order',
  submission: 'a PI Draft',
}

/** `target_type` as the trigger writes it, mapped to this module's two kinds. */
function targetKind(value: unknown): ActivityTargetKind {
  return value === 'order_submission' ? 'submission' : 'order'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** "Order 0524", or null when this reader could not name that record. */
function resolvedTarget(
  kind: ActivityTargetKind,
  id: unknown,
  resolve: ActivityTargetResolver,
): string | null {
  const label = typeof id === 'string' && id ? resolve(kind, id) : null
  return label ? `${ALLOCATION_TARGET_WORD[kind]} ${label}` : null
}

/**
 * "Order 0524", or "a Confirmed Order" when it could not be named.
 *
 * The indefinite form is deliberate. "Order —" and "Order undefined" both read
 * as a defect; "a Confirmed Order" reads as the true statement it is.
 */
function namedTarget(
  kind: ActivityTargetKind,
  id: unknown,
  resolve: ActivityTargetResolver,
): string {
  return resolvedTarget(kind, id, resolve) ?? KIND_INDEFINITE[kind]
}

const STATUS_LABEL: Record<string, string> = {
  pending_approval:    'Pending Review',
  needs_clarification: 'Needs Clarification',
  // THE SAME WORDS THE BADGES USE (src/lib/finance/paymentDestination.ts).
  approved_unlinked:   'Received — Unallocated',
  approved_linked:     'Received Payment',
  rejected:            'Rejected',
}

function statusLabel(status: unknown): string {
  return (typeof status === 'string' && STATUS_LABEL[status]) || String(status ?? '')
}

// Which of the three submission targets the payment was raised against, read
// from the request_submitted payload (20260715). Absent on rows written before
// that migration, in which case the event reads as it always did.
// 'unallocated' IS DELIBERATELY BLANK, and the suffix is then omitted entirely:
// submit_payment_request leaves order_id NULL for EVERY destination
// (20261013000000 §3), so the payload cannot tell a Confirmed-Order request
// apart from a Suspense one and naming either would be a guess.
const TARGET_LABEL: Record<string, string> = {
  unallocated:     '',
  order_request:   'Order Request',
  confirmed_order: 'Confirmed Order',
}

function submittedTargetSuffix(p: Record<string, unknown>): string {
  const target = str(p.payment_target_type)
  if (!target) return ''
  const label = TARGET_LABEL[target] ?? target
  if (!label) return ''
  const named = str(p.order_request_number) || str(p.order_number)
  return named ? ` against ${label} ${named}` : ` against ${label}`
}

/** One side of a target change, described by what it points at. */
function targetSide(type: unknown, requestNumber: unknown, orderNumber: unknown): string {
  const label = typeof type === 'string' ? (TARGET_LABEL[type] ?? type) : 'no target'
  if (str(requestNumber)) return `${label} ${str(requestNumber)}`
  if (str(orderNumber))   return `${label} ${str(orderNumber)}`
  return label
}

/**
 * The last resort, and the reason no snake_case ever reaches a reader.
 *
 * A future migration will add an event type this file has never heard of. That
 * row must still render, and it must still read like English — so the raw name
 * is unwrapped into words rather than printed as it is stored.
 */
export function humanizeEventType(eventType: string): string {
  const words = eventType.replace(/[_-]+/g, ' ').trim()
  if (!words) return 'Activity recorded'
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

/**
 * The sentence one activity row is shown as.
 *
 * `resolve` is optional: a surface that has not loaded any target records still
 * gets correct, readable text — just the indefinite form of the allocation
 * events.
 */
export function paymentActivityLabel(
  row: PaymentActivityRow,
  resolve: ActivityTargetResolver = NEVER_RESOLVES,
): string {
  const p = row.payload ?? {}
  switch (row.event_type) {
    case 'request_submitted':
      return `Payment request submitted${submittedTargetSuffix(p)}`

    // A pre-approval correction. Deliberately NOT called a link or an unlink:
    // nothing has been approved yet, so no money has moved anywhere.
    case 'target_changed':
      return `Payment target changed from ${targetSide(p.from_target_type, p.from_order_request_number, p.from_order_number)} to ${targetSide(p.to_target_type, p.to_order_request_number, p.to_order_number)}`

    case 'order_linked':
      // from_order_request_* is present only when the link happened as an
      // automatic transfer during Order Request conversion (20260698).
      return str(p.from_order_request_number) || str(p.from_order_request_id)
        ? `Payment transferred to Confirmed Order ${str(p.order_number) || str(p.order_id)} from Order Request ${str(p.from_order_request_number) || str(p.from_order_request_id)}`
        : `Linked to Order ${str(p.order_number) || str(p.order_id)}`
    case 'order_unlinked':         return `Unlinked from Order ${str(p.order_number) || str(p.order_id)}`
    case 'order_request_linked':   return `Linked to Order Request ${str(p.order_request_number) || str(p.order_request_id)}`
    case 'order_request_unlinked': return `Unlinked from Order Request ${str(p.order_request_number) || str(p.order_request_id)}`
    case 'order_link_changed':
      return `Order link changed from ${str(p.from_order_number) || str(p.from_order_id)} to ${str(p.to_order_number) || str(p.to_order_id)}`

    // ── The allocation events ──
    //
    // These three used to fall through to `default` and print their raw
    // event_type, so the one screen that exists to say where the money went
    // said "allocation_created" instead of saying where the money went.
    case 'allocation_created': {
      const kind = targetKind(p.target_type)
      return `Payment allocated to ${namedTarget(kind, p.target_id, resolve)}`
    }
    case 'allocation_reversed': {
      const kind = targetKind(p.target_type)
      return `Allocation to ${namedTarget(kind, p.target_id, resolve)} reversed`
    }
    case 'allocation_moved': {
      // The PI-to-Order conversion, and the only shape it has: the allocation
      // leaves an order_submission and lands on an order. Both ends are in the
      // payload, so when both can be named the sentence says both.
      const to   = namedTarget('order', p.moved_to_order_id ?? p.target_id, resolve)
      const from = resolvedTarget('submission', p.moved_from_order_submission_id, resolve)
      return from
        ? `Payment allocation moved from ${from} to ${to}`
        : `Payment allocation moved to ${to}`
    }

    // The decision events. Named for what was DECIDED rather than described as
    // a status transition.
    case 'status_changed': {
      const to = p.to_status
      if (to === 'approved_unlinked' || to === 'approved_linked') return 'Payment approved'
      if (to === 'needs_clarification')                          return 'Clarification requested'
      if (to === 'rejected')                                     return 'Payment rejected'
      if (to === 'pending_approval')                             return 'Resubmitted for approval'
      return `Status changed from ${statusLabel(p.from_status)} to ${statusLabel(p.to_status)}`
    }

    // The cash trail (20260716). Names come from the payload, resolved
    // server-side at write time — the timeline never renders a uuid.
    case 'collection_details_updated': return 'Cash collection details updated'
    case 'cash_handover_recorded': {
      const to = str(p.to_handed_over_to_name)
      // Cleared: the handover was recorded and has been taken back off.
      if (!p.to_handed_over_to_id) return 'Cash handover cleared'
      return to ? `Cash handed over to ${to}` : 'Cash handover recorded'
    }

    default: return humanizeEventType(row.event_type)
  }
}
