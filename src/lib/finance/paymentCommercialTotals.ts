// ── "Total Before GST" for the payments on one page ──────────────────────────
//
// WHAT THE NUMBER IS
// ------------------
// The PI's full commercial total immediately before GST:
//
//   product amount before discount − discount + fabric + packing + transportation
//
// BOE does not compute that sum. A PI TRANSCRIBES it from the workbook into
// order_submissions.total_before_gst (20260908000000; the rule is spelled out in
// 20261002000000_order_submission_product_edit.sql: "BOE does not compute a PI's
// totals"). Re-deriving it here would be the wrong move twice over: the stored
// product figure and the discount are not both "before discount" (so a re-sum
// can subtract the discount twice), and a worded charge ("Included", "as
// applicable") is stored as 0 with a meaning, so a naive sum misstates the
// total. The stored column is the one authoritative figure — it already carries
// a recorded fabric charge even when the client supplies the fabric, because
// choosing "client supplies the fabric" never deletes the figure
// (piReviewModals.tsx PiTermsEditModal) — and it is what the PI page, the PDF
// and the Order's billing value read.
//
// WHICH PI
// --------
// A payment is for ONE record, named by the destination projection
// (finance_payment_destinations):
//   * a PI Draft            → destination.submissionId
//   * a Confirmed Order     → orders.source_order_submission_id of destination.orderId
// A revised PI is applied in place onto the same order_submissions row, so that
// row is always the current approved PI. A mixed or suspense destination names
// no single record and has no total.
//
// COST
// ----
// Two batched reads per page, never one per row, and never awaited by the first
// paint: the orders → PI hop (only when a Confirmed Order is on the page) and the
// PI totals. A record the reader's RLS does not return simply has no entry, and
// the screen says "Unavailable" rather than a misleading ₹0.

import type { createClient } from '@/lib/supabase/client'
import type { PaymentDestination } from './paymentDestination'

export type PaymentTotals = Map<string, number | null>

/** The stored figure as a number, or null when it is absent or not a finite amount. */
export function readTotalBeforeGst(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * The PI each payment's total comes from, or null for a payment with no single
 * record behind it. Pure; the loader below only adds the reads.
 */
export function piIdForDestination(
  destination: PaymentDestination | null | undefined,
  piByOrderId: ReadonlyMap<string, string | null>,
): string | null {
  if (!destination) return null
  if (destination.kind === 'pi_draft') return destination.submissionId
  if (destination.kind === 'confirmed_order' && destination.orderId) {
    return piByOrderId.get(destination.orderId) ?? null
  }
  return null
}

export async function loadPaymentTotals(
  supabase: ReturnType<typeof createClient>,
  destinations: ReadonlyMap<string, PaymentDestination>,
): Promise<PaymentTotals> {
  const totals: PaymentTotals = new Map()
  if (destinations.size === 0) return totals

  // Confirmed Orders on the page → their source PI, in one read.
  const orderIds = [...new Set([...destinations.values()]
    .filter(d => d.kind === 'confirmed_order' && d.orderId)
    .map(d => d.orderId as string))]

  const piByOrderId = new Map<string, string | null>()
  if (orderIds.length > 0) {
    const { data } = await supabase
      .from('orders').select('id, source_order_submission_id').in('id', orderIds)
    for (const row of (data ?? []) as { id: string; source_order_submission_id: string | null }[]) {
      piByOrderId.set(row.id, row.source_order_submission_id)
    }
  }

  const piIds = new Set<string>()
  for (const d of destinations.values()) {
    const pi = piIdForDestination(d, piByOrderId)
    if (pi) piIds.add(pi)
  }

  const totalByPi = new Map<string, number | null>()
  if (piIds.size > 0) {
    const { data } = await supabase
      .from('order_submissions').select('id, total_before_gst').in('id', [...piIds])
    for (const row of (data ?? []) as { id: string; total_before_gst: string | number | null }[]) {
      totalByPi.set(row.id, readTotalBeforeGst(row.total_before_gst))
    }
  }

  // Every payment gets an entry once the reads have settled, so "no entry yet"
  // (still loading) and "settled with no figure" (Unavailable) stay different.
  for (const [paymentId, d] of destinations) {
    const pi = piIdForDestination(d, piByOrderId)
    totals.set(paymentId, pi ? (totalByPi.get(pi) ?? null) : null)
  }
  return totals
}
