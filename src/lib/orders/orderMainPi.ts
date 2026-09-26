// THE MAIN PI, AND THE WHOLE TRAIL BEHIND IT.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// A Confirmed Order carries one PI that is in force and, once anybody has
// revised it, a stack of versions that no longer are. The status workspace
// above the product list states the one in force; a modal states all of them.
// This decides which is which, and what each row says.
//
// THE MAIN PI IS THE LATEST APPROVED VERSION, AND NOTHING ELSE. Not the latest
// upload, not the latest pending revision, not the newest row. A pending
// revision is a proposal — the Order still runs on the approved document until
// an administrator says otherwise — and a rejected one never ran on anything.
// Reading "Main PI" off the newest row would put an unapproved figure in front
// of the person planning production against it.
//
// IT COMPUTES NOTHING AND AUTHORIZES NOTHING. describePiVersionHistory has
// already read the rows, resolved the actor names and formatted every date;
// public.order_pi_versions' own partial unique indexes guarantee at most one
// approved and one pending version per Order. This selects, labels and orders.

import {
  piVersionLabel,
  type PiVersionHistory,
  type PiVersionView,
} from './orderPiVersions'

// ── Words ─────────────────────────────────────────────────────────────────────

export const MAIN_PI_TITLE = 'Main PI'
export const MAIN_PI_VIEW_LABEL = 'View'
export const MAIN_PI_DOWNLOAD_LABEL = 'Download'
export const MAIN_PI_HISTORY_LABEL = 'View history'

export const MAIN_PI_UPLOADED_LABEL = 'Uploaded'
export const MAIN_PI_APPROVED_LABEL = 'Approved'

/**
 * WHAT AN ORDER WITH NO APPROVED PI SAYS.
 *
 * Two different absences, worded apart, because they call for different things
 * from the reader. An Order that never came from a PI has nothing to wait for;
 * an Order whose only version is still pending has a decision outstanding, and
 * saying so is the whole value of the card.
 *
 * NEITHER SUBSTITUTES ANOTHER DOCUMENT. A pending or rejected upload is not
 * shown here as though it were in force — that is precisely the mistake this
 * card exists to prevent.
 */
export const MAIN_PI_NONE = 'This Order was not created from a PI, so there is no approved PI to show.'
export const MAIN_PI_AWAITING =
  'No PI has been approved for this Order yet. A revision is uploaded and waiting for a decision.'

/** What a revision that never recorded why it was raised says in the history. */
export const REMARK_NOT_RECORDED = 'Not recorded'
/** What the very first PI says where later rows carry a change remark. */
export const REMARK_INITIAL = 'Initial PI'
export const REMARK_LABEL = 'Change remark'

export const PI_HISTORY_MODAL_TITLE = 'PI history'
export const PI_HISTORY_MODAL_EMPTY = 'No PI versions are recorded for this Order.'
export const PI_HISTORY_CURRENT_BADGE = 'Current'

// ── The Main PI card ──────────────────────────────────────────────────────────

export type MainPiCard =
  | { kind: 'none'; message: string }
  | { kind: 'awaiting'; message: string }
  | {
      kind: 'ready'
      version: PiVersionView
      /** `PI V3` — the reference this product uses for a version everywhere. */
      reference: string
      /** `Approved`, from the shared status map. */
      statusLabel: string
      uploadedAt: string
      /**
       * When it was approved, or null when the record does not carry it.
       *
       * NEVER FILLED IN FROM THE UPLOAD DATE. They are different moments — a PI
       * uploaded on Tuesday and approved on Friday has two dates — and a card
       * that quietly printed one under the other's caption would be inventing
       * a decision date somebody could plan against.
       */
      approvedAt: string | null
      /** True when the file can actually be signed for a reader. */
      hasFile: boolean
      fileName: string | null
      /** A revision is waiting on a decision; the Main PI is unaffected. */
      pendingRevision: boolean
      /** THE OPEN REVISION ITSELF (pending an admin, or awaiting operations) —
       *  drawn beside the PI in force, never in its place. */
      proposal: PiVersionView | null
    }

/**
 * Which PI is in force, and what the card says about it.
 *
 * `history.current` is describePiVersionHistory's own answer, and it is the
 * APPROVED row: the database admits exactly one per Order. Nothing here
 * re-derives that, so the card and the history modal cannot disagree about
 * which version is current.
 */
export function mainPiCard(history: PiVersionHistory): MainPiCard {
  const current = history.current
  if (!current) {
    const awaiting = history.pending !== null
    return awaiting
      ? { kind: 'awaiting', message: MAIN_PI_AWAITING }
      : { kind: 'none', message: MAIN_PI_NONE }
  }

  return {
    kind: 'ready',
    version: current,
    reference: piVersionLabel(current.versionNumber),
    statusLabel: current.statusLabel,
    uploadedAt: current.uploadedAt,
    approvedAt: current.decidedAt,
    hasFile: current.workbookPath !== null,
    fileName: current.workbookName,
    pendingRevision: history.pending !== null,
    proposal: history.pending,
  }
}

// ── The history ───────────────────────────────────────────────────────────────

export type PiTimelineEntry = {
  version: PiVersionView
  /** The one in force. At most one entry carries it. */
  isCurrent: boolean
  /**
   * The change remark, as the history prints it.
   *
   *   the remark        a revision that recorded one
   *   Not recorded      a revision that did not. NEVER INVENTED: rows written
   *                     before the remark was required legitimately have none,
   *                     and guessing one would put words in somebody's mouth.
   *   Initial PI        version 1, which is not a revision and was never asked
   *                     for a reason.
   */
  remark: string
  /** True only for `Not recorded`, so the row can mute it. */
  remarkMissing: boolean
}

/**
 * EVERY VERSION THIS ORDER HAS CARRIED, NEWEST FIRST.
 *
 * describePiVersionHistory splits the rows three ways for the card that wanted
 * them split; the history wants them whole. Recombining and re-sorting here
 * keeps that function — and its tests — untouched.
 *
 * The sort is by version number descending, which is the order the rows were
 * created in: public.order_pi_versions numbers them from 1 with a unique
 * constraint per Order, so it is a total order and needs no tiebreak.
 */
export function piVersionTimeline(history: PiVersionHistory): PiTimelineEntry[] {
  const all: PiVersionView[] = [
    ...(history.current ? [history.current] : []),
    ...(history.pending ? [history.pending] : []),
    ...history.history,
  ]

  return all
    .slice()
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map(version => {
      const initial = version.versionNumber === 1
      const recorded = version.revisionReason !== null && version.revisionReason.trim() !== ''
      return {
        version,
        isCurrent: history.current !== null && version.id === history.current.id,
        remark: recorded
          ? version.revisionReason as string
          : initial ? REMARK_INITIAL : REMARK_NOT_RECORDED,
        remarkMissing: !recorded && !initial,
      }
    })
}

/**
 * Whether a proposed revision needs a change remark.
 *
 * THE SAME RULE THE DATABASE HOLDS, restated for the dialog so a person is told
 * before they press rather than refused after.
 * public.order_pi_versions_revision_needs_reason exempts version 1 and requires
 * a non-blank reason on every later row; propose_order_pi_revision() trims and
 * refuses a blank one again under a row lock. This never decides anything on
 * its own — it only decides whether to mark the field required.
 */
export function revisionRemarkRequired(nextVersionNumber: number): boolean {
  return nextVersionNumber > 1
}

/** True when a typed remark would be refused. Whitespace is not a remark. */
export function remarkIsBlank(value: string | null | undefined): boolean {
  return (value ?? '').trim() === ''
}
