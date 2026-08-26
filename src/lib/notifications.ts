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
// the title, so — unlike Finance/Orders — the TYPE cannot say which module a
// row belongs to. The column that can is `task_id` (see TASK_STRUCTURAL_OR
// below). Finance & Order Management use dedicated, stable enum types
// (`finance_*` / `order_*` — see 20260694000000 and /api/finance|orders/notify),
// matched by an explicit `type.in.(...)` list.
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

// ─── Task Management's category rule: STRUCTURAL, not wording ────────────────
//
// WHAT THIS REPLACED, AND WHY IT HAD TO GO. Until this change the Task feed was
// a whitelist of 16 leading-wildcard title fragments — `title.ilike.%completed
// task%` and friends. A row reached the feed only if a human-readable sentence
// composed at the call site happened to contain one of them. That is a
// classifier built on prose, and it silently dropped real notifications:
//
//   · `New task assigned to you`  — EVERY new-task assignment. Written by
//     tasks/create, tasks/assigned-by-me, MeetingTaskModal and
//     /api/tasks/[id]/copy, matched by none of the 16 fragments. A person was
//     given a task and was never told.
//   · `New quotation request`     — quotation-requests/new, same cause.
//   · `Task reopened` / `X reopened a task` — /api/restore-task's non-cancel
//     branch.
//   · `Task moved to Waiting` / `Task moved to Blocked` — the ACTOR-LESS
//     fallbacks in /api/notify-status-update. The fragments read `moved task
//     to waiting`; the fallback sentence reads `moved to Waiting`. Only the
//     named-actor form ever matched.
//   · `Task status updated`       — that route's default branch.
//
// None of this was a suppression decision. It was wording drift, and no test
// could catch it because the rule and the sentences lived in different files.
//
// THE RULE NOW. `task_id IS NOT NULL`. The column is the Task Management task
// foreign key and nothing else uses it: /api/assets/notify,
// /api/assets/warranty-sweep, /api/finance/notify and
// /api/orders/submissions/notify all write `task_id: null` explicitly and carry
// their subject in `entity_id`; /api/objections and /api/objections/review
// never set it at all. So a non-null `task_id` means "this is about a task",
// structurally, and no future rewording of any sentence can hide a row again.
//
// WHY THIS IS SAFE NOW AND WAS NOT BEFORE. The old comment here warned that
// widening to `task_id IS NOT NULL` would resurface the ~16k historical
// `overdue`/`escalation` rows the hourly `run_task_health_check` job wrote —
// they are about tasks, so they carry a task_id. That was true when the title
// whitelist was the ONLY thing keeping them out. It is no longer the only
// thing: every endpoint that uses this filter also chains
// `.not('type', 'in', SYSTEM_TYPE_EXCLUSION)`, which removes all five system
// types by enum value on the list, the count, mark-all-read and delete-all
// alike. The exclusion is now the rule that keeps cron noise out, deliberately
// and by type, instead of a title whitelist keeping it out by accident.
//
// LEGACY ROWS WITH A NULL task_id. Every task write path in the repository sets
// task_id — the four client inserts, /api/notify-status-update, /api/cancel-task,
// /api/restore-task, /api/tasks/[id]/copy and transition_task_review(). If a
// historical row exists that a removed path wrote without one, it leaves the
// feed under this rule. That case is deliberately NOT handled by keeping the
// title fragments as a second OR branch: two competing classifiers is the
// condition that produced this defect. If such rows are found, the fallback is
// one documented extra OR term added here, not a return to title matching.
const TASK_STRUCTURAL_OR = 'task_id.not.is.null'

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
      return TASK_STRUCTURAL_OR
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

// ─── System-generated activity: the ONE exclusion rule ────────────────────────
//
// THE PROBLEM THIS NAMES. `public.notification_type` carries two populations
// that have nothing to do with each other:
//
//   · events a PERSON caused, addressed to another person who may want to
//     respond — `task_acknowledged`, `finance_*`, `asset_*`, `*_issue_*` …
//   · records the SYSTEM produced on its own — the hourly database job
//     `run_task_health_check` has been writing `overdue` and `escalation` rows
//     since June (≈16k of them), plus the never-finished `stale_flag` and the
//     two digest types.
//
// Nobody asked for the second kind and nobody can act on one: an escalation is
// an observation about a task, not a request that somebody do something. They
// are the notification noise.
//
// WHAT THIS RULE IS. One list, one predicate, one PostgREST fragment — used by
// the write guard (src/lib/notificationWrites.ts) so no application path can
// create such a row, and by every category read filter so none can surface one.
// Before this, the task feed excluded them only as a side effect of its title
// whitelist: correct, but by accident, and one widened pattern away from
// dumping 16k rows into everyone's inbox. That accident is now the rule: the
// Task feed selects structurally on `task_id` (see TASK_STRUCTURAL_OR), so this
// exclusion is the ONLY thing keeping cron rows out of it — which is why it is
// chained on the list, the count, mark-all-read and delete-all without
// exception.
//
// WHAT IT IS NOT. It is not a rule about *how* a row was produced. A scheduled
// job that raises something a person must actually deal with is a real
// notification and stays — see ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES below.
// The distinction is "can the recipient act on this", not "did a human click".
export const SYSTEM_GENERATED_NOTIFICATION_TYPES = [
  // Written by the hourly `run_task_health_check` database job.
  'escalation',
  'overdue',
  'stale_flag',
  // Digest rows. `is_digest` marks them too; the type is listed so the rule
  // needs to read only one column.
  'morning_digest',
  'evening_digest',
] as const

export type SystemGeneratedNotificationType = typeof SYSTEM_GENERATED_NOTIFICATION_TYPES[number]

/**
 * Scheduled, NON-user-initiated, and deliberately kept.
 *
 * `asset_warranty_expiring` is raised by /api/assets/warranty-sweep — nobody
 * clicks anything, a warranty simply crosses the 30-day line — and it asks an
 * admin to make a renewal decision before a date passes. That is an actionable
 * reminder, so the suppression rule must not touch it.
 *
 * Listed explicitly rather than left to fall through, so that "a sweep wrote
 * it, therefore suppress it" can never be inferred from the code: the test
 * suite asserts this list survives the guard.
 */
export const ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES = [
  'asset_warranty_expiring',
] as const

const SYSTEM_TYPE_SET: ReadonlySet<string> = new Set(SYSTEM_GENERATED_NOTIFICATION_TYPES)

/**
 * True for a row the system produced about itself, which no recipient can act
 * on. The single predicate every write guard and read filter consults.
 */
export function isSystemGeneratedNotificationType(type: string | null | undefined): boolean {
  return typeof type === 'string' && SYSTEM_TYPE_SET.has(type)
}

/**
 * Split rows bound for `notifications` into the ones that may be written and
 * the ones the rule suppresses. Never throws: a suppressed row is a no-op, not
 * a failure, because the business action that produced it has already
 * succeeded and must not be rolled back over a notification.
 */
export function partitionSystemNotifications<T extends { type?: string | null }>(
  rows: readonly T[],
): { deliverable: T[]; suppressed: T[] } {
  const deliverable: T[] = []
  const suppressed:  T[] = []
  for (const row of rows) {
    if (isSystemGeneratedNotificationType(row.type)) suppressed.push(row)
    else deliverable.push(row)
  }
  return { deliverable, suppressed }
}

/**
 * PostgREST filter excluding every system type, to be chained with `.not()`
 * ALONGSIDE a category's `.or(...)` — the two combine with AND.
 *
 * Applied on the list, the count, mark-all-read and delete-all so all four
 * agree. Chaining it can never hide a human-generated row: every application
 * write path uses `task_acknowledged` / `task_assigned` / a module's own enum
 * value, and none of those appears in the list above.
 */
export const SYSTEM_TYPE_EXCLUSION = `(${SYSTEM_GENERATED_NOTIFICATION_TYPES.join(',')})`
