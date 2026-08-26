// ONE NOTIFICATION → ONE COMPACT EVENT LINE.
//
// The card header carries the task title, its assignee and the update count.
// Everything below it answers three questions and nothing else:
//
//   1. what happened      "Added a comment"
//   2. a brief detail     the comment's first line, or Working → Waiting
//   3. when               "2h ago"
//
// ── WHAT THE DATABASE ACTUALLY GIVES US ─────────────────────────────────────
//
// A `notifications` row has exactly these columns: id, user_id, task_id,
// entity_id, type, title, body, is_read, is_push_sent, is_digest, created_at,
// read_at. Every task notification stores the ACTOR SENTENCE in `title`
// ("Dhruv added a comment") and the TASK TITLE in `body`.
//
// So of the five fields this presentation would like:
//
//   task assignee     NOT here — it belongs to the task; fetched by a batch
//                     lookup (see ./taskAssignees.ts), never per row.
//   event actor       here, but only as PROSE inside `title`. Parsed, not read.
//   new status        here, same way — "moved task to Waiting".
//   previous status   NOT ANYWHERE. `notifications` has no from_status, and
//                     nothing links a notification row to the
//                     `task_activity_log` row that does have one: there is no
//                     activity_log_id column, only (task_id, created_at), and
//                     matching on a timestamp is a guess dressed as data.
//   comment text      NOT ANYWHERE either, for the same reason. `body` holds
//                     the task title on every write path, not the comment.
//
// ── SO THIS MODULE NEVER INVENTS ────────────────────────────────────────────
//
// Each shape degrades to the most specific HONEST line the row can support:
//
//   both statuses known   Status changed      Working → Waiting
//   only the new one      Status changed to Waiting
//   neither               Status updated
//   comment with text     Added a comment     "Please confirm the …"
//   comment without       Comment added
//
// The optional fields are typed in and threaded through so that the day a
// writer starts storing them, the richer line appears with no change here. They
// are simply never populated from a `notifications` row today.

import type { Notification } from '@/lib/types'
import { taskStatusLabel } from '@/lib/ui'

/** One line of comment preview. Longer than a phone shows, shorter than a paragraph. */
export const COMMENT_PREVIEW_MAX = 120

/** Shown when a comment notification carries no preview text. */
export const COMMENT_WITHOUT_PREVIEW = 'Comment added'

/** Shown when neither status is known. */
export const STATUS_WITHOUT_VALUES = 'Status updated'

export type NotificationEventDetail =
  /** A quoted line of the actual comment. */
  | { kind: 'comment'; text: string }
  /** Previous → new, only when BOTH are genuinely known. */
  | { kind: 'transition'; from: string; to: string }
  /** Any other short supporting line: "Due 27 August". */
  | { kind: 'plain'; text: string }

export type NotificationEvent = {
  /** The action line. Always present, always a complete phrase. */
  action: string
  /** The optional second line. Null when the row supports nothing honest. */
  detail: NotificationEventDetail | null
  /**
   * The person who did it, when the row names one.
   *
   * The CARD's assignee is the task's owner, not the actor of every event, so
   * this is deliberately separate. `actorMetaFor` below decides whether to show
   * it — repeating "Nishant" on Nishant's own card says nothing.
   */
  actorName: string | null
}

/**
 * Extra facts a caller may supply for a row.
 *
 * NOT read from `notifications` — nothing there carries them. This is the seam:
 * a writer that starts storing a comment preview or a status transition passes
 * it here and the richer line renders, with no other change.
 */
export type NotificationEventExtras = {
  commentPreview?: string | null
  fromStatus?: string | null
  toStatus?: string | null
}

/** Collapse whitespace and cut on a word boundary, with a real ellipsis. */
export function truncateOneLine(text: string, max = COMMENT_PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  // Only break on a word if that leaves most of the budget used; otherwise a
  // long unbroken token would collapse to almost nothing.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${body.replace(/[\s.,;:!?-]+$/, '')}…`
}

/**
 * Strip anything that is not prose from a comment before showing it.
 *
 * A preview is one line in a list, so it must never render markup, a JSON
 * fragment or a storage URL — both because they are meaningless at this size
 * and because an attachment URL in a notification list is a link to a file
 * whose permissions this card has not checked.
 */
export function safeCommentPreview(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let text = raw
  // A whole-payload JSON blob is not a comment anybody wrote.
  if (/^\s*[[{]/.test(text)) return null
  text = text
    .replace(/https?:\/\/\S+/gi, '')          // links, including storage URLs
    .replace(/<[^>]*>/g, ' ')                 // any markup
    .replace(/[*_`~#>]+/g, ' ')               // markdown emphasis / heading marks
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return truncateOneLine(text)
}

// ── Reading the action out of the title prose ────────────────────────────────
//
// The same sentences src/lib/notificationMeta.ts already parses for its badge,
// read here for the action line. Order matters for the same reason it does
// there: "approved and completed task" must be tested before "completed task".

const ACTION_PATTERNS: Array<{ re: RegExp; action: string }> = [
  { re: /submitted task for approval/i,  action: 'Submitted for approval' },
  { re: /approved and completed task/i,  action: 'Approved and completed' },
  { re: /returned task to working/i,     action: 'Returned for changes' },
  { re: /new task assigned to you/i,     action: 'Task assigned' },
  { re: /new quotation request/i,        action: 'Quotation request assigned' },
  { re: /added a comment/i,              action: 'Added a comment' },
  { re: /new comment on task/i,          action: 'Added a comment' },
  { re: /acknowledged task|task acknowledged/i, action: 'Acknowledged' },
  { re: /completed task|task completed/i, action: 'Task completed' },
  { re: /cancelled a task|cancelled task|task cancelled/i, action: 'Task cancelled' },
  { re: /reversed cancellation|cancellation reversed/i, action: 'Cancellation reversed' },
  { re: /reopened a task|task reopened/i, action: 'Task reopened' },
  { re: /moved task to (\w+)|task moved to (\w+)/i, action: 'Status changed' },
  // /api/notify-status-update's default branch writes exactly "Task status
  // updated" when it is given an action it does not recognise. It IS a status
  // event, so it routes to the status branch — which, finding neither value,
  // renders STATUS_WITHOUT_VALUES rather than the generic "Task updated".
  { re: /task status updated|status updated/i, action: 'Status changed' },
]

/** The generic last resort. Never says who or what, because it does not know. */
const FALLBACK_ACTION = 'Task updated'

/** The new status named in the title, when the sentence is a status change. */
function parseNewStatus(title: string): string | null {
  const m = /(?:moved task to|task moved to|moved to)\s+([A-Za-z_]+)/i.exec(title)
  return m ? m[1] : null
}

/**
 * The actor's name, when the sentence starts with one.
 *
 * The writers compose "<name> <verb phrase>", so the actor is whatever sits in
 * front of the matched verb. A sentence with no actor — the actor-less
 * fallbacks like "Task cancelled" — yields null rather than a guess.
 */
function parseActor(title: string, matched: RegExp): string | null {
  const m = matched.exec(title)
  if (!m || m.index === 0) return null
  const before = title.slice(0, m.index).trim()
  if (!before) return null
  // A plausible display name: a few words, no trailing verb fragments.
  if (before.length > 60 || /\b(and|the|a)$/i.test(before)) return null
  return before
}

/** Present a status value the way the rest of the product does. */
function statusLabel(value: string): string {
  const label = taskStatusLabel(value.toLowerCase(), 'assignee')
  // taskStatusLabel answers for known statuses; anything else is shown
  // capitalised rather than raw.
  return label || value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

/**
 * Turn one notification into its action line, detail line and actor.
 *
 * `extras` supplies facts the row itself cannot carry. Omit it and the result
 * is exactly what a stored `notifications` row supports — which is what every
 * historical row and every row written today will produce.
 */
export function describeNotificationEvent(
  n: Pick<Notification, 'title' | 'type'>,
  extras: NotificationEventExtras = {},
): NotificationEvent {
  const title = typeof n.title === 'string' ? n.title : ''

  const hit = ACTION_PATTERNS.find(p => p.re.test(title))
  const action = hit?.action ?? FALLBACK_ACTION
  const actorName = hit ? parseActor(title, hit.re) : null

  // ── Comment ──
  if (action === 'Added a comment') {
    const preview = safeCommentPreview(extras.commentPreview)
    if (preview) return { action, detail: { kind: 'comment', text: preview }, actorName }
    // No preview stored. Say what happened and stop — an empty quote or the
    // task title standing in for the comment would both be lies.
    return { action: COMMENT_WITHOUT_PREVIEW, detail: null, actorName }
  }

  // ── Status change ──
  if (action === 'Status changed') {
    const from = extras.fromStatus ? statusLabel(extras.fromStatus) : null
    const to = extras.toStatus ? statusLabel(extras.toStatus) : (
      parseNewStatus(title) ? statusLabel(parseNewStatus(title)!) : null
    )
    if (from && to) return { action, detail: { kind: 'transition', from, to }, actorName }
    // NEVER invent the previous value. The new one alone is a complete
    // sentence on its own line.
    if (to) return { action: `Status changed to ${to}`, detail: null, actorName }
    return { action: STATUS_WITHOUT_VALUES, detail: null, actorName }
  }

  return { action, detail: null, actorName }
}

/**
 * The muted metadata line under an event: "By Dhruv · 2h ago", or just the time.
 *
 * THE RULE. The header already says who the task belongs to. Repeating that
 * name on every event would imply the assignee performed each one — including
 * the ones somebody else did. So the actor is shown ONLY when it differs from
 * the assignee, and then exactly once, here, never also inside the action
 * sentence (which is why the action lines above name no one).
 */
export function actorMetaFor(
  actorName: string | null,
  assigneeName: string | null,
  relativeTime: string,
): string {
  if (!actorName) return relativeTime
  if (assigneeName && actorName.trim().toLowerCase() === assigneeName.trim().toLowerCase()) {
    return relativeTime
  }
  return `By ${actorName} · ${relativeTime}`
}

/** "3 updates" / "1 update" — events, never subtasks. Always the word "updates". */
export function updateCountLabel(count: number): string {
  return `${count} update${count === 1 ? '' : 's'}`
}
