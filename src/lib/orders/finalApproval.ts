// Finance verification and final PI approval, as rules and as words.
//
// WHAT THIS PHASE IS
// ------------------
// The last two decisions taken on a PI submission, and the only ones that bring
// a Confirmed Order into existence:
//
//   FINANCE VERIFICATION  a finance authority signs off that the commercial
//                         figures and the advance terms on this PI are right.
//                         It approves nothing, creates nothing, and — the point
//                         worth repeating everywhere it appears — RECORDS NO
//                         PAYMENT. No receipt, no request, no reconciliation.
//   FINAL APPROVAL        a PI reviewer approves the verified PI. One Order is
//                         created, an official four-digit number is allocated
//                         to it, and the PI becomes read-only forever.
//
// TWO AUTHORITIES, ON PURPOSE
// ---------------------------
// They are separate permissions and neither implies the other:
//
//   finance.approve (with Finance module entry)  may verify, may NOT approve
//   orders.approve_order                         may approve, may NOT verify
//
// An active admin holds both, exactly as can_verify_pi_finance() and
// actor_has_module_permission() have it in the database. Somebody holding only
// one of the two sees only one of the two controls, and the RPC behind each
// re-derives the same rule server-side.
//
// NONE OF THIS IS AUTHORIZATION. Every rule below decides what to RENDER and
// what to send. The database decides what may HAPPEN, and decides it again for
// every call, under a row lock, on the values it holds rather than the ones a
// browser sent:
//
//   verify_pi_finance_check    can_verify_pi_finance(), a SUBMITTED record, no
//                              deletion reservation. Idempotent.
//   approve_order_submission   orders.approve_order, a SUBMITTED record, a
//                              CURRENT finance verification, FINANCE-VERIFIED
//                              PAYMENT of at least 40% of the grand total or an
//                              APPROVED reduced-payment exception, no blocking
//                              issues, the workbook and every product image
//                              still in storage, no deletion reservation, and no
//                              Order already linked. It also MOVES the PI's
//                              active allocations onto the new Order.
//
// So a hidden control is a courtesy and a defeated one gets a refusal from
// Postgres.

import {
  PAYMENT_ADMIN_APPROVAL_REQUIRED,
  PAYMENT_AWAITING_VERIFICATION,
  PAYMENT_EXCEPTION_PENDING,
  PAYMENT_EXCEPTION_REJECTED,
  PAYMENT_EXCEPTION_STALE,
  shortfallSentence,
  type PaymentPosition,
} from './paymentGate'

// ── The persisted state, as the page reads it ─────────────────────────────────

/** The finance-verification columns of one order_submissions row. */
export type PersistedFinanceVerification = {
  finance_verified_by: string | null
  finance_verified_at: string | null
  finance_verified_submission_at: string | null
}

/** Named explicitly so `select('*')` is never needed. */
export const PI_FINANCE_COLUMNS: readonly string[] = [
  'finance_verified_by',
  'finance_verified_at',
  'finance_verified_submission_at',
]

/** The approval columns and the Order link. `approved_by`/`approved_at` already
 *  existed; `order_id` was reserved by 20260908000000 and is written for the
 *  first time by this phase. */
export const PI_APPROVAL_COLUMNS: readonly string[] = [
  'approved_by',
  'approved_at',
  'order_id',
]

// ── The staleness rule, in the browser ────────────────────────────────────────

/**
 * Whether a finance verification is CURRENT for the submission on screen.
 *
 * THE MIRROR OF public.order_submission_finance_verified(timestamptz,
 * timestamptz, timestamptz), and it must stay one:
 *
 *   current  ⇔  a verification exists AND it names THIS submitted_at
 *
 * WHY A TIMESTAMP COMPARISON AND NOT A BOOLEAN. A PI that is returned and
 * resubmitted takes a NEW submitted_at, so a sign-off made against the previous
 * version stops matching. The database clears the columns outright on any move
 * away from 'submitted' as well, so in practice this is a second, independent
 * reason a stale verification reads as absent — which is what makes it
 * impossible to present one as current by writing the columns some other way.
 *
 * Compared as INSTANTS rather than as strings: PostgREST may render the same
 * moment as '...+00:00' or '...Z', and a string comparison would call one
 * submission's own verification stale.
 */
export function financeVerificationIsCurrent(
  verification: PersistedFinanceVerification,
  submittedAtIso: string | null,
): boolean {
  const verified = instant(verification.finance_verified_at)
  const boundTo = instant(verification.finance_verified_submission_at)
  const submitted = instant(submittedAtIso)
  if (verified === null || boundTo === null || submitted === null) return false
  return boundTo === submitted
}

/** An ISO timestamp as a number of milliseconds, or null. */
function instant(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// ── Copy: finance verification ────────────────────────────────────────────────

export const FINANCE_SECTION_LABEL = 'Finance'
export const FINANCE_PENDING_TEXT = 'Finance verification pending.'
export const VERIFY_FINANCE_BUTTON_LABEL = 'Verify Finance'
export const VERIFY_FINANCE_BUSY_LABEL = 'Verifying…'
export const VERIFY_FINANCE_DIALOG_TITLE = 'Verify finance'

/**
 * What the verifier is confirming, and what they are emphatically not.
 *
 * The second sentence is the whole reason this dialog exists rather than a bare
 * button: "verify" beside a grand total is read as "the money is in" unless the
 * screen says otherwise, and no payment record exists anywhere in this phase to
 * make that true.
 */
export const VERIFY_FINANCE_CONFIRM =
  'This confirms the commercial figures and the advance terms on this PI are correct.'
export const VERIFY_FINANCE_NOT_A_PAYMENT =
  'It does not record receipt of any payment. No payment, request or receipt is created.'

/** How a completed verification is stated. Built here so the two screens that
 *  can print it cannot word it differently. */
export function financeVerifiedLine(verifierName: string | null, at: string | null): string {
  const who = verifierName && verifierName.trim() !== '' ? verifierName.trim() : 'a colleague'
  const when = at && at.trim() !== '' ? at.trim() : 'an earlier date'
  return `Verified by ${who} · ${when}`
}

// ── What the workflow area says about finance ─────────────────────────────────

export type FinanceStatusView = {
  /** True when a CURRENT verification stands. */
  verified: boolean
  /** "Verified by X · date", or the pending sentence. */
  text: string
  /** Whether the Verify Finance control belongs on screen for this viewer. */
  canVerify: boolean
  verifierId: string | null
  verifiedAtIso: string | null
}

export type FinanceStatusInput = {
  status: string
  submittedAtIso: string | null
  verification: PersistedFinanceVerification
  /** can_verify_pi_finance(), as the browser resolved it. */
  canVerifyFinance: boolean
  /** Already formatted, or null. This module does no date work. */
  verifiedAt: string | null
  verifierName: string | null
}

/**
 * The compact finance line for the workflow panel — for EVERY viewer who can
 * read the PI, not only for the person who can act on it.
 *
 * WHY EVERYBODY SEES THE STATE. A PI waiting on somebody else's sign-off must
 * not look inert to the reviewer who is waiting, or to the employee wondering
 * why nothing has happened. Only the CONTROL is gated.
 *
 * WHY ONLY WHILE SUBMITTED AND AFTER APPROVAL. A draft has nothing to verify, a
 * returned record's figures are about to change, and a rejected one is closed.
 * On an approved record the line stays, because who signed the figures off is
 * part of the approved record's history.
 */
export function describeFinanceStatus(input: FinanceStatusInput): FinanceStatusView | null {
  if (input.status !== 'submitted' && input.status !== 'approved') return null

  const verified = input.status === 'approved'
    // An approved PI was verified by definition — the RPC refuses otherwise —
    // and its verification is deliberately NOT cleared, so the columns are read
    // straight rather than re-tested against a submitted_at that no longer moves.
    ? input.verification.finance_verified_at !== null
    : financeVerificationIsCurrent(input.verification, input.submittedAtIso)

  return {
    verified,
    text: verified
      ? financeVerifiedLine(input.verifierName, input.verifiedAt)
      : FINANCE_PENDING_TEXT,
    // Never on an approved record: there is nothing left to verify, and the
    // database refuses it.
    canVerify: !verified && input.status === 'submitted' && input.canVerifyFinance,
    verifierId: input.verification.finance_verified_by,
    verifiedAtIso: input.verification.finance_verified_at,
  }
}

// ── Copy: final approval ──────────────────────────────────────────────────────

/** The primary action. Names both halves of what it does, because it does both
 *  and a button reading only "Approve" would understate the second. */
export const APPROVE_ORDER_BUTTON_LABEL = 'Approve PI & Create Order'
export const APPROVE_ORDER_DIALOG_TITLE = 'Approve PI & Create Order'
/** The dialog's own confirm button. Shorter than the opener, because by then the
 *  reader knows which PI they are looking at. */
export const APPROVE_ORDER_CONFIRM_LABEL = 'Approve & Create Order'
export const APPROVE_ORDER_BUSY_LABEL = 'Approving…'

export const APPROVE_ORDER_FINAL_NOTE =
  'Approval is final. An official Order number will be assigned and the confirmed Order will be created.'
export const APPROVE_ORDER_NOT_A_PAYMENT =
  'This does not record receipt of any payment.'

export const APPROVE_SUMMARY_LABEL = {
  client: 'Client',
  grandTotal: 'Grand total',
  advance: 'Advance condition',
  finance: 'Finance verification',
  lines: 'Product lines',
} as const

export const FINANCE_SUMMARY_VERIFIED = 'Verified'
export const FINANCE_SUMMARY_PENDING = 'Pending'

/** How the created Order is announced. */
export const APPROVED_ORDER_HEADING = 'Order created'
export const APPROVED_ORDER_NUMBER_LABEL = 'Order number'
export const OPEN_ORDER_BUTTON_LABEL = 'Open Order'

/** Where the created Order lives. One place, so the route shape has one source. */
export function orderHref(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}`
}

// ── Eligibility: may this reviewer press it, and if not, why ──────────────────

export type ApprovalReadiness = {
  /** True when every precondition the browser can see is satisfied. */
  ready: boolean
  /**
   * The first unmet precondition, as one short sentence — or null.
   *
   * ONE REASON, NOT A LIST. A reviewer fixes them one at a time, and a stack of
   * three sentences under a disabled button reads as an error report rather than
   * as the next thing to do. The order below is the order they are resolved in.
   */
  blocker: string | null
}

export const APPROVAL_BLOCKED_BLOCKING_ISSUES =
  'This PI still has issues that must be fixed in the workbook before it can be approved.'
export const APPROVAL_BLOCKED_FINANCE =
  'Finance must verify this PI before it can be approved.'
/**
 * The payment position could not be read at all.
 *
 * FAILS CLOSED, and says why. A reviewer whose browser could not read the PI's
 * payment position must not be offered a control whose outcome nobody can
 * predict — and must not be told the payment is insufficient either, which would
 * be a claim about money nobody has checked.
 */
export const APPROVAL_BLOCKED_PAYMENT_UNKNOWN =
  'The verified payment position for this PI could not be read. Reload the page before approving.'
export const APPROVAL_BLOCKED_NO_LINES =
  'This PI has no stored product lines.'
export const APPROVAL_BLOCKED_DELETION =
  'This PI is reserved for deletion.'
/**
 * The PI is missing something an approved Order would then be missing too.
 *
 * DELIBERATELY CARRIES THE SPECIFIC LIST rather than a fixed sentence: the
 * reviewer is being asked why they cannot approve, and "something is missing"
 * is the answer that sends them hunting. piReadiness already names the whole
 * remaining distance in one line, so that line is what appears here.
 */
export const approvalBlockedIncomplete = (summary: string): string =>
  `${summary} An Order created from it would be missing the same thing.`

export type ApprovalReadinessInput = {
  status: string
  /** Whether a CURRENT finance verification stands. */
  financeVerified: boolean
  /**
   * Where this PI stands on the verified-payment gate, exactly as
   * pi_submission_payment_summary() reported it — or null when the summary could
   * not be read. NEVER re-derived here: the browser has no opinion about how
   * much money has arrived.
   */
  paymentPosition: PaymentPosition | null
  /**
   * How much MORE verified payment is needed, for the sentence. Read straight
   * off the summary, already rounded up to a payable figure by the database.
   */
  neededForStandard: string | number | null
  hasBlockingIssues: boolean
  productCount: number
  /**
   * piReadiness('submission').summary, or null when the PI is complete.
   *
   * MIRRORED, NEVER COMPUTED HERE. approve_order_submission re-derives the
   * client name and the product lines under a row lock and refuses on its own;
   * this exists so the reviewer reads the reason beside the disabled control
   * instead of discovering it by pressing the button.
   */
  incompleteSummary?: string | null
  /** order_submissions.deletion_claim_token — set while a deletion is in flight. */
  deletionClaimed: boolean
}

/**
 * The one sentence a blocked payment gate produces, for each position.
 *
 * Kept beside the readiness rule rather than in paymentGate.ts because it is
 * about APPROVAL specifically — what the reviewer looking at the disabled button
 * needs — while the position hints in paymentGate.ts speak to everybody who
 * opens the PI.
 */
export function paymentApprovalBlocker(
  position: PaymentPosition,
  neededForStandard: string | number | null,
): string | null {
  if (position === 'standard_met' || position === 'exception_approved') return null
  if (position === 'exception_pending') return PAYMENT_EXCEPTION_PENDING
  if (position === 'exception_rejected') return PAYMENT_EXCEPTION_REJECTED
  // APPROVED, BUT FOR SOMETHING ELSE. Never folded into "not enough payment":
  // that would send somebody to collect money when what is needed is for the
  // approver to look at the terms that changed.
  if (position === 'exception_stale') return PAYMENT_EXCEPTION_STALE

  const shortfall = shortfallSentence(neededForStandard)
  const lead = position === 'verification_pending'
    ? PAYMENT_AWAITING_VERIFICATION
    : null

  // The shortfall first when there is one, because it is the figure somebody
  // acts on; then who can decide instead. Unverified money is NAMED so nobody
  // concludes the payment they entered this morning was lost.
  return [lead, shortfall, PAYMENT_ADMIN_APPROVAL_REQUIRED]
    .filter((part): part is string => part !== null)
    .join(' ')
}

/**
 * Whether the approval control may be pressed, and the one sentence explaining
 * it when it may not.
 *
 * A DISABLED BUTTON WITH A REASON, and not a hidden one. Every blocker here is
 * ACTIONABLE and belongs to somebody: finance has not signed off, the advance is
 * waiting on a decision, the workbook still has issues. A reviewer who cannot
 * see the control cannot see what is holding it up either, and would ask.
 *
 * That is the opposite of the inert "Approve" this screen used to carry, which
 * explained only that a later phase would bring approval — a promise, not a
 * task, and one people read as the current action.
 *
 * MIRRORS approve_order_submission()'s own order of checks, so the sentence a
 * reviewer reads is the refusal they would have got.
 */
export function describeApprovalReadiness(input: ApprovalReadinessInput): ApprovalReadiness {
  const blocked = (blocker: string): ApprovalReadiness => ({ ready: false, blocker })

  if (input.status !== 'submitted') return { ready: false, blocker: null }
  if (input.deletionClaimed) return blocked(APPROVAL_BLOCKED_DELETION)
  if (!input.financeVerified) return blocked(APPROVAL_BLOCKED_FINANCE)

  // THE PAYMENT GATE, where the advance declaration used to be.
  //
  // A DECLARED ADVANCE IS NOT A PAYMENT, and from Phase 3 it decides nothing:
  // the database sums FINANCE-VERIFIED allocations at the instant of approval and
  // compares them with the exact 40% of the grand total. This mirrors that answer
  // so the sentence under a disabled button is the refusal the reviewer would
  // have got — it never computes it.
  if (input.paymentPosition === null) return blocked(APPROVAL_BLOCKED_PAYMENT_UNKNOWN)
  const paymentBlocker = paymentApprovalBlocker(input.paymentPosition, input.neededForStandard)
  if (paymentBlocker !== null) return blocked(paymentBlocker)

  if (input.hasBlockingIssues) return blocked(APPROVAL_BLOCKED_BLOCKING_ISSUES)
  if (input.productCount === 0) return blocked(APPROVAL_BLOCKED_NO_LINES)

  // LAST, and on purpose. Everything above is somebody else's outstanding task
  // — finance has not signed off, the money has not arrived, the workbook has
  // problems — and each is a bigger obstacle than a missing field. Reporting an
  // absent client name ahead of an unverified PI would put the smallest thing
  // first and read as though it were the only one.
  const incomplete = input.incompleteSummary ?? null
  if (incomplete !== null) return blocked(approvalBlockedIncomplete(incomplete))

  return { ready: true, blocker: null }
}

// ── The result the RPC hands back ─────────────────────────────────────────────

export type ApprovalOutcome = {
  orderId: string
  /** The official four-digit number, exactly as the allocator produced it. */
  displayNumber: string
  /** True when this call found the PI already approved rather than approving it. */
  alreadyApproved: boolean
}

/**
 * The RPC's JSON, as something the screen can show — or null.
 *
 * NOTHING IS DERIVED, INFERRED OR DEFAULTED. The number is whatever the database
 * returned and is never reconstructed, padded or renumbered here; a response
 * missing either field yields null and the page re-reads the record instead of
 * announcing something it made up. That is the same rule the whole numbering
 * design rests on: the browser never has an opinion about an Order number.
 */
export function readApprovalOutcome(value: unknown): ApprovalOutcome | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>

  const orderId = typeof row.order_id === 'string' ? row.order_id.trim() : ''
  const displayNumber = typeof row.display_number === 'string' ? row.display_number.trim() : ''
  if (orderId === '' || displayNumber === '') return null

  return {
    orderId,
    displayNumber,
    alreadyApproved: row.already_approved === true,
  }
}
