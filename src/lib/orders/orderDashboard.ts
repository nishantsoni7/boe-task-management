// ── What /orders offers besides its action lists ──────────────────────────────
//
// The Orders dashboard's QUEUE LINKS, as DATA rather than as JSX, so what the
// page offers — and, just as importantly, what it no longer offers — is a
// statement a test can read.
//
// THE DASHBOARD IS NOW LED BY WHAT NEEDS INTERVENTION (orderDashboardSummary.ts:
// alignment, advance, due date, fabric and finish, PANIC MODE, then revenue).
// What remains here are only the queues somebody is asked to WORK — PI Drafts,
// and the operations handoff — each a link to the page that
// resolves it. The running-orders list, Active Orders, the Review Queue card and the four
// money cards (Payments, Awaiting Verification, Available Funds, Running Value)
// are gone
// from this page: none of them told anyone what to do next, and each still has
// its own home in Orders and Finance.
//
// EVERY FIGURE IS THE DATABASE'S. Each count below is a `head: true` exact count
// under the reader's own RLS, so a card can never show a number for records the
// reader may not open.
//
// A COUNT NOBODY MAY SEE IS NOT ZERO. An absent count draws no card at all.

import type { OrdersCapabilities } from '@/lib/permissions/orders'
import {
  AWAITING_OPERATIONS_REVIEW_LABEL,
  AWAITING_OPERATIONS_REVIEW_SUB,
  OPERATIONS_REVIEW_QUEUE_HREF,
} from './operationsHandoff'

/** The importer. The one way a new Order begins. */
export const UPLOAD_PI_PATH = '/orders/import'

/** Every count the dashboard draws. `undefined` means "not readable by you". */
export type OrderDashboardCounts = {
  /** PI Drafts this reader can see, in the working statuses. */
  piDrafts: number | undefined
  /**
   * PI versions awaiting THIS reader's operations acceptance (20261229000000):
   * live handoffs assigned to them, undecided. Zero for everybody who is not
   * the assigned reviewer, which is why the card is offered only above zero.
   */
  operationsReview: number | undefined
  /** Live, undecided handoffs with NO reviewer assigned — an admin's problem. */
  operationsUnassigned: number | undefined
  /**
   * Live handoffs FLAGGED for clarification that this reader can see: work
   * needing an answer from the approver, then a fresh decision — visible until
   * it is resolved, whoever it is addressed to.
   */
  operationsFlagged: number | undefined
}

export const NO_ORDER_DASHBOARD_COUNTS: OrderDashboardCounts = {
  piDrafts: undefined,
  operationsReview: undefined,
  operationsUnassigned: undefined,
  operationsFlagged: undefined,
}

export type DashboardTone = 'neutral' | 'attention'

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
 * The queue links, in the order the workflow runs.
 *
 * `loading` is expressed as a null VALUE rather than as an absent card, so the
 * grid does not reflow as counts land. An absent card means "this reader is not
 * offered this", which is a different statement and must not flicker.
 */
export function orderDashboardCards(input: {
  counts: OrderDashboardCounts
  orders: OrdersCapabilities
}): OrderDashboardCard[] {
  const { counts } = input
  const cards: OrderDashboardCard[] = []

  // ── The pre-approval workflow ──
  //
  // OFFERED ONLY WHEN SOMETHING IS WAITING, like the handoff below: a permanent
  // "0 awaiting approval" is not a queue anybody can work, and PI Drafts stays one
  // click away in the sidebar. An unknown count draws nothing either — never a
  // dash beside a number that was not read.
  if ((counts.piDrafts ?? 0) > 0) {
    cards.push({
      key: 'pi_drafts',
      label: 'PI Drafts',
      value: counts.piDrafts ?? null,
      sub: 'Awaiting approval',
      href: '/orders/drafts',
      tone: 'neutral',
    })
  }

  // ── The operations handoff (20261229000000) ──
  //
  // OFFERED ONLY WHEN SOMETHING IS WAITING. To the assigned operations
  // reviewer the count is the PI versions awaiting their acceptance; to
  // anybody else it is zero and the card is meaningless — except for the
  // versions NOBODY is assigned to, which need an administrator, so those are
  // counted for everyone who can see the Orders they belong to. Never drawn
  // at zero: a permanent "0 awaiting you" would be a card about nothing.
  const awaitingMe = counts.operationsReview ?? 0
  const unassigned = counts.operationsUnassigned ?? 0
  const flagged = counts.operationsFlagged ?? 0
  if (awaitingMe > 0 || unassigned > 0 || flagged > 0) {
    // The headline is what waits on THIS reader; the subtitle names the two
    // things that wait on an administrator: nobody assigned, and a version the
    // reviewer could not accept (flagged), which stays here until resolved.
    const admin = [
      unassigned > 0 ? `${unassigned} with no reviewer assigned` : null,
      flagged > 0 ? `${flagged} flagged: clarification needed` : null,
    ].filter(Boolean).join(' · ')
    cards.push({
      key: 'operations_review',
      label: AWAITING_OPERATIONS_REVIEW_LABEL,
      value: awaitingMe > 0 ? awaitingMe : unassigned + flagged,
      sub: awaitingMe > 0 ? (admin ? `${AWAITING_OPERATIONS_REVIEW_SUB} · ${admin}` : AWAITING_OPERATIONS_REVIEW_SUB) : admin,
      href: OPERATIONS_REVIEW_QUEUE_HREF,
      tone: 'attention',
    })
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

