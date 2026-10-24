// ── Suggesting which order a bank credit probably belongs to ────────────────
//
// Pure. NOTHING here links, verifies or allocates. Money from the same payer
// tends to go to the same order again and again; when an earlier credit from
// that payer was linked to a payment that is allocated to an order (or a PI),
// the page says so, with the evidence, and a person decides.

import { nameOverlap, nameTokens, payerFromNarration } from './bankMatching'

/** One earlier credit that was linked to a payment, with where that payment went. */
export type PayerHistoryEntry = {
  /** The earlier credit's narration (the payer is read from it). */
  narration: string
  lineDate: string
  /** What the earlier payment was worth to this target. */
  allocatedAmount: number
  paymentId: string
  humanPaymentId: string | null
  targetType: 'order' | 'pi_draft'
  targetId: string
  /** Order number, or the PI's workbook name. */
  reference: string | null
  /** A PI's reserved Order number, when it has one. */
  reservedOrderNumber: string | null
}

export type OrderSuggestion = {
  targetType: 'order' | 'pi_draft'
  targetId: string
  reference: string | null
  reservedOrderNumber: string | null
  /** How many earlier payments from this payer went there. */
  times: number
  /** The most recent such payment: the evidence shown to the person. */
  latest: { humanPaymentId: string | null; paymentId: string; lineDate: string; amount: number }
}

/** The words that identify a payer; empty when the narration names nobody. */
export function payerKey(narration: string): string {
  return nameTokens(payerFromNarration(narration) ?? '').sort().join(' ')
}

/** Same payer: every significant word of each name appears in the other (truncated bank names allowed). */
export function samePayer(narrationA: string, narrationB: string): boolean {
  const a = payerFromNarration(narrationA)
  const b = payerFromNarration(narrationB)
  if (!a || !b) return false
  if (nameTokens(a).length === 0 || nameTokens(b).length === 0) return false
  return nameOverlap(a, b) >= 0.99 && nameOverlap(b, a) >= 0.99
}

export function suggestOrdersForLine(
  line: { narration: string },
  history: PayerHistoryEntry[],
  max = 2,
): OrderSuggestion[] {
  const byTarget = new Map<string, OrderSuggestion>()
  for (const h of history) {
    if (!samePayer(line.narration, h.narration)) continue
    const key = h.targetType + ':' + h.targetId
    const evidence = { humanPaymentId: h.humanPaymentId, paymentId: h.paymentId, lineDate: h.lineDate, amount: h.allocatedAmount }
    const hit = byTarget.get(key)
    if (!hit) {
      byTarget.set(key, {
        targetType: h.targetType, targetId: h.targetId, reference: h.reference,
        reservedOrderNumber: h.reservedOrderNumber, times: 1, latest: evidence,
      })
    } else {
      hit.times++
      if (h.lineDate > hit.latest.lineDate) hit.latest = evidence
    }
  }
  return [...byTarget.values()]
    .sort((a, b) => b.times - a.times || (a.latest.lineDate < b.latest.lineDate ? 1 : -1))
    .slice(0, max)
}

export function orderSuggestionLabel(s: OrderSuggestion): string {
  if (s.targetType === 'order') return s.reference ? `Order ${s.reference}` : 'an Order'
  const name = s.reservedOrderNumber ? `PI for Order ${s.reservedOrderNumber}` : 'a PI Draft'
  return s.reference ? `${name} (${s.reference})` : name
}
