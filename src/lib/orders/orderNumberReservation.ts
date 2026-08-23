// ── The Order number, before there is an Order ────────────────────────────────
//
// THE PROBLEM THIS SOLVES. The revised PI a customer signs has to carry the
// Order number. The number was allocated as the Order row was inserted, inside
// approve_order_submission() — and the only stage at which a PI's own owner may
// replace its workbook is draft or needs_changes, which is before approval, when
// no number existed. So the number was never available at the one moment it was
// needed.
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
  /** Held, and the revised PI has not been uploaded since. */
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
 * Whether the revised PI is still outstanding.
 *
 * THE SAME TEST THE DATABASE MAKES, and deliberately not a second opinion:
 * approve_order_submission() compares the PI's live workbook hash against the
 * hash captured when the number was issued, and refuses while they agree. A
 * screen that decided this some other way would tell somebody they were ready to
 * be approved and then watch the approval refuse them.
 *
 * A MISSING LIVE HASH IS OUTSTANDING, not satisfied — it is not evidence that a
 * revised workbook exists, and the database refuses it for exactly that reason.
 */
export function revisedPiOutstanding(input: {
  reservedWorkbookSha256: string | null | undefined
  currentWorkbookSha256: string | null | undefined
}): boolean {
  if (!input.currentWorkbookSha256) return true
  return input.currentWorkbookSha256 === input.reservedWorkbookSha256
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
      standing: outstanding
        ? `${number} is held for this PI. ${RESERVATION_INSTRUCTION}`
        : `${number} is held for this PI, and a revised file has been uploaded since it was issued. The Confirmed Order will be created as ${number}.`,
      blockedReason: null,
      canCopy: true,
    }
  }

  const blocked = reservationBlockedReason(input)
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
  if (m.includes('ORDER_SUBMISSION_REVISED_PI_MISSING')) {
    return 'An Order number was reserved for this PI, but the revised PI carrying that number has not been uploaded. Upload it before approving.'
  }
  if (m.includes('ORDER_NUMBER_RESERVATION_IN_USE')) {
    return 'The Order number reserved for this PI is already in use. Nothing was approved — ask an administrator to check the numbering.'
  }
  return null
}
