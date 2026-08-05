// Meetings — domain types, label maps and query column lists.
//
// The column constants live here, not inline in each page, for the reason
// src/lib/assets/detail.ts gives: the list screen, the working screen and the
// follow-ups screen all read the same rows, and a column added to one query and
// not another is how a filter silently starts matching nothing.

// ─── Meeting ──────────────────────────────────────────────────────────────────

/** Phase 1 supports exactly two review types. */
export type MeetingType = 'new_order' | 'repair_order'

export type MeetingStatus = 'draft' | 'in_progress' | 'completed'

/** Overall position of one order in the review. */
export type OrderPosition = 'on_track' | 'attention' | 'at_risk' | 'closed'

/** Where one SKU line stands. */
export type ItemStatus = 'open' | 'waiting' | 'resolved'

export type Meeting = {
  id: string
  meeting_type: MeetingType
  meeting_date: string
  title: string
  lead_id: string
  status: MeetingStatus
  note: string | null
  created_by: string
  created_at: string
  updated_at: string
  completed_at: string | null
  completed_by: string | null
  // Joined for display — never selected with `*`.
  lead_name?: string | null
  created_by_name?: string | null
}

export type MeetingAttendee = {
  meeting_id: string
  user_id: string
  added_at: string
  full_name?: string | null
  team?: string | null
}

export type MeetingOrder = {
  id: string
  meeting_id: string
  order_number: string
  order_type: MeetingType
  customer_name: string | null
  expected_dispatch_date: string | null
  position: OrderPosition
  latest_update: string | null
  next_review_date: string | null
  remarks: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export type MeetingOrderItem = {
  id: string
  meeting_order_id: string
  sku: string
  product_name: string
  quantity: number | null
  current_stage: string | null
  latest_update: string | null
  issue: string | null
  responsible_department: string | null
  next_follow_up_date: string | null
  status: ItemStatus
  linked_task_id: string | null
  linked_task_at: string | null
  linked_task_by: string | null
  created_by: string
  created_at: string
  updated_at: string
}

/** The linked task, read live from Task Management. Never mirrored here. */
export type LinkedTask = {
  id: string
  title: string
  status: string
  priority: string
  due_date: string | null
  assigned_to: string
  assignee_name?: string | null
}

export type MeetingHistoryEntryType =
  | 'order_added'
  | 'order_update'
  | 'item_added'
  | 'item_update'
  | 'task_linked'
  | 'import'

export type MeetingHistoryEntry = {
  id: string
  meeting_id: string
  meeting_order_id: string | null
  meeting_order_item_id: string | null
  order_number: string
  sku: string | null
  product_name: string | null
  entry_type: MeetingHistoryEntryType
  previous_update: string | null
  new_update: string | null
  previous_status: string | null
  new_status: string | null
  previous_follow_up_date: string | null
  new_follow_up_date: string | null
  detail: string | null
  actor_id: string
  created_at: string
  actor_name?: string | null
}

// ─── Query column lists ───────────────────────────────────────────────────────

export const MEETING_COLUMNS = [
  'id', 'meeting_type', 'meeting_date', 'title', 'lead_id', 'status', 'note',
  'created_by', 'created_at', 'updated_at', 'completed_at', 'completed_by',
].join(', ')

export const MEETING_ORDER_COLUMNS = [
  'id', 'meeting_id', 'order_number', 'order_type', 'customer_name',
  'expected_dispatch_date', 'position', 'latest_update', 'next_review_date',
  'remarks', 'created_by', 'created_at', 'updated_at',
].join(', ')

export const MEETING_ORDER_ITEM_COLUMNS = [
  'id', 'meeting_order_id', 'sku', 'product_name', 'quantity', 'current_stage',
  'latest_update', 'issue', 'responsible_department', 'next_follow_up_date',
  'status', 'linked_task_id', 'linked_task_at', 'linked_task_by',
  'created_by', 'created_at', 'updated_at',
].join(', ')

/** One meeting lifecycle event. Never mixed with the SKU update history. */
export type MeetingActivityEventType =
  | 'created'
  | 'started'
  | 'completed'
  | 'reopened'
  | 'returned_to_draft'

export type MeetingActivityEntry = {
  id: string
  meeting_id: string
  event_type: MeetingActivityEventType
  previous_status: MeetingStatus | null
  new_status: MeetingStatus
  detail: string | null
  actor_id: string
  created_at: string
  actor_name?: string | null
}

export const MEETING_ACTIVITY_COLUMNS = [
  'id', 'meeting_id', 'event_type', 'previous_status', 'new_status',
  'detail', 'actor_id', 'created_at',
].join(', ')

export const MEETING_HISTORY_COLUMNS = [
  'id', 'meeting_id', 'meeting_order_id', 'meeting_order_item_id',
  'order_number', 'sku', 'product_name', 'entry_type',
  'previous_update', 'new_update', 'previous_status', 'new_status',
  'previous_follow_up_date', 'new_follow_up_date', 'detail',
  'actor_id', 'created_at',
].join(', ')

// ─── Presentation ─────────────────────────────────────────────────────────────
//
// One palette, used by the tab strip, the row badge and the modal alike, so a
// state wears the same colour everywhere. Shapes match the `{ label, bg, color,
// border }` convention every other BOE list page already uses, which is what
// `accentFromBadge` in @/components/ui/StatusTabs consumes.

export type BadgeMeta = { label: string; bg: string; color: string; border: string }

/**
 * New Order and Repair Order reviews must be distinguishable at a glance
 * WITHOUT being two separate systems — same screens, same table, one colour and
 * one word of difference.
 */
export const MEETING_TYPE_META: Record<MeetingType, BadgeMeta> = {
  new_order:    { label: 'New Order',    bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  repair_order: { label: 'Repair Order', bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
}

export const MEETING_STATUS_META: Record<MeetingStatus, BadgeMeta> = {
  draft:       { label: 'Draft',       bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' },
  in_progress: { label: 'In Progress', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  completed:   { label: 'Completed',   bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

export const ORDER_POSITION_META: Record<OrderPosition, BadgeMeta> = {
  on_track:  { label: 'On Track',  bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  attention: { label: 'Attention', bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  at_risk:   { label: 'At Risk',   bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  closed:    { label: 'Closed',    bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' },
}

/**
 * Open / Waiting / Resolved must never be confusable with one another, nor with
 * "has a linked task" — which is why a linked task is shown as a task chip in
 * its own column and never as a fourth status here.
 */
export const ITEM_STATUS_META: Record<ItemStatus, BadgeMeta> = {
  open:     { label: 'Open',     bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  waiting:  { label: 'Waiting',  bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  resolved: { label: 'Resolved', bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

export const MEETING_TYPES: MeetingType[] = ['new_order', 'repair_order']
export const ORDER_POSITIONS: OrderPosition[] = ['on_track', 'attention', 'at_risk', 'closed']
export const ITEM_STATUSES: ItemStatus[] = ['open', 'waiting', 'resolved']

/**
 * Default title for a new meeting: type plus date, editable from the moment the
 * form opens. Generated in the browser rather than the database because the
 * user must be able to see and change it before saving.
 */
export function defaultMeetingTitle(type: MeetingType, date: string): string {
  const label = MEETING_TYPE_META[type].label
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return `${label} Review`
  const pretty = parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${label} Review — ${pretty}`
}

/** A date column, rendered the way every other BOE list renders one. */
export function formatMeetingDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** A timestamp in the history drawer: date plus time, IST. */
export function formatMeetingTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  })
}

/** `sales` → `Sales`. Departments are stored as their Control Center key. */
export function departmentLabel(key: string | null | undefined): string {
  if (!key) return '—'
  return key.charAt(0).toUpperCase() + key.slice(1)
}
