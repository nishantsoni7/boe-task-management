// WHAT THE PI DETAIL PAGE SAYS — decided here, away from the JSX that draws it.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The screen answers ten questions and it answers them differently for six
// audiences: the owner of a draft, the owner of a returned PI, the owner of a
// submitted one, a management reviewer, somebody who may settle an advance
// exception and nothing else, and a colleague who may only read. Written inline
// that is a dozen ternaries inside a card, and the day one of them drifts a
// reviewer is told to wait for themselves.
//
// So the WORDS and the ARRANGEMENT are decided by pure functions here, with
// tests around them, and the components below only draw what they return.
//
// NONE OF THIS IS AUTHORIZATION, AND NONE OF IT IS A BUSINESS RULE.
//
//   * who may act        → describeSubmissionActions (submissionWorkflow.ts)
//   * who may settle an
//     advance exception  → describeAdvanceActions (advanceRequirement.ts)
//   * what an advance
//     condition MEANS    → describeAdvance (advanceRequirement.ts)
//   * what a commercial
//     figure is          → buildCommercialRows (previewView.ts)
//   * what an event was  → describeActivityEntries (submissionActivity.ts)
//
// Every one of those is re-derived by the database for every write. This file
// reads their answers and picks a heading.

import type { SubmissionActions } from '@/lib/orders/submissionWorkflow'
import {
  ADVANCE_NONE_LABEL,
  type AdvanceView,
} from '@/lib/orders/advanceRequirement'
import {
  APPROVE_SUMMARY_LABEL,
  FINANCE_SUMMARY_PENDING,
  FINANCE_SUMMARY_VERIFIED,
  orderHref,
} from '@/lib/orders/finalApproval'
import { draftStatusLabel } from '@/lib/orders/draftsView'
import { PAYMENT_POSITION_LABEL, type PaymentPosition } from '@/lib/orders/paymentGate'
import type { PiAmountRow } from '@/lib/pi/previewView'

// ── Tones ─────────────────────────────────────────────────────────────────────

/** The restrained palette this page spends state colour from. */
export type PiDetailTone = 'neutral' | 'blue' | 'amber' | 'red' | 'green'

// ── 1. Page identity ──────────────────────────────────────────────────────────

/**
 * The one metadata line under the client name.
 *
 * SHORT FACTS ONLY, and only the ones a record actually carries. A block that
 * would read "Created by —" is not printed at all: a labelled hole is worse than
 * the absence it reports, and this line has no labels to hang one on.
 *
 * The WORKBOOK FILENAME is deliberately not in here. It is the one fact that can
 * be sixty characters long, and it gets its own quiet file treatment beside the
 * line rather than being allowed to push everything else onto a second row.
 */
export function buildIdentityFacts(input: {
  productCount: number
  /** Already formatted. This module does no date work. */
  savedAt: string
  /** order_submissions.source_created_by — whoever the PI document itself named. */
  documentAuthor: string | null
  /** Resolved display name of the person who submitted it, when it was. */
  submitterName: string | null
  submittedAt: string | null
}): string[] {
  const facts: string[] = [
    `${input.productCount} product line${input.productCount === 1 ? '' : 's'}`,
  ]

  // Submitted supersedes saved as "the last thing that happened to this record",
  // so the two are never printed side by side.
  if (input.submittedAt) {
    facts.push(
      input.submitterName
        ? `Submitted ${input.submittedAt} by ${input.submitterName}`
        : `Submitted ${input.submittedAt}`,
    )
  } else {
    facts.push(`Saved ${input.savedAt}`)
  }

  if (input.documentAuthor) facts.push(`PI by ${input.documentAuthor}`)

  return facts
}

// ── 2. Order overview ─────────────────────────────────────────────────────────

export type OverviewDate = {
  key: string
  label: string
  /** Formatted. A date the PI did not give is not returned at all. */
  value: string
}

/**
 * The timeline band: the dates that belong to the ORDER, plus the one moment the
 * record itself moved.
 *
 * "Last saved" is NOT here. It is a fact about the file rather than about the
 * commitment, and it is already on the identity line above.
 *
 * A DATE THE PI NEVER GAVE IS NOT A ROW. These three are optional on a real
 * workbook and most drafts carry none of them, which produced a whole column of
 * "Not provided · Not provided · Not provided" — a block of screen reporting
 * three non-events, in a card whose job is to be scanned. Nothing here needs
 * action, so nothing here needs a placeholder; the column simply shortens, and
 * when every date is absent the section disappears and its width goes to the
 * two sections that have something to say.
 */
export function buildOverviewDates(input: {
  created: string
  confirmed: string
  dispatch: string
  submittedAt: string | null
}): OverviewDate[] {
  const dates: OverviewDate[] = [
    { key: 'created', label: 'PI created', value: omitDash(input.created) },
    { key: 'confirmed', label: 'Order confirmed', value: omitDash(input.confirmed) },
    { key: 'dispatch', label: 'Dispatch commitment', value: omitDash(input.dispatch) },
  ].filter((date): date is OverviewDate & { value: string } => date.value !== null)

  // The submission stamp is never dropped when it exists: it is the one date on
  // this card that is a fact about the RECORD's progress rather than about the
  // document, and it is what a reviewer asks for first.
  if (input.submittedAt) {
    dates.push({ key: 'submitted', label: 'Submitted for review', value: input.submittedAt })
  }
  return dates
}

/**
 * A shared-builder value, or null when the PI said nothing.
 *
 * buildHeaderRows returns an em dash for anything absent. An em dash on screen
 * reads as "unfinished"; null lets the field say `Not provided` instead, which
 * is what the document actually tells us.
 */
export function omitDash(value: string): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' || trimmed === '—' ? null : trimmed
}

// ── The commercial snapshot ───────────────────────────────────────────────────

/**
 * The advance condition, as ONE block.
 *
 * WHY IT COLLAPSED. The snapshot used to print four things about the advance:
 * the standard 40% amount, the selected-condition label, the proposed
 * percentage-and-amount, and a decision badge — and the workflow panel printed
 * most of them a second time, and the commercial breakdown printed the standard
 * amount a third. On a PI with a 0% exception that is four renderings of "no
 * advance", which is how a page ends up feeling like it is arguing with itself.
 *
 * There is now ONE current-state answer, here, and it says three things at most:
 *
 *   label     what this figure IS — a requirement that stands, or one that has
 *             been asked for and not yet granted
 *   figures   the percentage and the rupees, together, on one line
 *   status    only when a decision exists to report
 *
 * THE STANDARD AMOUNT IS NOT SHOWN BESIDE AN EXCEPTION. Two figures side by side
 * read as two things that are owed. The comparison belongs where the decision is
 * being taken — the pending-exception band — and nowhere else.
 */
export type AdvanceRequirement = {
  /** `Advance requirement` for a condition that stands, `Requested advance`
   *  for one still waiting on, or refused by, management. */
  label: string
  /** `₹10,14,800 · 40%`, `No advance · ₹0 · 0%`, or `Not declared`. */
  figures: string
  /** `Pending`, `Exception approved`, `Rejected` — or null when no exception
   *  decision exists to report. */
  status: string | null
  statusTone: PiDetailTone | null
}

export type CommercialSnapshot = {
  /** The largest number in the page content. */
  grandTotal: string
  productLines: string
  /**
   * Where this PI stands on the verified-payment requirement, or null while the
   * payment position has not been read.
   *
   * IT IS NOT THE DECLARED ADVANCE, and cannot be: this block used to print the
   * amount an employee DECLARED, which was a promise standing in for a fact. The
   * fact now exists — pi_submission_payment_summary() reports what Finance has
   * actually verified — and a screen that showed the promise beside it would be
   * showing two answers to one question, one of which decides nothing.
   *
   * NULL RATHER THAN A PLACEHOLDER while it is unread: "Payment position —" on
   * the commonest state of the commonest record is a permanent block answering a
   * question nobody has asked yet.
   */
  payment: PaymentSnapshot | null
}

/** The payment block of the snapshot. */
export type PaymentSnapshot = {
  /** `Verified payment`. */
  label: string
  /** `₹4,00,000 · 40%`, or `₹0 · 0%`. Both figures come from the database. */
  figures: string
  /** The approval position, in its own words — or null while it is unknown. */
  status: string | null
  statusTone: PiDetailTone | null
}

export const ADVANCE_REQUIREMENT_LABEL = 'Advance requirement'
export const ADVANCE_REQUESTED_LABEL = 'Requested advance'
export const ADVANCE_UNDECLARED_LABEL = 'Not declared'

/** The snapshot block's own heading, since Phase 3. */
export const PAYMENT_SNAPSHOT_LABEL = 'Verified payment'

export const EXCEPTION_STATUS_TEXT: Record<string, string> = {
  pending: 'Pending',
  approved: 'Exception approved',
  rejected: 'Rejected',
}


/** The approval position, in the snapshot's tone vocabulary. One map, so the
 *  band on the payment card and the block at the top of the page cannot colour
 *  the same state differently. */
const POSITION_TONE: Record<PaymentPosition, PiDetailTone> = {
  standard_met:         'green',
  exception_approved:   'green',
  exception_pending:    'amber',
  exception_rejected:   'red',
  verification_pending: 'blue',
  payment_required:     'amber',
}


/** "No advance", without the ": 0%" the choice label carries — the percentage
 *  is on the same line already, and saying it twice is what this pass removes. */
const ADVANCE_NONE_LABEL_SHORT = ADVANCE_NONE_LABEL.replace(/\s*:\s*0%\s*$/, '')

/**
 * Everything the top-of-page snapshot prints.
 *
 * NOT ONE FIGURE IS COMPUTED HERE. The grand total is the formatted persisted
 * one, and every advance figure comes from describeAdvance, which derives them
 * through the single shared formula. This function chooses which of those to put
 * where, and — now — which of them not to print at all.
 */
export function buildCommercialSnapshot(input: {
  /** The formatted persisted grand total. */
  grandTotal: string
  productCount: number
  /**
   * The payment position, exactly as pi_submission_payment_summary() reported
   * it, already formatted — or null while it has not been read.
   *
   * NOTHING IS COMPUTED HERE. The amount, the percentage and the position were
   * all decided in `numeric` in the database; this arranges them into one line.
   */
  payment: {
    verifiedAmount: string
    verifiedPercent: string
    position: PaymentPosition | null
  } | null
}): CommercialSnapshot {
  const { payment } = input

  return {
    grandTotal: input.grandTotal,
    productLines: `${input.productCount} product line${input.productCount === 1 ? '' : 's'}`,
    payment: payment === null ? null : {
      label: PAYMENT_SNAPSHOT_LABEL,
      // THE AMOUNT LEADS and the percentage follows it, because the amount is
      // the fact and the percentage is what it comes to against this total.
      figures: `${payment.verifiedAmount} · ${payment.verifiedPercent}`,
      status: payment.position === null ? null : PAYMENT_POSITION_LABEL[payment.position],
      statusTone: payment.position === null ? null : POSITION_TONE[payment.position],
    },
  }
}

// ── The commercial breakdown, at the foot of the page ─────────────────────────

/**
 * The stored commercial rows, minus the advance.
 *
 * THE ADVANCE IS NOT A CALCULATION LINE HERE. buildCommercialRows ends with
 * "Required advance (40%)" and its payment disclaimer, which is right on the
 * IMPORT PREVIEW — that screen has no other advance information anywhere, and a
 * person looking at a freshly parsed workbook needs to be told what will be
 * required of the client.
 *
 * This page does have somewhere else: the snapshot at the top states the CURRENT
 * condition, including an approved exception that makes the standard 40% simply
 * wrong. Printing the standard row down here as well would contradict it. So the
 * row is dropped from this screen and from this screen only, by the page, and
 * the shared builder is untouched.
 */
export const ADVANCE_ROW_KEY = 'advance'

export function commercialBreakdownRows(rows: readonly PiAmountRow[]): PiAmountRow[] {
  return rows.filter(row => row.key !== ADVANCE_ROW_KEY)
}

// ── 3. Workflow and actions ───────────────────────────────────────────────────

export type WorkflowPanel = {
  /** What this viewer is being asked, in their own terms. */
  heading: string
  /**
   * One quiet metadata line — who moved this record last, and when.
   *
   * NOT A SENTENCE. It replaced three of them: "Waiting for your decision.",
   * "Nothing on this PI can be changed while it is under review.", and a
   * paragraph explaining what each button did. A reviewer opening a submitted PI
   * needs the actor and the timestamp; the two buttons beside the heading say
   * the rest without help.
   */
  meta: string | null
  /**
   * A short instruction, and ONLY where action is genuinely required and not
   * already obvious from the controls. In practice: a draft that cannot be
   * submitted until the workbook is corrected.
   */
  instruction: string | null
  tone: PiDetailTone
  /** The heading over submission.review_note. The one column carries two
   *  different decisions, so it says which one wrote it. */
  noteHeading: string
  /**
   * True for a record nobody can move from this screen — rejected, or approved.
   * The panel stays informative and stops looking like somewhere to press.
   */
  closed: boolean
}

export const WORKFLOW_HEADING = {
  reviewer: 'Management review',
  draftOwner: 'Ready for management?',
  needsChangesOwner: 'Changes requested',
  /**
   * Sentence case, and deliberately NOT REVIEW_QUEUE_TITLE.
   *
   * That constant is the drafts LIST's section heading and is title case there;
   * borrowing it dragged "Submitted for Review" onto a page whose every other
   * heading is sentence case. Two screens, two headings, and the list keeps the
   * words it already had.
   */
  submitted: 'Submitted for review',
  rejected: 'Rejected',
  approved: 'Approved',
} as const

export const REJECTED_NOTE_HEADING = 'Why this was rejected'
export const CHANGES_NOTE_HEADING = 'What management asked for'

/** The one instruction that survives: a draft nobody can submit yet. */
export const DRAFT_OWNER_BLOCKED_STANDING =
  'Correct the issues below in the Excel PI and upload it again before submitting.'

/** Who moved the record last, and when. Used for the panel's metadata line. */
function actorLine(verb: string, name: string | null, at: string | null): string | null {
  if (!at) return null
  return `${verb} by ${name ?? 'a colleague'} · ${at}`
}

/**
 * The workflow panel, for THIS viewer and THIS record.
 *
 * THE ROLE DECIDES THE HEADING, not the status alone. A submitted PI says
 * "Submitted for review" to the employee who is waiting and "Management review"
 * to the person who is being waited on, because the same fact is a different
 * instruction to each of them.
 *
 * WHAT THIS FUNCTION NO LONGER RETURNS is as much the point as what it does.
 * There is no standing paragraph, no restatement of the status the identity
 * badge already carries, and no description of what pressing a button will do.
 * The page trusts its labels.
 */
export function describeWorkflowPanel(input: {
  status: string
  actions: SubmissionActions
  /** True when the stored diagnostics still block submission. */
  hasBlockingIssues: boolean
  /** Already formatted, or null. This module does no date work. */
  submittedAt: string | null
  submitterName: string | null
  rejectedAt: string | null
  rejectedByName: string | null
}): WorkflowPanel {
  const { actions, status } = input
  const isReviewer = actions.canRequestChanges || actions.canReject

  const noteHeading = status === 'rejected' ? REJECTED_NOTE_HEADING : CHANGES_NOTE_HEADING
  const submittedLine = actorLine('Submitted', input.submitterName, input.submittedAt)
  const rejectedLine = actorLine('Rejected', input.rejectedByName, input.rejectedAt)

  if (isReviewer) {
    return {
      heading: WORKFLOW_HEADING.reviewer,
      meta: submittedLine,
      instruction: null,
      tone: 'blue',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'draft') {
    const owns = actions.canSubmit || actions.canChangePi
    return {
      heading: owns ? WORKFLOW_HEADING.draftOwner : draftStatusLabel(status),
      meta: null,
      instruction: owns && input.hasBlockingIssues ? DRAFT_OWNER_BLOCKED_STANDING : null,
      tone: 'neutral',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'needs_changes') {
    return {
      heading: WORKFLOW_HEADING.needsChangesOwner,
      // Management's own note is rendered verbatim below the heading and says
      // what to change; a procedural sentence repeating the two buttons beside
      // it would be the third telling of one instruction.
      meta: submittedLine,
      instruction: null,
      tone: 'amber',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'submitted') {
    return {
      heading: WORKFLOW_HEADING.submitted,
      meta: submittedLine,
      instruction: null,
      tone: 'blue',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'rejected') {
    return {
      heading: WORKFLOW_HEADING.rejected,
      meta: rejectedLine,
      instruction: null,
      tone: 'red',
      noteHeading,
      closed: true,
    }
  }

  if (status === 'approved') {
    return {
      heading: WORKFLOW_HEADING.approved,
      meta: submittedLine,
      instruction: null,
      tone: 'green',
      noteHeading,
      closed: true,
    }
  }

  // An unrecognised status is shown as itself rather than mislabelled, exactly
  // as the drafts list does.
  return {
    heading: draftStatusLabel(status),
    meta: submittedLine,
    instruction: null,
    tone: 'neutral',
    noteHeading,
    closed: true,
  }
}

// ── The advance decision band ─────────────────────────────────────────────────

/**
 * The band's heading. "Advance exception" and not "Advance requirement": the
 * band exists only while there is an EXCEPTION to settle, and the requirement
 * itself is stated once, in the snapshot at the top.
 */
export const ADVANCE_BAND_TITLE = 'Reduced-payment approval'

/**
 * The one line describing what was asked for, for the band.
 *
 * `Reduced advance · ₹3,17,125 · 12.5%` or `No advance · ₹0 · 0%`. It names the
 * KIND of exception as well as the figures, because the person reading it is
 * being asked to grant exactly that and the two zero cases are not the same
 * decision as a reduction.
 */
export function describeRequestedException(
  advance: AdvanceView,
  /**
   * The LIVE verified-payment line, when the payment summary has been read.
   *
   * PREFERRED OVER THE STORED FIGURES, always. Since Phase 3 the decision in
   * front of the approver is "start this Order on the money that has actually
   * arrived", and the money that has actually arrived is a figure that moves —
   * so the band states the current one rather than the snapshot taken when the
   * request was made. The stored wording below remains for records written
   * before this phase, where a DECLARED advance is genuinely all there is.
   */
  verifiedLine?: string | null,
): string {
  if (verifiedLine) return verifiedLine
  if (advance.declaredAmountValue === null) {
    return advance.conditionLabel ?? ADVANCE_UNDECLARED_LABEL
  }
  const figures = advance.declaredPercentLabel === null
    ? advance.declaredAmount
    : `${advance.declaredAmount} · ${advance.declaredPercentLabel}`
  const kind = advance.isZeroPercent ? ADVANCE_NONE_LABEL_SHORT : ADVANCE_REDUCED_KIND
  return `${kind} · ${figures}`
}

const ADVANCE_REDUCED_KIND = 'Reduced advance'
const ADVANCE_STANDARD_KIND = 'Standard advance'

/**
 * The advance as MANAGEMENT'S REVIEW SURFACES state it.
 *
 * THE AMOUNT IS ON IT, always, because that is what was declared and what the
 * business is being asked to accept. A condition label on its own — "Advance:
 * 40% or above" — tells a reviewer which route was taken and not one thing about
 * the figure they are signing off, which is the whole question in front of them.
 *
 * `Standard advance · ₹10,14,800 · 40%`
 * `Reduced advance · ₹3,17,125 · 12.5%`
 * `No advance · ₹0 · 0%`
 *
 * Both the finance verification dialog and the final approval summary print
 * this, so the two cannot state the same record differently.
 */
export function describeAdvanceForReview(advance: AdvanceView): string {
  if (advance.undeclared || advance.declaredAmountValue === null) {
    return advance.conditionLabel ?? ADVANCE_UNDECLARED_LABEL
  }
  const kind = advance.condition === 'exception'
    ? (advance.isZeroPercent ? ADVANCE_NONE_LABEL_SHORT : ADVANCE_REDUCED_KIND)
    : ADVANCE_STANDARD_KIND
  const figures = advance.declaredPercentLabel === null
    ? advance.declaredAmount
    : `${advance.declaredAmount} · ${advance.declaredPercentLabel}`
  return `${kind} · ${figures}`
}

// ── 4. Blocking issues ────────────────────────────────────────────────────────

/**
 * The one sentence under the blocking list.
 *
 * The Change PI control is NOT duplicated here — it is in the workflow panel
 * above, where every other action this viewer has already lives, and two of the
 * same button on one screen is two places for somebody to wonder which is which.
 */
export const BLOCKING_INSTRUCTION =
  'Correct these in the Excel PI and upload it again with Change PI. Nothing on this screen can be edited — the order must match the document the client was sent.'

// ── 8. The page footnote ──────────────────────────────────────────────────────

/**
 * One muted line, replacing the paragraph that used to explain at length that no
 * order number exists. It says the two things that are true and stops.
 */
export const STORED_COPY_NOTE =
  'Stored PI copy. Official order numbering begins after management approval.'

// ── 9. Final approval ─────────────────────────────────────────────────────────
//
// What the approval dialog SHOWS, and what the workflow panel says once an Order
// exists. The RULES live in finalApproval.ts; this is the arrangement.

/** One line of the approval dialog's summary. */
export type ApprovalSummaryRow = {
  key: string
  label: string
  value: string
  /** True for the figure the eye should land on first. */
  strong?: boolean
}

/**
 * The compact final summary a reviewer confirms against.
 *
 * FIVE FACTS, AND NOT ONE MORE. Client, grand total, the advance condition, the
 * finance state and how many product lines are being committed to. Between them
 * they answer "am I approving the thing I think I am approving", which is the
 * only question a confirmation dialog is for.
 *
 * WHAT IS DELIBERATELY ABSENT: the commercial breakdown, the addresses, the
 * dispatch commitment and the product table. All of them are on the page behind
 * this dialog, in full, and a reviewer who has not read them is not helped by a
 * truncated copy in a modal.
 *
 * THE ADVANCE FIGURES ARE NOT RESTATED HERE EITHER — the condition is named
 * ("Standard advance (40%)", "No advance (0%)") and the rupee value stays on the
 * page, where it is derived once from the current grand total.
 */
export function buildApprovalSummary(input: {
  client: string
  grandTotal: string
  /** advance.conditionLabel, or the undeclared label. One source, one wording. */
  advanceLabel: string
  financeVerified: boolean
  productCount: number
}): ApprovalSummaryRow[] {
  return [
    { key: 'client', label: APPROVE_SUMMARY_LABEL.client, value: input.client },
    { key: 'total', label: APPROVE_SUMMARY_LABEL.grandTotal, value: input.grandTotal, strong: true },
    { key: 'advance', label: APPROVE_SUMMARY_LABEL.advance, value: input.advanceLabel },
    {
      key: 'finance',
      label: APPROVE_SUMMARY_LABEL.finance,
      value: input.financeVerified ? FINANCE_SUMMARY_VERIFIED : FINANCE_SUMMARY_PENDING,
    },
    {
      key: 'lines',
      label: APPROVE_SUMMARY_LABEL.lines,
      value: `${input.productCount} line${input.productCount === 1 ? '' : 's'}`,
    },
  ]
}

/**
 * The created Order, as the approved record reports it — or null.
 *
 * NULL WHEN THE NUMBER COULD NOT BE READ, and that is a real case rather than a
 * defect: an Order is visible to its requester, to operations, to an admin and
 * to a holder of orders.view_all, and a finance verifier is none of those. They
 * still see that the PI was approved — the status badge, the banner and the
 * Activity entry all say so — and they are simply not shown a number and a link
 * into a record they cannot open. Inventing a number here, or showing a link
 * that leads to "not available", would be worse than saying less.
 */
export type ApprovedOrderView = {
  orderId: string
  displayNumber: string
  href: string
}

export function describeApprovedOrder(input: {
  orderId: string | null
  displayNumber: string | null
}): ApprovedOrderView | null {
  const orderId = (input.orderId ?? '').trim()
  const displayNumber = (input.displayNumber ?? '').trim()
  if (orderId === '' || displayNumber === '') return null
  return { orderId, displayNumber, href: orderHref(orderId) }
}
