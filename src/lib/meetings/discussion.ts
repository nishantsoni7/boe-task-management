// Meetings — the order-discussion workflow (migration 20261213000000).
//
// One business issue on an order has ONE identity for its whole life, whatever
// number of meetings it passes through:
//
//   meeting_discussion_items        the issue        — Open or Resolved
//   meeting_discussion_appearances  the issue on ONE meeting's agenda
//   meeting_discussion_events       the append-only trail
//
// This file is the pure half: the two categories, the two states, what the board
// counts, and how an issue's trail reads back grouped by meeting. Everything
// here can be asserted without a database, which is the point — the rules the
// workflow is judged on (a resolved item never carries forward, a filter never
// silently matches nothing, history is newest-first by meeting) are the rules a
// test can reach.
//
// The column constants live here for the reason src/lib/meetings/types.ts gives:
// the board, the workspace and the Inbox read the same rows, and a column added
// to one query and not another is how a filter quietly starts matching nothing.

import type { BadgeMeta, MeetingOrderEvidence, MeetingStatus } from './types'

// ─── The two categories ───────────────────────────────────────────────────────

/**
 * The only two primary categories, matching the CHECK constraint. A third one is
 * a product decision and a migration, never a client-side addition.
 *
 *   running_order — the order has not shipped yet: drawing or material approval,
 *                   production, QC, packing, dispatch.
 *   after_sales   — the order has shipped and something came back: repair,
 *                   replacement, site damage, wrong item, finish or fitting.
 */
export type DiscussionCategory = 'running_order' | 'after_sales'

/** A convenience tag on an after-sales issue. NOT a category — see the CHECK. */
export type AfterSalesTag = 'repair' | 'replacement' | 'site_issue' | 'other'

/** Two states. Pending / Working / Waiting / Blocked are TASK states. */
export type DiscussionItemState = 'open' | 'resolved'

export type DiscussionEventType =
  | 'captured'
  | 'added_to_agenda'
  | 'carried_forward'
  | 'update'
  | 'task_linked'
  | 'resolved'
  | 'reopened'

export const DISCUSSION_CATEGORIES: DiscussionCategory[] = ['running_order', 'after_sales']
export const AFTER_SALES_TAGS: AfterSalesTag[] = ['repair', 'replacement', 'site_issue', 'other']

/**
 * Running Order wears the existing blue/info family (the same one New Order and
 * an open SKU line already wear); After Sales wears the existing amber/warning
 * family. No new colour enters the BOE palette, and neither state is ever
 * communicated by colour alone — the label travels with it everywhere.
 */
export const DISCUSSION_CATEGORY_META: Record<DiscussionCategory, BadgeMeta> = {
  running_order: { label: 'Running Order', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  after_sales:   { label: 'After Sales',   bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
}

export const DISCUSSION_STATE_META: Record<DiscussionItemState, BadgeMeta> = {
  open:     { label: 'Open',     bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  resolved: { label: 'Resolved', bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

export const AFTER_SALES_TAG_LABEL: Record<AfterSalesTag, string> = {
  repair:      'Repair',
  replacement: 'Replacement',
  site_issue:  'Site Issue',
  other:       'Other',
}

/** One line a non-technical reader can act on, used by the guide and the forms. */
export const DISCUSSION_CATEGORY_HELP: Record<DiscussionCategory, string> = {
  running_order:
    'The order has not been dispatched yet — drawing or material approval, production, '
    + 'a material concern, a QC issue, or a dispatch commitment.',
  after_sales:
    'The order has already been dispatched and something has been reported — a repair, '
    + 'a replacement, site damage, a wrong item, or a finish or fitting problem.',
}

/**
 * Category validation, in the browser as well as in the database.
 *
 * The database is the boundary (the CHECK constraint refuses anything else); this
 * exists so a form can refuse before a round trip, and so a test can state the
 * rule without one.
 */
export function isDiscussionCategory(value: unknown): value is DiscussionCategory {
  return value === 'running_order' || value === 'after_sales'
}

export function isAfterSalesTag(value: unknown): value is AfterSalesTag {
  return typeof value === 'string' && (AFTER_SALES_TAGS as string[]).includes(value)
}

/**
 * An after-sales tag on a running-order issue is refused, exactly as the
 * `meeting_discussion_items_tag_is_after_sales_only` CHECK refuses it. The UI
 * clears the tag when the category changes; this is what proves it has to.
 */
export function afterSalesTagAllowed(category: DiscussionCategory, tag: unknown): boolean {
  if (tag === null || tag === undefined || tag === '') return true
  return category === 'after_sales' && isAfterSalesTag(tag)
}

/**
 * Which review a category belongs in. The existing `meeting_type` is the whole
 * relevance key — there is no meeting-series model here and does not need to be.
 * Mirrors the CASE in apply_meeting_discussion_carry_forward().
 */
export function meetingTypeForCategory(category: DiscussionCategory): 'new_order' | 'repair_order' {
  return category === 'running_order' ? 'new_order' : 'repair_order'
}

export function categoryForMeetingType(type: 'new_order' | 'repair_order'): DiscussionCategory {
  return type === 'new_order' ? 'running_order' : 'after_sales'
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export type MeetingDiscussionItem = {
  id: string
  category: DiscussionCategory
  after_sales_tag: AfterSalesTag | null
  order_number: string
  /** upper(btrim(order_number)), generated by the database — the same key the Order rail matches on. */
  order_number_key?: string
  customer_name: string | null
  title: string
  details: string | null
  source_task_id: string | null
  state: DiscussionItemState
  created_by: string
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolved_by: string | null
  // resolution_note is deliberately absent. It is meeting-specific text, and the
  // issue row is readable by people who may not open the meeting that resolved it,
  // so no client role may select that column. The note is the 'resolved' trail
  // row's `detail`, which follows that meeting's visibility.
  // Joined for display — never selected with `*`.
  created_by_name?: string | null
  resolved_by_name?: string | null
}

export type MeetingDiscussionAppearance = {
  id: string
  meeting_id: string
  discussion_item_id: string
  /** The Order's row in this meeting. NULL until evidence needs a folder. */
  meeting_order_id: string | null
  agenda_position: number
  /** The appearance this was inherited from, when it was carried forward. */
  carried_from_id: string | null
  /** 'automatic' = carry-forward (from a meeting or the Inbox); 'manual' = an editor put it here. */
  placement: 'manual' | 'automatic'
  latest_update: string | null
  decision: string | null
  next_review_date: string | null
  discussed_at: string | null
  discussed_by: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export type MeetingDiscussionEvent = {
  id: string
  discussion_item_id: string
  meeting_id: string | null
  appearance_id: string | null
  order_number: string
  meeting_title: string | null
  event_type: DiscussionEventType
  previous_update: string | null
  new_update: string | null
  previous_state: DiscussionItemState | null
  new_state: DiscussionItemState | null
  previous_review_date: string | null
  new_review_date: string | null
  task_id: string | null
  detail: string | null
  actor_id: string
  created_at: string
  actor_name?: string | null
}

export const MEETING_DISCUSSION_ITEM_COLUMNS = [
  'id', 'category', 'after_sales_tag', 'order_number', 'order_number_key',
  'customer_name', 'title', 'details', 'source_task_id', 'state',
  'created_by', 'created_at', 'updated_at',
  'resolved_at', 'resolved_by',
].join(', ')

export const MEETING_DISCUSSION_APPEARANCE_COLUMNS = [
  'id', 'meeting_id', 'discussion_item_id', 'meeting_order_id', 'agenda_position',
  'carried_from_id', 'placement', 'latest_update', 'decision', 'next_review_date',
  'discussed_at', 'discussed_by', 'created_by', 'created_at', 'updated_at',
].join(', ')

export const MEETING_DISCUSSION_EVENT_COLUMNS = [
  'id', 'discussion_item_id', 'meeting_id', 'appearance_id', 'order_number',
  'meeting_title', 'event_type', 'previous_update', 'new_update',
  'previous_state', 'new_state', 'previous_review_date', 'new_review_date',
  'task_id', 'detail', 'actor_id', 'created_at',
].join(', ')

export const DISCUSSION_EVENT_LABEL: Record<DiscussionEventType, string> = {
  captured:        'Issue raised',
  added_to_agenda: 'Added to this meeting',
  carried_forward: 'Carried forward — still open',
  update:          'Update recorded',
  task_linked:     'Follow-up task',
  resolved:        'Resolved',
  reopened:        'Reopened',
}

// ─── The board ────────────────────────────────────────────────────────────────

/**
 * One row of the meeting board: the issue, its place on THIS agenda, and the
 * counts a reviewer wants before opening it.
 *
 * `linkedTaskIds` is every task ever linked to this appearance; `readableTaskIds`
 * is the subset the CURRENT VIEWER may actually open, resolved by reading
 * public.tasks under that viewer's own RLS. The two are separate on purpose: a
 * meeting viewer must never be able to use a task link to reach a task they
 * cannot otherwise see.
 */
export type DiscussionRow = {
  appearance: MeetingDiscussionAppearance
  item: MeetingDiscussionItem
  /** Meetings held before this one that discussed the SAME issue. */
  earlierMeetings: number
  evidenceCount: number
  linkedTaskIds: string[]
  /**
   * Resolved in THIS meeting and still resolved as this meeting records it — the
   * "resolved today" count. An issue resolved here and then reopened later in the
   * same live meeting is not resolved today.
   */
  resolvedHere: boolean
  /**
   * The state THIS meeting shows. For a completed meeting it is the state when the
   * meeting was completed; for a live meeting it is the state now. Filters, the
   * summary and the status badge all read this, so a completed meeting never
   * appears to have changed because of something decided after it closed.
   */
  recordedState: DiscussionItemState
  /** The resolution in force at that moment, when recordedState is 'resolved'. */
  resolution: MeetingDiscussionEvent | null
  /** True when the issue has been resolved or reopened since this meeting closed. */
  changedSince: boolean
}

export type DiscussionFilter = 'all' | DiscussionCategory | DiscussionItemState

export const DISCUSSION_FILTERS: DiscussionFilter[] = [
  'all', 'running_order', 'after_sales', 'open', 'resolved',
]

export const DISCUSSION_FILTER_LABEL: Record<DiscussionFilter, string> = {
  all:           'All',
  running_order: 'Running Order',
  after_sales:   'After Sales',
  open:          'Open',
  resolved:      'Resolved',
}

/** Has this issue been covered in this meeting? The board's "to go" count. */
export function isDiscussedHere(appearance: Pick<MeetingDiscussionAppearance, 'discussed_at'>): boolean {
  return appearance.discussed_at !== null
}

export function matchesDiscussionFilter(row: DiscussionRow, filter: DiscussionFilter): boolean {
  switch (filter) {
    case 'all':      return true
    case 'open':     return row.recordedState === 'open'
    case 'resolved': return row.recordedState === 'resolved'
    default:         return row.item.category === filter
  }
}

/** Board rows after the filter and the free-text search, in agenda order. */
export function filterDiscussionRows(
  rows: readonly DiscussionRow[],
  filter: DiscussionFilter,
  search = '',
): DiscussionRow[] {
  const q = search.trim().toLowerCase()
  return rows.filter(row => {
    if (!matchesDiscussionFilter(row, filter)) return false
    if (!q) return true
    const haystack = [
      row.item.order_number,
      row.item.customer_name ?? '',
      row.item.title,
      row.appearance.latest_update ?? '',
    ].join(' ').toLowerCase()
    return haystack.includes(q)
  })
}

export type DiscussionSummary = {
  total: number
  discussed: number
  toDiscuss: number
  resolvedHere: number
}

/**
 * The compact meeting summary. `toDiscuss` counts only OPEN items that have not
 * been touched: an item resolved in an earlier meeting is not work outstanding
 * in this one, and counting it would make the number meaningless.
 */
export function discussionSummary(rows: readonly DiscussionRow[]): DiscussionSummary {
  let discussed = 0
  let toDiscuss = 0
  let resolvedHere = 0
  for (const row of rows) {
    if (isDiscussedHere(row.appearance)) discussed += 1
    else if (row.recordedState === 'open') toDiscuss += 1
    if (row.resolvedHere) resolvedHere += 1
  }
  return { total: rows.length, discussed, toDiscuss, resolvedHere }
}

/** Agenda order: the position carry-forward gave it, then when it was added. */
export function sortDiscussionRows(rows: readonly DiscussionRow[]): DiscussionRow[] {
  return [...rows].sort((a, b) =>
    a.appearance.agenda_position - b.appearance.agenda_position
    || a.appearance.created_at.localeCompare(b.appearance.created_at))
}

/**
 * Compose the board rows from the four reads the screen already does.
 *
 * `earlierAppearances` is every appearance of these issues ANYWHERE the viewer
 * can see; only the ones in meetings held before this one count as earlier — by
 * meeting date then creation time, the same clock earlierMeetingOrders() uses, so
 * opening last month's review never shows what happened after it.
 */
export function buildDiscussionRows(input: {
  appearances: readonly MeetingDiscussionAppearance[]
  itemsById: ReadonlyMap<string, MeetingDiscussionItem>
  events: readonly MeetingDiscussionEvent[]
  evidence: readonly MeetingOrderEvidence[]
  /** Omitted only where nothing is being asserted about earlier meetings. */
  earlierAppearances?: readonly {
    discussion_item_id: string
    meeting_id: string
    meeting: { meeting_date: string; created_at: string } | null
  }[]
  currentMeeting: {
    id: string
    meeting_date: string
    created_at: string
    status?: MeetingStatus
    completed_at?: string | null
  }
}): DiscussionRow[] {
  const { appearances, itemsById, events, evidence, currentMeeting } = input
  const earlierAppearances = input.earlierAppearances ?? []

  const earlierCount = new Map<string, number>()
  for (const row of earlierAppearances) {
    if (!row.meeting || row.meeting_id === currentMeeting.id) continue
    if (!heldBefore(row.meeting, currentMeeting)) continue
    earlierCount.set(row.discussion_item_id, (earlierCount.get(row.discussion_item_id) ?? 0) + 1)
  }

  const evidenceCount = new Map<string, number>()
  for (const image of evidence) {
    const key = image.discussion_appearance_id
    if (!key) continue
    evidenceCount.set(key, (evidenceCount.get(key) ?? 0) + 1)
  }

  const taskIds = new Map<string, string[]>()
  for (const event of events) {
    if (!event.appearance_id) continue
    if (event.event_type === 'task_linked' && event.task_id) {
      const list = taskIds.get(event.appearance_id) ?? []
      if (!list.includes(event.task_id)) list.push(event.task_id)
      taskIds.set(event.appearance_id, list)
    }
  }

  const eventsByItem = new Map<string, MeetingDiscussionEvent[]>()
  for (const event of events) {
    const list = eventsByItem.get(event.discussion_item_id) ?? []
    list.push(event)
    eventsByItem.set(event.discussion_item_id, list)
  }

  const rows: DiscussionRow[] = []
  for (const appearance of appearances) {
    const item = itemsById.get(appearance.discussion_item_id)
    // An appearance whose issue did not come back is dropped rather than shown
    // without a category or a title.
    if (!item) continue
    const recorded = stateInMeeting(eventsByItem.get(item.id) ?? [], item.state, currentMeeting)
    rows.push({
      appearance,
      item,
      earlierMeetings: earlierCount.get(item.id) ?? 0,
      evidenceCount: evidenceCount.get(appearance.id) ?? 0,
      linkedTaskIds: taskIds.get(appearance.id) ?? [],
      // The resolution IN FORCE for this meeting, and it was taken here. A resolve
      // followed by a reopen leaves no resolution in force, so it is not counted.
      resolvedHere: recorded.recorded === 'resolved' && recorded.resolution?.appearance_id === appearance.id,
      recordedState: recorded.recorded,
      resolution: recorded.resolution,
      changedSince: recorded.changedSince,
    })
  }
  return sortDiscussionRows(rows)
}

export type StateInMeeting = {
  recorded: DiscussionItemState
  current: DiscussionItemState
  /** The 'resolved' event in force at the cut-off, when recorded is 'resolved'. */
  resolution: MeetingDiscussionEvent | null
  changedSince: boolean
}

/**
 * The state an issue had AS THIS MEETING RECORDS IT.
 *
 * Why this exists: `meeting_discussion_items.state` is CURRENT state. An issue
 * resolved in a meeting and reopened a month later reads 'open' today, and an issue
 * left open when a meeting closed and resolved the week after reads 'resolved'.
 * Showing that current value inside the completed meeting would make the record of
 * that meeting appear to have changed — the one thing a completed meeting must
 * never do.
 *
 * So the state is REPLAYED from the append-only trail, which is never rewritten:
 * start Open (every issue is captured Open), apply each 'resolved' and 'reopened'
 * event in time order, and stop at the meeting's completion. A live meeting has no
 * cut-off, so its recorded state is the current one.
 *
 * The resolution returned is the EVENT, not the item's resolved_* columns, because
 * a reopen clears those columns — the event keeps the original note, actor and time.
 */
export function stateInMeeting(
  itemEvents: readonly MeetingDiscussionEvent[],
  current: DiscussionItemState,
  meeting: { status?: MeetingStatus; completed_at?: string | null },
): StateInMeeting {
  const cutoff = meeting.status === 'completed' && meeting.completed_at ? meeting.completed_at : null

  const transitions = itemEvents
    .filter(e => e.event_type === 'resolved' || e.event_type === 'reopened')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  let state: DiscussionItemState = 'open'
  let resolution: MeetingDiscussionEvent | null = null
  for (const event of transitions) {
    if (cutoff !== null && event.created_at > cutoff) break
    if (event.event_type === 'resolved') { state = 'resolved'; resolution = event }
    else { state = 'open'; resolution = null }
  }

  if (cutoff === null) {
    // Live: the meeting shows now. The replayed resolution is still the right note.
    return { recorded: current, current, resolution: current === 'resolved' ? resolution : null, changedSince: false }
  }
  return { recorded: state, current, resolution, changedSince: state !== current }
}

/**
 * The note of the most recent resolution of an issue that THIS reader can see — what
 * the Reopen dialog quotes. It comes from the trail, never from the issue row: the
 * row's resolution_note is not readable by any client role, because the resolving
 * meeting's visibility is what decides who may read it. Null when no resolution is
 * visible, and the dialog then quotes nothing rather than guessing.
 */
export function latestResolutionNote(
  events: readonly MeetingDiscussionEvent[],
  itemId: string,
): string | null {
  let latest: MeetingDiscussionEvent | null = null
  for (const event of events) {
    if (event.discussion_item_id !== itemId || event.event_type !== 'resolved') continue
    if (!latest || event.created_at > latest.created_at) latest = event
  }
  return latest?.detail ?? null
}

/** Meeting `a` was held before meeting `b`: by date, then by when it was raised. */
export function heldBefore(
  a: { meeting_date: string; created_at: string },
  b: { meeting_date: string; created_at: string },
): boolean {
  if (a.meeting_date !== b.meeting_date) return a.meeting_date < b.meeting_date
  return a.created_at < b.created_at
}

// ─── One issue's history, grouped by meeting ──────────────────────────────────

export type DiscussionMeetingGroup = {
  /** null for the events that belong to no meeting: captured, reopened. */
  meetingId: string | null
  meetingTitle: string
  meetingDate: string | null
  /** When the meeting was raised — the tie-break when two share a date. */
  meetingCreatedAt: string | null
  appearanceId: string | null
  /** That meeting's own recorded position — never an earlier meeting's. */
  update: string | null
  decision: string | null
  nextReviewDate: string | null
  events: MeetingDiscussionEvent[]
  evidence: MeetingOrderEvidence[]
  linkedTaskIds: string[]
  /** True for the meeting currently open, which reads as "this meeting". */
  isCurrent: boolean
}

/**
 * This issue's whole thread, newest meeting first.
 *
 * Grouped by APPEARANCE, so each group is exactly one meeting's discussion of
 * this issue and nothing is mixed between them. An event with no meeting — the
 * capture, and a reopen taken outside a review — lands in a final group, because
 * it belongs to the issue rather than to any one meeting.
 *
 * This is the ISSUE's history. The Order's general history (every matter ever
 * discussed against the same order number) is a different table read on a
 * different screen, and the two are never merged.
 */
export function groupDiscussionHistory(input: {
  appearances: readonly MeetingDiscussionAppearance[]
  meetingsById: ReadonlyMap<string, { id: string; title: string; meeting_date: string; created_at: string }>
  events: readonly MeetingDiscussionEvent[]
  evidence: readonly MeetingOrderEvidence[]
  currentMeetingId?: string | null
}): DiscussionMeetingGroup[] {
  const { appearances, meetingsById, events, evidence, currentMeetingId } = input

  const byAppearance = new Map<string, DiscussionMeetingGroup>()
  for (const appearance of appearances) {
    const meeting = meetingsById.get(appearance.meeting_id)
    byAppearance.set(appearance.id, {
      meetingId: appearance.meeting_id,
      meetingTitle: meeting?.title ?? 'A meeting you cannot see',
      meetingDate: meeting?.meeting_date ?? null,
      meetingCreatedAt: meeting?.created_at ?? null,
      appearanceId: appearance.id,
      update: appearance.latest_update,
      decision: appearance.decision,
      nextReviewDate: appearance.next_review_date,
      events: [],
      evidence: [],
      linkedTaskIds: [],
      isCurrent: !!currentMeetingId && appearance.meeting_id === currentMeetingId,
    })
  }

  const loose: MeetingDiscussionEvent[] = []
  for (const event of events) {
    const group = event.appearance_id ? byAppearance.get(event.appearance_id) : undefined
    if (!group) { loose.push(event); continue }
    group.events.push(event)
    if (event.event_type === 'task_linked' && event.task_id && !group.linkedTaskIds.includes(event.task_id)) {
      group.linkedTaskIds.push(event.task_id)
    }
  }

  for (const image of evidence) {
    const group = image.discussion_appearance_id
      ? byAppearance.get(image.discussion_appearance_id)
      : undefined
    if (group) group.evidence.push(image)
  }

  const groups = [...byAppearance.values()]
  // Newest meeting first. A group whose meeting is not readable keeps its place
  // by the appearance's own creation time rather than jumping to the top.
  groups.sort((a, b) => {
    const left  = a.meetingDate ?? ''
    const right = b.meetingDate ?? ''
    if (left !== right) return left < right ? 1 : -1
    return 0
  })
  for (const group of groups) {
    group.events.sort((a, b) => a.created_at.localeCompare(b.created_at))
    group.evidence.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  if (loose.length > 0) {
    groups.push({
      meetingId: null,
      // Not "before any meeting": a reopen taken after the last review lands here
      // too. These are the things that happened to the issue OUTSIDE a meeting.
      meetingTitle: 'Outside a meeting',
      meetingDate: null,
      meetingCreatedAt: null,
      appearanceId: null,
      update: null,
      decision: null,
      nextReviewDate: null,
      events: [...loose].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      evidence: [],
      linkedTaskIds: [],
      isCurrent: false,
    })
  }

  return groups
}

/**
 * The part of an issue's thread that is EARLIER than a given meeting — what the
 * workspace's "Earlier meetings" panel shows.
 *
 *   * a meeting group counts only if that meeting was held BEFORE this one (by
 *     date, then by when it was raised). This meeting and every later one are
 *     excluded, so opening last month's review never shows this month's
 *     discussion as if it came first. A group whose meeting did not come back has
 *     no date to compare and is excluded rather than guessed.
 *   * the outside-a-meeting group keeps only what happened before this meeting's
 *     cut-off: for a completed meeting, its completion; for a live one, now. A
 *     reopen taken after a meeting closed is not part of that meeting's past.
 */
export function earlierDiscussionHistory(
  groups: readonly DiscussionMeetingGroup[],
  current: {
    id: string
    meeting_date: string
    created_at: string
    status?: MeetingStatus
    completed_at?: string | null
  },
): DiscussionMeetingGroup[] {
  const cutoff = current.status === 'completed' && current.completed_at ? current.completed_at : null
  const earlier: DiscussionMeetingGroup[] = []
  for (const group of groups) {
    if (group.meetingId === null) {
      const events = cutoff === null ? group.events : group.events.filter(e => e.created_at <= cutoff)
      if (events.length > 0) earlier.push({ ...group, events })
      continue
    }
    if (group.meetingId === current.id) continue
    if (!group.meetingDate || !group.meetingCreatedAt) continue
    if (!heldBefore({ meeting_date: group.meetingDate, created_at: group.meetingCreatedAt }, current)) continue
    earlier.push(group)
  }
  return earlier
}

// ─── Carry-forward, stated in the browser's own words ─────────────────────────

/**
 * Whether this issue is eligible to appear in the next meeting of its category.
 *
 * The browser NEVER decides this — apply_meeting_discussion_carry_forward() does,
 * inside the transaction that creates the meeting. This function exists so the
 * screen can tell a reader what will happen ("still open — moves to the next
 * review") and so the promise can be asserted without a database.
 */
export function carriesForward(item: Pick<MeetingDiscussionItem, 'state'>): boolean {
  return item.state === 'open'
}

/**
 * Is this issue waiting in the Meeting Inbox? There is no inbox table: an issue
 * with no appearance anywhere IS the Inbox, which is why nothing can be lost
 * from it and why the source task link always survives.
 */
export function isInInbox(appearanceCount: number, item: Pick<MeetingDiscussionItem, 'state'>): boolean {
  return appearanceCount === 0 && item.state === 'open'
}
