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

import {
  REVIEW_QUEUE_TITLE,
  type SubmissionActions,
  type SubmissionBanner,
} from '@/lib/orders/submissionWorkflow'
import { ADVANCE_STANDARD_PERCENT, type AdvanceView } from '@/lib/orders/advanceRequirement'
import { draftStatusLabel } from '@/lib/orders/draftsView'

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
  /** Formatted, or null when the PI did not say. */
  value: string | null
}

/**
 * The timeline band: the dates that belong to the ORDER, plus the one moment the
 * record itself moved.
 *
 * "Last saved" is NOT here. It is a fact about the file rather than about the
 * commitment, and it is already on the identity line above — printing it twice
 * on one screen is exactly the kind of repetition this redesign removes.
 *
 * The three document dates keep their labels even when empty, because "Dispatch
 * commitment: not provided" is itself a thing a reviewer needs to know. The
 * submission stamp is dropped entirely when there is none: an unsubmitted PI has
 * no submission, and a row saying so would be reporting a non-event.
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
  ]
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

/** Shown where the LABEL is still useful but the PI said nothing. */
export const NOT_PROVIDED = 'Not provided'

// ── The commercial snapshot ───────────────────────────────────────────────────

export type CommercialSnapshot = {
  /** The largest number in the page content. */
  grandTotal: string
  productLines: string
  standardAdvanceLabel: string
  standardAdvanceAmount: string
  /** "Standard advance (40%)", "Reduced advance", "No advance (0%)", or the
   *  honest "Not declared" for a record submitted before Phase B. */
  conditionLabel: string
  /** "12.5% · ₹1,47,500" under an exception, and null otherwise. */
  exceptionFigures: string | null
  /** "Pending decision" / "Approved" / "Rejected", or null. */
  statusLabel: string | null
  statusTone: PiDetailTone | null
}

export const ADVANCE_UNDECLARED_LABEL = 'Not declared'

const EXCEPTION_TONE: Record<string, PiDetailTone> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
}

/**
 * Everything the top-of-page snapshot prints.
 *
 * NOT ONE FIGURE IS COMPUTED HERE. The grand total is the formatted persisted
 * one, and every advance figure comes from describeAdvance, which derives them
 * through the single shared formula. This function chooses which of those to put
 * where.
 *
 * NO PAYMENT LANGUAGE, anywhere in what it returns: an advance is a condition
 * BOE will require, not a record that anything was received.
 */
export function buildCommercialSnapshot(input: {
  /** The formatted persisted grand total. */
  grandTotal: string
  productCount: number
  advance: AdvanceView
}): CommercialSnapshot {
  const { advance } = input

  return {
    grandTotal: input.grandTotal,
    productLines: `${input.productCount} product line${input.productCount === 1 ? '' : 's'}`,
    standardAdvanceLabel: `Standard advance (${ADVANCE_STANDARD_PERCENT}%)`,
    standardAdvanceAmount: advance.standardAmount,
    conditionLabel: advance.undeclared
      ? ADVANCE_UNDECLARED_LABEL
      : advance.conditionLabel ?? ADVANCE_UNDECLARED_LABEL,
    exceptionFigures: advance.exceptionPercentLabel === null
      ? null
      : advance.exceptionAmount === null
        ? advance.exceptionPercentLabel
        : `${advance.exceptionPercentLabel} · ${advance.exceptionAmount}`,
    statusLabel: advance.statusLabel,
    statusTone: advance.status === null ? null : EXCEPTION_TONE[advance.status] ?? null,
  }
}

// ── 3. Workflow and actions ───────────────────────────────────────────────────

export type WorkflowPanel = {
  /** What this viewer is being asked, in their own terms. */
  heading: string
  /** One line: where the record stands and who it is waiting on. */
  standing: string
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
  reviewer: 'Management Review',
  draftOwner: 'Ready for management?',
  needsChangesOwner: 'Changes requested',
  /** The same words the drafts queue uses for the same state. */
  submitted: REVIEW_QUEUE_TITLE,
  rejected: 'Rejected',
  approved: 'Approved',
} as const

export const REJECTED_NOTE_HEADING = 'Why this was rejected'
export const CHANGES_NOTE_HEADING = 'What management asked for'

export const DRAFT_OWNER_STANDING =
  'This PI has not been handed to management yet. Submitting it starts the review; nothing is numbered and no order is created.'
export const DRAFT_OWNER_BLOCKED_STANDING =
  'This PI cannot be submitted until the issues below are corrected in the Excel PI and the file is uploaded again.'
export const DRAFT_READONLY_STANDING =
  'This PI is still with the person who filed it. It has not been submitted for approval.'
export const REVIEWER_STANDING = 'Waiting for your decision.'
export const REVIEWER_EXCEPTION_PENDING =
  'A proposed advance is waiting too. Settling it does not approve the PI.'

/**
 * The workflow panel, for THIS viewer and THIS record.
 *
 * THE ROLE DECIDES THE HEADING, not the status alone. A submitted PI says
 * "Submitted for Review" to the employee who is waiting and "Management Review"
 * to the person who is being waited on, because the same fact is a different
 * instruction to each of them.
 *
 * The STANDING line reuses describeSubmissionBanner wherever that helper already
 * says it. That banner used to be a card of its own above an overview that
 * repeated it; it is the same sentence, in the one place that needs it.
 */
export function describeWorkflowPanel(input: {
  status: string
  actions: SubmissionActions
  /** describeSubmissionBanner's answer for this record, or null for a draft. */
  banner: SubmissionBanner | null
  /** True when the stored diagnostics still block submission. */
  hasBlockingIssues: boolean
  /** True when an exception is waiting for somebody's decision. */
  exceptionPending: boolean
  /** Already formatted, or null. This module does no date work. */
  submittedAt: string | null
  submitterName: string | null
}): WorkflowPanel {
  const { actions, banner, status } = input
  const isReviewer = actions.canRequestChanges || actions.canReject

  const noteHeading = status === 'rejected' ? REJECTED_NOTE_HEADING : CHANGES_NOTE_HEADING

  if (isReviewer) {
    // NOT the banner's sentence. That one ends "nothing on this PI can be
    // changed while it is under review", which is written for the employee who
    // is waiting — to the person being waited on it is a line about somebody
    // else's restriction. A reviewer needs who sent it, when, and whether there
    // is a second decision on the same record.
    return {
      heading: WORKFLOW_HEADING.reviewer,
      standing: [
        REVIEWER_STANDING,
        input.submittedAt
          ? `Submitted by ${input.submitterName ?? 'a colleague'} on ${input.submittedAt}.`
          : '',
        input.exceptionPending ? REVIEWER_EXCEPTION_PENDING : '',
      ].filter(Boolean).join(' '),
      tone: 'blue',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'draft') {
    const owns = actions.canSubmit || actions.canChangePi
    return {
      heading: owns ? WORKFLOW_HEADING.draftOwner : draftStatusLabel(status),
      standing: owns
        ? (input.hasBlockingIssues ? DRAFT_OWNER_BLOCKED_STANDING : DRAFT_OWNER_STANDING)
        : DRAFT_READONLY_STANDING,
      tone: 'neutral',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'needs_changes') {
    return {
      heading: WORKFLOW_HEADING.needsChangesOwner,
      standing: banner?.body ?? '',
      tone: 'amber',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'submitted') {
    return {
      heading: WORKFLOW_HEADING.submitted,
      standing: banner?.body ?? '',
      tone: 'blue',
      noteHeading,
      closed: false,
    }
  }

  if (status === 'rejected') {
    return {
      heading: WORKFLOW_HEADING.rejected,
      standing: banner?.body ?? '',
      tone: 'red',
      noteHeading,
      closed: true,
    }
  }

  if (status === 'approved') {
    return {
      heading: WORKFLOW_HEADING.approved,
      standing: banner?.body ?? '',
      tone: 'green',
      noteHeading,
      closed: true,
    }
  }

  // An unrecognised status is shown as itself rather than mislabelled, exactly
  // as the drafts list does.
  return {
    heading: draftStatusLabel(status),
    standing: banner?.body ?? '',
    tone: 'neutral',
    noteHeading,
    closed: true,
  }
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
