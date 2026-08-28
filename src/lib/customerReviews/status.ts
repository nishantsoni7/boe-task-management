import type { CustomerReviewRequest, CustomerReviewStatus } from './types'
import { containsSteeringLanguage } from './invitation'

// THE TRANSITION TABLE, and the prerequisites that guard the one transition
// that matters.
//
// This file is the browser's copy. The DECIDING copy is
// transition_customer_review_request() in
// supabase/migrations/20261017000000_customer_review_outreach.sql, which holds
// the identical table and re-checks it on every call. They are written to match
// deliberately: the UI must never offer a button whose RPC will refuse it, and
// the RPC must never accept a move the UI would not have offered.
//
// The rule this file exists to state: a status is a claim about something that
// happened in the real world, and every claim here is made by a person. Nothing
// below infers a status from an event. In particular there is no transition
// FROM "the employee opened WhatsApp" TO 'sent' — opening a link is not
// evidence that a message was sent, and the two are recorded separately for
// exactly that reason.

/** Every legal move, by current status. An absent key is a terminal state. */
export const CUSTOMER_REVIEW_TRANSITIONS: Readonly<
  Record<CustomerReviewStatus, readonly CustomerReviewStatus[]>
> = {
  draft:              ['ready_to_send', 'cancelled'],
  // Back to draft is how an employee reopens a request to correct it, and it is
  // the only backwards move in the module. Everything after 'sent' describes
  // something that already reached a customer.
  ready_to_send:      ['draft', 'sent', 'cancelled'],
  // ONE PATH THROUGH THE MIDDLE. sent → verified used to exist and was wrong:
  // verification means "somebody checked that this customer published a
  // review", and a request in 'sent' is one where nothing has come back at all,
  // so that edge let a verifier jump from "we sent a message" to "the review is
  // confirmed" with no record of a response in between. The lifecycle is now
  // linear — sent → customer_responded → verified → closed — and recording a
  // published review URL is what moves a sent request along it (see
  // record_customer_review_evidence in 20261017000000), because a published
  // review IS a response. That move never verifies anything.
  sent:               ['customer_responded', 'cancelled'],
  customer_responded: ['verified', 'cancelled'],
  verified:           ['closed'],
  // Terminal. A closed request is a finished record; a cancelled one was
  // abandoned before anybody verified it. Re-opening either would mean
  // rewriting history rather than correcting a plan.
  closed:             [],
  cancelled:          [],
}

export function canTransition(
  from: CustomerReviewStatus,
  to: CustomerReviewStatus,
): boolean {
  return (CUSTOMER_REVIEW_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * The two transitions that need `customer_review_requests.verify`.
 *
 * Named as a set rather than checked inline so the UI, the capability
 * derivation and the tests all read one list. Everything else in the module
 * belongs to the employee who did the outreach.
 */
export const VERIFIER_ONLY_TRANSITIONS: ReadonlySet<CustomerReviewStatus> =
  new Set<CustomerReviewStatus>(['verified', 'closed'])

export function transitionRequiresVerify(to: CustomerReviewStatus): boolean {
  return VERIFIER_ONLY_TRANSITIONS.has(to)
}

/** A request that can no longer move at all. */
export function isTerminalStatus(status: CustomerReviewStatus): boolean {
  return (CUSTOMER_REVIEW_TRANSITIONS[status] ?? []).length === 0
}

/** Statuses whose content is still editable. Mirrors can_edit_customer_review_request(). */
export const EDITABLE_STATUSES: ReadonlySet<CustomerReviewStatus> =
  new Set<CustomerReviewStatus>(['draft', 'ready_to_send'])

export function isEditableStatus(status: CustomerReviewStatus): boolean {
  return EDITABLE_STATUSES.has(status)
}

// ─── Ready-to-Send prerequisites ──────────────────────────────────────────────

/**
 * The fields a request needs before it may leave 'draft', as sentences an
 * employee can act on.
 *
 * Mirrors assert_customer_review_ready() in the migration, one check for one
 * check, in the same order. An empty array means the request is ready.
 *
 * SAVING A DRAFT IS LENIENT AND THIS IS NOT: a half-filled draft is a normal
 * thing to have, and a half-filled invitation is not a thing to send.
 *
 * `internal_note` is deliberately absent. It is context for BOE, it never
 * reaches the customer, and requiring it would be requiring paperwork rather
 * than requiring correctness.
 *
 * A PROJECT PHOTOGRAPH IS REQUIRED, by product decision. It anchors the request
 * to work BOE actually did for this customer. Note what that does NOT mean:
 * photographs are never attached to the WhatsApp message — wa.me carries text
 * only — so they are a private project reference stored with the request, and
 * the sharing confirmation is what covers the employee sending them by hand.
 */
export function readyToSendBlockers(
  request: Pick<
    CustomerReviewRequest,
    | 'genuine_customer_confirmed'
    | 'customer_name'
    | 'whatsapp_number'
    | 'interaction_type'
    | 'review_url'
    | 'image_permission_confirmed'
    | 'greeting_name'
    | 'project_reference'
  >,
  projectPhotoCount: number,
): string[] {
  const blockers: string[] = []

  if (request.genuine_customer_confirmed !== true) {
    blockers.push('Confirm this is a genuine BOE customer or project contact.')
  }
  if (!request.customer_name || request.customer_name.trim() === '') {
    blockers.push('Add the customer or project name.')
  }
  if (!request.whatsapp_number) {
    blockers.push('Add a valid WhatsApp number.')
  }
  if (!request.interaction_type) {
    blockers.push('Choose the interaction type.')
  }
  if (!request.review_url) {
    blockers.push('Add the review destination (an https link).')
  }
  // The invitation must still be a neutral ask. The locked sentences cannot be
  // removed, so the only way to steer one is through the two editable
  // fragments — which is exactly what this refuses.
  if (containsSteeringLanguage(request.greeting_name)) {
    blockers.push('Remove the rating request from the greeting — the customer chooses the rating.')
  }
  if (containsSteeringLanguage(request.project_reference)) {
    blockers.push('Remove the rating request from the project reference — the customer chooses the rating.')
  }
  // The photograph first, then the permission to share it — and the second only
  // once there is something to share. Both must clear before a request is
  // ready, so the end state is the same either way; what the ordering avoids is
  // asking somebody to confirm permission for photographs that do not exist
  // yet. assert_customer_review_ready() raises in this same order for the same
  // reason.
  if (projectPhotoCount === 0) {
    blockers.push('Attach at least one real photograph of this customer’s project.')
  } else if (request.image_permission_confirmed !== true) {
    blockers.push('Confirm BOE has permission to share these photographs.')
  }

  return blockers
}

// ─── What the screen offers ───────────────────────────────────────────────────

export type CustomerReviewAction = {
  to: CustomerReviewStatus
  /** The button's words. Plain operational language, not status names. */
  label: string
  /** Whether this action needs a short note or URL before it can be taken. */
  prompt?: 'verification_note' | 'cancel_reason' | 'review_link'
  /** Rendered as the destructive option. */
  destructive?: boolean
}

const ACTION_LABELS: Record<CustomerReviewStatus, CustomerReviewAction> = {
  ready_to_send:      { to: 'ready_to_send',      label: 'Mark Ready to Send' },
  draft:              { to: 'draft',              label: 'Reopen for Editing' },
  // The wording carries the whole point: the employee is confirming what THEY
  // did, not reporting what WhatsApp did.
  sent:               { to: 'sent',               label: 'I sent this invitation' },
  customer_responded: { to: 'customer_responded', label: 'Customer replied', prompt: 'review_link' },
  verified:           { to: 'verified',           label: 'Verify', prompt: 'verification_note' },
  closed:             { to: 'closed',             label: 'Close request' },
  cancelled:          { to: 'cancelled',          label: 'Cancel request', prompt: 'cancel_reason', destructive: true },
}

/**
 * The moves this person may make on this request, in the order a screen should
 * offer them.
 *
 * Three separate gates, and all three have to pass:
 *   1. the transition table above,
 *   2. `verify` for the two verifier-only moves,
 *   3. ownership (or admin) for everything else — a verifier does not run
 *      somebody else's outreach for them.
 *
 * This is the UI half of the boundary. The RPC re-checks all three, and the RPC
 * is what actually refuses.
 */
export function availableActions(
  request: Pick<CustomerReviewRequest, 'status' | 'created_by'>,
  viewer: { userId: string | null; isAdmin: boolean; canUse: boolean; canVerify: boolean },
): CustomerReviewAction[] {
  if (!viewer.userId) return []

  const isOwner = request.created_by === viewer.userId

  return (CUSTOMER_REVIEW_TRANSITIONS[request.status] ?? [])
    .filter(to => {
      if (transitionRequiresVerify(to)) return viewer.isAdmin || viewer.canVerify
      return viewer.isAdmin || (isOwner && viewer.canUse)
    })
    .map(to => ACTION_LABELS[to])
}
