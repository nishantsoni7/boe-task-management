// ── Who physically held the money ────────────────────────────────────────────
//
// PNB and Paytm are the two payment modes where a person carries cash between
// the customer and the company. Who collected it, who handed it to whom, and
// when, is an accountability record — and since 20261014000000 §2 it is an
// APPEND-ONLY LOG (finance_payment_custody_events) rather than the five
// single-event columns 20260716000000 put on the payment row.
//
// ONE TRAIL, TWO SOURCES, AND NO SECOND VOCABULARY
// ------------------------------------------------
// The five legacy columns are not deleted and not migrated: they are HISTORY,
// and every payment recorded before the change still carries them. So this
// module projects them into the SAME event shape the log stores
// (legacyCustodyEvents) and merges the two (custodyTrail). One reader, one
// ordering, one set of labels — which is what "one custody system, not one per
// account" means in practice.
//
// A legacy event is MARKED as one. It carries no recorded-by and no recorded-at
// because the columns never held them, and pretending otherwise would invent an
// audit trail that does not exist.
//
// NOTHING HERE AUTHORIZES ANYTHING. Every rule below is re-derived server-side:
// the applicable modes by payment_mode_requires_custody(), the required people
// and times by append_payment_custody_events_internal, and who may append at all
// by append_payment_custody_events. A browser check tells somebody before a
// round trip; it is never the boundary.

import { modeRequiresCustodyTrail, paymentModeLabel } from './paymentEntry'

export { modeRequiresCustodyTrail }

// ── The two activities ───────────────────────────────────────────────────────

export const CUSTODY_ACTIVITY_TYPES = ['collected', 'handed_over'] as const
export type CustodyActivityType = typeof CUSTODY_ACTIVITY_TYPES[number]

export const CUSTODY_ACTIVITY_LABEL: Record<CustodyActivityType, string> = {
  collected:   'Collected',
  handed_over: 'Handed Over',
}

export const CUSTODY_ACTIVITY_OPTIONS: { value: CustodyActivityType; label: string }[] =
  CUSTODY_ACTIVITY_TYPES.map(value => ({ value, label: CUSTODY_ACTIVITY_LABEL[value] }))

export function isCustodyActivityType(value: string | null | undefined): value is CustodyActivityType {
  return (CUSTODY_ACTIVITY_TYPES as readonly string[]).includes(value ?? '')
}

/** The section heading, wherever the trail is drawn or read. */
export const CUSTODY_TRAIL_TITLE = 'Collection & Handover Activity'

/**
 * The one sentence under the heading.
 *
 * It names the ACCOUNTS and never what they mean internally: an account name
 * followed by a bracketed gloss is exactly the text this product does not
 * print.
 */
export const CUSTODY_TRAIL_NOTE =
  'Recorded for PNB and Paytm payments. Each activity is saved permanently and cannot be edited afterwards — add a new activity to correct the record.'

// ── A saved activity ─────────────────────────────────────────────────────────

export type CustodyEvent = {
  /** The row id, or a synthetic one for a legacy projection. */
  id: string
  activityType: CustodyActivityType
  /** ISO timestamp. For a legacy handover this is midnight of the stored date. */
  occurredAt: string
  collectedBy: string | null
  handedBy: string | null
  handedTo: string | null
  remark: string | null
  /** The payment mode in force when this happened. Never re-derived from today's. */
  paymentModeAtEvent: string
  /** Who recorded it, and when. Absent for a legacy projection — see below. */
  recordedBy: string | null
  recordedAt: string | null
  /**
   * True when this is the five legacy columns read back rather than a stored
   * event. It is shown as such: the columns carry no author and no recording
   * time, and inventing them would be inventing an audit trail.
   */
  legacy: boolean
}

/** The projection columns a saved event arrives in. */
export type CustodyEventRow = {
  id: string
  activity_type: string
  occurred_at: string
  collected_by_user_id: string | null
  handed_by_user_id: string | null
  handed_to_user_id: string | null
  remark: string | null
  payment_mode_at_event: string
  created_by: string | null
  created_at: string | null
}

export function readCustodyEvent(row: CustodyEventRow): CustodyEvent {
  return {
    id: row.id,
    activityType: isCustodyActivityType(row.activity_type) ? row.activity_type : 'collected',
    occurredAt: row.occurred_at,
    collectedBy: row.collected_by_user_id,
    handedBy: row.handed_by_user_id,
    handedTo: row.handed_to_user_id,
    remark: row.remark,
    paymentModeAtEvent: row.payment_mode_at_event,
    recordedBy: row.created_by,
    recordedAt: row.created_at,
    legacy: false,
  }
}

// ── The legacy five columns, read as events ──────────────────────────────────

export type LegacyCustodyColumns = {
  payment_mode: string
  collected_by_user_id: string | null
  collected_from_text: string | null
  handed_over_to_user_id: string | null
  /** A DATE, not a timestamp: the old shape could not say what time it happened. */
  handed_over_at: string | null
  collection_handover_note: string | null
}

/**
 * Up to two events, from a payment's five legacy columns.
 *
 * A COLLECTION when somebody was named as collecting it, and a HANDOVER when
 * both halves of the pair were recorded — which is exactly the rule
 * finance_payment_requests_handover_pair has enforced since 20260716000000, so
 * a half-recorded handover cannot be projected into an event that claims the
 * money moved.
 *
 * `collected_from_text` was free text for an outside party, which the event
 * model deliberately has no column for — an outside party is not a BOE user, and
 * a user reference cannot hold one. It is carried into the collection's remark,
 * which is where the same fact lives now.
 *
 * ORDER, WHEN THE OLD SHAPE COULD NOT SAY. The collection has no stored time at
 * all, so it is dated to the handover's day when there is one and left undated
 * otherwise — and either way it is MARKED legacy, so nothing reads a precision
 * the columns never had.
 */
export function legacyCustodyEvents(
  row: LegacyCustodyColumns,
  /** The payment date, the only other date the row has. */
  paymentDate?: string | null,
): CustodyEvent[] {
  const events: CustodyEvent[] = []
  const note = (row.collection_handover_note ?? '').trim()
  const from = (row.collected_from_text ?? '').trim()

  const collectionRemark = [from ? `Collected from ${from}` : '', note]
    .filter(Boolean).join(' · ') || null

  if (row.collected_by_user_id) {
    events.push({
      id: 'legacy-collected',
      activityType: 'collected',
      occurredAt: (paymentDate ?? '') || (row.handed_over_at ?? '') || '',
      collectedBy: row.collected_by_user_id,
      handedBy: null,
      handedTo: null,
      remark: collectionRemark,
      paymentModeAtEvent: row.payment_mode,
      recordedBy: null,
      recordedAt: null,
      legacy: true,
    })
  }

  // BOTH HALVES, OR NEITHER. A recipient with no date, or a date with nobody
  // named, is not a handover that happened.
  if (row.handed_over_to_user_id && row.handed_over_at) {
    events.push({
      id: 'legacy-handed-over',
      activityType: 'handed_over',
      occurredAt: row.handed_over_at,
      collectedBy: null,
      // THE OLD SHAPE NEVER RECORDED WHO HANDED IT OVER. It recorded who
      // collected it and who received it, and assumed the same person carried it
      // between. That assumption is written down here rather than smuggled in:
      // the collector is named as the hander, and the event is marked legacy.
      handedBy: row.collected_by_user_id,
      handedTo: row.handed_over_to_user_id,
      remark: !row.collected_by_user_id && note ? note : null,
      paymentModeAtEvent: row.payment_mode,
      recordedBy: null,
      recordedAt: null,
      legacy: true,
    })
  }

  return events
}

/**
 * The whole trail for one payment, in the order it happened.
 *
 * Legacy projections and stored events sort together on occurredAt; an undated
 * legacy collection sorts first, because it is the only thing that can have come
 * before a dated one. Ties break on the id so the order is stable across reads —
 * a list that reshuffles between renders reads as a bug.
 */
export function custodyTrail(
  saved: CustodyEvent[],
  legacy: CustodyEvent[] = [],
): CustodyEvent[] {
  return [...legacy, ...saved].sort((a, b) => {
    if (a.occurredAt === b.occurredAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (!a.occurredAt) return -1
    if (!b.occurredAt) return 1
    return a.occurredAt < b.occurredAt ? -1 : 1
  })
}

// ── An unsaved activity, in a form ───────────────────────────────────────────

export type CustodyDraft = {
  /**
   * THE IDEMPOTENCY KEY, minted once when the row appears and never changed.
   *
   * It is what makes a retried submission and a double click both write nothing:
   * finance_payment_custody_events is unique on (payment, key), and the append
   * door inserts ON CONFLICT DO NOTHING. A key regenerated on every render would
   * defeat the whole mechanism, which is why this is created with the row rather
   * than at submit time.
   */
  key: string
  activityType: CustodyActivityType
  /** An <input type="datetime-local"> value: 'YYYY-MM-DDTHH:mm'. */
  occurredAt: string
  collectedBy: string
  handedBy: string
  handedTo: string
  remark: string
}

export function emptyCustodyDraft(key: string, activityType: CustodyActivityType = 'collected'): CustodyDraft {
  return { key, activityType, occurredAt: '', collectedBy: '', handedBy: '', handedTo: '', remark: '' }
}

/**
 * What is wrong with one drafted activity, in one sentence, or null.
 *
 * The same rules append_payment_custody_events_internal applies, said here so a
 * person is told before a round trip rather than after one.
 */
export function custodyDraftError(draft: CustodyDraft): string | null {
  if (!draft.occurredAt.trim()) {
    return 'Enter the date and time this happened.'
  }
  if (draft.activityType === 'collected') {
    if (!draft.collectedBy.trim()) return 'Select who collected the money.'
    return null
  }
  if (!draft.handedBy.trim()) return 'Select who handed the money over.'
  if (!draft.handedTo.trim()) return 'Select who received the money.'
  if (draft.handedBy.trim() === draft.handedTo.trim()) {
    return 'A handover needs two different people.'
  }
  return null
}

/** The first thing wrong with a whole list, naming the row it is in. */
export function custodyDraftsError(drafts: CustodyDraft[]): string | null {
  for (let i = 0; i < drafts.length; i++) {
    const error = custodyDraftError(drafts[i])
    if (error) return `Activity ${i + 1}: ${error}`
  }
  return null
}

/**
 * The drafts as the RPC's p_custody_events argument.
 *
 * A datetime-local value carries no zone, so it is read as the browser's own
 * local time and sent as an absolute instant. `occurred_at` is a timestamptz and
 * comparing a bare local string against `now()` server-side would be wrong by
 * the offset.
 *
 * The fields the activity does not use are sent as null rather than omitted, so
 * the payload's shape does not depend on the branch that produced it.
 */
export function toRpcCustodyEvents(drafts: CustodyDraft[]): Record<string, string | null>[] {
  return drafts.map(d => {
    const collected = d.activityType === 'collected'
    return {
      key:           d.key,
      activity_type: d.activityType,
      occurred_at:   localInputToIso(d.occurredAt),
      collected_by:  collected ? (d.collectedBy.trim() || null) : null,
      handed_by:     collected ? null : (d.handedBy.trim() || null),
      handed_to:     collected ? null : (d.handedTo.trim() || null),
      remark:        d.remark.trim() || null,
    }
  })
}

/** 'YYYY-MM-DDTHH:mm' in the reader's own zone, as an absolute instant. */
export function localInputToIso(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

/** The inverse, for seeding a control from a stored instant. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
    + `T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

// ── One saved activity, as words ─────────────────────────────────────────────

export type CustodyEventLine = {
  id: string
  /** 'Collected' or 'Handed Over'. */
  title: string
  /** Who, resolved to names by the caller's own query. A uuid is never rendered. */
  people: string
  /** When it happened, already formatted. */
  when: string
  remark: string | null
  /** The account the money was in at the time. Never its internal meaning. */
  modeLabel: string
  legacy: boolean
}

/**
 * One event as the four things a reader needs.
 *
 * Returned as DATA rather than JSX so it can be asserted directly — a rendered
 * row is not a testable statement about who held the money.
 *
 * `names` is the caller's id → full name map. An id it cannot resolve reads as
 * "Unknown user", never as a raw uuid and never as a blank.
 */
export function custodyEventLine(
  event: CustodyEvent,
  names: Map<string, string>,
  formatDateTime: (iso: string) => string,
): CustodyEventLine {
  const who = (id: string | null) => (id ? names.get(id) || 'Unknown user' : 'Unknown user')
  return {
    id: event.id,
    title: CUSTODY_ACTIVITY_LABEL[event.activityType],
    people: event.activityType === 'collected'
      ? who(event.collectedBy)
      : `${who(event.handedBy)} → ${who(event.handedTo)}`,
    when: event.occurredAt ? formatDateTime(event.occurredAt) : 'Date not recorded',
    remark: (event.remark ?? '').trim() || null,
    modeLabel: paymentModeLabel(event.paymentModeAtEvent),
    legacy: event.legacy,
  }
}

/** Every user id one trail names, so a caller can resolve them in one query. */
export function custodyTrailUserIds(events: CustodyEvent[]): string[] {
  const ids = new Set<string>()
  for (const e of events) {
    if (e.collectedBy) ids.add(e.collectedBy)
    if (e.handedBy) ids.add(e.handedBy)
    if (e.handedTo) ids.add(e.handedTo)
    if (e.recordedBy) ids.add(e.recordedBy)
  }
  return [...ids]
}
