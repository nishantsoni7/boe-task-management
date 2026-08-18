// What may be done to a saved PI submission, and what a person is told when it
// cannot be done.
//
// WHY THIS IS A MODULE AND NOT A HANDFUL OF INLINE CONDITIONS
// ----------------------------------------------------------
// Two screens ask the same questions — the employee's draft page and the
// reviewer's version of that same page — and the answers depend on four things
// at once: the record's status, whether the caller owns it, whether they may
// create orders, and whether they hold orders.approve_order. Written inline that
// becomes eight nearly-identical boolean expressions across two files, and the
// day one of them drifts, a control appears for somebody the database will
// refuse. Written here it is one set of rules with tests around it.
//
// NONE OF THIS IS AUTHORIZATION. Every rule below decides what to RENDER. The
// database decides what may HAPPEN, and it decides it again for every call:
//
//   submit_order_submission           owner, orders.create, draft/needs_changes,
//                                     and a workbook plus images that actually
//                                     exist in storage
//   request_order_submission_changes  orders.approve_order, submitted only
//   reject_order_submission           orders.approve_order, submitted only
//   the Change PI flow                the order-files write policy and
//                                     assert_order_submission_editor, neither of
//                                     which this file can influence
//
// So a hidden button is a courtesy, and a button somebody defeats gets them a
// refusal from Postgres rather than an unauthorized write. What this file must
// never do is the reverse — show a control the database would allow but the
// product does not, which is why `canApprove` is a constant false here and there
// is no approval RPC to call.

import type { PiDraftListEntry } from './draftsView'

// ── Labels ────────────────────────────────────────────────────────────────────

export const SUBMIT_BUTTON_LABEL = 'Submit for Approval'
export const CHANGE_PI_BUTTON_LABEL = 'Change PI'
export const REQUEST_CHANGES_BUTTON_LABEL = 'Needs Changes'
export const REJECT_BUTTON_LABEL = 'Reject'
export const APPROVE_BUTTON_LABEL = 'Approve'
export const REVIEW_ACTION_LABEL = 'Review PI'
export const REVIEW_QUEUE_TITLE = 'Submitted for Review'

/**
 * The entry point to the importer, from PI Drafts.
 *
 * "Upload PI" and not "New Order": what the control does is upload one document.
 * An order comes into existence at approval, with a number, and a button
 * promising one here would be describing a step this phase cannot reach.
 */
export const UPLOAD_PI_BUTTON_LABEL = 'Upload PI'

/**
 * Why Approve is present but inert.
 *
 * It is shown rather than hidden because a reviewer needs to know that approval
 * is a step that exists and is coming, not wonder whether they have missed a
 * control. It is disabled rather than clickable because there is no approval RPC
 * to call — the transition to 'approved' is refused by the database for every
 * caller — and a button that fails is worse than one that explains itself.
 */
export const APPROVE_DISABLED_REASON = 'Available after advance review is added'

/** What the employee is warned of before they submit. */
export const SUBMIT_CONFIRM_NOTE =
  'Once submitted, this PI becomes read-only while management reviews it.'

// ── The employee's reply, when they resubmit ──────────────────────────────────
//
// A PI returned with "the fabric on line 3 is wrong" comes back corrected, and
// until now the reviewer had to diff two spreadsheets to find out what changed.
// So a resubmission may carry one optional line, which lands on the 'submitted'
// event in the append-only trail the reviewer already reads.
//
// OPTIONAL MEANS OPTIONAL. An employee who has nothing to add submits exactly as
// before; whitespace is trimmed to nothing and no empty entry is recorded. It is
// offered only on a RESUBMISSION — a first submission from draft has no reviewer
// question to answer, and a field asking for one would be clutter on the
// commonest path through the screen.
//
// It is NOT a message thread, and it never touches management's own review note:
// that is their field, on their event, and the trail keeps the request and the
// answer as two separate entries.

export const RESUBMIT_NOTE_LABEL = 'Reply to management (optional)'
export const RESUBMIT_NOTE_PLACEHOLDER =
  'Mention what you changed or answer the reviewer\u2019s question.'

/**
 * The cap, in characters, after trimming.
 *
 * MUST MATCH THE DATABASE. submit_order_submission_with_note refuses a longer
 * reply with ORDER_SUBMISSION_NOTE_TOO_LONG, and a test reads the number out of
 * the migration so the two cannot drift. The browser limit exists so somebody is
 * told while they type rather than after a round trip; the database limit is the
 * one that decides.
 */
export const RESUBMIT_NOTE_MAX_LENGTH = 1000

/** Whether the submit dialog offers the reply field for this status. */
export function submissionOffersReply(status: string): boolean {
  return status === 'needs_changes'
}

export type ReplyValidation =
  | { ok: true; note: string | null }
  | { ok: false; message: string }

export const RESUBMIT_NOTE_TOO_LONG =
  `Please shorten your reply to ${RESUBMIT_NOTE_MAX_LENGTH} characters or fewer.`

/**
 * The optional reply, as it will be sent — or the reason it cannot be.
 *
 * Trimmed, and whitespace-only becomes NULL rather than an empty string, so a
 * field somebody tabbed through leaves no trace. Length is measured AFTER
 * trimming, exactly as the database measures it, so a reply padded with spaces
 * is never rejected for a length it does not really have.
 */
export function validateResubmitReply(value: string | null | undefined): ReplyValidation {
  const note = (value ?? '').trim()
  if (note === '') return { ok: true, note: null }
  if (note.length > RESUBMIT_NOTE_MAX_LENGTH) return { ok: false, message: RESUBMIT_NOTE_TOO_LONG }
  return { ok: true, note }
}

// ── Who may do what ───────────────────────────────────────────────────────────

export type SubmissionActionInput = {
  status: string
  /** order_submissions.created_by */
  createdBy: string | null
  /** order_submissions.submitted_by */
  submittedBy: string | null
  /** The SIGNED-IN user, never a View As target. */
  viewerId: string | null
  /** orders.create, as deriveOrdersCapabilities resolved it. */
  canCreate: boolean
  /** orders.approve_order, as deriveOrdersCapabilities resolved it. */
  canApproveSubmission: boolean
}

export type SubmissionActions = {
  isOwner: boolean
  /** Submit for Approval — a draft or a returned submission, by its owner. */
  canSubmit: boolean
  /** Change PI — the same window as submitting, and the same owner. */
  canChangePi: boolean
  canRequestChanges: boolean
  canReject: boolean
  /** Always false in this phase. Approval belongs to the phase that creates
   *  Orders, and there is no RPC behind it. */
  canApprove: false
  /** True when this viewer has no action available on this record at all. */
  isReadOnly: boolean
}

/** The two states the EMPLOYEE owns. Everything else is somebody else's turn. */
const EDITABLE: readonly string[] = ['draft', 'needs_changes']

export function describeSubmissionActions(input: SubmissionActionInput): SubmissionActions {
  const viewer = input.viewerId
  // An owner is the creator or the named submitter — the same pair
  // can_edit_order_submission uses, so the button matches the RPC.
  const isOwner =
    viewer !== null
    && viewer !== ''
    && (input.createdBy === viewer || input.submittedBy === viewer)

  const editable = EDITABLE.includes(input.status) && isOwner && input.canCreate
  const underReview = input.status === 'submitted' && input.canApproveSubmission

  return {
    isOwner,
    canSubmit: editable,
    canChangePi: editable,
    canRequestChanges: underReview,
    canReject: underReview,
    canApprove: false,
    isReadOnly: !editable && !underReview,
  }
}

/**
 * Whether the PI behind this record may still be replaced.
 *
 * Read by the import screen when it is asked to replace an existing
 * submission's workbook, so a submitted, rejected or approved record fails
 * closed on arrival rather than after an upload.
 */
export function canReplaceSubmissionPi(status: string): boolean {
  return EDITABLE.includes(status)
}

// ── One list, two sections ────────────────────────────────────────────────────

export type ReviewQueueSplit = {
  /** Submitted records this viewer may act on, newest submission first. */
  review: PiDraftListEntry[]
  /** Everything else, in the order the list already had. */
  working: PiDraftListEntry[]
}

/**
 * Split the PI Drafts list into the review queue and the working list.
 *
 * ONE PAGE, NOT TWO. A separate review dashboard would mean a second route, a
 * second query, a second set of empty states and a second place for a record to
 * hide — and the reviewer would still have to visit the drafts page for anything
 * not currently submitted. So the queue is a section of the list that already
 * exists, present only for somebody who can act on it.
 *
 * THIS IS NOT A VISIBILITY RULE. Which submissions are in `entries` at all was
 * decided by RLS before this function saw them. What is decided here is only
 * where a row a person can ALREADY see is printed, which is a layout question.
 * A viewer without review authority gets the identical list they had before,
 * untouched and in its original order.
 */
export function splitDraftsForReview(
  entries: readonly PiDraftListEntry[],
  canReview: boolean,
): ReviewQueueSplit {
  if (!canReview) return { review: [], working: [...entries] }

  const review = entries.filter(entry => entry.status === 'submitted')
  const working = entries.filter(entry => entry.status !== 'submitted')

  // Newest submission first. A record with no recorded submission time — one
  // submitted before the time was stored — sorts last rather than first, so an
  // unknown never displaces a known.
  review.sort((a, b) => {
    if (a.submittedAtIso === b.submittedAtIso) return 0
    if (!a.submittedAtIso) return 1
    if (!b.submittedAtIso) return -1
    return a.submittedAtIso < b.submittedAtIso ? 1 : -1
  })

  return { review, working }
}

// ── The mandatory note ────────────────────────────────────────────────────────

export type NoteValidation =
  | { ok: true; note: string }
  | { ok: false; message: string }

export const NEEDS_CHANGES_NOTE_REQUIRED = 'Say what needs to change before sending this back.'
export const REJECT_REASON_REQUIRED = 'A reason is required to reject this PI.'

/**
 * A note that is whitespace is not a note.
 *
 * Trimmed here AND trimmed again by the database, which refuses a blank of its
 * own accord. The browser check exists so somebody is told before a round trip,
 * not because it is the control.
 */
export function validateReviewNote(
  value: string | null | undefined,
  intent: 'needs_changes' | 'reject',
): NoteValidation {
  const note = (value ?? '').trim()
  if (note === '') {
    return {
      ok: false,
      message: intent === 'reject' ? REJECT_REASON_REQUIRED : NEEDS_CHANGES_NOTE_REQUIRED,
    }
  }
  return { ok: true, note }
}

// ── Failures ──────────────────────────────────────────────────────────────────

export type SubmissionAction = 'submit' | 'request_changes' | 'reject'

export type SubmissionFailure = {
  /** Stable, non-sensitive, safe to show and to log. */
  code: string
  message: string
}

/**
 * The stable markers the RPCs raise, and the sentence each becomes.
 *
 * THE DATABASE MESSAGE ITSELF IS NEVER SHOWN. A Postgres error carries the
 * statement's own text — column names, the submission id, occasionally a value —
 * and none of it is anything an employee can act on. What is read from the error
 * is only which of these markers it contains; what is displayed is the fixed
 * sentence beside it.
 */
const FAILURE_MESSAGES: readonly { marker: string; code: string; message: string }[] = [
  { marker: 'ORDER_SUBMISSION_BLOCKED', code: 'BLOCKING_ISSUES',
    message: 'This PI still has issues that must be fixed in the workbook. Use Change PI to upload a corrected file.' },
  { marker: 'ORDER_SUBMISSION_INCOMPLETE', code: 'INCOMPLETE',
    message: 'This PI is not complete enough to submit. Use Change PI to upload a corrected file.' },
  { marker: 'ORDER_SUBMISSION_BAD_WORKBOOK_PATH', code: 'WORKBOOK_MISSING',
    message: 'The uploaded PI could not be located for this record. Upload it again with Change PI.' },
  { marker: 'ORDER_SUBMISSION_WORKBOOK_NOT_STORED', code: 'WORKBOOK_MISSING',
    message: 'The uploaded PI could not be found. Upload it again with Change PI.' },
  { marker: 'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX', code: 'WORKBOOK_NOT_XLSX',
    message: 'The stored file is not an .xlsx workbook. Upload the PI again with Change PI.' },
  { marker: 'ORDER_SUBMISSION_BAD_IMAGE_PATH', code: 'IMAGES_MISSING',
    message: 'A product image is not stored correctly. Upload the PI again with Change PI.' },
  { marker: 'ORDER_SUBMISSION_IMAGE_NOT_STORED', code: 'IMAGES_MISSING',
    message: 'A product image is missing from storage. Upload the PI again with Change PI.' },
  { marker: 'ORDER_SUBMISSION_NOT_UNDER_REVIEW', code: 'NOT_UNDER_REVIEW',
    message: 'This PI is no longer waiting for review. Refresh to see its current state.' },
  { marker: 'ORDER_SUBMISSION_NOTE_REQUIRED', code: 'NOTE_REQUIRED',
    message: NEEDS_CHANGES_NOTE_REQUIRED },
  { marker: 'ORDER_SUBMISSION_REASON_REQUIRED', code: 'REASON_REQUIRED',
    message: REJECT_REASON_REQUIRED },
  { marker: 'ORDER_SUBMISSION_TRANSITION_INVALID', code: 'STATE_CHANGED',
    message: 'This PI has already moved on. Refresh to see its current state.' },
  { marker: 'Authentication required', code: 'UNAUTHORIZED',
    message: 'Your session has expired. Sign in again and try once more.' },
  { marker: 'This account is not active', code: 'ACCOUNT_INACTIVE',
    message: 'This account cannot act on order submissions.' },
  { marker: 'not found', code: 'NOT_FOUND',
    message: 'This PI is not available. It may have been removed.' },
  { marker: 'do not have permission', code: 'FORBIDDEN',
    message: 'You do not have permission to do this.' },
  { marker: 'cannot be submitted by you', code: 'FORBIDDEN',
    message: 'This PI can no longer be submitted. Refresh to see its current state.' },
]

const FALLBACK: Record<SubmissionAction, string> = {
  submit: 'This PI could not be submitted just now. Try again in a moment.',
  request_changes: 'This PI could not be sent back just now. Try again in a moment.',
  reject: 'This PI could not be rejected just now. Try again in a moment.',
}

/**
 * A failed action, in the words the screen shows.
 *
 * Takes the raw error OBJECT rather than a message string, deliberately: the
 * screens never touch `.message` themselves, so no page can accidentally render
 * one, and the extraction lives in the one place that is tested for never
 * returning what it was given.
 */
export function describeSubmissionFailure(error: unknown, action: SubmissionAction): SubmissionFailure {
  const raw = typeof error === 'string'
    ? error
    : String((error as { message?: unknown } | null)?.message ?? '')

  const known = FAILURE_MESSAGES.find(entry => raw.includes(entry.marker))
  if (known) return { code: known.code, message: known.message }
  return { code: 'UNKNOWN', message: FALLBACK[action] }
}

// ── The status banner ─────────────────────────────────────────────────────────

export type SubmissionBannerTone = 'blue' | 'amber' | 'red' | 'green'

export type SubmissionBanner = {
  tone: SubmissionBannerTone
  title: string
  /**
   * One sentence about where the record stands: who acted, and when.
   *
   * THE MANAGEMENT NOTE IS NOT IN HERE, deliberately. It is somebody's own
   * words, of any length, and it already has a place of its own on the overview
   * card where it is rendered verbatim as multiline text. Folding it into this
   * sentence would print it twice on a returned submission and squeeze a
   * paragraph into a strip built for a line.
   */
  body: string
}

export type SubmissionBannerInput = {
  status: string
  /** Already formatted for display, or null. This module does no date work. */
  submittedAt: string | null
  submitterName: string | null
  rejectedAt: string | null
  rejectedByName: string | null
}

const who = (name: string | null): string => (name && name.trim() !== '' ? name.trim() : 'a colleague')
const when = (at: string | null): string => (at && at.trim() !== '' ? at.trim() : 'an earlier date')

/**
 * One contextual line about where this record stands, or null for a draft.
 *
 * A draft gets nothing on purpose: the status badge in the overview already says
 * "Draft", and a banner repeating it would be a permanent strip of screen spent
 * on the state every new record is in.
 */
export function describeSubmissionBanner(input: SubmissionBannerInput): SubmissionBanner | null {
  switch (input.status) {
    case 'submitted':
      return {
        tone: 'blue',
        title: 'Waiting for management review',
        body: `Submitted by ${who(input.submitterName)} on ${when(input.submittedAt)}. Nothing on this PI can be changed while it is under review.`,
      }
    case 'needs_changes':
      return {
        tone: 'amber',
        title: 'Management asked for changes',
        body: 'Correct the PI in Excel, upload it again with Change PI, then submit it for approval once more.',
      }
    case 'rejected':
      return {
        tone: 'red',
        title: 'Rejected by management',
        body: `Rejected by ${who(input.rejectedByName)} on ${when(input.rejectedAt)}. This record is closed and stays read-only.`,
      }
    case 'approved':
      return {
        tone: 'green',
        title: 'Approved',
        body: 'This PI has been approved and is read-only here.',
      }
    default:
      return null
  }
}

// ── The Change PI route ───────────────────────────────────────────────────────

/**
 * Where Change PI goes: the EXISTING upload screen, carrying the submission it
 * must replace the workbook on.
 *
 * A query parameter rather than a new route, because the screen it opens is the
 * same screen in every other respect — the same parser, the same upload, the
 * same trusted server pass, the same lease and rollback rules. A second route
 * would be a second copy of all of that.
 *
 * The id is not a capability. It reaches the import screen, which re-reads the
 * submission under the caller's own RLS and refuses anything they may not edit,
 * and it reaches the server, which re-derives ownership and editability from the
 * database before a single byte is written.
 */
export const CHANGE_PI_PARAM = 'submissionId'

export function changePiHref(submissionId: string): string {
  return `/orders/import?${CHANGE_PI_PARAM}=${encodeURIComponent(submissionId)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The submission id in a Change PI link, or null.
 *
 * Anything that is not a uuid is not a submission id, and is dropped rather than
 * sent to the database as a query parameter. A caller who supplies somebody
 * else's real id gets the same "not available" answer the drafts pages give,
 * because the read behind this is RLS's.
 */
export function readChangePiTarget(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim()
  return UUID.test(candidate) ? candidate.toLowerCase() : null
}
