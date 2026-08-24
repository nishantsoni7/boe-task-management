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
// A RACE IS NOT THE ONLY WAY THE THIRD CALL CAN BE REFUSED, and assuming it was
// is what stranded a PI in production. The reservation freezes the submission
// and its three own child tables. It does NOT freeze — and could not usefully
// freeze — the records OTHER modules keep about this PI, and three of those name
// it through a foreign key Postgres will not let go of:
//
//   finance_payment_allocations.order_submission_id        (20260918000000)
//   order_submission_correction_requests.submission_id     (20260930000000)
//   orders.source_order_submission_id                      (20260915000000)
//
// All three are NO ACTION, none of them is deleted by
// finalize_order_submission_deletion(), and every one of them is a record this
// system is right to protect: money, and what somebody asked to have corrected.
// So finalization was refused with a raw constraint error AFTER the workbook and
// every product image had already been destroyed, and the reservation — which is
// deliberately kept on that path, because the files really are gone — had no
// remaining route to completion. See BLOCKED below.
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
 * What the destructive button says once an attempt has failed recoverably.
 *
 * IT IS A DIFFERENT WORD FOR A DIFFERENT ACT. Pressing Delete PI a second time
 * looks, to the person doing it, like repeating something that did not work.
 * "Retry deletion" says the thing they are actually doing: resuming an
 * interrupted deletion, which the protocol is built to converge on rather than
 * to compound.
 */
export const DELETE_PI_RETRY_LABEL = 'Retry deletion'

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
  | 'BLOCKED'
  | 'STORAGE_CLEANUP_FAILED'
  | 'DELETE_FAILED'

// ── What still refers to this PI ──────────────────────────────────────────────

/**
 * The record kinds that keep a PI alive, and the reason each one does.
 *
 * ONE LIST, DERIVED FROM THE FOREIGN KEYS THEMSELVES, not from a guess about
 * which modules care. Every NO ACTION foreign key pointing at
 * public.order_submissions is here, and a kind that is not here is one Postgres
 * would refuse silently — which is exactly the failure this list exists to end.
 *
 * NONE OF THEM IS EVER REMOVED TO MAKE A DELETION SUCCEED. An allocation records
 * money that was received; a correction request records what somebody asked to
 * have changed; a Confirmed Order is the business record the PI became. Deleting
 * any of them to clear the way would be destroying the very history the refusal
 * is protecting, so the refusal is the answer and the person is told what to do
 * about it instead.
 */
export type DeletionBlockerKind =
  | 'payment_allocation'
  | 'correction_request'
  | 'confirmed_order'

export type DeletionBlocker = {
  kind: DeletionBlockerKind
  /** How many such records name this PI. Never an id, and never an amount. */
  count: number
}

export const DELETION_BLOCKER_KINDS: readonly DeletionBlockerKind[] = [
  'payment_allocation',
  'correction_request',
  'confirmed_order',
]

export function isDeletionBlockerKind(value: unknown): value is DeletionBlockerKind {
  return typeof value === 'string'
    && (DELETION_BLOCKER_KINDS as readonly string[]).includes(value)
}

/**
 * Whatever the route returned, as blockers this module can describe.
 *
 * THE BROWSER IS NOT TRUSTED WITH ITS OWN RESPONSE EITHER. The dialog renders
 * this text, so an unknown kind or a nonsense count must produce nothing rather
 * than a sentence assembled out of it.
 */
export function parseDeletionBlockers(value: unknown): DeletionBlocker[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<DeletionBlockerKind>()
  const blockers: DeletionBlocker[] = []
  for (const entry of value) {
    const kind = (entry as { kind?: unknown } | null)?.kind
    const count = (entry as { count?: unknown } | null)?.count
    if (!isDeletionBlockerKind(kind) || seen.has(kind)) continue
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) continue
    seen.add(kind)
    blockers.push({ kind, count })
  }
  return DELETION_BLOCKER_KINDS
    .map(kind => blockers.find(blocker => blocker.kind === kind))
    .filter((blocker): blocker is DeletionBlocker => blocker !== undefined)
}

const BLOCKER_SENTENCE: Record<DeletionBlockerKind, (count: number) => string> = {
  // THE REMEDY IS NAMED, because "a payment is allocated to this PI" is a
  // dead end on its own: the allocation is never deleted in its own right, and
  // the only thing that releases one is deleting the payment entry it belongs
  // to — which Finance allows while that payment is still unapproved and
  // refuses once it is not.
  //
  // IT NO LONGER TELLS THE READER TO GO AND DO IT. The earlier wording — "Delete
  // that payment entry in Finance first" — was an instruction addressed to
  // whoever happened to be looking, and two things made it a promise the product
  // could not keep. The only DELETE policies on finance_payment_requests are the
  // creator's own and an administrator's, so a reader who is neither cannot
  // carry it out; and this count includes the allocations of VERIFIED payments,
  // which nobody can delete at all. So the sentence now says who can do it and
  // when it is possible, and leaves the reader to decide whether that is them.
  payment_allocation: count => count === 1
    ? 'A payment is allocated to this PI. That allocation is released only by deleting the'
      + ' payment entry in Finance, which the person who raised it or an administrator can do'
      + ' while the payment is still unapproved.'
    : `${count} payments are allocated to this PI. Those allocations are released only by deleting`
      + ' the payment entries in Finance, which the person who raised each one or an administrator'
      + ' can do while that payment is still unapproved.',
  correction_request: count => count === 1
    ? 'A correction request belongs to this PI, and a correction request is kept permanently.'
    : `${count} correction requests belong to this PI, and a correction request is kept permanently.`,
  confirmed_order: () =>
    'A Confirmed Order was created from this PI, so the PI is its source record and stays.',
}

/**
 * Why this PI is still here, in the words the dialog shows.
 *
 * COUNTS AND KINDS ONLY. No id, no amount, no payment reference and no client
 * name: the reader already knows which PI they are looking at, and everything
 * else would be telling a browser about records its own row-level security may
 * well forbid it to read.
 */
export function describeDeletionBlockers(blockers: readonly DeletionBlocker[]): string {
  const sentences = parseDeletionBlockers(blockers)
    .map(blocker => BLOCKER_SENTENCE[blocker.kind](blocker.count))
  return sentences.length === 0
    ? 'Another record still refers to this PI, so it cannot be deleted.'
    : sentences.join(' ')
}

/**
 * Where a reader goes to deal with a payment that is holding a PI.
 *
 * THE LIST, NOT A RECORD. It is the Received Payments list and nothing more
 * specific: an allocated payment awaiting verification appears there, and a link
 * to the page discloses nothing, whereas a link naming the payment would tell a
 * browser about a row its own row-level security may forbid it to read.
 */
export const PAYMENT_BLOCKER_HREF = '/finance/received'
export const PAYMENT_BLOCKER_LINK_LABEL = 'Open Received Payments'

export type SubmissionDeletionFailure = {
  code: SubmissionDeletionCode
  message: string
  /**
   * True when the row's state on screen is known to be stale, so the list
   * refreshes rather than leaving a Delete control the database has refused.
   */
  refresh: boolean
  /**
   * Whether pressing the button again is a sensible thing to do.
   *
   * TRUE MEANS "THIS CONVERGES". Every stage of the deletion is idempotent — a
   * key already removed is not removed twice, a claim already held by this
   * caller is finished rather than retaken, a row already gone answers with
   * success — so a second attempt at an interrupted deletion finishes it. FALSE
   * means the answer will not change until something outside this dialog does,
   * and offering a red button that cannot work is worse than offering none.
   */
  retryable: boolean
  /**
   * True for the one refusal that is not a fault: another record legitimately
   * depends on this PI. Rendered differently, because nothing is wrong and
   * nothing is going to be fixed by waiting.
   */
  blocked: boolean
  /**
   * Which kinds are in the way, when the route said. Lets a surface offer the
   * Finance route for a payment blocker without re-parsing the message.
   */
  blockerKinds?: readonly DeletionBlockerKind[]
}

type FailureCopy = Omit<SubmissionDeletionFailure, 'code'>

const FAILURE_COPY: Record<SubmissionDeletionCode, FailureCopy> = {
  UNAUTHORIZED: {
    message: 'Your session has expired. Sign in again and try once more.',
    refresh: false, retryable: false, blocked: false,
  },
  FORBIDDEN: {
    message: 'Only the person who owns this PI, or an administrator, can delete it.',
    refresh: true, retryable: false, blocked: false,
  },
  // The one an employee is most likely to meet: they opened the dialog on a
  // draft and submitted it in another tab while it was open.
  STATUS_CHANGED: {
    message: 'This PI is now under review and cannot be deleted. Its status has been refreshed.',
    refresh: true, retryable: false, blocked: false,
  },
  NOT_FOUND: {
    message: 'This PI has already been deleted.',
    refresh: true, retryable: false, blocked: false,
  },
  // NEUTRAL, NOT AN ERROR, AND NOT A DEAD END EITHER. Another request holds the
  // reservation and is still inside its time to live, which is what a second
  // click and a second tab both meet. It is not retryable *now* — the honest
  // instruction is to wait, because the attempt that holds it is either about to
  // finish the job or about to go stale and let this one take it over.
  IN_PROGRESS: {
    message: 'Deletion is currently in progress. Please wait, then try again.',
    refresh: true, retryable: false, blocked: false,
  },
  // The reservation was released or taken over by another attempt before this
  // one could finish. Nothing was deleted by THIS request.
  CLAIM_INVALID: {
    message: 'The previous deletion did not finish. Retry deletion.',
    refresh: true, retryable: true, blocked: false,
  },
  // NOT A FAULT. Something the business is right to keep still names this PI,
  // and the real reason replaces this sentence whenever the route could say
  // which record it was — see describeDeletionFailure.
  BLOCKED: {
    message: 'Another record still refers to this PI, so it cannot be deleted.',
    refresh: true, retryable: false, blocked: true,
  },
  // TRUTHFUL RATHER THAN REASSURING. The record and every one of its file
  // references survive, and saying so is what makes the retry safe: object
  // removal is idempotent, so running it again converges instead of compounding.
  STORAGE_CLEANUP_FAILED: {
    message: 'The PI’s files could not be removed, so nothing was deleted. Retry deletion.',
    refresh: false, retryable: true, blocked: false,
  },
  DELETE_FAILED: {
    message: 'This PI could not be deleted just now. Retry deletion in a moment.',
    refresh: true, retryable: true, blocked: false,
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
  // NOT A MARKER THIS SYSTEM CHOSE — Postgres wrote it, and it is the only
  // notice given when a NO ACTION foreign key refuses to let a referenced row
  // go. It is matched LAST so no deliberate marker is ever answered as a
  // constraint failure, and it is matched at all because the alternative is what
  // stranded a PI in production: a generic "could not be deleted just now" for a
  // condition that will still be true in a year.
  //
  // The route establishes the blocking records itself and does not rely on this,
  // but it can be beaten to the row by a payment allocated in the window between
  // that check and finalization — which is precisely when a truthful answer
  // matters most, because the files are already gone by then.
  { marker: 'violates foreign key constraint', code: 'BLOCKED' },
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
export function describeDeletionFailure(
  code: unknown,
  /**
   * What the route said is still referring to this PI, when it could say. Only
   * consulted for BLOCKED: for every other code it would be noise, and for an
   * unknown code it would be a sentence built on a value nothing has checked.
   */
  blockers?: unknown,
): SubmissionDeletionFailure {
  const known: SubmissionDeletionCode = isSubmissionDeletionCode(code) ? code : 'DELETE_FAILED'
  const copy = FAILURE_COPY[known]
  if (known !== 'BLOCKED') return { code: known, ...copy }
  const parsed = parseDeletionBlockers(blockers)
  return {
    code: known,
    ...copy,
    message: parsed.length === 0 ? copy.message : describeDeletionBlockers(parsed),
    blockerKinds: parsed.map(blocker => blocker.kind),
  }
}
