import type { Quotation } from './api'

// What waits on the person looking at a quotation (owner-approved 13 Nov 2026). The cards these live in (Quotation request,
// Price approval) now sit at the bottom of the builder, below a long product list, so the builder shows a strip at the top that
// says so and jumps to the card. Every item leaves when its state changes: nothing here is stored.

export type NeedsYou = { key: 'request' | 'price_ask' | 'price_returned' | 'price_decide'; text: string; target: string }

export const REQUEST_CARD_ID = 'q-card-request'
export const PRICE_CARD_ID = 'q-card-price'

const OPEN: Quotation['status'][] = ['draft', 'sent', 'negotiating']

export function needsYou(base: Pick<Quotation, 'status' | 'may_edit' | 'request' | 'price'>): NeedsYou[] {
  const out: NeedsYou[] = []
  const r = base.request
  if (r?.may_send && r.status !== 'completed') {
    out.push({ key: 'request', text: `Quotation request from ${r.asked_by ?? 'sales'}: send it to sales when this quotation is ready.`, target: REQUEST_CARD_ID })
  }
  const p = base.price
  if (p && OPEN.includes(base.status)) {
    if (base.may_edit && p.state === 'to_ask') out.push({ key: 'price_ask', text: 'These prices need the pricing desk’s approval before the client link can be turned on.', target: PRICE_CARD_ID })
    if (base.may_edit && p.state === 'returned') out.push({ key: 'price_returned', text: 'The pricing desk sent the prices back.', target: PRICE_CARD_ID })
    if (p.may_decide && p.state === 'requested') out.push({ key: 'price_decide', text: 'Prices are waiting for your approval.', target: PRICE_CARD_ID })
  }
  return out
}
