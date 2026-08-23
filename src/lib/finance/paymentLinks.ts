// ── Where one payment's money actually points ─────────────────────────────────
//
// A payment row has to offer a door to every Order and PI Draft its money went
// to — and to NOTHING ELSE. That second half is the whole difficulty:
//
//   * a payment may be split across several Orders and PIs at once, so "the
//     linked record" is a list, not a field;
//   * the reader may be entitled to open some of those records and not others,
//     and the ones they may not open must not be named, numbered, counted
//     separately or linked;
//   * a payment with no allocations at all may still be attributed in full to
//     one Order by the canonical rule's direct-link fallback, and that Order is
//     a destination exactly as an allocated one is.
//
// HOW "MAY THIS READER OPEN IT" IS DECIDED, AND WHY IT IS NOT GUESSED
// ------------------------------------------------------------------
// By asking the database, once, for the page. The caller reads `orders` and
// `order_submissions` for the ids on screen; RLS returns the rows this reader
// may see and silently omits the rest. A target whose row came back has a name
// and a door; one that did not has NEITHER — it is reported as an unnamed
// destination of a known kind, which is what the reader is entitled to know
// (their own payment is split three ways) without learning whose business the
// third way is.
//
// THAT IS ALSO WHY THE LABEL IS THE PERMISSION SIGNAL. There is no second
// capability check here and there must not be: a per-record RLS answer is
// strictly more accurate than a module-entry capability, and re-deriving
// openability from `orders.view` would offer a door into a record RLS refuses.
// Module entry is still checked — a reader who cannot open Order Management at
// all is offered no doors — but it can only ever narrow this further.
//
// NOTHING HERE AUTHORIZES ANYTHING. Every href reaches a page that re-reads its
// record under the caller's own RLS. This decides what to DRAW.

import { orderDetailHref, piSubmissionHref } from './crossModuleLinks'
import type { AllocationTarget, PaymentAllocationSummary } from './paymentAllocations'

export type PaymentLinkKind = 'order' | 'submission'

export type PaymentLink = {
  /** Stable per row. The allocation id, or 'direct' for the legacy linkage. */
  key: string
  kind: PaymentLinkKind
  /**
   * What the reader sees. The record's own number when they may read it;
   * otherwise a bare kind name — never an id, and never a client name.
   */
  label: string
  /** True when `label` is the record's real number rather than a placeholder. */
  named: boolean
  /** This target's share of the payment, exact. Empty for the direct linkage. */
  amount: string
  /** Where to go, or null when this reader may not open the record. */
  href: string | null
}

/** The placeholder for a destination this reader may not open. */
export const UNNAMED_ORDER_LABEL = 'An Order'
export const UNNAMED_PI_LABEL = 'A PI Draft'

export function unnamedLabel(kind: PaymentLinkKind): string {
  return kind === 'order' ? UNNAMED_ORDER_LABEL : UNNAMED_PI_LABEL
}

export type PaymentLinksInput = {
  /** The live allocations this reader can see, from summarizePaymentAllocations. */
  summary: PaymentAllocationSummary
  /**
   * The payment's own direct linkage, when it has one and no active allocation
   * overrides it. Null otherwise — including when allocations exist, because
   * the canonical rule says the link then contributes NOTHING.
   */
  directOrder: { id: string; number: string | null } | null
  /** Display numbers by target id, for the records this reader could read. */
  labels: ReadonlyMap<string, string>
  /** Module entry for Order Management. A drawing gate, never authorization. */
  canOpenOrders: boolean
}

/**
 * Every destination one payment points at, in the order a reader would read
 * them: Orders first, then PI Drafts, each in allocation order.
 *
 * THE DIRECT LINKAGE IS INCLUDED ONLY WHEN NOTHING IS ALLOCATED, which is rule
 * 2 of the canonical attribution rule and not a separate decision made here. A
 * payment linked to Order X and allocated to Order Y points at Y — showing X as
 * well would name a destination that is attributed nothing, which is exactly the
 * ₹14L double-count PR #49 removed from the figures.
 */
export function paymentLinks(input: PaymentLinksInput): PaymentLink[] {
  const { summary, directOrder, labels, canOpenOrders } = input

  const fromTarget = (target: AllocationTarget): PaymentLink => {
    const name = labels.get(target.targetId) ?? target.label ?? null
    const named = typeof name === 'string' && name.trim() !== ''
    return {
      key: target.allocationId,
      kind: target.kind,
      label: named ? (name as string) : unnamedLabel(target.kind),
      named,
      amount: target.amount,
      // A DOOR ONLY WHERE BOTH HOLD: the reader can open the module at all, and
      // RLS actually returned this record. The second is the real gate; the
      // first only ever narrows it further.
      href: named && canOpenOrders
        ? (target.kind === 'order' ? orderDetailHref(target.targetId) : piSubmissionHref(target.targetId))
        : null,
    }
  }

  if (summary.targets.length > 0) {
    const orders = summary.targets.filter(t => t.kind === 'order').map(fromTarget)
    const submissions = summary.targets.filter(t => t.kind === 'submission').map(fromTarget)
    return [...orders, ...submissions]
  }

  if (directOrder) {
    const name = labels.get(directOrder.id) ?? directOrder.number ?? null
    const named = typeof name === 'string' && name.trim() !== ''
    return [{
      key: 'direct',
      kind: 'order',
      label: named ? (name as string) : UNNAMED_ORDER_LABEL,
      named,
      // The whole payment, by rule 2 — but the figure lives on the row, not
      // here, so this does not restate it.
      amount: '',
      href: named && canOpenOrders ? orderDetailHref(directOrder.id) : null,
    }]
  }

  return []
}

/**
 * The direct linkage to pass in, derived from a projection row.
 *
 * NULL AS SOON AS ANYTHING IS ALLOCATED. `allocated_total` is the projection's
 * own sum of active allocations; when it is above zero the allocations are
 * authoritative and the link points nowhere. This is the same branch
 * classifyPayment takes, expressed once so a row cannot show a destination its
 * own figures attribute nothing to.
 */
export function directOrderOf(row: {
  order_id: string | null
  order_number: string | null
  allocated_total?: string | number | null
}): { id: string; number: string | null } | null {
  if (!row.order_id) return null
  const allocated = Number(row.allocated_total ?? 0)
  if (Number.isFinite(allocated) && allocated > 0) return null
  return { id: row.order_id, number: row.order_number }
}

/**
 * How many destinations this reader is being shown, and how many of them they
 * may open.
 *
 * `hidden` is deliberately reported as a NUMBER and not as a list: a reader
 * whose payment is split with somebody else's Order may know that it is split —
 * it is their money — without learning which Order, whose client it is, or what
 * it is worth to them. That is the same boundary the projection draws by
 * exposing how much and to what kind, never to which record.
 */
export function linkCounts(links: readonly PaymentLink[]): {
  total: number
  openable: number
  hidden: number
} {
  const openable = links.filter(l => l.href !== null).length
  const named = links.filter(l => l.named).length
  return { total: links.length, openable, hidden: links.length - named }
}
