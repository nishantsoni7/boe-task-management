// ── THE PI'S INTERNAL ORDER DETAILS, ON THE CONFIRMED ORDER ─────────────────
//
// Sales fills these on the PI before it is sent (Internal order details); the
// Order page used to show none of them (owner, 2026-10-19). They are listed in
// the Documents card, as a property list, beside the PI they were agreed with.
//
// The dates, the salesperson and the lead source are NOT repeated here: the
// Order's own summary panel already states them. The commission keeps its own
// reader rule (can_read_order_submission_commission): a reader outside it sees
// "Restricted", never a value and never a false "No".

import { orderDetailsAbsent, orderDetailsReview, type OrderDetailsRow } from './salesOrderDetails'

export const ORDER_INTERNAL_DETAILS_TITLE = 'Internal order details'
export const ORDER_INTERNAL_DETAILS_NOTE = 'BOE only'

export type OrderInternalDetailRow = {
  key: 'fabric_responsibility' | 'middleman_commission' | 'billing_percentage' | 'billing_terms' | 'payment_terms'
  label: string
  value: string
  /** No value (or restricted): drawn quieter than an answer. */
  muted: boolean
}

const blank = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())

export function orderInternalDetailRows(row: OrderDetailsRow): OrderInternalDetailRow[] {
  const review = new Map(orderDetailsReview(row, []).map(r => [r.key, r]))
  const pick = (key: 'fabric_responsibility' | 'middleman_commission' | 'billing_percentage' | 'payment_terms'): OrderInternalDetailRow => {
    const r = review.get(key)
    const value = r?.value ?? null
    return {
      key,
      label: r?.label ?? key,
      value: value ?? orderDetailsAbsent(r?.need ?? 'optional', key),
      muted: value === null || (key === 'middleman_commission' && !!row.commission_restricted),
    }
  }
  const billingTerms = blank(row.billing_terms)
  return [
    pick('fabric_responsibility'),
    pick('middleman_commission'),
    pick('billing_percentage'),
    { key: 'billing_terms', label: 'Billing terms', value: billingTerms ?? orderDetailsAbsent('optional'), muted: billingTerms === null },
    pick('payment_terms'),
  ]
}
