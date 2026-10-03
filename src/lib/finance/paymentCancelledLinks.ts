// ── What a REJECTED request was linked to, kept for display ──────────────────
//
// WHY THIS EXISTS
// ---------------
// Rejecting a payment request cancels its pending allocation intents
// (finance_payment_requests_cancel_intents_on_reject: status 'cancelled',
// cancelled_reason 'payment request rejected'). The destination projection
// (finance_payment_destinations) reads ACTIVE allocations and PENDING intents
// only, so a rejected request reads as Suspense: its Against cell loses the PI /
// Order it was raised for, and with it the Total Before GST.
//
// The relationship is not lost — the cancelled intent keeps the target it named.
// This reads it back so the list can say "PI Draft PID-00007 (cancelled)" and
// show that PI's total.
//
// WHAT IT NEVER DOES
// ------------------
//   * It changes nothing. The cancellation stands, no intent or allocation is
//     reactivated, and no money is attributed to anything.
//   * It never guesses. Only intents the REJECTION itself cancelled are read (the
//     trigger's exact reason), not ones an edit replaced or an admin withdrew; a
//     client name or an Order number on the request is never consulted.
//   * It never picks between several. If the latest rejection cancelled intents
//     for more than one distinct record, the request has no single historical
//     record and nothing is shown for it.
//   * It never overrides a LIVE destination. Only a request whose destination is
//     Suspense/absent is looked up, and a resubmitted request (pending again)
//     has a pending intent again and is not in that set.

import type { createClient } from '@/lib/supabase/client'
import type { PaymentDestination } from './paymentDestination'

/** The exact reason finance_payment_requests_cancel_intents_on_reject writes. */
export const REJECTION_CANCEL_REASON = 'payment request rejected'

export type CancelledIntentRow = {
  payment_request_id: string
  target_type: string
  order_submission_id: string | null
  order_id: string | null
  cancelled_at: string | null
}

export type HistoricalTarget =
  | { kind: 'pi_draft'; submissionId: string }
  | { kind: 'confirmed_order'; orderId: string }

/**
 * The one record a request's latest rejection cancelled its link to, or null.
 * Pure. "Latest" = the newest cancelled_at; a request rejected, resubmitted and
 * rejected again is judged by its most recent rejection only.
 */
export function pickHistoricalTarget(rows: readonly CancelledIntentRow[]): HistoricalTarget | null {
  const dated = rows.filter(r => r.cancelled_at)
  if (dated.length === 0) return null
  const newest = dated.reduce((a, b) => (Date.parse(b.cancelled_at!) > Date.parse(a.cancelled_at!) ? b : a)).cancelled_at!
  const latest = dated.filter(r => r.cancelled_at === newest)

  const targets = new Map<string, HistoricalTarget>()
  for (const r of latest) {
    if (r.target_type === 'pi_draft' && r.order_submission_id) {
      targets.set(`s:${r.order_submission_id}`, { kind: 'pi_draft', submissionId: r.order_submission_id })
    } else if (r.target_type === 'confirmed_order' && r.order_id) {
      targets.set(`o:${r.order_id}`, { kind: 'confirmed_order', orderId: r.order_id })
    } else {
      return null // a row we cannot read as one record: say nothing rather than guess
    }
  }
  return targets.size === 1 ? [...targets.values()][0] : null
}

/** Whether a payment's destination is the empty one this module may fill in. */
export function needsHistoricalLink(destination: PaymentDestination | null | undefined): boolean {
  return destination === null || destination === undefined || (destination.kind === 'suspense' && destination.source === 'none')
}

/**
 * The historical destination for each rejected request among `paymentIds`, in
 * two to three batched reads for the whole page. Failures return an empty map:
 * the list then shows exactly what it showed before this module existed.
 */
export async function loadCancelledLinks(
  supabase: ReturnType<typeof createClient>,
  paymentIds: readonly string[],
): Promise<Map<string, PaymentDestination>> {
  const out = new Map<string, PaymentDestination>()
  const ids = [...new Set(paymentIds.filter(Boolean))]
  if (ids.length === 0) return out

  const { data, error } = await supabase
    .from('finance_payment_allocation_intents')
    .select('payment_request_id, target_type, order_submission_id, order_id, cancelled_at')
    .in('payment_request_id', ids)
    .eq('status', 'cancelled')
    .eq('cancelled_reason', REJECTION_CANCEL_REASON)
  if (error || !data) return out

  const byPayment = new Map<string, CancelledIntentRow[]>()
  for (const row of data as CancelledIntentRow[]) {
    const list = byPayment.get(row.payment_request_id) ?? []
    list.push(row)
    byPayment.set(row.payment_request_id, list)
  }
  const picked = new Map<string, HistoricalTarget>()
  for (const [paymentId, rows] of byPayment) {
    const target = pickHistoricalTarget(rows)
    if (target) picked.set(paymentId, target)
  }
  if (picked.size === 0) return out

  // How each record names itself. RLS decides what this reader may name; a
  // record they cannot read keeps its kind and says it is not visible to them.
  const submissionIds = [...new Set([...picked.values()].flatMap(t => t.kind === 'pi_draft' ? [t.submissionId] : []))]
  const orderIds = [...new Set([...picked.values()].flatMap(t => t.kind === 'confirmed_order' ? [t.orderId] : []))]

  const draftRef = new Map<string, string>()
  if (submissionIds.length > 0) {
    const { data: drafts } = await supabase.from('order_submissions').select('id, draft_reference').in('id', submissionIds)
    for (const d of (drafts ?? []) as { id: string; draft_reference: string | null }[]) {
      if (d.draft_reference && d.draft_reference.trim() !== '') draftRef.set(d.id, d.draft_reference.trim())
    }
  }
  const orderNumber = new Map<string, string>()
  if (orderIds.length > 0) {
    const { data: orders } = await supabase.from('orders').select('id, display_number').in('id', orderIds)
    for (const o of (orders ?? []) as { id: string; display_number: string | null }[]) {
      if (o.display_number && o.display_number.trim() !== '') orderNumber.set(o.id, o.display_number.trim())
    }
  }

  for (const [paymentId, target] of picked) {
    out.set(paymentId, target.kind === 'pi_draft'
      ? {
          paymentId, source: 'intent', kind: 'pi_draft', orderCount: 0, submissionCount: 1, customerCount: 1,
          orderId: null, orderNumber: null, submissionId: target.submissionId,
          reference: draftRef.get(target.submissionId) ?? null, cancelled: true,
        }
      : {
          paymentId, source: 'intent', kind: 'confirmed_order', orderCount: 1, submissionCount: 0, customerCount: 1,
          orderId: target.orderId, orderNumber: orderNumber.get(target.orderId) ?? null, submissionId: null,
          reference: orderNumber.get(target.orderId) ?? null, cancelled: true,
        })
  }
  return out
}

/** The live destinations with the historical ones filled in where there is no live one. */
export function withCancelledLinks(
  live: ReadonlyMap<string, PaymentDestination>,
  cancelled: ReadonlyMap<string, PaymentDestination>,
): Map<string, PaymentDestination> {
  const merged = new Map(live)
  for (const [paymentId, historical] of cancelled) {
    if (needsHistoricalLink(live.get(paymentId))) merged.set(paymentId, historical)
  }
  return merged
}
