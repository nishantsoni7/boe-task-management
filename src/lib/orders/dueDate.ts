// ── The due date, and the one rule that decides whether a PI has one ──────────
//
// WHAT THIS IS FOR
// ----------------
// `order_submissions.due_date` holds ONE thing: an explicit calendar date the PI
// document actually stated. Nothing here derives a date, and nothing here is
// allowed to start.
//
// WHY THE RULE HAS TO BE THIS NARROW
// ----------------------------------
// The workbook's dispatch cell (Master E113) is read by the parser as a date,
// but a production file fills it in three different ways:
//
//   a real Excel date serial   → a genuine calendar date
//   words                      → "6 weeks from date of confirmation"
//   a bare number of days      → "45", "90"
//
// Only the first is a due date. The second is a COMMITMENT, and turning it into
// a date means choosing an anchor the document never named — six weeks from the
// client's confirmation, from management's approval, or from the advance
// clearing are three different dates, and a wrong one is a promise made to a
// customer. So prose stays prose, in `dispatch_commitment`, and is shown as
// supporting text under "Not set" rather than as a date.
//
// THE THIRD CASE IS THE DANGEROUS ONE. `excelSerialToIso` rejects serials below
// 61, so "6" and "45" survive as the text "6" and "45". But 61 and above are
// converted, and a lead time typed as a plain number becomes a real-looking
// date in 1900:
//
//     61 → 1900-03-01     90 → 1900-03-30     120 → 1900-04-29    365 → 1900-12-30
//
// Those strings are already sitting in `dispatch_commitment` on saved records,
// and they match a strict ISO pattern perfectly. A backfill that trusted the
// pattern alone would adopt them as due dates. That is what the floor below
// exists to stop.
//
// ONE RULE, TWO IMPLEMENTATIONS. This module is the rule for the save path;
// migration 20260922000000 states the identical rule in SQL for the historical
// backfill. They must not drift — `dueDate.test.ts` pins every boundary, and the
// migration's own comment points back here.

/**
 * The absolute floor, and the anchor of last resort.
 *
 * It does BOTH jobs deliberately. As the fallback anchor it is what a record
 * with neither a confirmation date nor a creation date is measured against. As
 * an absolute floor it is what makes "a date in 1900 is never adopted" true even
 * when the record's own anchor is itself a mis-parsed 1900 date — an anchor
 * cannot vouch for a value if the anchor is wrong in the same way.
 */
export const DUE_DATE_FLOOR = '2020-01-01'

/**
 * A strict `YYYY-MM-DD` that is also a real day.
 *
 * The round trip is what rejects `2026-02-30`: Date normalises it to March 2nd,
 * and the re-formatted string no longer matches what came in. Parsed as UTC so
 * the machine's timezone cannot move a date across a midnight.
 */
export function isCalendarDate(value: string | null | undefined): value is string {
  const s = (value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
  return d.toISOString().slice(0, 10) === s
}

/**
 * The due date this PI may keep, or null.
 *
 * `candidate` is the parser's own `.iso` for E113 — set only when the cell held
 * a real date serial — or, for a cell somebody typed a date into as text, that
 * text. Both go through the same check, which is also the check the backfill
 * applies to what is already stored, so a record saved today and the same record
 * backfilled tomorrow resolve identically.
 *
 * NOTHING IS COMPUTED. There is no arithmetic here, no duration parsing, and no
 * fallback that invents a date from the commitment text. A value either passes
 * every test below unchanged, or there is no due date.
 */
export function plausibleDueDate(input: {
  /** The parser's `.iso`, or the cell's text when a date was typed by hand. */
  candidate: string | null | undefined
  /** order_confirmation_date, when the PI carries one. */
  orderConfirmationDate?: string | null
  /** creation_date — the anchor when there is no confirmation date. */
  creationDate?: string | null
}): string | null {
  const due = (input.candidate ?? '').trim()
  if (!isCalendarDate(due)) return null

  // The floor is absolute, and is checked before the anchor precisely so that a
  // record whose own dates are mis-parsed cannot admit a 1900 due date.
  if (due < DUE_DATE_FLOOR) return null

  // The anchor is the confirmation date where the PI gave one, the creation date
  // otherwise, and the floor when it gave neither. An anchor that is not itself a
  // real calendar date is not an anchor.
  const confirmed = isCalendarDate(input.orderConfirmationDate) ? input.orderConfirmationDate : null
  const created = isCalendarDate(input.creationDate) ? input.creationDate : null
  const anchor = confirmed ?? created ?? DUE_DATE_FLOOR

  // On or after: a PI confirmed and due the same day is a real, if urgent, order.
  if (due < anchor) return null

  return due
}

/**
 * What the top card shows when there is no due date.
 *
 * Deliberately not "Not provided", which is what an absent phone or address
 * says. A due date is not something the document forgot to carry — it is
 * something nobody has decided yet, and the wording says so.
 */
export const DUE_DATE_ABSENT = 'Not set'

/** The prefix on the supporting line, so it can never read as a date itself. */
export const COMMITMENT_PREFIX = 'Commitment:'

/**
 * The commitment text, but ONLY when it is genuinely prose.
 *
 * A stored commitment that is itself a bare ISO date is not worth repeating: it
 * either became the due date above, or it was rejected as implausible, and
 * printing "Commitment: 1900-03-30" under "Not set" would put the exact value
 * this module refused back on the screen dressed as an explanation.
 */
export function supportingCommitment(commitment: string | null | undefined): string | null {
  const text = (commitment ?? '').trim()
  if (text === '' || text === '—') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  return text
}
