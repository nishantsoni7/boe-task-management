import type { Quotation } from './api'

// What waits on the person looking at a quotation (owner-approved 13 Nov 2026). It used to be a full-width strip at the top of the
// builder with a "Go there" button to the Price approval card at the bottom; since 23 Nov 2026 the price approval block sits in the
// Status card itself (PricingDesk.tsx), and these sentences are what a salesperson reads there. Every item leaves when its state
// changes: nothing here is stored. The Quotation request card is the first thing on the page, so it needs no item.

export type NeedsYou = { key: 'price_ask' | 'price_returned' | 'price_decide'; text: string }

export const REQUEST_CARD_ID = 'q-card-request'

const OPEN: Quotation['status'][] = ['draft', 'sent', 'negotiating']

export function needsYou(base: Pick<Quotation, 'status' | 'may_edit' | 'price'>): NeedsYou[] {
  const out: NeedsYou[] = []
  const p = base.price
  if (p && OPEN.includes(base.status)) {
    if (base.may_edit && p.state === 'to_ask') out.push({ key: 'price_ask', text: 'These prices need the pricing desk’s approval before the client link can be turned on.' })
    if (base.may_edit && p.state === 'returned') out.push({ key: 'price_returned', text: 'The pricing desk sent the prices back.' })
    if (p.may_decide && p.state === 'requested') out.push({ key: 'price_decide', text: 'Prices are waiting for your approval.' })
  }
  return out
}
