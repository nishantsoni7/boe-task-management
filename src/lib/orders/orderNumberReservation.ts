// ── The Order number, before there is an Order ────────────────────────────────
//
// THE PROBLEM THIS SOLVES. The revised PI a customer signs has to carry the
// Order number. The number was allocated as the Order row was inserted, inside
// approve_order_submission() — and the only stage at which a PI's own owner may
// replace its workbook is draft or needs_changes, which is before approval, when
// no number existed. So the number was never available at the one moment it was
// needed.
//
// IT IS NOT OPTIONAL FOR A NEW PI. A PI Draft created after 20261009000000 takes
// its number automatically, the moment its first workbook is parsed — nobody
// presses anything — and cannot be submitted or approved until a revised
// workbook actually carries it. A draft that predates the migration is
// grandfathered: it takes no number by itself, and reserves through the
// compatibility action below if and when somebody wants it to.
//
// WHAT IT IS NOT. It is not `max(order_number) + 1` shown on a screen. Two
// people asking at the same moment would be shown the same number, print it on
// two customers' documents, and discover the collision at approval — when one of
// the two is already signed. reserve_order_number_for_submission()
// (20261009000000) takes the number from the real cycle under the same FOR
// UPDATE lock an Order creation takes, and advances it. A number that is shown
// is a number that is spent.
//
// AND IT IS NEVER GIVEN BACK. An abandoned reservation leaves a gap in the
// series. A gap is a question somebody can answer from the record; a reused
// number is two commercial documents claiming to be the same Order, which
// nothing can answer afterwards.
//
// This file is the vocabulary and the gates of the panel that shows it. No
// React, no network: every rule below is a function a test can pin.

/** The one instruction the panel gives, in the product's own words. */
export const RESERVATION_INSTRUCTION =
  'Add this Order number to the revised PI, then upload the revised file.'

/**
 * The columns the reservation panel reads, named here so they and the module
 * that reads them cannot drift apart — the same arrangement PI_APPROVAL_COLUMNS
 * and PI_FINANCE_COLUMNS already have.
 *
 * SPREAD INTO PI_DRAFT_DETAIL_COLUMNS, not read separately. The PI detail page
 * reads its record ONCE, and that is a rule with a test on it: a second request
 * for four columns is a second round trip on the critical path of a page
 * somebody is waiting for.
 *
 * WHICH MEANS 20261009000000 MUST BE APPLIED BEFORE THIS CODE SHIPS. A select
 * naming a column that does not exist fails whole. Exactly the ordering
 * 20260923000000 required for `billing_percentage`, and stated the same way.
 *
 * source_workbook_sha256 travels with them because the revised-PI test compares
 * it against the hash captured at reservation, and one without the other would
 * leave the panel unable to say where the PI stands.
 *
 * source_order_number is NOT here and must not be: the workbook's own number is
 * normally the number of whatever older PI this one was copied from, and no PI
 * screen renders it — a rule draftsAccess.test.ts holds these pages to.
 */
export const PI_RESERVATION_COLUMNS: readonly string[] = [
  // Whether the workflow is mandatory for this PI. It decides the panel's
  // WORDING and nothing else — a new draft is told its number is coming, a
  // grandfathered one is offered the compatibility action — and the database
  // decides both.
  'reservation_required',
  'reserved_order_number',
  'reserved_order_number_at',
  'reserved_number_workbook_sha256',
  'reserved_order_number_used_at',
  'source_workbook_sha256',
]

/**
 * Those columns as they arrive on the row.
 *
 * Every one nullable, and NULL is the ordinary case: a PI that has reserved
 * nothing carries nothing here, which is the truth about it.
 *
 * OPTIONAL rather than required, so a fixture or a caller that predates the
 * feature still describes a submission. Every reader coalesces to null, so an
 * absent field and a null one are the same answer — which they are.
 */
export type PiReservationFields = {
  reservation_required?: boolean | null
  reserved_order_number?: string | null
  reserved_order_number_at?: string | null
  reserved_number_workbook_sha256?: string | null
  reserved_order_number_used_at?: string | null
  source_workbook_sha256?: string | null
}

export const RESERVE_ACTION_LABEL = 'Reserve Order number'
export const RESERVED_HEADING     = 'Reserved Order number'

/**
 * THE TWO NUMBERS A PI SCREEN MAY SHOW, named apart so they can never be read as
 * one another.
 *
 *   reserved   taken from the Confirmed Order cycle and held for this PI. It is
 *              what goes on the revised document.
 *   confirmed  the number the Confirmed Order actually came out with. Equal to
 *              `reserved` where one was held, and the cycle's next number where
 *              none was.
 *
 * AND THE THIRD IS NOT A NUMBER THESE SCREENS SHOW. `source_order_number` — the
 * workbook's own B20 — is normally the number of whatever older PI this one was
 * copied from, and no PI screen renders it: beside a reserved Order number it
 * could only be read as a rival answer to the same question. A PI Draft has no
 * Order number of its own, which is what NO_PI_NUMBER_NOTE says out loud rather
 * than leaving to be inferred from an empty space.
 */
export type PiNumberSet = {
  reserved: string | null
  confirmed: string | null
}

export const NUMBER_LABEL: Record<keyof PiNumberSet, string> = {
  reserved:  RESERVED_HEADING,
  confirmed: 'Confirmed Order number',
}

/** Said whenever there is no reservation, so the absence is stated, not implied. */
export const NO_PI_NUMBER_NOTE =
  'A PI Draft has no Order number of its own — the reference inside the file is not one.'

/** What the panel is being asked to say. One of five, never two. */
export type ReservationState =
  /** No number, and this viewer may take one. */
  | 'available'
  /** No number, and something stops one being taken. */
  | 'blocked'
  /** Held, and no revised PI has been uploaded since. */
  | 'awaiting_revised_pi'
  /** Held, and a different workbook has been uploaded since it was taken. */
  | 'revised_pi_uploaded'
  /** The Confirmed Order exists and carries it. */
  | 'used'

export type ReservationView = {
  state: ReservationState
  /** The reserved number, when there is one. */
  number: string | null
  /** One sentence saying where this PI stands. Never empty. */
  standing: string
  /** Why the action is unavailable, when it is. Null otherwise. */
  blockedReason: string | null
  /** Whether to draw the copy control — only ever beside a real number. */
  canCopy: boolean
}

/**
 * Whether NO revised PI has been uploaded since the number was issued.
 *
 * THE FIRST HALF OF THE DATABASE'S TEST, and only the first half. The rule has
 * two parts — a workbook must have been re-parsed since the number was issued,
 * AND the number it parsed to must be the reserved one — and this screen can
 * only see the first. The second reads the parsed cell, which no PI screen
 * renders: the workbook's own B20 is normally the number of whatever older PI
 * this one was copied from, and putting it beside a reserved Order number would
 * offer a reader two rival answers to one question.
 *
 * SO THIS IS A WORDING HINT, NOT A VERDICT. `false` means "a revised file has
 * arrived", never "you are ready" — and the panel says exactly that much. The
 * verdict is the server's, and it arrives as a refusal on submit
 * (revisedPiRefusalMessage below), which names both numbers because it can.
 *
 * A MISSING LIVE HASH COUNTS AS OUTSTANDING: it is not evidence that a revised
 * workbook exists, and order_submission_revised_pi_refusal() refuses it for
 * exactly that reason.
 */
export function revisedPiOutstanding(input: {
  reservedWorkbookSha256: string | null | undefined
  currentWorkbookSha256: string | null | undefined
}): boolean {
  if (!input.currentWorkbookSha256) return true
  return input.currentWorkbookSha256 === input.reservedWorkbookSha256
}

/**
 * The one normalization applied before an Order number read out of a workbook is
 * compared — mirroring normalize_order_number_reference() in SQL exactly.
 *
 * WHY IT EXISTS IN TYPESCRIPT AT ALL, given the comparison is the database's:
 * so the rule can be stated once in a test that reads like the rule, and so a
 * future screen that needs to explain the rule does not invent a second one.
 * Nothing in the browser decides an approval with it.
 *
 * IT DOES NOT STRIP LEADING ZEROS. They are part of the identifier
 * (20260704000000 §4), so 42 is not 0042 and a document printed with 42 carries
 * the wrong number.
 */
export function normalizeOrderNumberReference(value: string | null | undefined): string | null {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  return collapsed === '' ? null : collapsed
}

/**
 * Why a number cannot be reserved right now, or null when it can.
 *
 * MIRRORS reserve_order_number_for_submission()'s OWN REFUSALS, in its order, so
 * the control is offered exactly when the write would land. It is a DRAWING
 * rule and authorizes nothing: the RPC re-derives the actor, re-asks the
 * workbook-editor authority and re-reads the PI under its own lock.
 */
export function reservationBlockedReason(input: {
  status: string
  hasOrder: boolean
  deletionClaimed: boolean
  hasWorkbook: boolean
  canEditWorkbook: boolean
}): string | null {
  if (input.hasOrder || input.status === 'approved') {
    return 'This PI has already become an Order and carries its number.'
  }
  if (input.status === 'rejected') {
    return 'A rejected PI cannot reserve an Order number.'
  }
  if (input.deletionClaimed) {
    return 'This PI is reserved for deletion and cannot reserve an Order number.'
  }
  if (input.status !== 'draft' && input.status !== 'needs_changes') {
    // Said as the stage rule rather than as "you cannot": the number is
    // reserved before review precisely so the owner can still upload the
    // revised file, and after submission they cannot.
    return 'An Order number is reserved while the PI is a draft or has been returned for changes — the stages at which the revised file can still be uploaded.'
  }
  if (!input.hasWorkbook) {
    return 'Upload the PI file first — the reserved number has to go into it.'
  }
  if (!input.canEditWorkbook) {
    return 'Only this PI’s owner, or an admin, can reserve its Order number.'
  }
  return null
}

/** Everything the panel renders, resolved once. */
export function describeReservation(input: {
  reserved: string | null | undefined
  reservedWorkbookSha256: string | null | undefined
  currentWorkbookSha256: string | null | undefined
  usedAt: string | null | undefined
  confirmedNumber: string | null | undefined
  status: string
  hasOrder: boolean
  deletionClaimed: boolean
  hasWorkbook: boolean
  canEditWorkbook: boolean
  /**
   * Whether this PI must hold a reserved number before it can be submitted —
   * order_submissions.reservation_required. TRUE for every draft created after
   * 20261009000000, FALSE for the grandfathered population.
   *
   * It changes the WORDING, never the gate: a new draft is told the number is
   * coming, a legacy one is offered the choice, and the database decides both.
   */
  reservationRequired?: boolean | null
}): ReservationView {
  const number = input.reserved ?? null

  if (number && (input.usedAt || input.confirmedNumber)) {
    return {
      state: 'used',
      number,
      standing: input.confirmedNumber && input.confirmedNumber !== number
        // Cannot happen through the approval path — the Order is created WITH
        // the reservation — so it is stated plainly rather than smoothed over.
        ? `This PI reserved ${number}, but the Confirmed Order was created as ${input.confirmedNumber}.`
        : `The Confirmed Order was created as ${number}, the number reserved for this PI.`,
      blockedReason: null,
      canCopy: true,
    }
  }

  if (number) {
    const outstanding = revisedPiOutstanding(input)
    return {
      state: outstanding ? 'awaiting_revised_pi' : 'revised_pi_uploaded',
      number,
      // THE SECOND SENTENCE PROMISES NOTHING. A revised file having arrived is
      // not the same as it carrying the right number, and only the server knows
      // which — so this says what it can see and names when the answer comes.
      standing: outstanding
        ? `${number} is held for this PI. ${RESERVATION_INSTRUCTION}`
        : `${number} is held for this PI, and a revised file has been uploaded since it was issued. It is checked against ${number} when the PI is submitted for review.`,
      blockedReason: null,
      canCopy: true,
    }
  }

  const blocked = reservationBlockedReason(input)
  const required = Boolean(input.reservationRequired)

  // A NEW DRAFT IS NOT BEING OFFERED A CHOICE. Its number is issued the moment
  // its first PI is uploaded, by the database, with no control to press — so the
  // wording says what is about to happen rather than inviting a decision. The
  // only reason it can be sitting here with no number is that no PI file has
  // been uploaded yet, which is what the blocked reason will already say.
  if (required) {
    return {
      state: blocked ? 'blocked' : 'available',
      number: null,
      standing: blocked
        ? `No Order number has been reserved for this PI yet. ${NO_PI_NUMBER_NOTE}`
        : `An Order number is issued for this PI as soon as its PI file is uploaded, and the revised PI must carry it before the PI can be submitted for review. ${NO_PI_NUMBER_NOTE}`,
      blockedReason: blocked,
      canCopy: false,
    }
  }

  return {
    state: blocked ? 'blocked' : 'available',
    number: null,
    standing: blocked
      ? `No Order number has been reserved for this PI. ${NO_PI_NUMBER_NOTE}`
      : `${NO_PI_NUMBER_NOTE} Reserve one now if the revised PI has to carry it — it is taken from the Order series and held for this PI alone.`,
    blockedReason: blocked,
    canCopy: false,
  }
}

/**
 * The message out of whatever the client handed back, and nothing else.
 *
 * TAKES THE ERROR, NOT ITS MESSAGE, on purpose: the PI screens are held to a
 * rule that the raw database text never appears in their own source at all —
 * `error.message` is forbidden there by draftsAccess.test.ts, because the one
 * place it is written is the one place somebody can pass it on to a screen. So
 * the extraction lives here, beside the mapping that makes it safe, exactly as
 * describeSubmissionFailure() does it.
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const value = (error as { message?: unknown }).message
    if (typeof value === 'string') return value
  }
  return ''
}

/** Server refusals, mapped to a sentence naming the rule that refused. */
export function reservationErrorMessage(error: unknown): string {
  const m = messageOf(error)

  if (m.includes('ORDER_NUMBER_RESERVATION_STAGE')) {
    return 'An Order number can only be reserved while the PI is a draft or has been returned for changes.'
  }
  if (m.includes('ORDER_NUMBER_RESERVATION_NO_WORKBOOK')) {
    return 'Upload the PI file first — the reserved number has to go into it.'
  }
  if (m.includes('ORDER_SUBMISSION_NOT_OWNED')) {
    return 'Only this PI’s owner, or an admin, can reserve its Order number.'
  }
  if (m.includes('ORDER_SUBMISSION_FORBIDDEN')) {
    return 'You do not have permission to reserve an Order number.'
  }
  if (m.includes('ORDER_SUBMISSION_NOT_EDITABLE')) {
    return 'This PI has left draft, so its Order number can no longer be reserved here.'
  }
  if (m.includes('ORDER_SUBMISSION_DELETION_CLAIMED')) {
    return 'This PI is reserved for deletion and cannot reserve an Order number.'
  }
  if (m.includes('ORDER_SUBMISSION_CONVERTED')) {
    return 'This PI has already become an Order and carries its number.'
  }
  if (m.includes('ORDER_SUBMISSION_REJECTED')) {
    return 'A rejected PI cannot reserve an Order number.'
  }
  if (m.includes('ORDER_NUMBER_CYCLE_EXHAUSTED')) {
    return 'Order numbers have reached 9999. An administrator has to decide on the numbering before another can be issued.'
  }
  if (m.includes('ORDER_NUMBER_CYCLE_BEHIND') || m.includes('ORDER_NUMBER_CYCLE_INVALID')) {
    return 'The Order numbering is misconfigured, so no number can be issued. Ask an administrator to check it.'
  }
  if (m.includes('ORDER_NUMBER_CYCLE_MISSING')) {
    return 'Order numbering is not configured. Ask an administrator to set it up.'
  }
  if (m.includes('ORDER_NUMBER_IN_USE')) {
    return 'That Order number is already in use. Refresh and try again.'
  }

  return 'The Order number could not be reserved. Nothing was issued — refresh and try again.'
}

/**
 * Approval-time refusals that belong to the reservation, so the review screen
 * says WHY rather than showing a database string.
 *
 * Returns null for anything that is not a reservation refusal, so a caller can
 * fall through to its own existing mapping rather than swallowing every error.
 */
export function reservationApprovalMessage(error: unknown): string | null {
  const m = messageOf(error)

  // THE MISMATCH MESSAGE IS THE SERVER'S OWN, PASSED THROUGH. It is the one
  // refusal on this screen that names two numbers — what the file says and what
  // is reserved — and neither is knowable here: no PI screen reads the parsed
  // cell. Rewriting it into a fixed sentence would throw away the only fact that
  // makes it actionable.
  if (m.includes('ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH')) {
    return afterCode(m, 'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH')
  }
  if (m.includes('ORDER_SUBMISSION_REVISED_PI_NO_NUMBER')) {
    return afterCode(m, 'ORDER_SUBMISSION_REVISED_PI_NO_NUMBER')
  }
  if (m.includes('ORDER_SUBMISSION_REVISED_PI_MISSING')) {
    return afterCode(m, 'ORDER_SUBMISSION_REVISED_PI_MISSING')
  }
  if (m.includes('ORDER_SUBMISSION_RESERVATION_REQUIRED')) {
    return 'This PI has no Order number yet. Upload the PI file so a number can be issued, then put that number into the revised PI.'
  }
  if (m.includes('ORDER_FROM_RESERVED_PI_REQUIRES_APPROVAL')) {
    return 'An Order for this PI can only be created by approving it.'
  }
  if (m.includes('ORDER_NUMBER_RESERVATION_IN_USE')) {
    return 'The Order number reserved for this PI is already in use. Nothing was approved — ask an administrator to check the numbering.'
  }
  return null
}

/**
 * The human half of a `CODE: sentence` refusal, with the code taken off.
 *
 * THESE THREE MESSAGES ARE WRITTEN FOR A PERSON, in the database, because they
 * are the only place both numbers are known. What is stripped is the machine
 * prefix, and nothing else — no reformatting, no truncation, no substitution.
 * A message that somehow arrives without one is passed through whole rather than
 * replaced, because an unexpected shape is not a reason to say less.
 */
function afterCode(message: string, code: string): string {
  const at = message.indexOf(code)
  if (at < 0) return message
  const rest = message.slice(at + code.length).replace(/^\s*:\s*/, '').trim()
  return rest === '' ? message : rest
}
