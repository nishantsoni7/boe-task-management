// PAYMENTS STILL ON THEIR WAY, AND WHO EACH ONE IS PENDING FROM (owner, 2026-11-11).
//
// A PNB, Paytm or Canara payment is carried by people until a company cash
// custodian has it (src/lib/finance/cashJourney.ts). The For you column used to
// say "Dhruv holds ₹21,91,600", one card per person, with Review. The owner has
// nothing to do for money that is in somebody else's hands, so each payment now
// gets one card that says whose move it is and for how long: "Pending from Dhruv
// · 3 days". The person it is pending from already has Accept / Hand over cards
// of their own (AttentionPanel.tsx); this card is only the news for everyone
// else. Pure words, nothing decides anything.
//
// Pure, so the test runner can execute it.

import { formatINR } from '@/lib/currency'
import { waitingAge, type CashPayment } from '@/lib/finance/cashJourney'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { itemKeys } from '@/lib/modules/forYouSnooze'

export type PendingFrom = {
  /** Clear all's key: the payment AND whose move it is, so a hand-on is new news. */
  key: string
  label: string
  brief: string
  detail: string
  /** How long it has waited on that person. Oldest first. */
  hours: number
  /** The holder, for the link to Cash journeys. */
  holderId: string | null
  /** The company cash custodian may record receiving it: the only action a card offers. */
  canReceive: boolean
}

const hoursSince = (iso: string | null | undefined, now: number): number | null => {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isFinite(at) ? Math.max(0, (now - at) / 3_600_000) : null
}

export function pendingFromCard(p: CashPayment, now = Date.now()): PendingFrom {
  const h = p.openHandover
  const holder = p.holderName ?? 'an unknown holder'

  // Handed over and not accepted: the move is the receiver's. A handover the
  // receiver marked not received leaves the cash with the giver.
  const who = !h ? holder : h.status === 'disputed' ? h.giverName : h.recipientName
  const hours = (h ? hoursSince(h.createdAt, now) : null) ?? p.ageHours
  const detail = !h
    ? `${holder} holds it, not handed on`
    : h.status === 'disputed'
      ? `${h.recipientName} marked it not received`
      : `${h.giverName} handed it to ${h.recipientName}, not accepted yet`

  return {
    key: itemKeys.work('pending-from', p.paymentId, h ? `${h.id}:${h.status}` : `held:${p.holderId ?? ''}`),
    label: `Pending from ${who} · ${waitingAge(hours)}`,
    brief: `${formatINR(p.amount)} · ${customerDisplayName(p.clientName)}`,
    detail,
    hours,
    holderId: p.holderId,
    canReceive: p.canReceive,
  }
}

/** Oldest waiting first, like Finance's own list. */
export function pendingFromCards(payments: readonly CashPayment[], now = Date.now()): PendingFrom[] {
  return payments.map(p => pendingFromCard(p, now)).sort((a, b) => b.hours - a.hours)
}
