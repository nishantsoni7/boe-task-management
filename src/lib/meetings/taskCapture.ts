// Prefilling "Add to Meeting" from a task.
//
// The business problem this serves: sales assigns a task to management that says
// "Order 2041 — customer says the finish is wrong", and management must be able
// to put it on the next review's agenda in a few taps. Every second of typing
// here is a second during which somebody decides to mention it verbally instead.
//
// What can honestly be prefilled, and nothing beyond it:
//
//   * THE ISSUE LINE — the task title, trimmed and clamped. It is the sentence
//     somebody already wrote about this problem.
//   * THE ORDER NUMBER — read from a labelled line in the task body first
//     ("Order: 2041", which is exactly what a meeting-born task already carries,
//     see taskDraft.ts), then from an order-shaped token in the title.
//   * THE CUSTOMER — from a labelled line only. There is no way to recognise a
//     customer name in free text, and guessing one would put a wrong name on a
//     management record.
//   * THE CATEGORY — suggested from the words used, never decided. A dispatched
//     order with a complaint is After Sales; anything else defaults to Running
//     Order, which is the commoner case.
//
// public.tasks has no order_number and no customer column (and should not grow
// one for this: Meetings does not own the order master). So every value here is
// a SUGGESTION in an editable field, and the form refuses to submit without an
// order number the user has actually seen.

import { isDiscussionCategory, type AfterSalesTag, type DiscussionCategory } from './discussion'

/** Issue lines stay readable in the board's single-line cell. */
const ISSUE_MAX = 120

export type TaskCaptureSource = {
  title?: string | null
  /** The task body. `note` is the column's name in public.tasks. */
  note?: string | null
}

export type TaskCapturePrefill = {
  issue: string
  orderNumber: string
  customerName: string
  category: DiscussionCategory
  afterSalesTag: AfterSalesTag | null
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clamp(text: string, max: number): string {
  const clean = collapse(text)
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/**
 * The value of a `Label: value` line, if the text has one.
 *
 * Anchored to the start of a line so a sentence that happens to contain the word
 * cannot match, and the value stops at the end of that line — a description with
 * "Customer: Acme" followed by three more paragraphs yields "Acme".
 */
function labelledValue(text: string, labels: readonly string[]): string {
  for (const line of text.split(/\r?\n/)) {
    for (const label of labels) {
      const prefix = `${label}:`
      if (line.trim().toLowerCase().startsWith(prefix.toLowerCase())) {
        const value = collapse(line.trim().slice(prefix.length))
        if (value !== '' && value !== '—' && value !== '-') return value
      }
    }
  }
  return ''
}

/**
 * An order-shaped token: three to ten digits, optionally behind a BOE prefix or a
 * hash. Deliberately narrow — a two-digit number in a title is far more often a
 * quantity than an order, and a wrong order number on a meeting agenda is worse
 * than an empty field the user fills in.
 */
const ORDER_TOKEN = /(?:\b(?:BOE|boe|Boe)[-\s]?)?#?\b(\d{3,10})\b/

export function extractOrderNumber(source: TaskCaptureSource): string {
  const title = source.title ?? ''
  const note  = source.note ?? ''

  const labelled = labelledValue(`${note}\n${title}`, ['Order', 'Order No', 'Order Number', 'Order Ref'])
  if (labelled !== '') return labelled.slice(0, 40)

  const match = ORDER_TOKEN.exec(title) ?? ORDER_TOKEN.exec(note)
  return match ? match[0].trim() : ''
}

export function extractCustomerName(source: TaskCaptureSource): string {
  const labelled = labelledValue(`${source.note ?? ''}\n${source.title ?? ''}`, ['Customer', 'Client', 'Buyer'])
  return labelled.slice(0, 80)
}

/**
 * Words that only appear once an order has shipped. The suggestion is a starting
 * position in a two-button picker the user is looking at, not a classification:
 * getting it wrong costs one tap, and the tag travels with it so nothing has to
 * be re-typed.
 */
const AFTER_SALES_HINTS: { pattern: RegExp; tag: AfterSalesTag | null }[] = [
  { pattern: /\breplace(?:ment|d)?\b/i,                      tag: 'replacement' },
  { pattern: /\brepair(?:ing|ed|s)?\b/i,                     tag: 'repair' },
  { pattern: /\bsite\b.*\b(damage|issue|visit|complaint)\b/i, tag: 'site_issue' },
  { pattern: /\b(damaged|damage)\b.*\b(site|delivery|transit)\b/i, tag: 'site_issue' },
  { pattern: /\bwrong (item|product|piece|finish|colour|color)\b/i, tag: 'other' },
  { pattern: /\bafter[-\s]?sales\b/i,                        tag: null },
  { pattern: /\b(complaint|installed|installation)\b/i,       tag: null },
]

export function suggestCategory(source: TaskCaptureSource): {
  category: DiscussionCategory
  afterSalesTag: AfterSalesTag | null
} {
  const text = `${source.title ?? ''} ${source.note ?? ''}`
  for (const hint of AFTER_SALES_HINTS) {
    if (hint.pattern.test(text)) return { category: 'after_sales', afterSalesTag: hint.tag }
  }
  return { category: 'running_order', afterSalesTag: null }
}

/** Everything the quick sheet opens with. Every field stays editable. */
export function buildTaskCapturePrefill(source: TaskCaptureSource): TaskCapturePrefill {
  const suggestion = suggestCategory(source)
  return {
    issue: clamp(source.title ?? '', ISSUE_MAX),
    orderNumber: extractOrderNumber(source),
    customerName: extractCustomerName(source),
    category: suggestion.category,
    afterSalesTag: suggestion.afterSalesTag,
  }
}

/**
 * Can this be submitted? The same four requirements
 * capture_meeting_discussion_item() raises on, checked before the round trip so
 * the user is told in the form rather than by a toast.
 *
 * A target meeting is NOT required: with none, the issue waits in the Meeting
 * Inbox, which is the whole reason the Inbox exists.
 */
export function capturePrefillIsSubmittable(draft: {
  category: unknown
  orderNumber: string
  issue: string
  afterSalesTag: unknown
}): boolean {
  if (!isDiscussionCategory(draft.category)) return false
  if (draft.orderNumber.trim() === '') return false
  if (draft.issue.trim() === '') return false
  if (draft.afterSalesTag && draft.category !== 'after_sales') return false
  return true
}

/**
 * The optional long form sent as `p_details`: where this came from, so the
 * meeting has the context without anyone opening the task — and so a reviewer who
 * CANNOT open the task still knows an issue was raised from one.
 *
 * The task's title and body are NOT copied in. A meeting viewer who may not read
 * that task must not learn its contents from an agenda row; what they get is the
 * issue line the capturing user chose to write.
 */
export function captureDetails(input: {
  taskRef?: string | null
  extra?: string | null
}): string | null {
  const lines: string[] = []
  const extra = collapse(input.extra ?? '')
  if (extra !== '') lines.push(extra)
  if (input.taskRef) lines.push(`Raised from task ${input.taskRef}.`)
  return lines.length > 0 ? lines.join('\n\n') : null
}

// ─── Which meeting quick capture offers ─────────────────────────────────────

/** What quick capture needs to know about a meeting it might offer. */
export type CaptureMeetingOption = {
  id: string
  meeting_date: string
  meeting_type: string
  status: string
  created_at?: string | null
}

/** No meeting chosen: the issue waits in the Meeting Inbox. */
export const CAPTURE_INBOX = ''

/**
 * The meetings Task Detail's quick capture may put an issue on, nearest first.
 *
 * Only a LIVE meeting (draft or in progress) of the review type the category
 * belongs in, dated TODAY OR LATER in Indian business dates (`today` comes from
 * istToday()). A draft dated in the past is a meeting that did not happen as
 * planned — a stale draft, or a QA meeting left behind — and a few taps from a
 * task must never write a real issue into it. Past drafts stay manageable inside
 * Meetings; they are simply not quick-capture targets. Editability is decided by
 * the caller (canEditThisMeeting) before this runs.
 *
 * Dates are compared as YYYY-MM-DD strings, which order correctly; ties are
 * broken by when the meeting was raised, then by id, so the order is stable.
 */
export function captureTargetMeetings<T extends CaptureMeetingOption>(
  meetings: readonly T[],
  category: DiscussionCategory,
  today: string,
): T[] {
  const type = category === 'running_order' ? 'new_order' : 'repair_order'
  return meetings
    .filter(meeting =>
      meeting.meeting_type === type
      && (meeting.status === 'draft' || meeting.status === 'in_progress')
      && meeting.meeting_date >= today)
    .sort((a, b) =>
      a.meeting_date.localeCompare(b.meeting_date)
      || (a.created_at ?? '').localeCompare(b.created_at ?? '')
      || a.id.localeCompare(b.id))
}

/**
 * The target actually selected: the person's own choice while it is still one of
 * the offered meetings (or the Inbox), otherwise the nearest upcoming meeting,
 * otherwise the Meeting Inbox. There is deliberately no fallback to a past
 * meeting. Recomputed on every render, so switching the category can never leave
 * a meeting of the other review type selected.
 */
export function captureTargetId(
  chosenId: string | null,
  offered: readonly Pick<CaptureMeetingOption, 'id'>[],
): string {
  if (chosenId === CAPTURE_INBOX) return CAPTURE_INBOX
  if (chosenId !== null && offered.some(meeting => meeting.id === chosenId)) return chosenId
  return offered[0]?.id ?? CAPTURE_INBOX
}

/**
 * Whether Add may be pressed. Never while the meeting list is still loading or
 * failed to load: either would silently turn into "Inbox" although an upcoming
 * meeting may exist.
 */
export function captureSubmitAllowed(state: {
  saving: boolean
  finished: boolean
  meetingsLoaded: boolean
  meetingsError: string | null
  draftSubmittable: boolean
}): boolean {
  return !state.saving && !state.finished && state.meetingsLoaded
    && state.meetingsError === null && state.draftSubmittable
}
