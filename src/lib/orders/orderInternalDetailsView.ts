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
import { describeMiddlemanParts } from './piInternalDetails'
import { formatBillingPercentage, readBillingPercentage } from './billingPercentage'

export const ORDER_INTERNAL_DETAILS_TITLE = 'Internal Order Details'
export const ORDER_INTERNAL_DETAILS_NOTE = 'BOE only'

export type OrderInternalDetailRow = {
  key: 'fabric_responsibility' | 'billing_percentage' | 'middleman_commission' | 'middleman_name' | 'billing_terms' | 'payment_terms'
  label: string
  value: string
  /** No value (or restricted): drawn quieter than an answer. */
  muted: boolean
}

const blank = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())

/**
 * THE CARD'S ROWS, in the order the owner asked for (2026-10-26): fabric
 * responsibility, bill / cash percentage, middleman commission, middleman name.
 * Billing and payment terms follow only when the PI states them.
 */
export function orderInternalDetailRows(row: OrderDetailsRow): OrderInternalDetailRow[] {
  const review = new Map(orderDetailsReview(row, []).map(r => [r.key, r]))
  const fabric = review.get('fabric_responsibility')
  const fabricValue = fabric?.value ?? null
  const billing = readBillingPercentage(row.billing_percentage ?? null)
  const middleman = describeMiddlemanParts(row)
  const restricted = !!row.commission_restricted
  const billingTerms = blank(row.billing_terms)
  const paymentTerms = blank(row.payment_terms)
  const rows: OrderInternalDetailRow[] = [
    {
      key: 'fabric_responsibility', label: fabric?.label ?? 'Fabric responsibility',
      value: fabricValue ?? orderDetailsAbsent(fabric?.need ?? 'submission', 'fabric_responsibility'),
      muted: fabricValue === null,
    },
    {
      key: 'billing_percentage', label: 'Bill / cash percentage',
      value: billing === null ? orderDetailsAbsent('optional') : `Bill ${formatBillingPercentage(billing)} · Cash ${formatBillingPercentage(Math.round((100 - billing) * 100) / 100)}`,
      muted: billing === null,
    },
    {
      key: 'middleman_commission', label: 'Middleman commission', value: middleman.commission,
      muted: restricted || middleman.commission === 'Not answered' || middleman.commission === 'No',
    },
    {
      key: 'middleman_name', label: 'Middleman name', value: middleman.name,
      muted: restricted || ['Not answered', 'Not applicable', 'Not named'].includes(middleman.name),
    },
  ]
  if (billingTerms) rows.push({ key: 'billing_terms', label: 'Billing terms', value: billingTerms, muted: false })
  if (paymentTerms) rows.push({ key: 'payment_terms', label: 'Payment terms', value: paymentTerms, muted: false })
  return rows
}
