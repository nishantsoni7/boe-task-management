// Module-scoped "real activity" filters for notifications — used by the list
// API, the unread-badge count endpoint, mark-all-read and delete-all. Every
// module (Task Management, Finance, Orders) gets its own filter here, and every
// endpoint that touches notifications resolves its scope through
// `getNotificationCategoryFilter` so list/count/mark-read/delete-all can never
// disagree about which rows belong to which module.
//
// Each filter is a PostgREST `.or()` clause. Rows that do not match a module's
// filter are simply not part of that module's feed — including legacy/digest
// rows (`morning_digest`, etc.) and the `overdue`/`escalation` rows an hourly
// DB cron job (`run_task_health_check`) has been writing since June: those are
// intentionally not surfaced anywhere today, and this change must not start
// surfacing them.
//
// Task Management notifications are all stored under generic enum types
// (`task_acknowledged`, `task_assigned`, ...) with the event meaning living in
// the title, so — unlike Finance/Orders — they can only be whitelisted by
// title fragment (see TASK_TITLE_OR below). Finance & Order Management use
// dedicated, stable enum types (`finance_*` / `order_*` — see 20260694000000
// and /api/finance|orders/notify), matched by an explicit `type.in.(...)` list.
//
// IMPORTANT: `notifications.type` is a Postgres enum (`notification_type`), and
// enum columns do NOT support the `LIKE` operator (`type.like.finance_%`
// errors server-side with "operator does not exist: notification_type ~~
// unknown"). Confirmed directly against the DB: a HEAD/count request swallows
// the error and silently returns `count: null` (read as 0 by callers), while a
// full list request surfaces it as an explicit 404/500. Always use `.in()` /
// `type.in.(...)` against the exact enum values instead of a prefix `LIKE`.
//
// Sample Tracking has its own separate notification system (sample_notifications
// table) and is intentionally excluded here.

export const FINANCE_NOTIFICATION_TYPES = [
  'finance_submitted',
  'finance_resubmitted',
  'finance_clarification',
  'finance_approved_suspense',
  'finance_approved_linked',
  'finance_rejected',
  'finance_linked',
  'finance_status_corrected',
] as const

export const ORDER_NOTIFICATION_TYPES = [
  'order_submitted',
  'order_assigned',
  'order_clarification',
  'order_resubmitted',
  'order_rejected',
  'order_converted',
] as const

// PostgREST `type.in.(...)` fragment for an enum column — the safe equivalent
// of a `LIKE 'prefix_%'` prefix match, since enums only support equality/`IN`.
const typeInList = (types: readonly string[]) => `type.in.(${types.join(',')})`

// Task Management's title-based whitelist. Deliberately narrow and unchanged
// from the original shared filter — do NOT widen this to `task_id IS NOT NULL`
// (see the cron-job note above: that would resurface ~16k historical
// overdue/escalation rows that have never been shown to users).
const TASK_TITLE_OR = [
  'title.ilike.%acknowledged task%',
  'title.ilike.%task acknowledged%',
  'title.ilike.%moved task to waiting%',
  'title.ilike.%moved task to blocked%',
  'title.ilike.%completed task%',
  'title.ilike.%task completed%',
  'title.ilike.%added a comment%',
  'title.ilike.%new comment on task%',
  'title.ilike.%cancelled task%',
  'title.ilike.%task cancelled%',
  'title.ilike.%cancelled a task%',
  'title.ilike.%reversed cancellation%',
  'title.ilike.%cancellation reversed%',
].join(',')

export type NotificationCategory = 'task' | 'finance' | 'order'

const VALID_CATEGORIES: readonly NotificationCategory[] = ['task', 'finance', 'order']

// Module-scoped filter. Used by every module's own unread count, notification
// list, mark-all-read and delete-all so every one of those endpoints agrees on
// exactly which rows count as "Task", "Finance", or "Orders".
export function getNotificationCategoryFilter(category: NotificationCategory): string {
  switch (category) {
    case 'task':
      return TASK_TITLE_OR
    case 'finance':
      return typeInList(FINANCE_NOTIFICATION_TYPES)
    case 'order':
      return typeInList(ORDER_NOTIFICATION_TYPES)
  }
}

export type CategoryResolution =
  | { ok: true; category: NotificationCategory }
  | { ok: false; error: string }

// Single source of truth for resolving the `category` request param/body field,
// shared by every notification endpoint (list, count, mark-all-read, delete-all)
// so they can never disagree on what counts as valid input.
//
// Absent (`null`/`undefined`) is treated as "old caller, no opinion" and
// defaults to `task` for backward compatibility. A *present* value that isn't
// one of the three known categories is a caller mistake — e.g. a typo'd
// `?category=Finance` or `?category=orders` — and must be rejected loudly
// (HTTP 400) rather than silently falling back to `task`, which would quietly
// misroute one module's request into another's data.
export function resolveNotificationCategory(v: unknown): CategoryResolution {
  if (v === null || v === undefined) return { ok: true, category: 'task' }
  if (typeof v === 'string' && (VALID_CATEGORIES as readonly string[]).includes(v)) {
    return { ok: true, category: v as NotificationCategory }
  }
  return { ok: false, error: `Invalid category '${String(v)}'. Must be one of: ${VALID_CATEGORIES.join(', ')}.` }
}
