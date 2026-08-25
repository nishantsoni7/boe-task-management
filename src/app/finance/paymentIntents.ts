// ── What a pending payment request is FOR ─────────────────────────────────────
//
// A Payment Request is unverified money, so it must not create an active
// allocation before Finance approves it. Since 20261013000000 the record of what
// it is for lives in `finance_payment_allocation_intents` — a pending INTENT,
// not an allocation:
//
//   • it contributes nothing to any allocated total;
//   • it reduces no remaining balance;
//   • it satisfies no 40% verified-payment gate;
//   • it appears as no active allocation.
//
// Approval is the only thing that converts one, and it does so in the same
// transaction that verifies the payment.
//
// WHY A SCREEN NEEDS IT ANYWAY. The payment ROW deliberately carries no linkage
// for a targeted request — order_id and order_request_id are provenance since
// 20261012000000 and this model does not start writing money into them again —
// so `payment_target_type` reads 'unallocated' for every new request, which is
// true of the row and useless to a person looking at it. The intent is where
// "this is for PI 4471" is written down, and this module is how a modal reads
// it back.
//
// READ ONLY, AND SCOPED BY THE PAYMENT. The table has a SELECT policy and no
// INSERT, UPDATE or DELETE policy at all: every write happens inside a SECURITY
// DEFINER function. Whoever may see the payment may see what it intends, and
// nobody may change it from a browser.

import type { createClient } from '@/lib/supabase/client'
import { PAYMENT_DESTINATION_LABEL, type PaymentDestination } from '@/lib/finance/paymentEntry'

export type IntentStatus = 'pending' | 'applied' | 'cancelled'

export type StoredIntent = {
  id: string
  /** 'pi_draft' or 'confirmed_order'. Suspense creates no intent at all. */
  targetType: Extract<PaymentDestination, 'pi_draft' | 'confirmed_order'>
  status: IntentStatus
  /** The PI Draft or the Order this intent names. */
  targetId: string
  intendedAmount: number
  /**
   * How the target identifies itself: an Order's number, or a PI's own source
   * number / workbook name. Null when the record could not be read — which is a
   * different fact from "there is no target", and is shown as such.
   */
  reference: string | null
}

/** What the status MEANS on a screen, in the vocabulary the rest of Finance uses. */
export const INTENT_STATUS_LABEL: Record<IntentStatus, string> = {
  pending:   'Awaiting verification',
  applied:   'Allocated on approval',
  cancelled: 'Cancelled',
}

/**
 * The destination line for a payment, in one sentence.
 *
 * `null` intent means Suspense — no target was chosen — which is a real answer
 * and not a missing one, so it is named rather than left blank.
 */
export function intentDestinationLabel(intent: StoredIntent | null): string {
  if (!intent) return PAYMENT_DESTINATION_LABEL.suspense
  return PAYMENT_DESTINATION_LABEL[intent.targetType]
}

/** How the chosen record is written down, or what to say when it cannot be read. */
export function intentReferenceLabel(intent: StoredIntent | null): string | null {
  if (!intent) return null
  return intent.reference ?? 'Not visible to you'
}

/**
 * The one intent a payment request carries, or null when it carries none.
 *
 * TWO ROUND TRIPS AT MOST, on one payment, when a modal opens: the intent, then
 * the record it names so a number can be shown instead of a uuid. Never called
 * per row of a list.
 *
 * A cancelled intent is still returned. A rejected request keeps its intent for
 * the audit trail (20261013000000 §6) and a screen that hid it would be hiding
 * the reason the payment exists.
 */
export async function loadPaymentIntent(
  supabase: ReturnType<typeof createClient>,
  paymentRequestId: string,
): Promise<StoredIntent | null> {
  const { data } = await supabase
    .from('finance_payment_allocation_intents')
    .select('id, target_type, order_submission_id, order_id, intended_amount, status')
    .eq('payment_request_id', paymentRequestId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data) return null

  const row = data as {
    id: string
    target_type: string
    order_submission_id: string | null
    order_id: string | null
    intended_amount: number | string
    status: string
  }
  const targetType = row.target_type === 'pi_draft' ? 'pi_draft' : 'confirmed_order'

  let reference: string | null = null
  if (targetType === 'confirmed_order' && row.order_id) {
    const { data: o } = await supabase
      .from('orders')
      .select('display_number')
      .eq('id', row.order_id)
      .maybeSingle()
    reference = (o as { display_number?: string } | null)?.display_number ?? null
  } else if (targetType === 'pi_draft' && row.order_submission_id) {
    // A PI has no allocated number of its own until one is reserved or issued,
    // so its reference is what the workbook itself carries — the same two
    // fields every other PI picker in this module shows.
    const { data: s } = await supabase
      .from('order_submissions')
      .select('source_order_number, source_workbook_name')
      .eq('id', row.order_submission_id)
      .maybeSingle()
    const pi = s as { source_order_number?: string | null; source_workbook_name?: string | null } | null
    reference = pi ? (pi.source_order_number || pi.source_workbook_name || null) : null
  }

  return {
    id: row.id,
    targetType,
    targetId: (targetType === 'pi_draft' ? row.order_submission_id : row.order_id) ?? '',
    status: (['pending', 'applied', 'cancelled'] as const).includes(row.status as IntentStatus)
      ? (row.status as IntentStatus)
      : 'pending',
    intendedAmount: Number(row.intended_amount),
    reference,
  }
}
