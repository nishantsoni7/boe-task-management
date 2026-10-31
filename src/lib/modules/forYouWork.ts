// RECORDS WAITING ON THE VIEWER, as cards of the Modules For you column.
//
// Payment requests to verify (owner, 2026-10-31), and the four items an
// administrator can add from Control Center: a payment sent back, a PI waiting
// for approval, an Order change request and a PI waiting for Operations. Each is
// a short read of an existing table under the reader's own RLS
// (src/hooks/queries/useForYouWork.ts), so a card can never name a record the
// reader may not open, and each button opens the record's existing page, where
// the decision is made. Nothing here decides anything.
//
// Pure, so the test runner can execute it.

import { formatINR } from '@/lib/currency'
import { customerDisplayName, paymentModeLabel } from '@/lib/finance/paymentEntry'
import { itemKeys } from '@/lib/modules/forYouSnooze'
import type { ForYouItemKey } from '@/lib/modules/forYouCatalogue'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { OPERATIONS_REVIEW_ANCHOR } from '@/lib/orders/operationsHandoff'
import { timeAgo } from '@/lib/ui'

/** How many cards of one kind the column lists before "N more". */
export const FOR_YOU_CARDS_SHOWN = 5

/** How many rows one read fetches. The count comes back with them. */
export const FOR_YOU_READ_LIMIT = 20

export type WorkItemKey = Extract<ForYouItemKey,
  'payment_request' | 'payment_sent_back' | 'pi_waiting_approval' | 'order_change_request' | 'pi_waiting_operations'>

export type WorkCard = {
  /** Clear all's key: the record and its version. */
  key: string
  label: string
  brief: string
  detail: string
  action: string
  href: string
}

type Person = { full_name: string | null } | null

export type PaymentRequestRow = {
  id: string
  client_name: string | null
  amount: number | string
  payment_mode: string | null
  created_at: string
  updated_at: string | null
  submitted_by_user: Person
}

export type SentBackRow = {
  id: string
  human_payment_id: string | null
  request_number: string
  client_name: string | null
  amount: number | string
  clarification_requested_at: string | null
  updated_at: string
}

export type PiApprovalRow = {
  id: string
  client_name: string | null
  bill_to_name: string | null
  draft_reference: string | null
  submitted_at: string | null
  created_at: string
  submitted_by_user: Person
}

export type ChangeRequestRow = {
  id: string
  order_id: string
  order_number_snapshot: string
  request_type: 'edit' | 'cancel'
  created_at: string
  order: { client_name: string | null } | null
  requested_by_user: Person
}

export type OperationsRow = {
  id: string
  order_id: string
  version_number: number
  approved_at: string | null
  created_at: string
  order: { client_name: string | null; display_number: string | null; status: string | null } | null
}

const money = (amount: number | string, client: string | null) =>
  `${formatINR(Number(amount))} · ${customerDisplayName(client)}`

const orderBrief = (number: string | null | undefined, client: string | null | undefined) => {
  const label = displayOrderNumber(number)
  return [label ? `Order ${label}` : 'Order', client].filter(Boolean).join(' · ')
}

export function paymentRequestCard(r: PaymentRequestRow): WorkCard {
  const by = r.submitted_by_user?.full_name
  return {
    key: itemKeys.work('payment-request', r.id, r.updated_at),
    label: `Payment request · ${timeAgo(r.created_at)}`,
    brief: money(r.amount, r.client_name),
    detail: [by ? `Sent by ${by}` : null, r.payment_mode ? paymentModeLabel(r.payment_mode) : null]
      .filter(Boolean).join(' · '),
    action: 'Review',
    href: `/finance?tab=pending&request=${r.id}`,
  }
}

export function sentBackCard(r: SentBackRow): WorkCard {
  return {
    key: itemKeys.work('payment-sent-back', r.id, r.updated_at),
    label: `Sent back to you · ${timeAgo(r.clarification_requested_at ?? r.updated_at)}`,
    brief: money(r.amount, r.client_name),
    detail: `${r.human_payment_id ?? r.request_number} · Finance has a question`,
    action: 'Open',
    href: `/finance?tab=clarification&request=${r.id}`,
  }
}

export function piApprovalCard(r: PiApprovalRow): WorkCard {
  const by = r.submitted_by_user?.full_name
  return {
    key: itemKeys.work('pi-approval', r.id, r.submitted_at),
    label: `PI waiting for approval · ${timeAgo(r.submitted_at ?? r.created_at)}`,
    brief: r.client_name || r.bill_to_name || 'Unnamed client',
    detail: [r.draft_reference, by ? `Submitted by ${by}` : null].filter(Boolean).join(' · '),
    action: 'Review',
    href: draftDetailHref(r.id),
  }
}

export function changeRequestCard(r: ChangeRequestRow): WorkCard {
  const by = r.requested_by_user?.full_name
  return {
    key: itemKeys.work('order-change', r.id, null),
    label: `${r.request_type === 'cancel' ? 'Cancellation request' : 'Order change'} · ${timeAgo(r.created_at)}`,
    brief: orderBrief(r.order_number_snapshot, r.order?.client_name),
    detail: by ? `Requested by ${by}` : 'Waiting for review',
    action: 'Review',
    href: `/orders/${r.order_id}`,
  }
}

export function operationsCard(r: OperationsRow): WorkCard {
  return {
    key: itemKeys.work('pi-operations', r.id, null),
    label: `PI waiting for Operations · ${timeAgo(r.approved_at ?? r.created_at)}`,
    brief: orderBrief(r.order?.display_number, r.order?.client_name),
    detail: `PI V${r.version_number} needs your review`,
    action: 'Review',
    href: `/orders/${r.order_id}#${OPERATIONS_REVIEW_ANCHOR}`,
  }
}

/** A cancelled Order has nothing left to accept: the door refuses it, so no card offers it. */
export const isOpenForOperations = (r: OperationsRow) => r.order?.status !== 'cancelled'
