// ── Deciding one pending payment from a PI Draft ──────────────────────────────
//
// THE SAME TWO DOORS FINANCE USES, AND NO THIRD.
//
//   approve  approve_finance_payment_request(p_request_id, p_admin_note), the
//            one approval RPC. It re-derives finance.approve (with Finance module
//            entry), locks the row, refuses anything that is not
//            pending_approval, links an Order where one is named and applies the
//            payment's allocation intents — all inside one transaction.
//   reject   a direct UPDATE of status, admin_note and updated_at: exactly the
//            write Finance's review dialog makes. RLS decides who may make it —
//            finance_payment_requests_approver_decide admits a PENDING row only
//            for finance.approve, and only into rejected / needs_clarification —
//            and finance_payment_requests_guard_pending_decision refuses every
//            other column.
//
// Both writes fire finance_payment_requests_log_activity, so a decision taken on
// a PI Draft leaves the same activity entry as one taken in Finance, and the
// notifications below are Finance's own, with the same payloads.
//
// WHAT IS DIFFERENT, AND WHY. Finance holds the whole payment row in memory; a PI
// Draft holds only its allocation summary. So the row is read once first — for
// the notification context, and to refuse a decision on a payment that is no
// longer pending before anything is written. And the rejection asks for a row
// COUNT, because an UPDATE that RLS filters out succeeds with zero rows, and
// this screen must not report a rejection that did not happen.
//
// NOTHING HERE DECIDES WHO MAY ACT. canVerifyPayment() decides what is drawn;
// the database decides what is allowed. A raw database message never leaves
// this module — the PI screens show fixed sentences only.

import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyFinance, notifyOrderUpdate } from '@/lib/notify'

export type PaymentDecision = 'approve' | 'reject'

/** The columns the decision and its notifications need, and no others. */
export const PAYMENT_DECISION_COLUMNS =
  'id, request_number, status, submitted_by, client_name, payment_against, order_id, order_number'

type DecisionRow = {
  id: string
  request_number: string
  status: string
  submitted_by: string | null
  client_name: string | null
  payment_against: string | null
  order_id: string | null
  order_number: string | null
}

export const PAYMENT_DECISION_MESSAGE = {
  reasonRequired: 'Enter a reason before rejecting this payment.',
  unavailable: 'This payment could not be opened. It may have been removed, or you may not have access to it.',
  notPending: 'This payment is no longer awaiting verification — it may already have been decided. The list has been refreshed.',
  notPermitted: 'You do not have permission to verify payments.',
  targetChanged: 'This payment changed while it was being decided. Refresh and try again.',
  needsFinance: 'This payment cannot be verified from here. Open it in Finance to correct its destination first.',
  failed: 'The decision could not be saved. Please try again.',
} as const

export type PaymentDecisionResult =
  | { ok: true; decision: PaymentDecision; requestNumber: string }
  | { ok: false; message: string }

type DecisionClient = Pick<SupabaseClient, 'from' | 'rpc'>

export type PaymentDecisionNotifiers = {
  notifyFinance: typeof notifyFinance
  notifyOrderUpdate: typeof notifyOrderUpdate
}

const DEFAULT_NOTIFIERS: PaymentDecisionNotifiers = { notifyFinance, notifyOrderUpdate }

/** A database refusal, as one of the fixed sentences above. */
export function describePaymentDecisionError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): string {
  const code = error?.code ?? ''
  const message = error?.message ?? ''
  if (code === '42501' || /row-level security|permission denied/i.test(message)) {
    return PAYMENT_DECISION_MESSAGE.notPermitted
  }
  if (/Only a pending payment request/i.test(message)) return PAYMENT_DECISION_MESSAGE.notPending
  if (message.includes('PAYMENT_TARGET_CHANGED')) return PAYMENT_DECISION_MESSAGE.targetChanged
  if (/ORDER_REQUEST_|no linked order/i.test(message)) return PAYMENT_DECISION_MESSAGE.needsFinance
  if (code === 'P0002') return PAYMENT_DECISION_MESSAGE.unavailable
  return PAYMENT_DECISION_MESSAGE.failed
}

export async function decidePayment(
  client: DecisionClient,
  input: { paymentId: string; decision: PaymentDecision; note: string | null },
  notifiers: PaymentDecisionNotifiers = DEFAULT_NOTIFIERS,
): Promise<PaymentDecisionResult> {
  const note = (input.note ?? '').trim()
  // Finance requires a note for a rejection and so does this. Refused before any
  // read, so a missing reason costs no round trip.
  if (input.decision === 'reject' && note === '') {
    return { ok: false, message: PAYMENT_DECISION_MESSAGE.reasonRequired }
  }

  const { data, error: readError } = await client
    .from('finance_payment_requests')
    .select(PAYMENT_DECISION_COLUMNS)
    .eq('id', input.paymentId)
    .maybeSingle()
  if (readError) return { ok: false, message: describePaymentDecisionError(readError) }

  const r = data as DecisionRow | null
  if (!r) return { ok: false, message: PAYMENT_DECISION_MESSAGE.unavailable }
  if (r.status !== 'pending_approval') return { ok: false, message: PAYMENT_DECISION_MESSAGE.notPending }

  if (input.decision === 'approve') {
    const { error: rpcError } = await client.rpc('approve_finance_payment_request', {
      p_request_id: r.id,
      p_admin_note: note || null,
    })
    if (rpcError) return { ok: false, message: describePaymentDecisionError(rpcError) }

    // Finance's own notification, with Finance's own wording choice: a new_order
    // payment lands in Suspense, anything else links straight to its Order.
    void notifiers.notifyFinance(
      r.payment_against === 'new_order'
        ? { event: 'finance_approved_suspense', requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name }
        : { event: 'finance_approved_linked',   requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name, orderNumber: r.order_number },
    )
    if (r.order_id) void notifiers.notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })
    return { ok: true, decision: 'approve', requestNumber: r.request_number }
  }

  const { count, error: updateError } = await client
    .from('finance_payment_requests')
    .update({
      admin_note: note,
      status:     'rejected',
      updated_at: new Date().toISOString(),
    }, { count: 'exact' })
    .eq('id', r.id)
    // Only the pending decision this screen offered. A payment decided elsewhere
    // in the meantime is left exactly as that decision left it.
    .eq('status', 'pending_approval')
  if (updateError) return { ok: false, message: describePaymentDecisionError(updateError) }
  if (!count) return { ok: false, message: PAYMENT_DECISION_MESSAGE.notPending }

  void notifiers.notifyFinance({
    event: 'finance_rejected',
    requestNumber: r.request_number,
    entityId: r.id,
    creatorId: r.submitted_by,
    clientName: r.client_name,
  })
  // A rejection moves an Order's money too, exactly as Finance announces it.
  if (r.order_id) void notifiers.notifyOrderUpdate({ orderId: r.order_id, event: 'payment' })
  return { ok: true, decision: 'reject', requestNumber: r.request_number }
}
