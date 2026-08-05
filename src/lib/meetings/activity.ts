// Rendering the meeting lifecycle trail.
//
// Deliberately separate from history.ts, which renders order and SKU discussion
// updates. The two answer different questions and must never share a list:
//
//   history.ts   → "what did we say about this SKU?"
//   activity.ts  → "when was this meeting run, by whom, and was it reopened?"
//
// The rule this file exists to preserve: meetings.completed_at / completed_by
// are CURRENT STATE and are cleared on reopen (the table's CHECK constraint
// requires it). The activity log is the history, and it is never cleared — so a
// meeting completed, reopened and completed again shows BOTH completions here,
// each with its own actor and timestamp.

import { formatMeetingTimestamp, type MeetingActivityEntry, type MeetingActivityEventType } from './types'

/** The verb shown at the head of each line. */
export const ACTIVITY_EVENT_LABEL: Record<MeetingActivityEventType, string> = {
  created:           'Meeting created',
  started:           'Meeting started',
  completed:         'Meeting completed',
  reopened:          'Meeting reopened',
  returned_to_draft: 'Returned to draft',
}

/**
 * The accent each event wears. Completion is the only green: it is the one
 * event that closes something. Reopening is amber because it is an exception,
 * not a failure — the palette must not make a legitimate correction look like
 * an error.
 */
export const ACTIVITY_EVENT_TONE: Record<MeetingActivityEventType, 'neutral' | 'blue' | 'green' | 'amber'> = {
  created:           'neutral',
  started:           'blue',
  completed:         'green',
  reopened:          'amber',
  returned_to_draft: 'amber',
}

/**
 * One line, as it reads on screen:
 *   "Meeting completed by Priya Nair · 5 Aug 2026, 12:05 pm"
 *
 * The actor is never omitted — an audit line with no name is not an audit line
 * — so a missing join renders "Unknown" rather than collapsing the sentence.
 */
export function activitySentence(entry: MeetingActivityEntry): string {
  const who = entry.actor_name?.trim() || 'Unknown'
  return `${ACTIVITY_EVENT_LABEL[entry.event_type]} by ${who} · ${formatMeetingTimestamp(entry.created_at)}`
}

/**
 * Oldest first — the opposite of the SKU history drawer, and on purpose.
 *
 * A lifecycle trail is read as a narrative ("created, started, completed,
 * reopened, completed"), and a narrative runs forwards. A SKU drawer is read to
 * find the latest update, so that one runs backwards. Ties break on id so the
 * order is stable when two events share a timestamp.
 */
export function sortActivity(entries: readonly MeetingActivityEntry[]): MeetingActivityEntry[] {
  return [...entries].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )
}

/**
 * Every completion the meeting has ever had, oldest first.
 *
 * The reason this module has an activity log at all: before it, reopening
 * erased `completed_at`/`completed_by` and the first completion was gone. This
 * returning more than one entry is the proof that it no longer is.
 */
export function completionEvents(
  entries: readonly MeetingActivityEntry[],
): MeetingActivityEntry[] {
  return sortActivity(entries).filter(e => e.event_type === 'completed')
}

/** True once a meeting has been completed and reopened at least once. */
export function wasReopened(entries: readonly MeetingActivityEntry[]): boolean {
  return entries.some(e => e.event_type === 'reopened')
}
