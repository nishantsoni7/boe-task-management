import type { Quotation } from './api'

// What waits on the person looking at a quotation (owner-approved 13 Nov 2026). The Price approval card sits at the bottom of the
// builder, below a long product list, so the builder shows a strip at the top that says so and jumps to the card. Every item
// leaves when its state changes: nothing here is stored. The Quotation request card moved to the very top of the page (owner,
// 18 Nov 2026), so it needs no strip: it is the first thing seen.

export type NeedsYou = { key: 'price_ask' | 'price_returned' | 'price_decide'; text: string; target: string }

export const REQUEST_CARD_ID = 'q-card-request'
export const PRICE_CARD_ID = 'q-card-price'

const OPEN: Quotation['status'][] = ['draft', 'sent', 'negotiating']

export function needsYou(base: Pick<Quotation, 'status' | 'may_edit' | 'price'>): NeedsYou[] {
  const out: NeedsYou[] = []
  const p = base.price
  if (p && OPEN.includes(base.status)) {
    if (base.may_edit && p.state === 'to_ask') out.push({ key: 'price_ask', text: 'These prices need the pricing desk’s approval before the client link can be turned on.', target: PRICE_CARD_ID })
    if (base.may_edit && p.state === 'returned') out.push({ key: 'price_returned', text: 'The pricing desk sent the prices back.', target: PRICE_CARD_ID })
    if (p.may_decide && p.state === 'requested') out.push({ key: 'price_decide', text: 'Prices are waiting for your approval.', target: PRICE_CARD_ID })
  }
  return out
}
