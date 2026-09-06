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
  // ── Phase C and Phase 3 (20260915000000, 20260919000000, 20260921000000) ──
  //
  // These were admitted by the constraint long before they had words here, so
  // every PI's timeline silently DROPPED its finance check, its payments and
  // its approval. 20261116000000 asks the Order to show the whole chronology,
  // which is not possible while the trail cannot name half of it.
  finance_verified: 'Finance check verified',
  approved: 'Confirmed Order created',
  payment_recorded: 'Payment attached',
  payment_allocations_moved: 'Payments moved onto the Order',
  // ── Edits after submission (20260923000000 – 20261003000000) ──
  billing_percentage_set: 'Billing percentage set',
  billing_percentage_amended_by_admin: 'Billing percentage amended by admin',
  client_details_updated: 'Client details updated',
  client_details_amended_by_admin: 'Client details amended by admin',
  schedule_terms_updated: 'Schedule and terms updated',
  schedule_terms_amended_by_admin: 'Schedule and terms amended by admin',
  correction_requested: 'Correction requested',
  correction_resolved: 'Correction resolved',
  correction_rejected: 'Correction refused',
  product_details_updated: 'Product details updated',
  product_details_amended_by_admin: 'Product details amended by admin',
  workbook_replaced_by_admin: 'PI workbook replaced by admin',
  // ── The Order number (20261009000000) ──
  order_number_reserved: 'Order number reserved',
  order_number_revised_pi_verified: 'Revised PI carries the Order number',
  order_number_used: 'Order number assigned',
  // ── The PI decision, payment decisions and revisions (20261116000000) ──
  pi_approved: 'PI approved',
  payment_verified: 'Payment verified by Finance',
  payment_rejected: 'Payment rejected by Finance',
  pi_revision_proposed: 'Revised PI uploaded',
  pi_revision_approved: 'Revised PI approved',
  pi_revision_rejected: 'Revised PI rejected',
}

/**
 * The three events that carry advance figures.
 *
 * A NAMED SET, because two named metadata keys are read for these actions and
 * for nothing else. It used to be inferred from the presence of an explanatory
 * sentence, which coupled "does this event have figures" to a piece of display
 * copy — and the copy has since been removed.
 *
 * WHY THE COPY WENT. Each advance event used to render a fixed sentence beneath
 * it: "Sent to management with the PI. No payment was recorded or requested.",
 * "The PI stays under review. Approving the advance condition does not approve
 * the PI." They were true, and on an audit trail they were noise — the same
 * paragraph under every occurrence of the same event, crowding out the actor,
 * the time and the words a person actually typed. The trail states facts; the
 * screen's labels and controls carry the meaning.
 */
export const PI_ADVANCE_ACTIONS: ReadonlySet<string> = new Set([
  'advance_exception_requested',
  'advance_exception_approved',
  'advance_exception_rejected',
])

/**
 * The restrained colour each event is marked with in the audit trail.
 *
 * INFORMATIVE, NEVER DECORATIVE. Colour only means "this is a different kind of
 * thing" while it is scarce, so a trail of eight events is mostly neutral: the
 * two that merely record a document (created, replaced) take no colour at all.
 *
 * It lives HERE, beside the labels, because it is a statement about what an
 * event MEANS, and meaning is this module's job. A page that picked its own
 * colours would be free to decide that a rejection is amber.
 */
export type PiActivityTone = 'neutral' | 'blue' | 'amber' | 'green' | 'red'

export const PI_ACTIVITY_TONE: Record<string, PiActivityTone> = {
  submission_created: 'neutral',
  parse_replaced: 'neutral',
  submitted: 'blue',
  changes_requested: 'amber',
  rejected: 'red',
  advance_exception_requested: 'amber',
  advance_exception_approved: 'green',
  advance_exception_rejected: 'red',
  finance_verified: 'green',
  approved: 'green',
  payment_recorded: 'blue',
  payment_allocations_moved: 'neutral',
  billing_percentage_set: 'neutral',
  billing_percentage_amended_by_admin: 'amber',
  client_details_updated: 'neutral',
  client_details_amended_by_admin: 'amber',
  schedule_terms_updated: 'neutral',
  schedule_terms_amended_by_admin: 'amber',
  correction_requested: 'amber',
  correction_resolved: 'green',
  correction_rejected: 'red',
  product_details_updated: 'neutral',
  product_details_amended_by_admin: 'amber',
  workbook_replaced_by_admin: 'amber',
  order_number_reserved: 'neutral',
  order_number_revised_pi_verified: 'neutral',
  order_number_used: 'green',
  pi_approved: 'green',
  payment_verified: 'green',
  payment_rejected: 'red',
  pi_revision_proposed: 'amber',
  pi_revision_approved: 'green',
  pi_revision_rejected: 'red',
}

/**
 * The two payment-decision events carry the share of the payment this PI holds.
 *
 * A NAMED SET, for the same reason PI_ADVANCE_ACTIONS is one: exactly one
 * metadata key is read for these two actions and for nothing else.
 */
export const PI_PAYMENT_DECISION_ACTIONS: ReadonlySet<string> = new Set([
  'payment_verified',
  'payment_rejected',
])

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
  /** The marker colour for this event in the trail. See PI_ACTIVITY_TONE. */
  tone: PiActivityTone
}

/**
 * The amount and percentage an advance event carried, as one short line.
 *
 * THE AMOUNT LEADS, because the amount is what the employee declared and the
 * percentage is what it came to. Events written before amounts were declared
 * carry the same two keys — the migration that introduced them derived the
 * amount from the percentage — so every entry ever logged still renders, and
 * renders the same way round.
 *
 * READS EXACTLY TWO KEYS, and only for an action that is one of the three. A
 * missing, non-numeric or malformed value yields null rather than a partial
 * sentence, so an event written by a build that recorded something else prints
 * as a plain event rather than as a broken one.
 */
function advanceFigures(row: PersistedActivity): string | null {
  const metadata = row.metadata
  if (!metadata || typeof metadata !== 'object') return null

  // The payment decision: the rupees allocated to this PI, and the payment's
  // human id when Finance has one. One key for the figure, one for the id.
  if (PI_PAYMENT_DECISION_ACTIONS.has(row.action)) {
    const allocated = toFiniteNumber(metadata['allocated_amount'])
    const id = typeof metadata['human_payment_id'] === 'string' && metadata['human_payment_id'].trim() !== ''
      ? metadata['human_payment_id'].trim()
      : null
    if (allocated === null && id === null) return null
    return [id, allocated === null ? null : formatInr(allocated)]
      .filter((s): s is string => s !== null).join(' · ')
  }

  if (!PI_ADVANCE_ACTIONS.has(row.action)) return null

  const percent = toFiniteNumber(metadata['advance_percent'])
  const amount = toFiniteNumber(metadata['advance_amount'])
  if (percent === null && amount === null) return null

  const percentLabel = percent === null ? null : `${String(Number(percent.toFixed(2)))}%`
  if (amount === null) return percentLabel
  if (percentLabel === null) return formatInr(amount)
  return `${formatInr(amount)} · ${percentLabel}`
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
        // The RAW ACTION STILL NEVER LEAVES THIS MODULE. What the trail is
        // handed is a colour name, so no build of the screen can print an enum.
        tone: PI_ACTIVITY_TONE[row.action] ?? 'neutral',
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

/**
 * The employee's own reply on the most recent submission, or null.
 *
 * WHY IT IS READ OUT OF THE TRAIL AND NOT OFF THE RECORD. A resubmission's reply
 * is written onto the 'submitted' EVENT and nowhere else — there is no column on
 * order_submissions holding it, deliberately, so that a later resubmission
 * cannot overwrite what was said about an earlier one. The reviewer's panel
 * needs the current one, which is the newest submission event's note.
 *
 * Entries arrive newest-first from describeActivityEntries, so the first match
 * is the current reply. Matching on the LABEL keeps the raw action name inside
 * this module, which is the same reason `action` is not a field on ActivityEntry.
 */
export function latestSubmissionReply(entries: readonly ActivityEntry[]): string | null {
  const submitted = entries.find(entry => entry.label === PI_ACTIVITY_LABEL.submitted)
  return submitted?.note ?? null
}
