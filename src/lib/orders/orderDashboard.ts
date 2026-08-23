// ── What /orders offers at a glance ───────────────────────────────────────────
//
// The Orders dashboard's quick access, as DATA rather than as JSX, so what the
// page offers — and, just as importantly, what it no longer offers — is a
// statement a test can read.
//
// THE WORKFLOW THIS FOLLOWS
//
//     PI upload → PI Draft → submit for review → finance/payment conditions
//     → management approval → Confirmed Order
//
// and the dashboard is that sequence, in order: upload, drafts, the review
// queue, confirmed Orders, then the money. Nothing here is a step in the retired
// Order Request workflow, and nothing links into one — the primary action is
// Upload PI, because an Order comes into existence at approval and a control
// promising one earlier would be describing a step that no longer exists.
//
// EVERY FIGURE IS THE DATABASE'S. Each count below is a `head: true` exact count
// under the reader's own RLS, so a card can never show a number for records the
// reader may not open, and a list on the page is never used to derive one — a
// derived figure would silently become a client-side aggregate the day the list
// gains a limit.
//
// A COUNT NOBODY MAY SEE IS NOT ZERO. Finance counts are undefined for a reader
// without Finance sight, and the card is not drawn at all. A "0" there would
// read as "nothing is waiting" when it actually means "you cannot see Finance",
// which is the confusion the old Unlinked Payments card made and this replaces.

import type { OrdersCapabilities } from '@/lib/permissions/orders'
import type { FinanceCapabilities } from '@/lib/permissions/finance'

/** The importer. The one way a new Order begins. */
export const UPLOAD_PI_PATH = '/orders/import'

/** Every count the dashboard draws. `undefined` means "not readable by you". */
export type OrderDashboardCounts = {
  /** PI Drafts this reader can see, in the working statuses. */
  piDrafts: number | undefined
  /** Submitted PIs waiting on a reviewer. Only meaningful to a reviewer. */
  reviewQueue: number | undefined
  /** running + on_hold + ready_for_dispatch. */
  activeOrders: number | undefined
  /** Confirmed Orders past their due date and not yet dispatched. */
  overdueOrders: number | undefined
  /** Payments recorded but not yet verified by Finance. */
  awaitingVerification: number | undefined
  /** Payments with a positive unallocated balance. */
  availableToAllocate: number | undefined
}

export const NO_ORDER_DASHBOARD_COUNTS: OrderDashboardCounts = {
  piDrafts: undefined,
  reviewQueue: undefined,
  activeOrders: undefined,
  overdueOrders: undefined,
  awaitingVerification: undefined,
  availableToAllocate: undefined,
}

export type DashboardTone = 'neutral' | 'attention' | 'money'

export type OrderDashboardCard = {
  key: string
  label: string
  /** The count, or null while it is still loading. */
  value: number | null
  /** One short line under the figure. Never a paragraph. */
  sub: string
  href: string
  tone: DashboardTone
}

/**
 * Whether a reader may follow a link into Finance at all.
 *
 * Module entry, not a role. A card drawn for somebody who cannot open Finance
 * would be a link to a page that refuses them, which is worse than an absent
 * card — and the destination re-derives this for itself in any case, so hiding
 * it grants nothing and showing it protects nobody.
 */
export function canSeeFinanceCards(finance: FinanceCapabilities): boolean {
  return finance.canAccessFinanceModule
}

/**
 * The dashboard's cards, in the order the workflow runs.
 *
 * `loading` is expressed as a null VALUE rather than as an absent card, so the
 * grid does not reflow as counts land. An absent card means "this reader is not
 * offered this", which is a different statement and must not flicker.
 */
export function orderDashboardCards(input: {
  counts: OrderDashboardCounts
  orders: OrdersCapabilities
  finance: FinanceCapabilities
}): OrderDashboardCard[] {
  const { counts, orders, finance } = input
  const cards: OrderDashboardCard[] = []

  // ── The pre-approval workflow ──
  cards.push({
    key: 'pi_drafts',
    label: 'PI Drafts',
    value: counts.piDrafts ?? null,
    sub: 'Awaiting approval',
    href: '/orders/drafts',
    tone: 'neutral',
  })

  // The review queue is a SECTION of PI Drafts, not a second screen, so this
  // card lands there. Offered only to a holder of orders.approve_order: to
  // anybody else the number is meaningless, because nothing is waiting on them.
  if (orders.canApproveOrderSubmission) {
    cards.push({
      key: 'review_queue',
      label: 'Review Queue',
      value: counts.reviewQueue ?? null,
      sub: 'Submitted, waiting on you',
      href: '/orders/drafts',
      tone: (counts.reviewQueue ?? 0) > 0 ? 'attention' : 'neutral',
    })
  }

  // ── Confirmed Orders ──
  cards.push({
    key: 'active_orders',
    label: 'Active Orders',
    value: counts.activeOrders ?? null,
    sub: 'Running, on hold, ready',
    href: '/orders/all',
    tone: 'neutral',
  })

  cards.push({
    key: 'overdue_orders',
    label: 'Overdue',
    value: counts.overdueOrders ?? null,
    sub: 'Past due date',
    href: '/orders/all',
    tone: (counts.overdueOrders ?? 0) > 0 ? 'attention' : 'neutral',
  })

  // ── The money ──
  //
  // Three cards, all of them links into Finance rather than a second Finance
  // page rebuilt here. The classification behind them is the canonical one
  // (src/lib/finance/paymentClassification.ts), so a card and the list it opens
  // are the same query shape and cannot disagree about what they are counting.
  if (canSeeFinanceCards(finance)) {
    cards.push({
      key: 'payments',
      label: 'Payments',
      value: null,
      sub: 'Orders, PI Drafts, available',
      href: '/finance/received?view=all',
      tone: 'money',
    })

    // Verification is the OTHER axis. Money awaiting it is real and already
    // classified, but it is not yet verified money and the two must never be
    // added together — which is why it has its own card rather than a share of
    // one.
    if (finance.canApprovePayment || finance.canViewAllFinance) {
      cards.push({
        key: 'awaiting_verification',
        label: 'Awaiting Verification',
        value: counts.awaitingVerification ?? null,
        sub: 'Recorded, not yet verified',
        href: '/finance?tab=pending',
        tone: (counts.awaitingVerification ?? 0) > 0 ? 'attention' : 'money',
      })
    }

    // OFFERED ONLY WHERE THE BALANCE CAN BE TRUSTED. The projection computes it
    // as the caller, so a reader without company-wide Finance sight gets a
    // withheld (null) balance on payments they did not submit — and a count over
    // those would understate. finance.allocate is the authority that makes this
    // card actionable at all, and view_all is what makes the figure complete.
    if (finance.canAllocatePayment && finance.canViewAllFinance) {
      cards.push({
        key: 'available_to_allocate',
        label: 'Available Funds',
        value: counts.availableToAllocate ?? null,
        sub: 'Needs allocating',
        href: '/finance/received?view=available',
        tone: (counts.availableToAllocate ?? 0) > 0 ? 'attention' : 'money',
      })
    }
  }

  return cards
}

/**
 * The one control that starts a new Order, and its copy.
 *
 * "Upload PI", never "New Order": what the control does is upload one document.
 * An Order comes into existence at approval, with a number, and a button
 * promising one here would describe a step this action cannot reach.
 */
export const NEW_ORDER_ACTION = {
  label: 'Upload PI',
  href: UPLOAD_PI_PATH,
  title: 'Upload the PI to start a new order',
} as const

/**
 * The page's subtitle.
 *
 * Says what the page is FOR now that the request queue is gone. The old copy —
 * "Running orders and operational overview" — described a dashboard whose
 * neighbours were a request list and a conversion queue.
 */
export const ORDER_DASHBOARD_SUBTITLE =
  'PI Drafts, confirmed Orders and the money against them.'
