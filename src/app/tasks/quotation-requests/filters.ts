// ── Quotation Requests list filtering ─────────────────────────────────────────
// Pure filter model for /tasks/quotation-requests. It lives outside the page so
// the AND-combination rules, the searchable field set and the created-date
// windows can be tested directly, and so the page never grows a second copy that
// drifts from this one.
//
// Every function here is client-side by design: the page already loads the
// user's full quotation-request set in one query (no pagination, no server-side
// filter pattern to extend), so narrowing happens in memory over data that is
// already on the page.

import type { Task, TaskPriority } from '@/lib/types'

// ── Filter shape ──────────────────────────────────────────────────────────────

export type DateFilterKey = 'all' | 'today' | '7d' | '30d'

// Today / 7d / 30d only. The codebase has no reusable date-range picker — the
// one other date filter (Confirmed Orders) is a page-local preset list too — and
// this task is not the place to introduce a new date-picker system.
export const DATE_FILTERS: { key: DateFilterKey; label: string }[] = [
  { key: 'all',   label: 'Any date' },
  { key: 'today', label: 'Today' },
  { key: '7d',    label: 'Last 7 days' },
  { key: '30d',   label: 'Last 30 days' },
]

export const PRIORITY_FILTERS: { key: TaskPriority; label: string }[] = [
  { key: 'high',   label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low',    label: 'Low' },
]

// No status filter: `status` still splits the Pending and Closed tabs on the
// page, but within a tab a quotation request is effectively always `working`,
// so filtering on it narrowed nothing.
export type QuotationFilters = {
  search: string
  /** `created_by` of the request, or 'all'. */
  assignedBy: string
  priority: TaskPriority | 'all'
  dateRange: DateFilterKey
}

export const EMPTY_FILTERS: QuotationFilters = {
  search:     '',
  assignedBy: 'all',
  priority:   'all',
  dateRange:  'all',
}

// ── Field accessors ───────────────────────────────────────────────────────────

/**
 * Who assigned the request. A quotation request is raised by one person and
 * handed to the quotation owner: /tasks/quotation-requests/new writes the raiser
 * to `created_by` and the owner to `assigned_to`. `delegated_by` is selected by
 * several task pages but never written or displayed, so it is not consulted.
 */
export function assignerId(task: Pick<Task, 'created_by'>): string {
  return task.created_by
}

export function assignerName(
  task: Pick<Task, 'created_by'>,
  userMap: Record<string, string>,
): string {
  return userMap[task.created_by]?.trim() || 'Unknown'
}

/**
 * The Created Date column and the date filter both read `created_at`, the row's
 * own insert timestamp. `last_update_at` moves every time the request is
 * touched, which would turn "Last 7 days" into "recently worked on" — so it is
 * deliberately not substituted here. (It still drives list ORDER on the page,
 * which is unchanged.)
 *
 * Returns NaN for a missing or unparseable timestamp; callers treat NaN as
 * "no usable date" rather than as the epoch.
 */
export function createdAtMs(task: Pick<Task, 'created_at'>): number {
  if (!task.created_at) return NaN
  return new Date(task.created_at).getTime()
}

// ── Date windows ──────────────────────────────────────────────────────────────

/**
 * Inclusive lower bound for a preset, at local midnight so "Today" means the
 * calendar day and not the last 24 hours. `null` = no date constraint.
 */
export function dateFilterStart(key: DateFilterKey, now: Date = new Date()): Date | null {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate()
  switch (key) {
    case 'today': return new Date(y, m, d)
    case '7d':    return new Date(y, m, d - 6)
    case '30d':   return new Date(y, m, d - 29)
    default:      return null
  }
}

export function matchesDateRange(
  task: Pick<Task, 'created_at'>,
  key: DateFilterKey,
  now: Date = new Date(),
): boolean {
  const start = dateFilterStart(key, now)
  if (!start) return true
  const ms = createdAtMs(task)
  // A request with no usable created_at cannot be placed in a window, so an
  // active date filter excludes it instead of guessing.
  if (Number.isNaN(ms)) return false
  return ms >= start.getTime()
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Fields the search box covers. Of the requested set, `tasks` carries customer
 * name, title and note; there is no request-number column on quotation requests
 * and none was added for search.
 */
export function matchesSearch(
  task: Pick<Task, 'customer_name' | 'title' | 'note'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [task.customer_name, task.title, task.note].some(
    v => (v ?? '').toLowerCase().includes(q),
  )
}

// ── Combination ───────────────────────────────────────────────────────────────

export function filtersActive(f: QuotationFilters): boolean {
  return (
    f.search.trim() !== '' ||
    f.assignedBy !== 'all' ||
    f.priority   !== 'all' ||
    f.dateRange  !== 'all'
  )
}

/**
 * AND across every active filter, applied to the tasks of ONE tab. Input order
 * is preserved — the page still owns sorting.
 */
export function applyQuotationFilters<T extends Task>(
  tasks: T[],
  f: QuotationFilters,
  now: Date = new Date(),
): T[] {
  return tasks.filter(t =>
    (f.assignedBy === 'all' || assignerId(t) === f.assignedBy) &&
    (f.priority   === 'all' || t.priority === f.priority) &&
    matchesDateRange(t, f.dateRange, now) &&
    matchesSearch(t, f.search),
  )
}

// ── Option lists ──────────────────────────────────────────────────────────────

/** Assigners present in the current tab, named from the page's existing user map. */
export function assignedByOptions(
  tasks: Pick<Task, 'created_by'>[],
  userMap: Record<string, string>,
): { id: string; name: string }[] {
  const ids = [...new Set(tasks.map(assignerId).filter(Boolean))]
  return ids
    .map(id => ({ id, name: userMap[id]?.trim() || 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
