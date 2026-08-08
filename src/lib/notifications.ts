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

// Assets & Access (20260731000000). Same contract as Finance/Orders: stable
// enum types, and `entity_id` carries the ASSET id for the deep link.
export const ASSET_NOTIFICATION_TYPES = [
  'asset_request_submitted',
  'asset_request_approved',
  'asset_request_rejected',
  'asset_edit_request_submitted',
  'asset_edit_request_approved',
  'asset_edit_request_rejected',
  'asset_assigned',
  'asset_transferred',
  'asset_transfer_acknowledged',
  'asset_returned',
  'asset_lost',
  'asset_recovered',
  'asset_repair_sent',
  'asset_repair_returned',
  'asset_warranty_expiring',
  // 20260802000000. The `access_*` values belong to this list on purpose: the
  // module — and its notifications page — is "Assets & Access", one feed for
  // both halves. A separate category would give the Access Register its own
  // bell and its own unread count for three mutations.
  'asset_edited',
  'asset_warranty_updated',
  'asset_service_added',
  'asset_document_uploaded',
  'asset_retired',
  'asset_disposed',
  'asset_restored',
  'access_granted',
  'access_updated',
  'access_revoked',
  'access_restored',
] as const

export const ORDER_NOTIFICATION_TYPES = [
  'order_submitted',
  'order_assigned',
  'order_clarification',
  'order_resubmitted',
  'order_rejected',
  'order_converted',
] as const

// Attendance & Payroll employee-raised issues (20260824000000).
//
// ONE feed for both, on purpose. Attendance and Payroll are the same operational
// loop — an employee disputes a day, and the deduction that day produced is on
// the payslip — and both land on the same admin's desk as the same kind of
// follow-up. Two feeds would mean two bells and two unread counts for one queue
// of work, which is how an admin ends up clearing one and never noticing the
// other. Same reasoning that keeps `access_*` inside the Assets list above.
//
// Four types, in two matched pairs, and expected to stay that way: this is the
// "someone reported a problem with their own record, and here is what came of
// it" channel, not a general attendance or payroll activity log. Anything
// routine belongs on the screens themselves, not in a notification.
//
//   *_issue_raised    written to every active ADMIN when an employee reports
//                     something (src/app/api/objections/route.ts).
//   *_issue_reviewed  written to the ONE EMPLOYEE who raised it, when an admin
//                     resolves or rejects it (…/objections/review/route.ts).
//                     Added by 20260825000000.
//
// Both halves in one category on purpose. They are two ends of a single
// conversation, and every endpoint scopes rows to `user_id = caller`, so the
// category decides which FEED a row belongs to while the row's own recipient
// decides who reads it. An employee therefore sees the outcomes of their own
// issues and no `*_raised` row at all, because none was ever addressed to them.
export const ATTENDANCE_PAYROLL_NOTIFICATION_TYPES = [
  'attendance_issue_raised',
  'payroll_issue_raised',
  'attendance_issue_reviewed',
  'payroll_issue_reviewed',
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

export type NotificationCategory = 'task' | 'finance' | 'order' | 'asset' | 'attendance_payroll'

const VALID_CATEGORIES: readonly NotificationCategory[] =
  ['task', 'finance', 'order', 'asset', 'attendance_payroll']

/**
 * Categories only an admin may read. Currently none.
 *
 * `attendance_payroll` was listed here while every row of it was addressed to
 * an admin: the feed was purely the company-wide queue of employees' disputes,
 * so refusing it to anyone else cost nothing and stated the intent plainly.
 *
 * That stopped being true when an admin's decision started notifying the
 * employee who raised the issue (20260825000000). The feed now has rows
 * belonging to employees, and a category gate would refuse a person their own
 * notification — the very bug the outcome notification exists to fix.
 *
 * What keeps one employee's rows away from another's has never been this list.
 * It is the `.eq('user_id', caller)` every notification endpoint applies, which
 * is row access and is untouched: an employee asking for this category is
 * answered with the outcomes of their own issues, and no `*_issue_raised` row,
 * because none was ever written to them.
 *
 * The machinery is kept rather than deleted. It is three lines, it is enforced
 * server-side in every notification endpoint via canReadNotificationCategory()
 * in src/lib/notificationAccess.ts, and the next admin-only feed is a one-word
 * change instead of a reconstruction.
 */
export const ADMIN_ONLY_CATEGORIES: readonly NotificationCategory[] = []

export function isAdminOnlyNotificationCategory(category: NotificationCategory): boolean {
  return ADMIN_ONLY_CATEGORIES.includes(category)
}

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
    case 'asset':
      return typeInList(ASSET_NOTIFICATION_TYPES)
    case 'attendance_payroll':
      return typeInList(ATTENDANCE_PAYROLL_NOTIFICATION_TYPES)
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
// one of the known categories is a caller mistake — e.g. a typo'd
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
