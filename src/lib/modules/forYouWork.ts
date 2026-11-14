// RECORDS WAITING ON THE VIEWER, as cards of the Modules For you column.
//
// Payment requests to verify (owner, 2026-10-31), the four items an
// administrator can add from Control Center: a payment sent back, a PI waiting
// for approval, an Order change request and a PI waiting for Operations, and a
// PI Operations flagged (2026-11-11, my_flagged_pis). Each is
// a short read of an existing table under the reader's own RLS
// (src/hooks/queries/useForYouWork.ts), so a card can never name a record the
// reader may not open, and each button opens the record's existing page, where
// the decision is made. Nothing here decides anything.
//
// Pure, so the test runner can execute it.

import { formatINR } from '@/lib/currency'
import { isTrackedPaymentMode } from '@/lib/finance/cashJourney'
import { customerDisplayName, paymentModeLabel } from '@/lib/finance/paymentEntry'
import { itemKeys } from '@/lib/modules/forYouSnooze'
import type { ForYouItemKey } from '@/lib/modules/forYouCatalogue'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { flaggedBrief, flaggedHref, flaggedLabel, reasonLine, type FlaggedPi } from '@/lib/orders/flaggedPis'
import { OPERATIONS_REVIEW_ANCHOR } from '@/lib/orders/operationsHandoff'
import { timeAgo } from '@/lib/ui'

/** How many cards of one kind the column lists before "N more". */
export const FOR_YOU_CARDS_SHOWN = 5

/** How many rows one read fetches. The count comes back with them. */
export const FOR_YOU_READ_LIMIT = 20

export type WorkItemKey = Extract<ForYouItemKey,
  'payment_request' | 'payment_sent_back' | 'pi_waiting_approval' | 'order_change_request' | 'pi_waiting_operations' | 'pi_flagged_by_operations'>

export type WorkCard = {
  /** Clear all's key: the record and its version. */
  key: string
  label: string
  brief: string
  detail: string
  action: string
  href: string
  /** Drawn in the urgent style: something is stuck until this person acts. */
  urgent?: boolean
}

type Person = { full_name: string | null } | null

export type PaymentRequestRow = {
  id: string
  client_name: string | null
  amount: number | string
  payment_mode: string | null
  created_at: string
  updated_at: string | null
  submitted_by: string | null
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

/** How many pending payments the verify read looks at: it is filtered by who may act on each, so it reads wider than the cards shown. */
export const FOR_YOU_PAYMENT_SCAN_LIMIT = 100

export type VerifyContext = {
  userId: string
  decidesOwnPayments: boolean
  /** A company cash custodian: a cash-route payment that reached the company came to one. */
  viewerIsCustodian: boolean
  /** Ids of the cash-route payments still on their way, or null while that list is not known. */
  inTransit: ReadonlySet<string> | null
}

/**
 * Whether a pending payment gets a verify card for this viewer (owner,
 * 2026-11-11): only a payment they can act on. A bank (HDFC) payment has no
 * cash chain, so every verifier is told. A cash-route payment is told only once
 * its cash has reached the company, and only to whoever recorded it or is a
 * custodian; while it is still on its way, who it is pending from is the news
 * (forYouPending.ts). Not knowing yet whether it is on its way means not shown.
 * A display rule: Finance still lets any verifier open and decide any payment.
 */
export function verifyCardApplies(
  r: Pick<PaymentRequestRow, 'id' | 'payment_mode' | 'submitted_by'>,
  ctx: VerifyContext,
): boolean {
  const own = r.submitted_by === ctx.userId
  if (own && !ctx.decidesOwnPayments) return false
  if (!isTrackedPaymentMode(r.payment_mode)) return true
  if (!ctx.inTransit || ctx.inTransit.has(r.id)) return false
  return own || ctx.viewerIsCustodian
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

/** A PI Operations flagged that this reader must answer: the Order is On Hold until they do, so it is drawn urgent. */
export function flaggedCard(r: FlaggedPi): WorkCard {
  // Review chain (20270718000000): the card is the approver's own work when Sales replied, or the salesperson's
  // when the approver sent it to them; its words say which.
  const replied = r.holder === 'coordinator' && r.reply !== null
  return {
    key: itemKeys.work('pi-flagged', r.handoffId, r.since),
    label: `${replied ? 'Sales replied on a flagged PI' : 'PI flagged by Operations'} · ${r.since ? timeAgo(r.since) : 'waiting'}`,
    brief: flaggedBrief(r),
    detail: replied
      ? `${r.replyByName ?? 'Sales'}: “${reasonLine(r.reply ?? '')}”`
      : `${flaggedLabel(r)} · “${reasonLine(r.reason)}”`,
    action: r.holder === 'sales' ? 'Reply' : r.holder === 'coordinator' ? (replied ? 'Forward' : 'Decide') : 'Respond',
    href: flaggedHref(r.orderId),
    urgent: true,
  }
}

/** A cancelled Order has nothing left to accept: the door refuses it, so no card offers it. */
export const isOpenForOperations = (r: OperationsRow) => r.order?.status !== 'cancelled'
