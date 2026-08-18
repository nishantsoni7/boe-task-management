// The history of one PI submission, as something a person can read.
//
// The rows come from public.order_submission_activity, which is append-only and
// written only by a database function no client role can execute. So this module
// has no integrity job at all — what it does is turn eight machine actions into
// eight English sentences, resolve an actor id to a name, and drop everything
// else on the floor.
//
// WHAT IS DELIBERATELY NOT SHOWN
// ------------------------------
//   * RAW `metadata`. It holds counts the server recorded for its own diagnosis
//     — item_count, warning_count, blocking_issue_count, the replay flag. None
//     of it answers a question an employee or a reviewer is asking on this
//     screen, and printing internal bookkeeping beside a business event invites
//     somebody to read meaning into it.
//
//     THE ONE CURATED EXCEPTION is the advance condition. The three
//     advance_exception_* events carry the proposed percentage and the amount it
//     came to, and those ARE the business fact of the event — "Advance exception
//     requested" with no percentage beside it tells a reviewer nothing. So two
//     named keys are read, for those three actions only, and rendered as one
//     short sentence. Nothing else in the object is reachable from this screen,
//     for any action, and an event whose metadata is missing or malformed simply
//     renders without the sentence.
//   * ids of any kind. Not the submission's, not the actor's, not the activity
//     row's. An id on screen is a thing to be copied into a support message and
//     then into a URL; the page already knows which record it is showing.
//   * previous_status / new_status. The action already says what happened, and
//     "submitted → needs_changes" beside "Changes requested" is the same fact in
//     database words.
//
// AN UNKNOWN ACTION IS NOT RENDERED. A later phase will add its own actions to
// the closed set in the migration, and a build of this application that predates
// it must not print a raw enum value into a business history. Dropping the row
// is the honest outcome: the trail itself is intact in the database, and this
// screen shows what it can name.

import { formatInr } from '@/lib/pi/previewView'

/** One row of public.order_submission_activity, as the detail page reads it. */
export type PersistedActivity = {
  id: string
  action: string
  actor_id: string | null
  note: string | null
  created_at: string
  /** Read for the three advance events only. See the header note. */
  metadata?: Record<string, unknown> | null
}

/**
 * The columns the page selects. Named, never `*`: the two status columns are not
 * read at all, so they cannot be rendered by accident, and `metadata` is read
 * only so the curated advance figures can be built from two named keys of it.
 */
export const PI_ACTIVITY_COLUMNS =
  ['id', 'action', 'actor_id', 'note', 'created_at', 'metadata'].join(', ')

/**
 * Every action the migrations admit, and the words for it.
 *
 * Kept in step with the CHECK constraint on order_submission_activity.action:
 * 20260908000000 established the first four, 20260910000000 added 'rejected',
 * and 20260913000000 adds the three advance events.
 *
 * "Rejected" is the PI. "Advance exception rejected" is one commercial term of
 * it, and the record goes back to the employee rather than ending — which is
 * exactly why the two must not read alike.
 */
export const PI_ACTIVITY_LABEL: Record<string, string> = {
  submission_created: 'Draft created',
  parse_replaced: 'PI replaced',
  submitted: 'Submitted for approval',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  advance_exception_requested: 'Advance exception requested',
  advance_exception_approved: 'Advance exception approved',
  advance_exception_rejected: 'Advance exception rejected',
}

/**
 * The fixed sentence under an advance event, explaining what it MEANT.
 *
 * The rejection's is the one that earns its place: refusing a proposed advance
 * also returns the PI, and one event says both — so the sentence states the
 * outcome rather than leaving a reader to wonder why the record moved. It is why
 * no second 'changes_requested' entry is written beside it.
 */
export const PI_ACTIVITY_DETAIL: Record<string, string> = {
  advance_exception_requested: 'Sent to management with the PI. No payment was recorded or requested.',
  advance_exception_approved: 'The PI stays under review. Approving the advance condition does not approve the PI.',
  advance_exception_rejected: 'The PI was returned to the employee for correction.',
}

export type ActivityEntry = {
  key: string
  label: string
  /** The person's name, or a neutral placeholder — never an id. */
  actor: string
  /** Formatted by the caller's own date helper, so every "when" in Orders is
   *  written the same way. */
  at: string
  note: string | null
  /**
   * The advance figures this event was about — "12.5% · ₹1,47,500" — or null.
   *
   * Present for the three advance actions and for nothing else, built from two
   * named metadata keys and never from the object at large.
   */
  figures: string | null
  /** The fixed explanatory sentence, or null. See PI_ACTIVITY_DETAIL. */
  detail: string | null
}

/**
 * The percentage and amount an advance event carried, as one short line.
 *
 * READS EXACTLY TWO KEYS, and only for an action that is one of the three. A
 * missing, non-numeric or malformed value yields null rather than a partial
 * sentence, so an event written by a build that recorded something else prints
 * as a plain event rather than as a broken one.
 */
function advanceFigures(row: PersistedActivity): string | null {
  if (PI_ACTIVITY_DETAIL[row.action] === undefined) return null
  const metadata = row.metadata
  if (!metadata || typeof metadata !== 'object') return null

  const percent = toFiniteNumber(metadata['advance_percent'])
  if (percent === null) return null

  const amount = toFiniteNumber(metadata['advance_amount'])
  const percentLabel = `${String(Number(percent.toFixed(2)))}%`
  return amount === null ? percentLabel : `${percentLabel} · ${formatInr(amount)}`
}

/** A JSON value as a finite number. PostgREST renders `numeric` as a string. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Shown when an actor cannot be resolved: a deleted account, or a row whose
 *  actor was recorded as nobody. */
export const UNKNOWN_ACTOR = 'Unknown user'

/**
 * The history, newest first.
 *
 * NEWEST FIRST because the question this section answers on arrival is "what
 * happened to this most recently" — a reviewer opening a returned submission
 * wants the return, not the day it was created. The order is total: the stamp
 * decides, and the row id breaks a tie so two events written in the same
 * transaction cannot swap places between renders.
 *
 * Names arrive as a map the caller has already batch-fetched. Resolving them
 * here, one query per row, would be a dozen round trips to print four names.
 */
export function describeActivityEntries(
  rows: readonly PersistedActivity[],
  namesById: ReadonlyMap<string, string>,
  formatWhen: (iso: string | null) => string,
): ActivityEntry[] {
  return rows
    .filter(row => typeof row.action === 'string' && PI_ACTIVITY_LABEL[row.action] !== undefined)
    .slice()
    .sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
      return a.id < b.id ? 1 : -1
    })
    .map(row => {
      const name = row.actor_id ? namesById.get(row.actor_id) : undefined
      const note = row.note && row.note.trim() !== '' ? row.note.trim() : null
      return {
        key: row.id,
        label: PI_ACTIVITY_LABEL[row.action],
        actor: name && name.trim() !== '' ? name.trim() : UNKNOWN_ACTOR,
        at: formatWhen(row.created_at),
        note,
        figures: advanceFigures(row),
        detail: PI_ACTIVITY_DETAIL[row.action] ?? null,
      }
    })
}

/**
 * Every user id a set of activity rows refers to, plus any extra ids the page
 * already needs a name for (the submitter, the reviewer who rejected it).
 *
 * One list, so the page makes ONE users read rather than one per section.
 */
export function activityActorIds(
  rows: readonly PersistedActivity[],
  extra: readonly (string | null | undefined)[] = [],
): string[] {
  const ids = new Set<string>()
  for (const row of rows) if (row.actor_id) ids.add(row.actor_id)
  for (const id of extra) if (id) ids.add(id)
  return [...ids]
}
