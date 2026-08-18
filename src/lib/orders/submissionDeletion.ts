// Permanently deleting a PI submission: who may, when, and what anybody is told
// when it does not work.
//
// WHY A MODULE AND NOT INLINE CONDITIONS
// --------------------------------------
// The rule is three facts wide — the record's status, whether the viewer owns
// it, and whether they are an administrator — and it is asked in three places:
// the PI Drafts list decides whether to draw the control, the confirmation
// dialog decides what to warn about, and the API route decides whether to
// attempt anything at all. Written inline that is three copies of one rule, and
// the day one of them drifts a Delete button appears for somebody the database
// will refuse — or, worse, does not appear for somebody it would allow.
//
// NONE OF THIS IS AUTHORIZATION. Every rule below decides what to RENDER and
// what to attempt. begin_order_submission_deletion() re-derives the actor, the
// ownership, the status and the administrator check inside the database, under a
// row lock, before anything is destroyed — so a hidden control is a courtesy and
// a defeated one gets a refusal from Postgres.
//
// DELETION IS THREE CALLS, NOT ONE, and the shape matters to the copy below:
// the record is RESERVED first, the files are removed second, and the row is
// erased third. While the reservation stands nothing can submit, replace or
// transition the PI, so the third call cannot be refused by a race — which is
// why there is no failure message here about files having been removed from a
// PI that survived. That state is unreachable.
//
// THE MATRIX, and it is the whole of it:
//
//                     owner   admin   anybody else
//   draft              yes     yes        no
//   needs_changes      yes     yes        no
//   rejected           yes     yes        no
//   submitted           NO      NO        no
//   approved            NO      NO        no
//   anything else       NO      NO        no
//
// NOT A PERMISSION. orders.view_all, orders.approve_order,
// orders.approve_advance_exception, Manager level and Contributor level all
// grant nothing here, and orders.delete means "remove an Order Request"
// (20260901000000) and is not consulted. See the migration header for why.

import { PI_DRAFT_STATUS_LABEL, isPiDraftStatus } from './draftsView'

// ── The rule ──────────────────────────────────────────────────────────────────

/**
 * The statuses a PI may be deleted from.
 *
 * AN ALLOW-LIST, mirroring public.order_submission_deletable_statuses(). A
 * status this does not name is refused, so anything a later phase invents fails
 * closed here exactly as it does in the database.
 */
export const DELETABLE_SUBMISSION_STATUSES: readonly string[] = [
  'draft',
  'needs_changes',
  'rejected',
]

export function submissionStatusIsDeletable(status: string | null | undefined): boolean {
  return typeof status === 'string' && DELETABLE_SUBMISSION_STATUSES.includes(status)
}

export type DeletionActor = {
  /** The signed-in user's id, or null while it is still unknown. */
  userId: string | null
  /** The project's established administrator check: users.role === 'admin'. */
  isAdmin: boolean
}

export type DeletableSubmission = {
  status: string
  /** The pair can_edit_order_submission reads. Either one is ownership. */
  created_by: string | null
  submitted_by: string | null
}

/**
 * Whether THIS viewer may delete THIS PI.
 *
 * Ownership is created_by OR submitted_by, the same pair the database's
 * order_submission_deletable_by() reads — an assistant submitting on somebody's
 * behalf must not lock the record away from either of them.
 *
 * Being the assigned REVIEWER is not ownership and confers nothing.
 */
export function canDeleteSubmission(
  submission: DeletableSubmission,
  actor: DeletionActor,
): boolean {
  if (!submissionStatusIsDeletable(submission.status)) return false
  if (actor.isAdmin) return true
  if (!actor.userId) return false
  return submission.created_by === actor.userId || submission.submitted_by === actor.userId
}

// ── Copy ──────────────────────────────────────────────────────────────────────

export const DELETE_PI_ACTION_LABEL = 'Delete PI'
/** The accessible name of the icon-only control in the list. */
export const DELETE_PI_ARIA_LABEL = 'Delete PI'
export const DELETE_PI_DIALOG_TITLE = 'Delete PI?'
export const DELETE_PI_CONFIRM_LABEL = 'Delete PI'
export const DELETE_PI_CANCEL_LABEL = 'Cancel'
export const DELETE_PI_BUSY_LABEL = 'Deleting…'

/**
 * What is about to be destroyed, said in full.
 *
 * IT NAMES THE FILES, because the record on screen is a table of numbers and
 * somebody agreeing to remove it may not picture the workbook and the
 * photographs going with it. And it says the word that matters — permanently —
 * rather than "remove", which reads as "hide".
 *
 * NO TYPED CONFIRMATION. The action is reversible in the only sense that counts:
 * the PI can be uploaded again. Making somebody type a client name to delete
 * their own draft is ceremony that trains people to type without reading.
 */
export const DELETE_PI_WARNING =
  'This will permanently delete the PI, its workbook, product images and activity history. '
  + 'This action cannot be undone.'

export const DELETE_PI_SUCCESS = 'PI deleted.'

/** The status, in the words the rest of Orders uses. Never a raw enum value. */
export function deletionStatusLabel(status: string | null | undefined): string {
  return isPiDraftStatus(status) ? PI_DRAFT_STATUS_LABEL[status] : (status ?? '—')
}

// ── Failures ──────────────────────────────────────────────────────────────────

/**
 * The stable codes the route returns, and nothing else ever reaches the screen.
 *
 * THE DATABASE MESSAGE IS NEVER SHOWN. A Postgres error carries the statement's
 * own text — column names, the submission id, occasionally a value — and none of
 * it is anything an employee can act on. The route reads which marker the error
 * contains and returns one of these; the screen turns it into a sentence.
 */
export type SubmissionDeletionCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'STATUS_CHANGED'
  | 'NOT_FOUND'
  | 'IN_PROGRESS'
  | 'CLAIM_INVALID'
  | 'STORAGE_CLEANUP_FAILED'
  | 'DELETE_FAILED'

export type SubmissionDeletionFailure = {
  code: SubmissionDeletionCode
  message: string
  /**
   * True when the row's state on screen is known to be stale, so the list
   * refreshes rather than leaving a Delete control the database has refused.
   */
  refresh: boolean
}

const FAILURE_COPY: Record<SubmissionDeletionCode, { message: string; refresh: boolean }> = {
  UNAUTHORIZED: {
    message: 'Your session has expired. Sign in again and try once more.',
    refresh: false,
  },
  FORBIDDEN: {
    message: 'Only the person who owns this PI, or an administrator, can delete it.',
    refresh: true,
  },
  // The one an employee is most likely to meet: they opened the dialog on a
  // draft and submitted it in another tab while it was open.
  STATUS_CHANGED: {
    message: 'This PI is now under review and cannot be deleted. Its status has been refreshed.',
    refresh: true,
  },
  NOT_FOUND: {
    message: 'This PI has already been deleted.',
    refresh: true,
  },
  // NEUTRAL, NOT AN ERROR. A second click, or a second tab, on a deletion that
  // is already running. Nothing is wrong and nothing needs retrying — the PI is
  // on its way out, and saying so is more use than an alarm.
  IN_PROGRESS: {
    message: 'This PI is already being deleted.',
    refresh: true,
  },
  // The reservation was released or taken over by another attempt before this
  // one could finish. Nothing was deleted by THIS request.
  CLAIM_INVALID: {
    message: 'This deletion was interrupted and did not complete. Try again.',
    refresh: true,
  },
  // TRUTHFUL RATHER THAN REASSURING. The reservation is released, the record and
  // every one of its file references survive, and saying so is what makes the
  // retry safe: object removal is idempotent, so running it again converges
  // instead of compounding.
  STORAGE_CLEANUP_FAILED: {
    message: 'The PI’s files could not be removed, so nothing was deleted. Try again in a moment.',
    refresh: false,
  },
  DELETE_FAILED: {
    message: 'This PI could not be deleted just now. Try again in a moment.',
    refresh: true,
  },
}

/**
 * The stable markers the RPC raises, in the order they are matched.
 *
 * Ordered longest-marker-first where one contains another, so a status refusal
 * is never answered as a permission refusal.
 */
const RPC_MARKERS: readonly { marker: string; code: SubmissionDeletionCode }[] = [
  // The two DELETION_ markers come first: 'ORDER_SUBMISSION_DELETION_CLAIMED'
  // shares no prefix with the DELETE_ ones, but ordering them deliberately is
  // cheaper than relying on that staying true.
  { marker: 'ORDER_SUBMISSION_DELETION_IN_PROGRESS',  code: 'IN_PROGRESS' },
  { marker: 'ORDER_SUBMISSION_DELETION_CLAIM_INVALID', code: 'CLAIM_INVALID' },
  // Raised by the guard when something tried to change a reserved PI. It reaches
  // this mapper only if a deletion somehow contends with itself.
  { marker: 'ORDER_SUBMISSION_DELETION_CLAIMED',      code: 'IN_PROGRESS' },
  { marker: 'ORDER_SUBMISSION_DELETE_STATUS',  code: 'STATUS_CHANGED' },
  { marker: 'ORDER_SUBMISSION_DELETE_MISSING', code: 'NOT_FOUND' },
  { marker: 'ORDER_SUBMISSION_DELETE_DENIED',  code: 'FORBIDDEN' },
  { marker: 'Authentication required',         code: 'UNAUTHORIZED' },
  { marker: 'This account is not active',      code: 'FORBIDDEN' },
]

/** Which code a raw database error means. Used by the route, never by a page. */
export function classifyDeletionError(error: unknown): SubmissionDeletionCode {
  const raw = typeof error === 'string'
    ? error
    : String((error as { message?: unknown } | null)?.message ?? '')
  return RPC_MARKERS.find(entry => raw.includes(entry.marker))?.code ?? 'DELETE_FAILED'
}

export function isSubmissionDeletionCode(value: unknown): value is SubmissionDeletionCode {
  return typeof value === 'string' && value in FAILURE_COPY
}

/**
 * A failed deletion, in the words the screen shows.
 *
 * Takes whatever the route returned — a known code, an unknown string, or
 * nothing at all — and always produces a sentence, so no failure path can leave
 * a dialog with an empty error box.
 */
export function describeDeletionFailure(code: unknown): SubmissionDeletionFailure {
  const known: SubmissionDeletionCode = isSubmissionDeletionCode(code) ? code : 'DELETE_FAILED'
  return { code: known, ...FAILURE_COPY[known] }
}
